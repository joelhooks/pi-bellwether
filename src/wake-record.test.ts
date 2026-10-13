import { afterEach, describe, expect, test, vi } from "vitest";
import { createWakeDelivery, toWakeRecord, type WakeEvents, type WakeRecord } from "./wake-record.ts";
import { watchReceiptText, wakeInstruction, type WatchReceipt } from "./watch.ts";
import { resultForMethod } from "./test-support.ts";

const receipt: WatchReceipt = {
  id: "watch-1", kind: "agent_state", label: "worker", status: "matched", wake: "agent",
  startedAt: "2026-10-13T00:00:00.000Z", finishedAt: "2026-10-13T00:00:01.000Z", target: "worker",
};
function strict(record: WakeRecord) {
  const allowed = ["$type", "watch", "source", "kind", "label", "target", "pane", "targetPaneId", "targetTerminalId", "status", "code", "failure", "startedAt", "finishedAt", "text", "result"];
  expect(Object.keys(record).every((key) => allowed.includes(key))).toBe(true);
  expect(record.$type).toBe("sh.mschf.agentgraph.wake");
  expect(["matched", "timedOut", "targetGone", "failed", "cancelled"]).toContain(record.status);
  expect(["agent_state", "pane_output", "ping"]).toContain(record.kind);
  expect(["herdr_watch", "herdr_ping_wait"]).toContain(record.source);
  for (const key of ["watch", "label", "target", "pane", "targetPaneId", "targetTerminalId", "code"] as const) {
    if (record[key] !== undefined) { expect(record[key]!.length).toBeGreaterThan(0); expect(record[key]!.length).toBeLessThanOrEqual(256); }
  }
  expect(record.failure?.length ?? 0).toBeLessThanOrEqual(1024);
  expect(record.text.length).toBeLessThanOrEqual(8192);
  expect(record.result?.length ?? 0).toBeLessThanOrEqual(2048);
  expect(record.result?.split("\n").length ?? 0).toBeLessThanOrEqual(12);
  expect(Number.isFinite(Date.parse(record.startedAt))).toBe(true);
  expect(Number.isFinite(Date.parse(record.finishedAt))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(16 * 1024);
}
afterEach(() => vi.useRealTimers());

describe("wake record", () => {
  test.each(["matched", "timedOut", "targetGone", "failed", "cancelled"] as const)("encodes %s for both watch kinds", (status) => {
    for (const kind of ["agent_state", "pane_output"] as const) {
      const input = { ...receipt, kind, status };
      const record = toWakeRecord(input);
      strict(record);
      expect(record.text).toBe(`${wakeInstruction(status)}\n\n${watchReceiptText(input)}`);
    }
  });
  test.each(["matched", "timedOut", "failed", "cancelled"] as const)("encodes ping %s", (status) => {
    const ping = { id: "ping-1", label: "ping", paneIds: ["p1"], startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, status };
    const record = toWakeRecord(ping);
    strict(record);
    expect(record.kind).toBe("ping");
    expect(record.text).toBe(`Degraded Herdr ping fallback settled. Inspect the pane and receipt before continuing.\n\n${JSON.stringify(ping)}`);
  });
  test("never mails socketPath, including the formatted text", () => {
    const record = toWakeRecord({ ...receipt, socketPath: "/private/socket" });
    expect(JSON.stringify(record)).not.toContain("socket");
  });
  test("keeps pane output intact within caps and clips oversize output", () => {
    // The shared fake server returns plain JSON; pin its known output shape.
    const result = resultForMethod("pane.wait_for_output") as Extract<NonNullable<WatchReceipt["result"]>, { type: "output_matched" }>;
    const output = "first\nsecond\nthird";
    const small = toWakeRecord({ ...receipt, kind: "pane_output", result: { ...result, matched_line: output } });
    strict(small);
    expect(small.result).toBe(output);
    expect(small.text).toContain(output);
    for (const output of ["x".repeat(3000), Array(20).fill("line").join("\n")]) {
      const big = toWakeRecord({ ...receipt, kind: "pane_output", result: { ...result, matched_line: output }, failure: "f".repeat(10000) });
      strict(big);
      expect(big.text.length).toBeLessThanOrEqual(8192);
      expect(big.result!.endsWith("…")).toBe(true);
    }
  });
  test("clips oversize ping text with a visible cut", () => {
    const record = toWakeRecord({ id: "ping", label: "ping", paneIds: ["p".repeat(12000)], startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, status: "matched" });
    strict(record);
    expect(record.text).toHaveLength(8192);
    expect(record.text.endsWith("…")).toBe(true);
  });
  test("bounds UTF-8 and escaped JSON to 16 KB", () => {
    for (const char of ["😀", "\u0000", "界"]) strict(toWakeRecord({ ...receipt, failure: char.repeat(20000) }));
  });
});

function setup(mode: "live" | "absent" | "offline" | "refused" | "timeout" = "live") {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const requests: Array<Record<string, unknown>> = [];
  const events: WakeEvents = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set);
      return () => { set.delete(listener); };
    },
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value);
      const request = value as Record<string, unknown>;
      if (event === "ratking/status" && mode !== "absent") events.emit("ratking/status:result", { requestId: request.requestId, name: mode === "offline" ? null : "owner", reader: "live" });
      if (event === "ratking/send") {
        requests.push(request);
        // A different request's result must not settle this send.
        events.emit("ratking/send:result", { requestId: "unrelated", status: "delivered", id: "other" });
        if (mode !== "timeout") events.emit("ratking/send:result", { requestId: request.requestId, ...(mode === "refused" ? { status: "not-delivered", code: "refused", reason: "not claimed" } : { status: "delivered", id: "mail" }) });
      }
    },
  };
  const local = vi.fn(), warn = vi.fn();
  return { delivery: createWakeDelivery({ events, local, warn }), local, warn, requests, listeners };
}
const message = { customType: "bellwether-herdr-watch", content: "original text", details: receipt };
test("matched wake mails strict record to self and never sends local message", async () => {
  const { delivery, requests, local } = setup();
  delivery.wake(toWakeRecord(receipt), message);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ to: "owner", kind: "data" });
  strict(requests[0]!.record as WakeRecord);
  expect(local).not.toHaveBeenCalled();
});
test.each(["absent", "offline"] as const)("%s self name gives one original local message", async (mode) => {
  vi.useFakeTimers();
  const { delivery, local, warn, requests } = setup(mode);
  delivery.wake(toWakeRecord(receipt), message);
  await vi.advanceTimersByTimeAsync(2000);
  expect(local).toHaveBeenCalledExactlyOnceWith(message);
  expect(warn).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});
test.each(["refused", "timeout"] as const)("%s mail falls back with warning", async (mode) => {
  vi.useFakeTimers();
  const { delivery, local, warn, listeners } = setup(mode);
  delivery.wake(toWakeRecord(receipt), message);
  await vi.advanceTimersByTimeAsync(0);
  if (mode === "timeout") {
    await vi.advanceTimersByTimeAsync(14999);
    expect(local).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(local).toHaveBeenCalledExactlyOnceWith(message);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`wake mail refused (${mode === "refused" ? "refused: not claimed" : "timeout:"}`));
  expect(listeners.get("ratking/send:result")?.size).toBe(0);
});
test("withdraw sends cancellation even while original mail is in flight", async () => {
  const { delivery, local, requests } = setup();
  delivery.wake(toWakeRecord(receipt), message);
  expect(delivery.withdraw(receipt.id)).toBe(true);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map((request) => request.record)).toEqual([
    expect.objectContaining({ watch: receipt.id, status: "matched" }),
    expect.objectContaining({ watch: receipt.id, status: "cancelled" }),
  ]);
  expect(local).not.toHaveBeenCalled();
  expect(delivery.withdraw(receipt.id)).toBe(false);
});
