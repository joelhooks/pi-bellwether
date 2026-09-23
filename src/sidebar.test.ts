import { afterEach, describe, expect, test, vi } from "vitest";

import { createHerdrClient } from "./herdr-client.ts";
import {
  agentsToken,
  createSidebarReporter,
  needsToken,
  SIDEBAR_SOURCE,
  waitToken,
} from "./sidebar.ts";
import {
  agentInfo,
  paneInfo,
  resultForMethod,
  startFakeHerdrServer,
  success,
  type FakeHerdrServer,
} from "./test-support.ts";
import type { WatchReceipt } from "./watch.ts";

const servers: FakeHerdrServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const NOW = Date.parse("2026-09-23T12:00:00.000Z");

function receipt(overrides: Partial<WatchReceipt> = {}): WatchReceipt {
  return {
    id: "a1",
    kind: "agent_state",
    label: "agent_state reviewer",
    status: "running",
    phase: "running",
    startedAt: new Date(NOW - 4 * 60_000).toISOString(),
    wake: "agent",
    target: "reviewer",
    ...overrides,
  };
}

describe("sidebar tokens", () => {
  test("waitToken is null when nothing is watched", () => {
    expect(waitToken([], NOW)).toBeNull();
  });

  test("one watch shows its target and age", () => {
    expect(waitToken([receipt()], NOW)).toBe("⏳ reviewer · 4m");
  });

  test("custom labels win over default labels", () => {
    expect(
      waitToken(
        [
          receipt({ label: "tests green", kind: "pane_output", target: undefined, pane: "w1:p2" }),
        ],
        NOW,
      ),
    ).toBe("⏳ tests green · 4m");
    expect(
      waitToken(
        [receipt({ label: "pane_output w1:p2", kind: "pane_output", target: undefined, pane: "w1:p2" })],
        NOW,
      ),
    ).toBe("⏳ w1:p2 · 4m");
  });

  test("several watches name the oldest and count the rest", () => {
    const token = waitToken(
      [
        receipt({ id: "a", target: "tests", label: "agent_state tests", startedAt: new Date(NOW - 60_000).toISOString() }),
        receipt({ id: "b", target: "reviewer", startedAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
        receipt({ id: "c", target: "docs", label: "agent_state docs" }),
      ],
      NOW,
    );
    expect(token).toBe("⏳ 3 waits · reviewer +2 · 2h");
  });

  test("gated watches say they wait on a prompt", () => {
    expect(waitToken([receipt({ phase: "gated" })], NOW)).toBe("⏳ reviewer · prompt…");
  });

  test("tokens stay short enough for the sidebar", () => {
    const token = waitToken(
      [receipt({ label: "a very long custom label that goes on and on forever", kind: "pane_output" })],
      NOW,
    );
    expect(token).not.toBeNull();
    expect([...(token ?? "")].length).toBeLessThanOrEqual(32);
    expect(token).toContain("…");
  });

  test("agentsToken counts other agents by state and drops trailing counts that do not fit", () => {
    const agents = [
      agentInfo({ pane_id: "w1:p1", agent_status: "working" }),
      agentInfo({ pane_id: "w1:p2", agent_status: "working" }),
      agentInfo({ pane_id: "w1:p3", agent_status: "blocked" }),
      agentInfo({ pane_id: "w1:p4", agent_status: "idle" }),
      agentInfo({ pane_id: "w1:p5", agent_status: "done" }),
    ];
    expect(agentsToken(agents, "w1:p1")).toBe("1 working · 1 blocked · 1 done");
    expect(agentsToken(agents.slice(2), "w1:p1")).toBe("1 blocked · 1 done · 1 idle");
    expect(agentsToken([agentInfo({ pane_id: "w1:p1" })], "w1:p1")).toBeNull();
  });

  test("needsToken names blocked agents and clears when none are blocked", () => {
    expect(
      needsToken(
        [
          agentInfo({ pane_id: "w1:p2", name: "reviewer", agent_status: "blocked" }),
          agentInfo({ pane_id: "w1:p3", name: "tests", agent_status: "blocked" }),
          agentInfo({ pane_id: "w1:p4", name: "docs", agent_status: "working" }),
        ],
        "w1:p1",
      ),
    ).toBe("⛔ reviewer, tests");
    expect(needsToken([agentInfo({ agent_status: "working" })], "w1:p9")).toBeNull();
  });
});

describe("sidebar reporter", () => {
  async function server() {
    const fake = await startFakeHerdrServer((request, socket) => {
      if (request.method === "pane.get") {
        socket.end(success(request, { type: "pane_info", pane: paneInfo({ pane_id: "w1:p1" }) }));
        return;
      }
      if (request.method === "agent.list") {
        socket.end(
          success(request, {
            type: "agent_list",
            agents: [
              agentInfo({ pane_id: "w1:p1", agent_status: "working" }),
              agentInfo({ pane_id: "w1:p2", name: "reviewer", agent_status: "blocked" }),
              agentInfo({ pane_id: "w2:p1", workspace_id: "w2", agent_status: "working" }),
            ],
          }),
        );
        return;
      }
      socket.end(success(request, resultForMethod(request.method)));
    });
    servers.push(fake);
    return fake;
  }

  test("makes no request without a pane or without active watches", async () => {
    const fake = await server();
    const client = createHerdrClient({ socketPath: fake.socketPath });
    const noPane = createSidebarReporter({ client, paneId: undefined, watches: () => [receipt()], debounceMs: 1 });
    noPane.changed();
    const idle = createSidebarReporter({ client, paneId: "w1:p1", watches: () => [], debounceMs: 1 });
    idle.changed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await noPane.stop();
    await idle.stop();
    expect(fake.requests).toHaveLength(0);
  });

  test("publishes pane wait and workspace agents/needs with a lease", async () => {
    const fake = await server();
    let active = [receipt()];
    const reporter = createSidebarReporter({
      client: createHerdrClient({ socketPath: fake.socketPath }),
      paneId: "w1:p1",
      watches: () => active,
      now: () => NOW,
      debounceMs: 1,
    });
    reporter.changed();
    await vi.waitFor(() =>
      expect(fake.requests.map((request) => request.method)).toContain("workspace.report_metadata"),
    );

    const pane = fake.requests.find((request) => request.method === "pane.report_metadata");
    expect(pane?.params).toMatchObject({
      pane_id: "w1:p1",
      source: SIDEBAR_SOURCE,
      tokens: { wait: "⏳ reviewer · 4m" },
      ttl_ms: expect.any(Number),
      seq: expect.any(Number),
    });
    const workspace = fake.requests.find((request) => request.method === "workspace.report_metadata");
    expect(workspace?.params).toMatchObject({
      workspace_id: "w1",
      source: SIDEBAR_SOURCE,
      tokens: { agents: "1 blocked", needs: "⛔ reviewer" },
      ttl_ms: expect.any(Number),
    });

    const before = fake.requests.length;
    active = [];
    reporter.changed();
    await vi.waitFor(() => expect(fake.requests.length).toBe(before + 1));
    expect(fake.requests.at(-1)).toMatchObject({
      method: "pane.report_metadata",
      params: { pane_id: "w1:p1", tokens: { wait: null } },
    });
    await reporter.stop();
    expect(fake.requests.length).toBe(before + 1);
  });

  test("sequence numbers increase across publishes", async () => {
    const fake = await server();
    const reporter = createSidebarReporter({
      client: createHerdrClient({ socketPath: fake.socketPath }),
      paneId: "w1:p1",
      watches: () => [receipt()],
      now: () => NOW,
      debounceMs: 1,
    });
    reporter.changed();
    await vi.waitFor(() =>
      expect(fake.requests.filter((request) => request.method === "pane.report_metadata")).toHaveLength(1),
    );
    reporter.changed();
    await vi.waitFor(() =>
      expect(fake.requests.filter((request) => request.method === "pane.report_metadata")).toHaveLength(2),
    );
    const seqs = fake.requests
      .filter((request) => request.method.endsWith("report_metadata"))
      .map((request) => request.params.seq as number);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1] ?? 0);
    }
    await reporter.stop();
  });

  test("stop clears a published wait token once", async () => {
    const fake = await server();
    const reporter = createSidebarReporter({
      client: createHerdrClient({ socketPath: fake.socketPath }),
      paneId: "w1:p1",
      watches: () => [receipt()],
      now: () => NOW,
      debounceMs: 1,
    });
    reporter.changed();
    await vi.waitFor(() =>
      expect(fake.requests.map((request) => request.method)).toContain("workspace.report_metadata"),
    );
    await reporter.stop();
    expect(fake.requests.at(-1)).toMatchObject({
      method: "pane.report_metadata",
      params: { tokens: { wait: null } },
    });
    const count = fake.requests.length;
    reporter.changed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.requests.length).toBe(count);
  });
});
