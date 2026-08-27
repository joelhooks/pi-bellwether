import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

import { createHerdrClient } from "./herdr-client.ts";
import type { HerdrClient } from "./herdr-client.ts";
import {
  classifyWatchError,
  createWatchRegistry,
  MAX_ACTIVE_WATCHES,
  MAX_TERMINAL_WATCHES,
  MAX_WATCH_TIMEOUT_MS,
  type WatchReceipt,
} from "./watch.ts";
import { HerdrApiError } from "./herdr-client.ts";
import {
  agentInfo,
  failure,
  resultForMethod,
  startFakeHerdrServer,
  success,
  type FakeHerdrServer,
} from "./test-support.ts";

const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function registryFor(
  server: FakeHerdrServer,
  messages: unknown[] = [],
  lifecycle: Array<{ lifecycle: string; receipt: WatchReceipt }> = [],
) {
  return createWatchRegistry({
    client: createHerdrClient({ socketPath: server.socketPath }),
    sendMessage(message) {
      messages.push(message);
    },
    onLifecycle(kind, receipt) {
      lifecycle.push({ lifecycle: kind, receipt });
    },
  });
}

async function waitForTerminal(
  status: () => WatchReceipt,
  timeoutMs = 1_000,
): Promise<WatchReceipt> {
  const deadline = Date.now() + timeoutMs;
  let receipt = status();
  while (receipt.status === "running" && Date.now() < deadline) {
    await sleep(2);
    receipt = status();
  }
  return receipt;
}

