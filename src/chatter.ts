import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Bellwether versions before 994c545 appended one `bellwether-intercom-signal`
 * entry for every intercom presence announcement from every peer. A session
 * that stayed open for days accumulated hundreds of thousands of them, which
 * kept the whole branch in memory and pinned the process at full CPU on GC.
 * The fix stopped new chatter; this module finds the old chatter so a session
 * can be told about it and cleaned.
 */
export const INTERCOM_SIGNAL_ENTRY_TYPE = "bellwether-intercom-signal";
export const PRESENCE_SIGNAL_KINDS: ReadonlySet<string> = new Set(["capability", "binding"]);
/** Below this many entries the cost is noise; above it the warning is worth a line. */
export const PRESENCE_CHATTER_WARN_THRESHOLD = 1_000;

export const isPresenceChatter = (entry: SessionEntry): boolean => {
  if (entry.type !== "custom" || entry.customType !== INTERCOM_SIGNAL_ENTRY_TYPE) return false;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return false;
  const kind = (data as { kind?: unknown }).kind;
  return typeof kind === "string" && PRESENCE_SIGNAL_KINDS.has(kind);
};

export const countPresenceChatter = (entries: readonly SessionEntry[]): number => {
  let count = 0;
  for (const entry of entries) if (isPresenceChatter(entry)) count += 1;
  return count;
};

/** The one-line warning shown on startup, or `undefined` when the branch is clean enough. */
export const presenceChatterWarning = (
  count: number,
  options: { readonly scriptPath: string; readonly sessionFile?: string },
): string | undefined => {
  if (count < PRESENCE_CHATTER_WARN_THRESHOLD) return undefined;
  const target = options.sessionFile ?? "<session.jsonl>";
  return (
    `Bellwether: this session carries ${count.toLocaleString("en-US")} pre-fix intercom presence entries, `
    + "which slows every branch walk and GC pass. Quit Pi, then run "
    + `node ${options.scriptPath} ${target} --apply and resume the session.`
  );
};
