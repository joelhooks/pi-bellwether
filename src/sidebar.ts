import { Effect } from "effect";

import type { HerdrClient, HerdrRequest } from "./herdr-client.ts";
import type { WatchReceipt } from "./watch.ts";

/**
 * Herdr sidebar reporter.
 *
 * Herdr merges custom tokens from every source into one map per pane or
 * workspace: the last writer wins and any source's clear removes the token.
 * Bellwether publishes and clears only its own pane's `$wait`. Workspace
 * `$agents` comes from Muster, out of Rat King turn records (bellwether-yoink
 * S5); Bellwether no longer scrapes pane state for it.
 */
export const SIDEBAR_SOURCE = "user:bellwether.v1";
export const SIDEBAR_TTL_MS = 3 * 60_000;
export const SIDEBAR_REFRESH_MS = 60_000;
export const SIDEBAR_DEBOUNCE_MS = 250;
/** Herdr's widest sidebar is 36 columns; leave room for the row's own padding. */
export const SIDEBAR_TOKEN_MAX_CHARS = 32;
const SIDEBAR_REQUEST_TIMEOUT_MS = 1_500;


function clip(text: string, max = SIDEBAR_TOKEN_MAX_CHARS): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function age(startedAt: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "<1m";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

/** A human label beats the generated `agent_state <target>` form. */
function waitName(receipt: WatchReceipt): string {
  const generated =
    receipt.kind === "agent_state"
      ? `agent_state ${receipt.target ?? ""}`
      : `pane_output ${receipt.pane ?? ""}`;
  if (receipt.label && receipt.label !== generated) return receipt.label;
  return receipt.target ?? receipt.pane ?? receipt.label;
}

export function waitToken(watches: readonly WatchReceipt[], now: number): string | null {
  if (watches.length === 0) return null;
  const oldest = [...watches].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  )[0] as WatchReceipt;
  const when = age(oldest.startedAt, now);
  if (watches.length === 1) {
    const suffix = ` · ${when}`;
    return `⏳ ${clip(waitName(oldest), SIDEBAR_TOKEN_MAX_CHARS - 2 - suffix.length)}${suffix}`;
  }
  const prefix = `⏳ ${watches.length} waits · `;
  const suffix = ` +${watches.length - 1} · ${when}`;
  return `${prefix}${clip(waitName(oldest), SIDEBAR_TOKEN_MAX_CHARS - prefix.length - suffix.length)}${suffix}`;
}

export interface SidebarReporterOptions {
  readonly client: HerdrClient;
  /** The caller's own pane (`HERDR_PANE_ID`). Without it the reporter stays silent. */
  readonly paneId: string | undefined;
  readonly watches: () => readonly WatchReceipt[];
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly refreshMs?: number;
}

export interface SidebarReporter {
  /** Watch set changed; publish soon. */
  readonly changed: () => void;
  /** Stop timers and clear this pane's `$wait` if Bellwether set it. */
  readonly stop: () => Promise<void>;
}

export function createSidebarReporter(options: SidebarReporterOptions): SidebarReporter {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? SIDEBAR_DEBOUNCE_MS;
  const refreshMs = options.refreshMs ?? SIDEBAR_REFRESH_MS;
  let lastSeq = 0;
  let waitPublished = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const nextSeq = () => {
    lastSeq = Math.max(lastSeq + 1, now());
    return lastSeq;
  };

  const request = <M extends HerdrRequest["method"]>(
    method: M,
    params: Readonly<Record<string, unknown>>,
  ) =>
    Effect.runPromise(
      options.client.request({ method, params, timeoutMs: SIDEBAR_REQUEST_TIMEOUT_MS }),
    );

  const clearWait = async (paneId: string) => {
    if (!waitPublished) return;
    waitPublished = false;
    await request("pane.report_metadata", {
      pane_id: paneId,
      source: SIDEBAR_SOURCE,
      tokens: { wait: null },
      seq: nextSeq(),
    });
  };

  const publish = async () => {
    const paneId = options.paneId;
    if (!paneId) return;
    const active = options.watches();
    if (active.length === 0) {
      await clearWait(paneId);
      return;
    }
    // A moved pane gets a new workspace-qualified ID; the caller's inherited ID
    // still resolves, so read the current identity before reporting.
    const current = await request("pane.get", { pane_id: paneId });
    const pane = current.pane;
    await request("pane.report_metadata", {
      pane_id: pane.pane_id,
      source: SIDEBAR_SOURCE,
      tokens: { wait: waitToken(active, now()) },
      seq: nextSeq(),
      ttl_ms: SIDEBAR_TTL_MS,
    });
    waitPublished = true;
    schedule(refreshMs);
  };

  const run = () => {
    queue = queue
      .then(publish)
      .catch(() => {
        // The sidebar is display-only. The next change or lease refresh retries.
        if (!stopped && options.watches().length > 0) schedule(refreshMs);
      });
    return queue;
  };

  function schedule(delayMs: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
    timer.unref?.();
  }

  return {
    changed() {
      if (stopped || !options.paneId) return;
      schedule(debounceMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // Shutdown must stay bounded: give an in-flight publish one request
      // deadline, then clear. A late publish expires with its lease.
      await Promise.race([
        queue.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, SIDEBAR_REQUEST_TIMEOUT_MS).unref?.()),
      ]);
      const paneId = options.paneId;
      if (paneId) await clearWait(paneId).catch(() => {});
    },
  };
}
