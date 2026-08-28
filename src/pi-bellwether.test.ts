import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import bellwetherExtension, {
  agentPromptClientTimeoutMs,
  agentStartClientTimeoutMs,
  remainingPromptProofTimeoutMs,
  renderWatchLivenessWidget,
} from "../extensions/pi-bellwether.ts";
import type { WatchReceipt } from "./watch.ts";
import {
  agentInfo,
  failure,
  paneInfo,
  resultForMethod,
  startFakeHerdrServer,
  success,
  type FakeHerdrServer,
} from "./test-support.ts";

const temporaryDirectories: string[] = [];
const servers: FakeHerdrServer[] = [];
const originalWaiterBinary = process.env.HERDR_PING_WAIT_BIN;
const originalSocketPath = process.env.HERDR_SOCKET_PATH;
const originalPaneId = process.env.HERDR_PANE_ID;

afterEach(async () => {
  if (originalWaiterBinary === undefined) delete process.env.HERDR_PING_WAIT_BIN;
  else process.env.HERDR_PING_WAIT_BIN = originalWaiterBinary;
  if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = originalSocketPath;
  if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = originalPaneId;
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

interface TestTool {
  readonly name: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly text: string }[];
    readonly details?: unknown;
  }>;
}

class EventBus {
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
    return () => undefined;
  }
}

function harness() {
  const tools = new Map<string, TestTool>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: unknown[] = [];
  const entries: unknown[] = [];
  const events = new EventBus();
  const apiDouble = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    events,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool(tool: TestTool) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  };
  // SAFETY: the extension factory only uses the methods supplied by this test double.
  bellwetherExtension(apiDouble as unknown as ExtensionAPI);
  return { tools, handlers, messages, entries, events };
}

function context() {
  return {
    mode: "tui",
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      notify() {},
      editor: async () => undefined,
      confirm: async () => true,
      setWidget() {},
    },
  };
}

