import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { wakeInstruction, watchReceiptText, type WatchReceipt } from "./watch.ts";

export interface PingReceipt {
  id: string;
  label: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "matched" | "timedOut" | "failed" | "cancelled";
  paneIds: readonly string[];
  failure?: string;
}
export interface WakeRecord {
  $type: "sh.mschf.agentgraph.wake";
  watch: string;
  source: "herdr_watch" | "herdr_ping_wait";
  kind: "agent_state" | "pane_output" | "ping";
  label: string;
  status: Exclude<WatchReceipt["status"], "running">;
  startedAt: string;
  finishedAt: string;
  text: string;
  target?: string;
  pane?: string;
  targetPaneId?: string;
  targetTerminalId?: string;
  code?: string;
  failure?: string;
  result?: string;
}

export function clip(text: string, chars: number, lines = Infinity): string {
  const bounded = text.split("\n").slice(0, lines).join("\n");
  if (bounded.length === text.length && text.length <= chars) return text;
  return bounded.slice(0, chars - 1) + "…";
}

export function toWakeRecord(receipt: WatchReceipt | PingReceipt): WakeRecord {
  if (receipt.status === "running" || !receipt.finishedAt) throw new Error("wake requires a settled receipt");
  const watch = "kind" in receipt;
  // Socket routing is private transport state, including in model-visible text.
  const { socketPath: _socketPath, ...publicReceipt } = watch ? receipt : { ...receipt, socketPath: undefined };
  const record: WakeRecord = {
    $type: "sh.mschf.agentgraph.wake",
    watch: clip(receipt.id, 256),
    source: watch ? "herdr_watch" : "herdr_ping_wait",
    kind: watch ? receipt.kind : "ping",
    label: clip(receipt.label, 256),
    status: receipt.status,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    text: clip(watch
      ? `${wakeInstruction(receipt.status)}\n\n${watchReceiptText(publicReceipt as WatchReceipt)}`
      : `Degraded Herdr ping fallback settled. Inspect the pane and receipt before continuing.\n\n${JSON.stringify(publicReceipt)}`, 8192),
  };
  if (receipt.failure !== undefined) record.failure = clip(receipt.failure, 1024);
  if (watch) {
    for (const key of ["target", "pane", "targetPaneId", "targetTerminalId", "code"] as const) {
      if (receipt[key]) record[key] = clip(receipt[key], 256);
    }
    if (receipt.result?.type === "output_matched") {
      record.result = clip(stripVTControlCharacters(receipt.result.matched_line ?? receipt.result.read.text), 2048, 12);
    }
  }
  // JSON escaping and multi-byte Unicode can exceed the wire budget even when
  // every field passes its character cap. Keep clipping evidence first.
  while (Buffer.byteLength(JSON.stringify(record)) > 16 * 1024) {
    if (record.text.length > 1) record.text = clip(record.text, Math.max(1, record.text.length - 256));
    else if (record.result && record.result.length > 1) record.result = clip(record.result, Math.max(1, record.result.length - 256));
    else if (record.failure && record.failure.length > 1) record.failure = clip(record.failure, Math.max(1, record.failure.length - 256));
    else throw new Error("wake metadata exceeds 16 KB");
  }
  return record;
}

export interface WakeEvents {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
}
type SendResult = { status: "delivered"; id: string } | { status: "not-delivered"; code: string; reason: string };
function exchange(events: WakeEvents, event: string, timeout: number, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(result);
    };
    const off = events.on(`${event}:result`, (value) => {
      if (typeof value === "object" && value !== null && "requestId" in value && value.requestId === requestId) finish(value as Record<string, unknown>);
    });
    const timer = setTimeout(() => finish(), timeout);
    try { events.emit(event, { requestId, ...body }); } catch { finish(); }
  });
}
export async function sendWake(events: WakeEvents, record: WakeRecord, to: string): Promise<SendResult> {
  const result = await exchange(events, "ratking/send", 15_000, { to, kind: "data", record });
  if (result?.status === "delivered" && typeof result.id === "string") return { status: "delivered", id: result.id };
  return { status: "not-delivered", code: typeof result?.code === "string" ? result.code : "timeout", reason: typeof result?.reason === "string" ? result.reason : "no delivery result within 15 s" };
}

interface LocalMessage { customType: string; content: string; details: unknown }

/**
 * Local delivery for a Pi with no live Rat King name, or after mail failed.
 * pi-until's follow-up arbiter gets it first, so Bellwether wakes still
 * serialize with pi-until's own and wait out compaction; direct send only
 * when nobody accepts synchronously.
 */
export function deliverLocal(
  events: Pick<WakeEvents, "emit">,
  sendMessage: (message: LocalMessage & { display: true }, options: { deliverAs: "followUp"; triggerTurn: true }) => void,
  message: LocalMessage,
): void {
  let accepted = false;
  try {
    events.emit("pi-until:follow-up", {
      version: 1,
      source: "bellwether",
      id: randomUUID(),
      customType: message.customType,
      content: message.content,
      details: message.details,
      accept: () => { accepted = true; },
    });
  } catch {
    // A listener failure is not acceptance.
  }
  if (!accepted) sendMessage({ ...message, display: true }, { deliverAs: "followUp", triggerTurn: true });
}
export function createWakeDelivery(options: {
  events: WakeEvents;
  local(message: LocalMessage): void;
  warn(message: string): void;
}) {
  const mailed = new Map<string, { record: WakeRecord; delivery: Promise<string | undefined> }>();
  return {
    wake(record: WakeRecord, message: LocalMessage) {
      const delivery = (async () => {
        const self = await exchange(options.events, "ratking/status", 2000, {});
        if (typeof self?.name !== "string" || !self.name || self.reader !== "live") {
          options.local(message);
          return undefined;
        }
        const result = await sendWake(options.events, record, self.name);
        if (result.status === "delivered") return self.name;
        options.local(message);
        options.warn(`${record.label}: wake mail refused (${result.code}: ${result.reason}); delivered locally`);
        return undefined;
      })();
      mailed.set(record.watch, { record, delivery });
      void delivery.then((to) => { if (!to && mailed.get(record.watch)?.delivery === delivery) mailed.delete(record.watch); });
    },
    withdraw(id: string): boolean {
      const entry = mailed.get(id);
      if (!entry) return false;
      mailed.delete(id);
      // Serialize withdrawal after an in-flight send. Local follow-ups cannot
      // be withdrawn, and a cancellation must never become a local wake.
      void entry.delivery.then(async (to) => {
        if (!to) return;
        const result = await sendWake(options.events, { ...entry.record, status: "cancelled", finishedAt: new Date().toISOString() }, to);
        if (result.status !== "delivered") options.warn(`${entry.record.label}: wake withdrawal refused (${result.code}: ${result.reason})`);
      });
      return true;
    },
  };
}
