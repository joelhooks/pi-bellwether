import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BELLWETHER_WAKES_CUSTOM_TYPE,
  createWakeRouter,
  PI_UNTIL_FOLLOW_UP_EVENT,
  type WakeMessage,
} from "./wake.ts";

afterEach(() => {
  vi.useRealTimers();
});

function message(id: string): WakeMessage {
  return {
    customType: "bellwether-herdr-watch",
    content: `watch ${id} matched`,
    details: { id },
  };
}

function setup(options: { busy?: boolean; accept?: boolean } = {}) {
  vi.useFakeTimers();
  let busy = options.busy ?? false;
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const router = createWakeRouter({
    events: {
      emit(event, payload) {
        const record = payload as Record<string, unknown>;
        emitted.push({ event, payload: record });
        if (options.accept) (record.accept as () => void)();
      },
    },
    sendMessage(sentMessage, sendOptions) {
      sent.push({ message: sentMessage, options: sendOptions });
    },
    isBusy: () => busy,
    settleMs: 100,
    maxHoldMs: 10_000,
    createId: () => "wake-1",
  });
  return {
    router,
    sent,
    emitted,
    setBusy(value: boolean) {
      busy = value;
    },
  };
}

describe("wake router", () => {
  test("delivers a single wake unchanged after a short settle window", () => {
    const { router, sent } = setup();
    router.wake(message("a"));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([
      {
        message: { ...message("a"), display: true },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);
  });

  test("coalesces wakes that settle together into one follow-up", () => {
    const { router, sent } = setup();
    router.wake(message("a"));
    vi.advanceTimersByTime(50);
    router.wake(message("b"));
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    const combined = sent[0]?.message as { customType: string; content: string; details: unknown };
    expect(combined.customType).toBe(BELLWETHER_WAKES_CUSTOM_TYPE);
    expect(combined.content).toContain("2 Bellwether waits settled");
    expect(combined.content).toContain("watch a matched");
    expect(combined.content).toContain("watch b matched");
    expect(combined.details).toEqual({
      wakes: [
        { customType: "bellwether-herdr-watch", details: { id: "a" } },
        { customType: "bellwether-herdr-watch", details: { id: "b" } },
      ],
    });
  });

  test("holds wakes while the agent is busy and sends one batch when it goes idle", () => {
    const { router, sent, setBusy } = setup({ busy: true });
    router.wake(message("a"));
    vi.advanceTimersByTime(5_000);
    router.wake(message("b"));
    router.wake(message("c"));
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(0);

    setBusy(false);
    router.idle();
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.message as { content: string }).content).toContain("3 Bellwether waits settled");
  });

  test("a missed idle signal delays a held wake but never loses it", () => {
    const { router, sent } = setup({ busy: true });
    router.wake(message("a"));
    vi.advanceTimersByTime(9_999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  test("routes through pi-until when its arbiter accepts", () => {
    const { router, sent, emitted } = setup({ accept: true });
    router.wake(message("a"));
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe(PI_UNTIL_FOLLOW_UP_EVENT);
    expect(emitted[0]?.payload).toMatchObject({
      version: 1,
      source: "bellwether",
      id: "wake-1",
      customType: "bellwether-herdr-watch",
      content: "watch a matched",
      details: { id: "a" },
    });
  });

  test("falls back to a direct follow-up when nothing accepts", () => {
    const { router, sent, emitted } = setup({ accept: false });
    router.wake(message("a"));
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("withdraw drops a held wake by key and leaves the rest", () => {
    const { router, sent } = setup({ busy: true });
    router.wake({ ...message("a"), key: "a" });
    router.wake({ ...message("b"), key: "b" });
    expect(router.withdraw("a")).toBe(true);
    expect(router.withdraw("missing")).toBe(false);
    router.flush();
    expect(sent).toHaveLength(1);
    expect((sent[0]?.message as { content: string }).content).toBe("watch b matched");
  });

  test("withdrawing the last held wake sends nothing", () => {
    const { router, sent } = setup({ busy: true });
    router.wake({ ...message("a"), key: "a" });
    router.withdraw("a");
    router.flush();
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(0);
  });

  test("a direct flush bypasses pi-until during shutdown", () => {
    const { router, sent, emitted } = setup({ accept: true, busy: true });
    router.wake(message("a"));
    router.flush({ direct: true });
    expect(emitted).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  test("flush delivers held wakes at once; dispose drops the timer only", () => {
    const { router, sent } = setup({ busy: true });
    router.wake(message("a"));
    router.flush();
    expect(sent).toHaveLength(1);
    router.flush();
    expect(sent).toHaveLength(1);

    router.wake(message("b"));
    router.dispose();
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(1);
  });
});
