import { describe, expect, test } from "vitest";

import {
  BELLWETHER_INTERCOM_NAMESPACE,
  createIntercomCoordination,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  type BellwetherSignal,
  type BellwetherWakeHint,
} from "./intercom.ts";
import type { WatchReceipt } from "./watch.ts";

class FakeEvents {
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();

  emit(event: string, payload: unknown) {
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
  readonly namespace = BELLWETHER_INTERCOM_NAMESPACE;
  connected = true;
  supported = true;
  readonly published: unknown[] = [];

  snapshot() {
    return { connected: this.connected, supported: this.supported };
  }

  publish(payload: unknown, options?: unknown) {
    this.published.push({ payload, options });
  }
}

function payloads(channel: FakeChannel): BellwetherSignal[] {
  return channel.published.map(
    (entry) => (entry as { payload: BellwetherSignal }).payload,
  );
}

function watchReceipt(): WatchReceipt {
  return {
    id: "watch-1",
    kind: "agent_state",
    label: "worker",
    status: "running",
    phase: "running",
    startedAt: new Date(0).toISOString(),
    wake: "agent",
    target: "worker",
  };
}

function setup(options: {
  activeWatches?: () => readonly WatchReceipt[];
  wake?: (signal: BellwetherWakeHint) => void;
  onSignal?: (signal: BellwetherSignal) => void;
  createEventId?: () => string;
} = {}) {
  const events = new FakeEvents();
  let registration: Registration | undefined;
  events.on(INTERCOM_EXTENSION_REGISTER_EVENT, (payload) => {
    registration = payload as Registration;
  });
  const adapter = createIntercomCoordination({
    events,
    sessionId: "session-a",
    paneId: "w1:p1",
    activeWatches: options.activeWatches ?? (() => []),
    wake: options.wake ?? (() => undefined),
    onSignal: options.onSignal,
    createEventId: options.createEventId,
  });
  return { adapter, events, get registration() { return registration; } };
}

describe("optional pi-intercom extension-bus adapter", () => {
  test("falls back cleanly when intercom is absent", () => {
    const events = new FakeEvents();
    const adapter = createIntercomCoordination({
      events,
      sessionId: "session-a",
      activeWatches: () => [],
      wake: () => undefined,
    });

    expect(adapter.snapshot()).toEqual({ connected: false, supported: false });
    expect(() => adapter.announce()).not.toThrow();
    adapter.dispose();
  });

  test("registers the real extension-bus strings, ownerEligible false, and path-free hints", () => {
    let sequence = 0;
    const setupResult = setup({ createEventId: () => `event-${++sequence}` });
    const channel = new FakeChannel();
    setupResult.registration?.onReady(channel);

    expect(INTERCOM_EXTENSION_REGISTER_EVENT).toBe("intercom:extension-register");
    expect(setupResult.registration).toMatchObject({
      namespace: "bellwether/herdr/v1",
      ownerEligible: false,
    });
    expect(payloads(channel)).toEqual([
      expect.objectContaining({ kind: "capability", protocol: 1 }),
      expect.objectContaining({ kind: "binding", paneId: "w1:p1" }),
    ]);
    expect(channel.published.every((entry) =>
      JSON.stringify(entry).includes('"audience":"capable"'),
    )).toBe(true);
    const wire = JSON.stringify(channel.published);
    expect(wire).not.toContain("prompt");
    expect(wire).not.toContain("output");
    expect(wire).not.toContain("transcript");
    expect(wire).not.toContain("socketPath");
    setupResult.adapter.dispose();
  });

  test("publishes targeted wake and workflow receipt hints without conversational data", () => {
    let sequence = 0;
    const setupResult = setup({ createEventId: () => `event-${++sequence}` });
    const channel = new FakeChannel();
    setupResult.registration?.onReady(channel);
    channel.published.splice(0);

    setupResult.adapter.publishWake({
      targetSessionId: "session-b",
      targetPaneId: "w2:p1",
      watchId: "watch-1",
    });
    setupResult.adapter.publishWorkflowReceipt({
      targetSessionId: "session-b",
      workflowId: "wf_1",
      itemId: "item_1",
      generation: 2,
      sequence: 44,
    });

    expect(payloads(channel)).toEqual([
      expect.objectContaining({
        kind: "wake_hint",
        targetSessionId: "session-b",
        targetPaneId: "w2:p1",
        watchId: "watch-1",
      }),
      expect.objectContaining({
        kind: "workflow_receipt",
        workflowId: "wf_1",
        itemId: "item_1",
        generation: 2,
        sequence: 44,
      }),
    ]);
    expect(JSON.stringify(channel.published)).not.toMatch(/prompt|output|transcript/);
    expect(() => setupResult.adapter.publishWake({})).toThrow("requires a target");
    setupResult.adapter.dispose();
  });

  test("wakes exactly once and rejects wrong-target, self, duplicate, and forged envelopes", () => {
    const received: BellwetherSignal[] = [];
    const wakes: BellwetherWakeHint[] = [];
    const setupResult = setup({
      wake: (signal) => wakes.push(signal),
      onSignal: (signal) => received.push(signal),
    });
    setupResult.registration?.onReady(new FakeChannel());

    const signal: BellwetherWakeHint = {
      version: 1,
      eventId: "hint-1",
      sourceSessionId: "session-b",
      targetSessionId: "session-a",
      targetPaneId: "w1:p1",
      kind: "wake_hint",
      watchId: "watch-1",
    };
    const deliver = (payload: BellwetherSignal, fromSessionId = "session-b") =>
      setupResult.registration?.onEvent({
        type: "message",
        fromSessionId,
        payload,
      });

    deliver(signal);
    deliver(signal);
    deliver({ ...signal, eventId: "hint-2", targetSessionId: "someone-else" });
    deliver({ ...signal, eventId: "hint-3", sourceSessionId: "session-a" }, "session-a");
    deliver({ ...signal, eventId: "hint-4" }, "forged-session");

    expect(wakes).toEqual([signal]);
    expect(received).toEqual([signal]);
    setupResult.adapter.dispose();
  });

  test("reconciles binding and active watches on join, presence, leave, and reconnect", () => {
    let sequence = 0;
    const setupResult = setup({
      activeWatches: () => [watchReceipt()],
      createEventId: () => `event-${++sequence}`,
    });
    const channel = new FakeChannel();
    setupResult.registration?.onReady(channel);
    channel.published.splice(0);

    setupResult.registration?.onEvent({
      type: "session_joined",
      session: { id: "session-b", name: "worker" },
    });
    setupResult.registration?.onEvent({
      type: "presence_update",
      session: { id: "session-c", status: "idle" },
    });
    setupResult.registration?.onEvent({ type: "session_left", sessionId: "session-b" });
    setupResult.registration?.onEvent({
      type: "connection",
      connected: true,
      supported: true,
    });

    const signals = payloads(channel);
    for (const target of ["session-b", "session-c"]) {
      expect(signals).toContainEqual(
        expect.objectContaining({ kind: "binding", targetSessionId: target }),
      );
      expect(signals).toContainEqual(
        expect.objectContaining({
          kind: "watch",
          lifecycle: "reconciled",
          targetSessionId: target,
        }),
      );
    }
    expect(signals.filter((signal) => signal.kind === "watch")).toHaveLength(4);
    setupResult.adapter.dispose();

    const before = channel.published.length;
    setupResult.registration?.onEvent({
      type: "connection",
      connected: true,
      supported: true,
    });
    expect(channel.published).toHaveLength(before);
  });
});
