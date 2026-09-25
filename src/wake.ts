/**
 * Routes Bellwether wakes into Pi.
 *
 * A worker fleet settles in bursts, and each settled wait used to start its own
 * agent turn. The router holds wakes while the agent is busy and releases them
 * as one follow-up shortly after it goes idle. The owner then reads every
 * settled receipt in a single turn.
 *
 * Delivery goes through pi-until's session-wide follow-up arbiter when that
 * extension accepts the request synchronously. pi-until then serializes
 * Bellwether wakes with its own recurring and terminal follow-ups. Without
 * pi-until, or while it shuts down, Bellwether sends the follow-up directly.
 */

export const PI_UNTIL_FOLLOW_UP_EVENT = "pi-until:follow-up";
export const BELLWETHER_WAKES_CUSTOM_TYPE = "bellwether-wakes";
/** Short enough to feel immediate, long enough to merge a burst. */
export const WAKE_SETTLE_MS = 250;
/** Bounds the damage of a missed `agent_end`: a held wake is late, never lost. */
export const WAKE_MAX_HOLD_MS = 5 * 60_000;

export interface WakeMessage {
  readonly customType: string;
  readonly content: string;
  readonly details: unknown;
  /** Lets the owner withdraw a held wake, e.g. the watch id. Never sent to Pi. */
  readonly key?: string;
}

/** Version 1 request accepted by pi-until's follow-up arbiter. */
export interface PiUntilFollowUpRequest {
  readonly version: 1;
  readonly source: string;
  readonly id: string;
  readonly customType: string;
  readonly content: string;
  readonly details: unknown;
  readonly accept: () => void;
}

export interface WakeRouterOptions {
  readonly events: { emit(event: string, payload: unknown): void };
  readonly sendMessage: (
    message: WakeMessage & { readonly display: true },
    options: { deliverAs: "followUp"; triggerTurn: true },
  ) => void;
  readonly isBusy: () => boolean;
  readonly settleMs?: number;
  readonly maxHoldMs?: number;
  readonly createId: () => string;
}

export interface WakeRouter {
  /** Queue one wake. Delivery waits for the agent to be idle. */
  readonly wake: (message: WakeMessage) => void;
  /** The agent finished a run; release held wakes after the settle window. */
  readonly idle: () => void;
  /**
   * Deliver everything held now. `direct` skips pi-until, whose queue may be
   * stopping during the same session shutdown and would drop the request.
   */
  readonly flush: (mode?: { readonly direct?: boolean }) => void;
  /** Drop one held wake by key. True when a wake was dropped. */
  readonly withdraw: (key: string) => boolean;
  /** Drop timers and held wakes without delivering. */
  readonly dispose: () => void;
}

function combine(messages: readonly WakeMessage[]): WakeMessage {
  if (messages.length === 1) {
    const { key: _key, ...message } = messages[0] as WakeMessage;
    return message;
  }
  return {
    customType: BELLWETHER_WAKES_CUSTOM_TYPE,
    content: [
      `${messages.length} Bellwether waits settled. Inspect each receipt before continuing.`,
      ...messages.map((message) => message.content),
    ].join("\n\n---\n\n"),
    details: {
      wakes: messages.map((message) => ({
        customType: message.customType,
        details: message.details,
      })),
    },
  };
}

export function createWakeRouter(options: WakeRouterOptions): WakeRouter {
  const settleMs = options.settleMs ?? WAKE_SETTLE_MS;
  const maxHoldMs = options.maxHoldMs ?? WAKE_MAX_HOLD_MS;
  let pending: WakeMessage[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    if (settleTimer) clearTimeout(settleTimer);
    if (holdTimer) clearTimeout(holdTimer);
    settleTimer = undefined;
    holdTimer = undefined;
  };

  /** True when pi-until synchronously accepted the request into its arbiter. */
  const offerToPiUntil = (message: WakeMessage): boolean => {
    let accepted = false;
    try {
      options.events.emit(PI_UNTIL_FOLLOW_UP_EVENT, {
        version: 1,
        source: "bellwether",
        id: options.createId(),
        customType: message.customType,
        content: message.content,
        details: message.details,
        accept: () => {
          accepted = true;
        },
      } satisfies PiUntilFollowUpRequest);
    } catch {
      // A listener failure is not acceptance.
    }
    return accepted;
  };

  const deliver = (message: WakeMessage, direct: boolean) => {
    if (!direct && offerToPiUntil(message)) return;
    options.sendMessage(
      { ...message, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flush = (mode?: { readonly direct?: boolean }) => {
    clearTimers();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    deliver(combine(batch), mode?.direct === true);
  };

  const scheduleSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (!options.isBusy()) flush();
    }, settleMs);
    // Timers are unref'd: a held wake must not keep a finishing process alive.
    settleTimer.unref?.();
  };

  return {
    wake(message) {
      pending.push(message);
      if (!holdTimer) {
        holdTimer = setTimeout(() => flush(), maxHoldMs);
        holdTimer.unref?.();
      }
      if (!options.isBusy()) scheduleSettle();
    },
    idle() {
      if (pending.length > 0) scheduleSettle();
    },
    flush,
    withdraw(key) {
      const before = pending.length;
      pending = pending.filter((message) => message.key !== key);
      if (pending.length === before) return false;
      if (pending.length === 0) clearTimers();
      return true;
    },
    dispose() {
      clearTimers();
      pending = [];
    },
  };
}