async function waiterExecutable(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-bellwether-extension-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "waiter.js");
  await writeFile(
    path,
    `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "turn_ended", pane_id: "w1:p1" }) + "\\n");
}, 250);
`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

describe("Bellwether watch liveness widget", () => {
  const theme = {
    bold: (text: string) => text,
    fg: (_color: "accent" | "dim" | "muted", text: string) => text,
  };

  test("renders active watches with a moving frame, phase, target, and age", () => {
    const watches: WatchReceipt[] = [
      {
        id: "watch-1",
        kind: "agent_state",
        label: "security review",
        status: "running",
        phase: "running",
        startedAt: "2026-08-28T00:00:00.000Z",
        wake: "agent",
        target: "attestation_security",
      },
      {
        id: "watch-2",
        kind: "pane_output",
        label: "scratch smoke",
        status: "running",
        phase: "starting",
        startedAt: "2026-08-28T00:01:30.000Z",
        wake: "silent",
        pane: "w6N:p1",
      },
    ];

    expect(
      renderWatchLivenessWidget(
        watches,
        Date.parse("2026-08-28T00:02:00.000Z"),
        1,
        100,
        theme,
      ),
    ).toEqual([
      "⠙ Bellwether waiting · 2 watches · oldest 2m",
      "  watching security review · attestation_security · 2m",
      "  connecting scratch smoke · w6N:p1 · 30s",
    ]);
  });

  test("caps detail rows and never exceeds the terminal width", () => {
    const watches: WatchReceipt[] = Array.from({ length: 5 }, (_, index) => ({
      id: `watch-${index}`,
      kind: "agent_state",
      label: `long worker label ${index} that must truncate safely`,
      status: "running",
      phase: "running",
      startedAt: "2026-08-28T00:00:00.000Z",
      wake: "agent",
      target: `worker-${index}`,
    }));

    const lines = renderWatchLivenessWidget(
      watches,
      Date.parse("2026-08-28T00:02:00.000Z"),
      0,
      40,
      theme,
    );
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe("  +2 more active");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test("hides when no watch is active or the terminal is too narrow", () => {
    expect(renderWatchLivenessWidget([], Date.now(), 0, 100, theme)).toEqual([]);
    expect(
      renderWatchLivenessWidget(
        [
          {
            id: "watch-1",
            kind: "agent_state",
            label: "done",
            status: "matched",
            startedAt: "2026-08-28T00:00:00.000Z",
            finishedAt: "2026-08-28T00:00:01.000Z",
            wake: "agent",
          },
        ],
        Date.now(),
        0,
        100,
        theme,
      ),
    ).toEqual([]);
    expect(
      renderWatchLivenessWidget(
        [
          {
            id: "watch-1",
            kind: "agent_state",
            label: "active",
            status: "running",
            startedAt: "2026-08-28T00:00:00.000Z",
            wake: "agent",
          },
        ],
        Date.now(),
        0,
        20,
        theme,
      ),
    ).toEqual([]);
  });
});

describe("Bellwether public surface", () => {
  test("registers four structured tools plus the degraded fallback and no legacy tools", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual([
      "herdr_agent",
      "herdr_layout",
      "herdr_pane",
      "herdr_ping_wait",
      "herdr_watch",
    ]);
  });

  test("tool schemas expose no wait, wait action, wait_output, or prompt settlement escape hatch", () => {
    const { tools } = harness();
    const agentSchema = tools.get("herdr_agent")?.parameters;
    const paneSchema = tools.get("herdr_pane")?.parameters;
    const watchSchema = tools.get("herdr_watch")?.parameters;
    if (!agentSchema || !paneSchema || !watchSchema) throw new Error("tools missing");

    const schemas = JSON.stringify({ agentSchema, paneSchema, watchSchema });
    expect(schemas).not.toContain('"wait"');
    expect(schemas).not.toContain("wait_output");
    expect(schemas).not.toContain("prompt_settle");
    expect(schemas).not.toContain("workflow_receipt");

    const agentProperties = (agentSchema as {
      properties?: Record<string, { description?: string }>;
    }).properties;
    const watchProperties = (watchSchema as {
      properties?: Record<string, { description?: string }>;
    }).properties;
    expect(agentProperties).toHaveProperty("timeoutSeconds");
    expect(agentProperties).not.toHaveProperty("timeout");
    expect(agentProperties?.timeoutSeconds?.description).toContain(
      "120 means two minutes",
    );
    expect(watchProperties).toHaveProperty("timeoutSeconds");
    expect(watchProperties).not.toHaveProperty("timeout");
    expect(watchProperties?.timeoutSeconds?.description).toContain(
      "7200 means two hours",
    );
  });

  test("converts explicit watch timeout seconds to Herdr milliseconds", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(success(request, resultForMethod(request.method)));
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools, handlers } = harness();
    const watch = tools.get("herdr_watch");
    if (!watch) throw new Error("herdr_watch missing");

    await watch.execute(
      "call-1",
      {
        action: "start",
        kind: "pane_output",
        pane: "w1:p1",
        match: "DONE",
        timeoutSeconds: 7_200,
        wake: "silent",
      },
      undefined,
      undefined,
      context(),
    );
    const deadline = Date.now() + 1_000;
    while (server.requests.length === 0 && Date.now() < deadline) await sleep(1);

    expect(server.requests[0]).toMatchObject({
      method: "pane.wait_for_output",
      params: { timeout_ms: 7_200_000 },
    });
    await handlers.get("session_shutdown")?.();
  });

  test("prompt sends bounded identity and proof-of-life requests and starts no watch", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(
        success(
          request,
          request.method === "agent.get"
            ? resultForMethod(request.method)
            : {
                type: "agent_prompted",
                agent: agentInfo({ agent_status: "working" }),
              },
        ),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools, handlers } = harness();
    await handlers.get("session_start")?.({ reason: "startup" }, context());
    const prompt = tools.get("herdr_agent");
    const watch = tools.get("herdr_watch");
    if (!prompt || !watch) throw new Error("required tools missing");

    const result = await prompt.execute(
      "call-1",
      { action: "prompt", target: "worker", prompt: "Do the bounded task." },
      undefined,
      undefined,
      context(),
    );
    const watches = await watch.execute(
      "call-2",
      { action: "list" },
      undefined,
      undefined,
      context(),
    );

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: "agent.get",
      params: { target: "worker" },
    });
    expect(server.requests[1]).toEqual(
      expect.objectContaining({
        method: "agent.prompt",
        params: {
          target: "w1:p1",
          text: "Do the bounded task.",
          wait: { until: ["working"], timeout_ms: 30_000 },
        },
      }),
    );
    expect(watches.content[0]?.text).toContain("No Herdr watches");
    expect(() => structuredClone(result.details)).not.toThrow();
    await handlers.get("session_shutdown")?.();
  });

  test("accepted targeted intercom wake triggers one hidden typed follow-up", async () => {
    process.env.HERDR_PANE_ID = "w1:p1";
    const { handlers, messages, entries, events } = harness();
    await handlers.get("session_start")?.({ reason: "startup" }, context());
    const registration = events.emitted.find(
      (entry) => entry.event === "intercom:extension-register",
    )?.payload as
      | {
          onReady(channel: unknown): void;
          onEvent(event: unknown): void;
        }
      | undefined;
    if (!registration) throw new Error("intercom registration missing");
    registration.onReady({
      namespace: "bellwether/herdr/v1",
      snapshot: () => ({ connected: true, supported: true }),
      publish() {},
    });
    const signal = {
      version: 1,
      eventId: "wake-1",
      sourceSessionId: "session-b",
      targetSessionId: "test-session",
      targetPaneId: "w1:p1",
      kind: "wake_hint",
      watchId: "watch-1",
    };
    registration.onEvent({
      type: "message",
      fromSessionId: "session-b",
      payload: signal,
    });
    registration.onEvent({
      type: "message",
      fromSessionId: "session-b",
      payload: signal,
    });

    expect(messages).toEqual([
      expect.objectContaining({
        customType: "bellwether-intercom-wake",
        content: "bellwether_intercom_wake",
        display: false,
      }),
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "bellwether-intercom-wake-hint" }),
    );
    await handlers.get("session_shutdown")?.();
  });
});

