/**
 * Read-only pi-intercom directory.
 *
 * Bellwether used to broadcast capability, binding, and watch hints on the
 * extension bus. Nothing consumed them, and recording them bloated session
 * files. Bellwether now publishes nothing. It registers one namespace only to
 * read pi-intercom's live session list, so `herdr_layout overview` can say
 * which intercom session runs in which Herdr pane.
 */

export const BELLWETHER_INTERCOM_NAMESPACE = "bellwether/directory/v1";
export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT =
  "intercom:extension-registry-ready";
export const INTERCOM_DIRECTORY_TIMEOUT_MS = 1_500;

interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): (() => void) | void;
}

export interface IntercomSession {
  readonly id: string;
  readonly name?: string;
  readonly status?: string;
}

interface IntercomChannel {
  snapshot(): { connected: boolean; supported: boolean };
  listSessions(): Promise<readonly unknown[]>;
}

export interface IntercomDirectory {
  /** Live peers, or undefined when pi-intercom is absent, disconnected, or slow. */
  readonly sessions: () => Promise<readonly IntercomSession[] | undefined>;
  readonly dispose: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSession(value: unknown): IntercomSession | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
  };
}

/**
 * Herdr records a Pi pane's session file as `agent_session.value`. Pi names the
 * file `<timestamp>_<session id>.jsonl`, and pi-intercom uses the same id.
 */
export function piSessionIdFromAgent(agent: Record<string, unknown>): string | undefined {
  const session = agent.agent_session;
  if (!isRecord(session) || session.agent !== "pi" || typeof session.value !== "string") {
    return undefined;
  }
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    session.value,
  )?.[1];
}

export function createIntercomDirectory(
  events: EventBus,
  timeoutMs = INTERCOM_DIRECTORY_TIMEOUT_MS,
): IntercomDirectory {
  let channel: IntercomChannel | undefined;
  let disposed = false;
  let registered = false;

  const register = () => {
    if (disposed || registered) return;
    events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: BELLWETHER_INTERCOM_NAMESPACE,
      ownerEligible: false,
      onReady(value: IntercomChannel) {
        if (disposed) return;
        channel = value;
        registered = true;
      },
      // Bellwether publishes nothing and ignores bus traffic.
      onEvent() {},
    });
  };

  const unsubscribe = events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, register);
  register();

  return {
    async sessions() {
      const current = channel;
      if (!current) return undefined;
      const snapshot = current.snapshot();
      if (!snapshot.connected || !snapshot.supported) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const listed = await Promise.race([
          current.listSessions(),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs);
          }),
        ]);
        if (!listed) return undefined;
        return listed.flatMap((value) => {
          const session = toSession(value);
          return session ? [session] : [];
        });
      } catch {
        return undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    dispose() {
      disposed = true;
      channel = undefined;
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}