describe("Herdr watch XState lifecycle", () => {
  test("moves starting to running and wakes exactly once on match", async () => {
    const server = await startFakeHerdrServer(async (request, socket) => {
      await sleep(10);
      socket.write(
        success(request, {
          type: "agent_info",
          agent: agentInfo({ agent_status: "done" }),
        }),
      );
      socket.write(
        success(request, {
          type: "agent_info",
          agent: agentInfo({ agent_status: "done" }),
        }),
      );
    });
    servers.push(server);
    const messages: unknown[] = [];
    const registry = registryFor(server, messages);

    const started = registry.start(
      { kind: "agent_state", target: "worker", wake: "agent" },
      { mode: "tui" },
    );
    expect(started.status).toBe("running");
    expect(started.phase).toBe("starting");

    while (server.requests.length === 0) await sleep(1);
    const running = registry.status(started.id);
    expect(running.status).toBe("running");
    expect(running.phase).toBe("running");

    const terminal = await waitForTerminal(() => registry.status(started.id));
    expect(terminal.status).toBe("matched");
    expect(messages).toHaveLength(1);
    expect(() => structuredClone(terminal)).not.toThrow();
    await registry.shutdown();
  });

  test("maps timeout and targetGone from server error.code", async () => {
    const outcomes = [
      ["timeout", "timedOut"],
      ["agent_not_running", "targetGone"],
      ["agent_not_found", "targetGone"],
    ] as const;

    for (const [code, expected] of outcomes) {
      const server = await startFakeHerdrServer((request, socket) => {
        socket.end(failure(request, code, "message text does not matter"));
      });
      servers.push(server);
      const registry = registryFor(server);
      const started = registry.start(
        { kind: "agent_state", target: "worker", wake: "silent" },
        { mode: "tui" },
      );
      const terminal = await waitForTerminal(() => registry.status(started.id));
      expect(terminal.status).toBe(expected);
      await registry.shutdown();
    }
  });

  test("classifies API codes without regexing messages", () => {
    expect(
      classifyWatchError(
        new HerdrApiError({
          operation: "agent.wait",
          code: "agent_not_running",
          message: "completely unrelated prose",
        }),
      ).kind,
    ).toBe("targetGone");
  });

  test("cancel closes its socket and never wakes", async () => {
    const server = await startFakeHerdrServer(() => {});
    servers.push(server);
    const messages: unknown[] = [];
    const registry = registryFor(server, messages);
    const started = registry.start(
      { kind: "pane_output", pane: "w1:p1", match: "DONE", wake: "agent" },
      { mode: "tui" },
    );
    while (server.requests.length === 0) await sleep(1);
    expect(server.requests[0]?.params).toMatchObject({
      source: "recent_unwrapped",
      match: { type: "substring", value: "DONE" },
    });

    const cancelled = registry.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    const deadline = Date.now() + 1_000;
    while (server.closedConnections() === 0 && Date.now() < deadline) {
      await sleep(1);
    }
    expect(server.closedConnections()).toBe(1);
    expect(messages).toHaveLength(0);
    await registry.shutdown();
  });

  test("shutdown closes every session-owned socket and suppresses wakes", async () => {
    const server = await startFakeHerdrServer(() => {});
    servers.push(server);
    const messages: unknown[] = [];
    const registry = registryFor(server, messages);
    registry.start(
      { kind: "agent_state", target: "a", wake: "agent" },
      { mode: "tui" },
    );
    registry.start(
      { kind: "pane_output", pane: "w1:p2", match: "DONE", wake: "agent" },
      { mode: "tui" },
    );
    while (server.requests.length < 2) await sleep(1);

    await registry.shutdown();
    const deadline = Date.now() + 1_000;
    while (server.closedConnections() < 2 && Date.now() < deadline) {
      await sleep(1);
    }

    expect(server.connections()).toBe(2);
    expect(server.closedConnections()).toBe(2);
    expect(messages).toHaveLength(0);
  });

  test("stops terminal actors and bounds retained receipt history", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(success(request, resultForMethod(request.method)));
    });
    servers.push(server);
    const registry = registryFor(server);

    for (let index = 0; index < MAX_TERMINAL_WATCHES + 36; index += 1) {
      const started = registry.start(
        { kind: "agent_state", target: `worker-${index}`, wake: "silent" },
        { mode: "tui" },
      );
      const terminal = await waitForTerminal(() => registry.status(started.id));
      expect(terminal.status).toBe("matched");
    }

    expect(registry.list()).toHaveLength(MAX_TERMINAL_WATCHES);
    expect(registry.stats()).toEqual({
      active: 0,
      retained: MAX_TERMINAL_WATCHES,
      subscriptions: 0,
    });
    await registry.shutdown();
  });

  test("preserves actor-level error diagnostics", async () => {
    const client: HerdrClient = {
      request() {
        throw new Error("actor exploded before Effect startup");
      },
      socketPath: () => "/unused.sock",
    };
    const registry = createWatchRegistry({
      client,
      sendMessage() {},
    });
    const started = registry.start(
      { kind: "agent_state", target: "worker", wake: "silent" },
      { mode: "tui" },
    );
    const terminal = await waitForTerminal(() => registry.status(started.id));

    expect(terminal.status).toBe("failed");
    expect(terminal.failure).toBe("actor exploded before Effect startup");
    expect(registry.stats().subscriptions).toBe(0);
    await registry.shutdown();
  });

  test("rejects watch timeouts above the safe Node timer limit", async () => {
    const server = await startFakeHerdrServer(() => {});
    servers.push(server);
    const registry = registryFor(server);
    expect(() =>
      registry.start(
        {
          kind: "agent_state",
          target: "worker",
          timeoutMs: MAX_WATCH_TIMEOUT_MS + 1,
          wake: "silent",
        },
        { mode: "tui" },
      ),
    ).toThrow(`at most ${MAX_WATCH_TIMEOUT_MS}ms`);
    await registry.shutdown();
  });

  test("enforces the active watch cap", async () => {
    const server = await startFakeHerdrServer(() => {});
    servers.push(server);
    const registry = registryFor(server);
    for (let index = 0; index < MAX_ACTIVE_WATCHES; index += 1) {
      registry.start(
        { kind: "agent_state", target: `worker-${index}`, wake: "silent" },
        { mode: "tui" },
      );
    }
    expect(() =>
      registry.start(
        { kind: "agent_state", target: "one-too-many", wake: "silent" },
        { mode: "tui" },
      ),
    ).toThrow(`at most ${MAX_ACTIVE_WATCHES}`);
    await registry.shutdown();
  });
});
