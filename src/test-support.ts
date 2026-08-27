import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

export interface FakeRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface FakeHerdrServer {
  readonly socketPath: string;
  readonly requests: FakeRequest[];
  readonly requestLines: string[];
  readonly connections: () => number;
  readonly closedConnections: () => number;
  readonly stop: () => Promise<void>;
}

export type FakeRequestHandler = (
  request: FakeRequest,
  socket: Socket,
) => void | Promise<void>;

export async function startFakeHerdrServer(
  handler: FakeRequestHandler,
): Promise<FakeHerdrServer> {
  const directory = await mkdtemp(join(tmpdir(), "bellwether-herdr-"));
  const socketPath = join(directory, "herdr.sock");
  const requests: FakeRequest[] = [];
  const requestLines: string[] = [];
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  let closedCount = 0;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    connectionCount += 1;
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      const line = data.subarray(0, newline).toString("utf8");
      requestLines.push(line);
      const request = JSON.parse(line) as FakeRequest;
      requests.push(request);
      void handler(request, socket);
    });
    socket.once("close", () => {
      sockets.delete(socket);
      closedCount += 1;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    requests,
    requestLines,
    connections: () => connectionCount,
    closedConnections: () => closedCount,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    },
  };
}

export function success(
  request: FakeRequest,
  result: Record<string, unknown>,
): string {
  return `${JSON.stringify({ id: request.id, result })}\n`;
}

export function failure(
  request: FakeRequest,
  code: string,
  message: string,
): string {
  return `${JSON.stringify({ id: request.id, error: { code, message } })}\n`;
}

export function workspaceInfo(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "w1",
    number: 1,
    label: "Workspace",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "w1:t1",
    agent_status: "idle",
    ...overrides,
  };
}

export function tabInfo(overrides: Record<string, unknown> = {}) {
  return {
    tab_id: "w1:t1",
    workspace_id: "w1",
    number: 1,
    label: "Tab",
    focused: true,
    pane_count: 1,
    agent_status: "idle",
    ...overrides,
  };
}

export function paneInfo(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: "w1:p1",
    terminal_id: "term-1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: true,
    cwd: "/tmp/project",
    foreground_cwd: "/tmp/project",
    label: "Pane",
    agent_status: "idle",
    revision: 1,
    ...overrides,
  };
}

export function agentInfo(overrides: Record<string, unknown> = {}) {
  return {
    terminal_id: "term-1",
    name: "worker",
    agent: "pi",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: true,
    state_change_seq: 1,
    revision: 1,
    cwd: "/tmp/project",
    foreground_cwd: "/tmp/project",
    ...overrides,
  };
}

export function paneLayout(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "w1",
    tab_id: "w1:t1",
    zoomed: false,
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "w1:p1",
    panes: [
      {
        pane_id: "w1:p1",
        focused: true,
        rect: { x: 0, y: 0, width: 120, height: 40 },
      },
    ],
    splits: [],
    ...overrides,
  };
}

export function paneRead(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: "w1:p1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    source: "recent_unwrapped",
    format: "text",
    text: "terminal output",
    revision: 1,
    truncated: false,
    ...overrides,
  };
}

export function resultForMethod(method: string): Record<string, unknown> {
  switch (method) {
    case "ping":
      return { type: "pong", version: "0.7.5", protocol: 17 };
    case "workspace.list":
      return { type: "workspace_list", workspaces: [workspaceInfo()] };
    case "workspace.create":
      return {
        type: "workspace_created",
        workspace: workspaceInfo(),
        tab: tabInfo(),
        root_pane: paneInfo(),
      };
    case "workspace.focus":
      return { type: "workspace_info", workspace: workspaceInfo() };
    case "tab.list":
      return { type: "tab_list", tabs: [tabInfo()] };
    case "tab.create":
      return { type: "tab_created", tab: tabInfo(), root_pane: paneInfo() };
    case "tab.focus":
      return { type: "tab_info", tab: tabInfo() };
    case "pane.list":
      return { type: "pane_list", panes: [paneInfo()] };
    case "pane.current":
      return { type: "pane_current", pane: paneInfo() };
    case "pane.get":
    case "pane.split":
      return { type: "pane_info", pane: paneInfo() };
    case "pane.layout":
      return { type: "pane_layout", layout: paneLayout() };
    case "pane.read":
    case "agent.read":
      return { type: "pane_read", read: paneRead() };
    case "pane.wait_for_output":
      return {
        type: "output_matched",
        pane_id: "w1:p1",
        revision: 1,
        matched_line: "DONE",
        read: paneRead(),
      };
    case "agent.list":
      return { type: "agent_list", agents: [agentInfo()] };
    case "agent.get":
    case "agent.focus":
    case "agent.rename":
    case "agent.wait":
      return { type: "agent_info", agent: agentInfo() };
    case "agent.start":
      return { type: "agent_started", agent: agentInfo(), argv: ["pi"] };
    case "agent.prompt":
      return { type: "agent_prompted", agent: agentInfo({ agent_status: "working" }) };
    case "pane.send_input":
    case "pane.send_text":
    case "pane.send_keys":
    case "pane.close":
    case "agent.send_keys":
      return { type: "ok" };
    default:
      throw new Error(`No fake Herdr result for ${method}`);
  }
}
