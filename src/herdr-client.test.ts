import { setTimeout as sleep } from "node:timers/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import {
  createHerdrClient,
  HerdrApiError,
  HerdrProtocolError,
  resolveHerdrSocketPath,
} from "./herdr-client.ts";
import {
  agentInfo,
  failure,
  paneInfo,
  startFakeHerdrServer,
  success,
  type FakeHerdrServer,
} from "./test-support.ts";

const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("Herdr Effect client", () => {
  test("resolves explicit, env, named, and default socket paths lazily", () => {
    expect(resolveHerdrSocketPath({ socketPath: "/explicit.sock" })).toBe(
      "/explicit.sock",
    );
    expect(
      resolveHerdrSocketPath({
        session: "work",
        home: "/home/test",
        env: { HERDR_SOCKET_PATH: "/ignored.sock" },
      }),
    ).toBe("/home/test/.config/herdr/sessions/work/herdr.sock");
    expect(
      resolveHerdrSocketPath({
        home: "/home/test",
        env: { HERDR_SOCKET_PATH: "/env.sock" },
      }),
    ).toBe("/env.sock");
    expect(
      resolveHerdrSocketPath({
        home: "/home/test",
        env: { HERDR_SESSION: "named" },
      }),
    ).toBe("/home/test/.config/herdr/sessions/named/herdr.sock");
    expect(resolveHerdrSocketPath({ home: "/home/test", env: {} })).toBe(
      "/home/test/.config/herdr/herdr.sock",
    );
  });

  test("writes one newline-delimited request and decodes one tagged response", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(success(request, { type: "pong", version: "0.7.5", protocol: 17 }));
    });
    servers.push(server);
    const client = createHerdrClient({
      socketPath: server.socketPath,
      requestId: () => "request-1",
    });

    const result = await Effect.runPromise(
      client.request({ method: "ping", params: {} }),
    );

    expect(result).toMatchObject({ type: "pong", protocol: 17 });
    expect(server.requestLines).toEqual([
      JSON.stringify({ id: "request-1", method: "ping", params: {} }),
    ]);
  });

  test("rejects unknown result tags, malformed nested fields, and wrong method tags", async () => {
    const cases = [
      {
        method: "agent.prompt" as const,
        result: { type: "not_a_herdr_result", agent: agentInfo() },
        message: "invalid Herdr result",
      },
      {
        method: "agent.prompt" as const,
        result: { type: "agent_prompted", agent: { pane_id: 7 } },
        message: "invalid Herdr result",
      },
      {
        method: "agent.prompt" as const,
        result: { type: "ok" },
        message: "disallowed result tag ok",
      },
    ];

    for (const testCase of cases) {
      const server = await startFakeHerdrServer((request, socket) => {
        socket.end(success(request, testCase.result));
      });
      servers.push(server);
      const client = createHerdrClient({ socketPath: server.socketPath });
      const outcome = await Effect.runPromise(
        client.request({ method: testCase.method, params: { target: "worker", text: "go" } }).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        ),
      );
      expect(outcome).toBeInstanceOf(HerdrProtocolError);
      expect(outcome?.message).toContain(testCase.message);
    }
  });

  test("uses Herdr error.code instead of parsing the message", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(failure(request, "agent_not_running", "words can change"));
    });
    servers.push(server);
    const client = createHerdrClient({ socketPath: server.socketPath });

    const outcome = await Effect.runPromise(
      client.request({ method: "agent.wait", params: { target: "worker" } }).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );

    expect(outcome).toBeInstanceOf(HerdrApiError);
    expect(outcome).toMatchObject({ code: "agent_not_running" });
  });

  test("interrupt closes the exact held socket", async () => {
    const server = await startFakeHerdrServer(() => {
      // Hold the request open until the client destroys this socket.
    });
    servers.push(server);
    const client = createHerdrClient({ socketPath: server.socketPath });
    const controller = new AbortController();
    const running = Effect.runPromise(
      client.request({ method: "agent.wait", params: { target: "worker" }, timeoutMs: null }),
      { signal: controller.signal },
    ).catch(() => undefined);

    while (server.requests.length === 0) await sleep(1);
    controller.abort();
    await running;
    const deadline = Date.now() + 1_000;
    while (server.closedConnections() === 0 && Date.now() < deadline) {
      await sleep(1);
    }

    expect(server.connections()).toBe(1);
    expect(server.closedConnections()).toBe(1);
  });

  test("isolates concurrent requests onto separate sockets", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(
        success(request, {
          type: "pane_info",
          pane: paneInfo({ pane_id: request.id }),
        }),
      );
    });
    servers.push(server);
    let sequence = 0;
    const client = createHerdrClient({
      socketPath: server.socketPath,
      requestId: () => `request-${++sequence}`,
    });

    const [first, second] = await Promise.all([
      Effect.runPromise(client.request({ method: "pane.get", params: { pane_id: "p1" } })),
      Effect.runPromise(client.request({ method: "pane.get", params: { pane_id: "p2" } })),
    ]);

    expect(server.connections()).toBe(2);
    expect(server.requests.map((request) => request.id).sort()).toEqual([
      "request-1",
      "request-2",
    ]);
    expect([first.type, second.type]).toEqual(["pane_info", "pane_info"]);
  });
});
