import { describe, expect, test } from "vitest";

import {
  BELLWETHER_INTERCOM_NAMESPACE,
  createIntercomDirectory,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  INTERCOM_EXTENSION_REGISTRY_READY_EVENT,
  piSessionIdFromAgent,
} from "./intercom.ts";

class FakeEvents {
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  on(event: string, listener: (payload: unknown) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return () => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
    };
  }
}

interface Registration {
  readonly namespace: string;
  readonly ownerEligible: boolean;
  readonly onReady: (channel: FakeChannel) => void;
  readonly onEvent: (event: unknown) => void;
}

class FakeChannel {
  connected = true;
  supported = true;
  published = 0;
  sessions: unknown[] = [
    { id: "s-1", name: "reviewer", status: "idle", cwd: "/tmp", model: "m", pid: 1, startedAt: 0, lastActivity: 0 },
    { id: 7 },
  ];
  listSessions: () => Promise<unknown[]> = async () => this.sessions;

  snapshot() {
    return { connected: this.connected, supported: this.supported };
  }

  publish() {
    this.published += 1;
  }
}

function connect(events: FakeEvents, channel = new FakeChannel()) {
  const registration = events.emitted.find(
    (entry) => entry.event === INTERCOM_EXTENSION_REGISTER_EVENT,
  )?.payload as Registration | undefined;
  if (!registration) throw new Error("directory did not register");
  registration.onReady(channel);
  return { registration, channel };
}

describe("intercom directory", () => {
  test("registers a publish-free, non-owner namespace", () => {
    const events = new FakeEvents();
    createIntercomDirectory(events);
    const { registration, channel } = connect(events);
    expect(registration.namespace).toBe(BELLWETHER_INTERCOM_NAMESPACE);
    expect(registration.ownerEligible).toBe(false);

    registration.onEvent({ type: "connection", connected: true, supported: true });
    registration.onEvent({ type: "session_joined", session: { id: "peer" } });
    registration.onEvent({ type: "message", fromSessionId: "peer", payload: { kind: "wake_hint" } });
    expect(channel.published).toBe(0);
  });

  test("returns live sessions with only id, name, and status", async () => {
    const events = new FakeEvents();
    const directory = createIntercomDirectory(events);
    connect(events);
    await expect(directory.sessions()).resolves.toEqual([
      { id: "s-1", name: "reviewer", status: "idle" },
    ]);
  });

  test("returns undefined when absent, disconnected, failing, or slow", async () => {
    const absent = createIntercomDirectory(new FakeEvents());
    await expect(absent.sessions()).resolves.toBeUndefined();

    const events = new FakeEvents();
    const directory = createIntercomDirectory(events, 20);
    const { channel } = connect(events);
    channel.connected = false;
    await expect(directory.sessions()).resolves.toBeUndefined();

    channel.connected = true;
    channel.listSessions = async () => {
      throw new Error("broker gone");
    };
    await expect(directory.sessions()).resolves.toBeUndefined();

    channel.listSessions = () => new Promise(() => {});
    await expect(directory.sessions()).resolves.toBeUndefined();
  });

  test("registers again when pi-intercom announces its registry late", () => {
    const events = new FakeEvents();
    createIntercomDirectory(events);
    events.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, {});
    const registrations = events.emitted.filter(
      (entry) => entry.event === INTERCOM_EXTENSION_REGISTER_EVENT,
    );
    expect(registrations).toHaveLength(2);
  });

  test("dispose drops the channel", async () => {
    const events = new FakeEvents();
    const directory = createIntercomDirectory(events);
    connect(events);
    directory.dispose();
    await expect(directory.sessions()).resolves.toBeUndefined();
  });
});

describe("piSessionIdFromAgent", () => {
  test("reads the session id from Herdr's Pi session path", () => {
    expect(
      piSessionIdFromAgent({
        agent_session: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/Users/x/.pi/agent/sessions/--proj--/2026-09-23T16-54-07-523Z_01a0cf30-59a3-7224-8fe5-26bf174f82ad.jsonl",
        },
      }),
    ).toBe("01a0cf30-59a3-7224-8fe5-26bf174f82ad");
  });

  test("ignores other agents and malformed paths", () => {
    expect(piSessionIdFromAgent({})).toBeUndefined();
    expect(
      piSessionIdFromAgent({ agent_session: { agent: "claude", value: "/x/_01a0cf30-59a3-7224-8fe5-26bf174f82ad.jsonl" } }),
    ).toBeUndefined();
    expect(piSessionIdFromAgent({ agent_session: { agent: "pi", value: "/x/session.jsonl" } })).toBeUndefined();
  });
});