type ExpectedRequest = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

async function executeAction(
  toolName: "herdr_layout" | "herdr_pane" | "herdr_agent",
  params: Record<string, unknown>,
) {
  const server = await startFakeHerdrServer((request, socket) => {
    let result = resultForMethod(request.method);
    if (request.method === "pane.current") {
      result = { type: "pane_current", pane: paneInfo({ pane_id: "w1:p1" }) };
    } else if (request.method === "pane.get") {
      result = {
        type: "pane_info",
        pane: paneInfo({ pane_id: request.params.pane_id }),
      };
    } else if (request.method === "pane.split") {
      result = { type: "pane_info", pane: paneInfo({ pane_id: "w1:p3" }) };
    }
    socket.end(success(request, result));
  });
  servers.push(server);
  process.env.HERDR_SOCKET_PATH = server.socketPath;
  process.env.HERDR_PANE_ID = "w1:p1";
  const { tools } = harness();
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`${toolName} missing`);
  const result = await tool.execute(
    "action-call",
    params,
    undefined,
    undefined,
    context(),
  );
  return { result, requests: server.requests };
}

describe("Herdr 0.7.5 action parity", () => {
  const currentRequest: ExpectedRequest = {
    method: "pane.current",
    params: { caller_pane_id: "w1:p1" },
  };

  test("maps every layout action to exact methods and parameters", async () => {
    const cases: Array<{
      params: Record<string, unknown>;
      expected: ExpectedRequest[];
    }> = [
      { params: { action: "current" }, expected: [currentRequest] },
      {
        params: { action: "workspace_list" },
        expected: [{ method: "workspace.list", params: {} }],
      },
      {
        params: {
          action: "workspace_create",
          cwd: "/tmp/new-workspace",
          focus: true,
          label: "New workspace",
        },
        expected: [
          currentRequest,
          {
            method: "workspace.create",
            params: {
              cwd: "/tmp/new-workspace",
              focus: true,
              label: "New workspace",
              env: {},
            },
          },
        ],
      },
      {
        params: { action: "workspace_focus", workspace: "w2" },
        expected: [
          { method: "workspace.focus", params: { workspace_id: "w2" } },
        ],
      },
      {
        params: { action: "tab_list", workspace: "w1" },
        expected: [{ method: "tab.list", params: { workspace_id: "w1" } }],
      },
      {
        params: {
          action: "tab_create",
          workspace: "w1",
          cwd: "/tmp/new-tab",
          label: "New tab",
          focus: false,
        },
        expected: [
          currentRequest,
          {
            method: "tab.create",
            params: {
              workspace_id: "w1",
              cwd: "/tmp/new-tab",
              focus: false,
              label: "New tab",
              env: {},
            },
          },
        ],
      },
      {
        params: { action: "tab_focus", tab: "w1:t2" },
        expected: [{ method: "tab.focus", params: { tab_id: "w1:t2" } }],
      },
      {
        params: { action: "pane_list", workspace: "w1" },
        expected: [
          currentRequest,
          { method: "pane.list", params: { workspace_id: "w1" } },
        ],
      },
      {
        params: { action: "pane_layout", pane: "w1:p2" },
        expected: [{ method: "pane.layout", params: { pane_id: "w1:p2" } }],
      },
      {
        params: {
          action: "pane_split",
          pane: "w1:p2",
          direction: "right",
          cwd: "/tmp/split",
          focus: true,
        },
        expected: [
          currentRequest,
          { method: "pane.get", params: { pane_id: "w1:p2" } },
          {
            method: "pane.split",
            params: {
              target_pane_id: "w1:p2",
              direction: "right",
              cwd: "/tmp/split",
              focus: true,
              env: {},
            },
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const { result, requests } = await executeAction("herdr_layout", testCase.params);
      expect(requests.map(({ method, params }) => ({ method, params }))).toEqual(
        testCase.expected,
      );
      expect(() => structuredClone(result.details)).not.toThrow();
    }
  });

  test("maps every pane action to exact methods and parameters", async () => {
    const cases: Array<{
      params: Record<string, unknown>;
      expected: ExpectedRequest[];
    }> = [
      {
        params: { action: "get", pane: "w1:p2" },
        expected: [{ method: "pane.get", params: { pane_id: "w1:p2" } }],
      },
      {
        params: { action: "run", pane: "w1:p2", command: "npm test" },
        expected: [
          {
            method: "pane.send_input",
            params: { pane_id: "w1:p2", text: "npm test", keys: ["Enter"] },
          },
        ],
      },
      {
        params: {
          action: "read",
          pane: "w1:p2",
          source: "recent-unwrapped",
          lines: 40,
          format: "ansi",
        },
        expected: [
          {
            method: "pane.read",
            params: {
              pane_id: "w1:p2",
              source: "recent_unwrapped",
              lines: 40,
              format: "ansi",
              strip_ansi: false,
            },
          },
        ],
      },
      {
        params: { action: "send_text", pane: "w1:p2", text: "hello" },
        expected: [
          { method: "pane.send_text", params: { pane_id: "w1:p2", text: "hello" } },
        ],
      },
      {
        params: { action: "send_keys", pane: "w1:p2", keys: ["ctrl+c"] },
        expected: [
          { method: "pane.send_keys", params: { pane_id: "w1:p2", keys: ["ctrl+c"] } },
        ],
      },
      {
        params: { action: "close", pane: "w1:p2", confirm: true },
        expected: [
          currentRequest,
          { method: "pane.close", params: { pane_id: "w1:p2" } },
        ],
      },
    ];

    for (const testCase of cases) {
      const { result, requests } = await executeAction("herdr_pane", testCase.params);
      expect(requests.map(({ method, params }) => ({ method, params }))).toEqual(
        testCase.expected,
      );
      expect(() => structuredClone(result.details)).not.toThrow();
    }
  });

  test("maps every agent action to exact methods and parameters", async () => {
    const cases: Array<{
      params: Record<string, unknown>;
      expected: ExpectedRequest[];
    }> = [
      {
        params: { action: "list" },
        expected: [{ method: "agent.list", params: {} }],
      },
      {
        params: { action: "get", target: "worker" },
        expected: [{ method: "agent.get", params: { target: "worker" } }],
      },
      {
        params: {
          action: "start",
          target: "unused",
          pane: "w1:p2",
          name: "worker",
          kind: "pi",
          agentArgs: ["--no-session"],
          timeoutSeconds: 8,
        },
        expected: [
          {
            method: "agent.start",
            params: {
              name: "worker",
              kind: "pi",
              pane_id: "w1:p2",
              args: ["--no-session"],
              timeout_ms: 8_000,
            },
          },
        ],
      },
      {
        params: { action: "prompt", target: "worker", prompt: "Do it." },
        expected: [
          { method: "agent.get", params: { target: "worker" } },
          {
            method: "agent.prompt",
            params: {
              target: "w1:p1",
              text: "Do it.",
              wait: { until: ["working"], timeout_ms: 30_000 },
            },
          },
        ],
      },
      {
        params: {
          action: "read",
          target: "worker",
          source: "visible",
          lines: 20,
          format: "text",
        },
        expected: [
          {
            method: "agent.read",
            params: {
              target: "worker",
              source: "visible",
              lines: 20,
              format: "text",
              strip_ansi: true,
            },
          },
        ],
      },
      {
        params: { action: "send_keys", target: "worker", keys: ["esc"] },
        expected: [
          { method: "agent.send_keys", params: { target: "worker", keys: ["esc"] } },
        ],
      },
      {
        params: { action: "focus", target: "worker" },
        expected: [{ method: "agent.focus", params: { target: "worker" } }],
      },
      {
        params: { action: "rename", target: "worker", name: "renamed" },
        expected: [
          { method: "agent.rename", params: { target: "worker", name: "renamed" } },
        ],
      },
    ];

    for (const testCase of cases) {
      const { result, requests } = await executeAction("herdr_agent", testCase.params);
      expect(requests.map(({ method, params }) => ({ method, params }))).toEqual(
        testCase.expected,
      );
      expect(() => structuredClone(result.details)).not.toThrow();
    }
  });

  test("rejects every action-specific missing input before sending its mutation", async () => {
    const cases: Array<{
      tool: "herdr_layout" | "herdr_pane" | "herdr_agent";
      params: Record<string, unknown>;
      message: string;
    }> = [
      { tool: "herdr_layout", params: { action: "workspace_focus" }, message: "workspace is required" },
      { tool: "herdr_layout", params: { action: "tab_focus" }, message: "tab is required" },
      { tool: "herdr_pane", params: { action: "run", pane: "w1:p2" }, message: "command is required" },
      { tool: "herdr_pane", params: { action: "send_text", pane: "w1:p2" }, message: "text is required" },
      { tool: "herdr_pane", params: { action: "send_keys", pane: "w1:p2" }, message: "keys is required" },
      { tool: "herdr_pane", params: { action: "close", pane: "w1:p2" }, message: "confirm=true" },
      { tool: "herdr_agent", params: { action: "get" }, message: "target is required" },
      { tool: "herdr_agent", params: { action: "start", name: "worker" }, message: "name, kind, and pane" },
      { tool: "herdr_agent", params: { action: "prompt", target: "worker" }, message: "target and prompt" },
      { tool: "herdr_agent", params: { action: "read" }, message: "target is required" },
      { tool: "herdr_agent", params: { action: "send_keys", target: "worker" }, message: "target and keys" },
      { tool: "herdr_agent", params: { action: "focus" }, message: "target is required" },
      { tool: "herdr_agent", params: { action: "rename", target: "worker" }, message: "target and name" },
    ];

    for (const testCase of cases) {
      await expect(executeAction(testCase.tool, testCase.params)).rejects.toThrow(
        testCase.message,
      );
    }
  });

  test("refuses to close the current Pi pane", async () => {
    await expect(
      executeAction("herdr_pane", {
        action: "close",
        pane: "w1:p1",
        confirm: true,
      }),
    ).rejects.toThrow("Refusing to close the pane Pi is running in");
  });

  test("agent.start gives Herdr its deadline and the socket a transport grace", () => {
    expect(agentStartClientTimeoutMs()).toBe(35_000);
    expect(agentStartClientTimeoutMs(8_000)).toBe(13_000);
  });

  test("agent.prompt returns a structured proof-of-life receipt", async () => {
    const { result } = await executeAction("herdr_agent", {
      action: "prompt",
      target: "worker",
      prompt: "Do it.",
    });

    expect(result.content[0]?.text).toContain("Proof of life");
    expect(result.details).toMatchObject({
      action: "prompt",
      proofOfLife: {
        status: "working",
        timeoutMs: 30_000,
        recoveredAfterStall: false,
        alreadyWorking: false,
        targetPaneId: "w1:p1",
      },
    });
  });

  test("agent.prompt treats an already-working target as live without waiting for turn settlement", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(
        success(
          request,
          request.method === "agent.get"
            ? {
                type: "agent_info",
                agent: agentInfo({ agent_status: "working" }),
              }
            : {
                type: "agent_prompted",
                agent: agentInfo({ agent_status: "working" }),
              },
        ),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools } = harness();
    const agent = tools.get("herdr_agent");
    if (!agent) throw new Error("herdr_agent missing");

    const result = await agent.execute(
      "call-1",
      { action: "prompt", target: "worker", prompt: "Queue this." },
      undefined,
      undefined,
      context(),
    );

    expect(server.requests).toMatchObject([
      { method: "agent.get", params: { target: "worker" } },
      {
        method: "agent.prompt",
        params: { target: "w1:p1", text: "Queue this." },
      },
    ]);
    expect(server.requests[1]?.params).not.toHaveProperty("wait");
    expect(result.details).toMatchObject({
      proofOfLife: { status: "working", alreadyWorking: true },
    });
  });

  test("agent.prompt rechecks working when the target settles during submission", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      const status = request.method === "agent.get" || request.method === "agent.wait"
        ? "working"
        : "idle";
      socket.end(
        success(request, {
          type: request.method === "agent.prompt" ? "agent_prompted" : "agent_info",
          agent: agentInfo({ agent_status: status }),
        }),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools } = harness();
    const agent = tools.get("herdr_agent");
    if (!agent) throw new Error("herdr_agent missing");

    const result = await agent.execute(
      "call-1",
      { action: "prompt", target: "worker", prompt: "Queue this." },
      undefined,
      undefined,
      context(),
    );

    expect(server.requests.map((request) => request.method)).toEqual([
      "agent.get",
      "agent.prompt",
      "agent.wait",
    ]);
    expect(server.requests.filter((request) => request.method === "agent.prompt")).toHaveLength(1);
    expect(result.details).toMatchObject({
      proofOfLife: { status: "working", alreadyWorking: true },
    });
  });

  test("agent.prompt uses the proof deadline as an absolute client deadline", () => {
    expect(agentPromptClientTimeoutMs()).toBe(30_000);
    expect(agentPromptClientTimeoutMs(8_000)).toBe(8_000);
  });

  test("agent.prompt recovers from Herdr's five-second stall gate without resubmitting", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      if (request.method === "agent.get") {
        socket.end(success(request, resultForMethod(request.method)));
        return;
      }
      if (request.method === "agent.prompt") {
        socket.end(
          failure(
            request,
            "agent_prompt_stalled",
            "agent prompt produced no observed state change",
          ),
        );
        return;
      }
      socket.end(
        success(request, {
          type: "agent_info",
          agent: agentInfo({ agent_status: "working" }),
        }),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools } = harness();
    const agent = tools.get("herdr_agent");
    if (!agent) throw new Error("herdr_agent missing");

    const result = await agent.execute(
      "call-1",
      { action: "prompt", target: "worker", prompt: "Do it." },
      undefined,
      undefined,
      context(),
    );

    expect(result.details).toMatchObject({
      proofOfLife: {
        status: "working",
        recoveredAfterStall: true,
        alreadyWorking: false,
      },
    });
    expect(server.requests).toMatchObject([
      { method: "agent.get", params: { target: "worker" } },
      {
        method: "agent.prompt",
        params: {
          target: "w1:p1",
          wait: { until: ["working"], timeout_ms: 30_000 },
        },
      },
      {
        method: "agent.wait",
        params: {
          target: "w1:p1",
          until: ["working"],
          timeout_ms: expect.any(Number),
        },
      },
    ]);
    const recoveryTimeoutMs = server.requests[2]?.params.timeout_ms;
    expect(recoveryTimeoutMs).toEqual(expect.any(Number));
    expect(recoveryTimeoutMs as number).toBeGreaterThan(0);
    expect(recoveryTimeoutMs as number).toBeLessThanOrEqual(30_000);
  });

  test("proof-of-life recovery spends only the original deadline remainder", () => {
    expect(remainingPromptProofTimeoutMs(1_000, 6_000)).toBe(25_000);
    expect(remainingPromptProofTimeoutMs(1_000, 31_001)).toBe(0);
  });

  test("agent.prompt does not start recovery after its proof deadline", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(
        request.method === "agent.get"
          ? success(request, resultForMethod(request.method))
          : failure(request, "agent_prompt_stalled", "late stall"),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools } = harness();
    const agent = tools.get("herdr_agent");
    if (!agent) throw new Error("herdr_agent missing");
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(31_001);

    try {
      await expect(
        agent.execute(
          "call-1",
          { action: "prompt", target: "worker", prompt: "Do it." },
          undefined,
          undefined,
          context(),
        ),
      ).rejects.toThrow("timed out after 30000ms");
    } finally {
      now.mockRestore();
    }
    expect(server.requests.map((request) => request.method)).toEqual([
      "agent.get",
      "agent.prompt",
    ]);
  });

  test("agent.prompt surfaces timeout when neither proof path sees working", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      if (request.method === "agent.get") {
        socket.end(success(request, resultForMethod(request.method)));
        return;
      }
      socket.end(
        failure(
          request,
          request.method === "agent.prompt" ? "agent_prompt_stalled" : "timeout",
          "no observed working state",
        ),
      );
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { tools } = harness();
    const agent = tools.get("herdr_agent");
    if (!agent) throw new Error("herdr_agent missing");

    await expect(
      agent.execute(
        "call-1",
        { action: "prompt", target: "worker", prompt: "Do it." },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("timeout");
    expect(server.requests.map((request) => request.method)).toEqual([
      "agent.get",
      "agent.prompt",
      "agent.wait",
    ]);
  });

  test("session_start records no socket path and opens no Herdr socket", async () => {
    const server = await startFakeHerdrServer((request, socket) => {
      socket.end(success(request, resultForMethod(request.method)));
    });
    servers.push(server);
    process.env.HERDR_SOCKET_PATH = server.socketPath;
    const { handlers, entries } = harness();
    await handlers.get("session_start")?.({ reason: "startup" }, context());

    expect(server.requests).toHaveLength(0);
    expect(JSON.stringify(entries)).not.toContain("socketPath");
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "bellwether-capability",
        data: expect.objectContaining({ directSocket: true }),
      }),
    );
    await handlers.get("session_shutdown")?.();
  });
});

test("herdr_ping_wait remains an explicit degraded fallback", async () => {
  process.env.HERDR_PING_WAIT_BIN = await waiterExecutable();
  const { tools, handlers, messages } = harness();
  const tool = tools.get("herdr_ping_wait");
  if (!tool) throw new Error("herdr_ping_wait was not registered");

  const startedAt = performance.now();
  const result = await tool.execute(
    "call-1",
    { action: "start", paneIds: ["w1:p1"] },
    undefined,
    undefined,
    context(),
  );
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(200);
  expect(result.content[0]?.text).toContain("degraded");
  expect(messages).toHaveLength(0);
  const deadline = Date.now() + 2_000;
  while (messages.length === 0 && Date.now() < deadline) await sleep(20);
  expect(messages).toHaveLength(1);
  await handlers.get("session_shutdown")?.();
});
