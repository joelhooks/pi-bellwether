import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Type } from "typebox";
import type { Static } from "typebox";

import {
  createHerdrClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HERDR_TRANSPORT_GRACE_MS,
} from "../src/herdr-client.ts";
import type {
  HerdrClient,
  HerdrError,
  HerdrRequest,
  HerdrResult,
} from "../src/herdr-client.ts";
import {
  createIntercomCoordination,
  type IntercomCoordination,
} from "../src/intercom.ts";
import {
  createPingWaitActor,
  resolvePingWaitBinary,
  runPingWait,
  terminalPingWaitStatus,
} from "../src/ping-wait.ts";
import type {
  PingWaitContext,
  PingWaitInput,
  PingWaitStatus,
} from "../src/ping-wait.ts";
import {
  createWatchRegistry,
  MAX_WATCH_TIMEOUT_MS,
  type AgentStatus,
  type ReadSource,
  type StartWatchParams,
  type WatchReceipt,
} from "../src/watch.ts";

const MAX_ACTIVE_PING_WAITS = 32;
const BELLWETHER_PROTOCOL = 1;

export function agentStartClientTimeoutMs(
  serverTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  return serverTimeoutMs + HERDR_TRANSPORT_GRACE_MS;
}

type JsonRecord = Record<string, unknown>;
type SplitDirection = "right" | "down";
type OutputFormat = "text" | "ansi";

const Action = {
  layout: [
    "current",
    "workspace_list",
    "workspace_create",
    "workspace_focus",
    "tab_list",
    "tab_create",
    "tab_focus",
    "pane_list",
    "pane_layout",
    "pane_split",
  ],
  pane: ["get", "run", "read", "send_text", "send_keys", "close"],
  agent: ["list", "get", "start", "prompt", "read", "send_keys", "focus", "rename"],
  watch: ["start", "list", "status", "cancel"],
} as const;

const AgentKindEnum = StringEnum(
  [
    "pi",
    "claude",
    "codex",
    "gemini",
    "cursor",
    "devin",
    "agy",
    "cline",
    "omp",
    "mastracode",
    "opencode",
    "copilot",
    "kimi",
    "kiro",
    "droid",
    "amp",
    "grok",
    "hermes",
    "kilo",
    "qodercli",
    "maki",
  ] as const,
  { description: "Supported coding agent kind and canonical executable" },
);
const AgentStatusEnum = StringEnum(
  ["idle", "working", "blocked", "done", "unknown"] as const,
);
const ReadSourceEnum = StringEnum(
  ["visible", "recent", "recent-unwrapped", "detection"] as const,
);
const WatchReadSourceEnum = StringEnum(
  ["visible", "recent", "recent-unwrapped"] as const,
);
const OutputFormatEnum = StringEnum(["text", "ansi"] as const);
const DirectionEnum = StringEnum(["right", "down"] as const);
const WakeEnum = StringEnum(["agent", "notify", "silent"] as const);

export const herdrLayoutParameters = Type.Object(
  {
    action: StringEnum(Action.layout),
    workspace: Type.Optional(Type.String()),
    tab: Type.Optional(Type.String()),
    pane: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    direction: Type.Optional(DirectionEnum),
    cwd: Type.Optional(Type.String()),
    focus: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const herdrPaneParameters = Type.Object(
  {
    action: StringEnum(Action.pane),
    pane: Type.String({ description: "Opaque pane ID returned by herdr_layout" }),
    command: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    keys: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    source: Type.Optional(ReadSourceEnum),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    format: Type.Optional(OutputFormatEnum),
    confirm: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const herdrAgentParameters = Type.Object(
  {
    action: StringEnum(Action.agent),
    target: Type.Optional(Type.String()),
    pane: Type.Optional(Type.String()),
    name: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" })),
    kind: Type.Optional(AgentKindEnum),
    agentArgs: Type.Optional(Type.Array(Type.String())),
    prompt: Type.Optional(Type.String({ maxLength: 900_000 })),
    timeout: Type.Optional(Type.Integer({ minimum: 3_001, maximum: 300_000 })),
    source: Type.Optional(ReadSourceEnum),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    format: Type.Optional(OutputFormatEnum),
    keys: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    clearName: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const herdrWatchParameters = Type.Object(
  {
    action: StringEnum(Action.watch),
    kind: Type.Optional(StringEnum(["agent_state", "pane_output"] as const)),
    id: Type.Optional(Type.String()),
    label: Type.Optional(Type.String({ maxLength: 120 })),
    target: Type.Optional(Type.String()),
    pane: Type.Optional(Type.String()),
    match: Type.Optional(Type.String()),
    regex: Type.Optional(Type.Boolean()),
    until: Type.Optional(Type.Array(AgentStatusEnum, { minItems: 1 })),
    timeout: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_WATCH_TIMEOUT_MS }),
    ),
    source: Type.Optional(WatchReadSourceEnum),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    raw: Type.Optional(Type.Boolean()),
    wake: Type.Optional(WakeEnum),
  },
  { additionalProperties: false },
);

const pingWaitParameters = Type.Object(
  {
    action: StringEnum(["start", "list", "status", "cancel"] as const),
    id: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    paneIds: Type.Optional(
      Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
    ),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000_000 })),
    wake: Type.Optional(StringEnum(["agent", "notify"] as const)),
  },
  { additionalProperties: false },
);

type PingWaitParameters = Static<typeof pingWaitParameters>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Herdr result ${record.type} omitted ${key}`);
  return value;
}

function recordArray(record: JsonRecord, key: string): JsonRecord[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`Herdr result ${record.type} has invalid ${key}`);
  }
  return value;
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requiredStringField(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Herdr result ${record.type} has invalid ${key}`);
  }
  return value;
}

function requiredNumberField(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`Herdr result ${record.type} has invalid ${key}`);
  }
  return value;
}

function wireReadSource(
  source: "visible" | "recent" | "recent-unwrapped" | "detection",
): string {
  return source === "recent-unwrapped" ? "recent_unwrapped" : source;
}

function formatOutput(output: string): string {
  const truncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content;
  return `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`;
}

function summarizeAgent(agent: JsonRecord): string {
  const pane = requiredStringField(agent, "pane_id");
  const name =
    stringField(agent, "name") ??
    stringField(agent, "display_agent") ??
    stringField(agent, "agent") ??
    pane;
  const status = requiredStringField(agent, "agent_status");
  const cwd = stringField(agent, "cwd");
  return `${name}: [${pane}] (${status})${cwd ? ` ${cwd}` : ""}`;
}

function summarizePane(pane: JsonRecord, currentPaneId?: string): string {
  const paneId = requiredStringField(pane, "pane_id");
  const label = stringField(pane, "label") ?? paneId;
  const status = requiredStringField(pane, "agent_status");
  const cwd = stringField(pane, "foreground_cwd") ?? stringField(pane, "cwd");
  const flags = [paneId === currentPaneId ? "current" : undefined, status]
    .filter(Boolean)
    .join(", ");
  return `${label}: [${paneId}]${flags ? ` (${flags})` : ""}${cwd ? ` ${cwd}` : ""}`;
}

function summarizeTab(tab: JsonRecord): string {
  return `${requiredStringField(tab, "label")}: [${requiredStringField(tab, "tab_id")}]`;
}

function summarizeWorkspace(workspace: JsonRecord): string {
  return `${requiredStringField(workspace, "label")}: [${requiredStringField(workspace, "workspace_id")}]`;
}

function toolText(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function requestFailure(error: HerdrError): Error {
  const code = "code" in error ? ` (${error.code})` : "";
  return new Error(`${error.operation}${code}: ${error.message}`);
}

async function runRequest(
  client: HerdrClient,
  input: HerdrRequest,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  const outcome = await Effect.runPromise(
    client.request(input).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (result) => ({ ok: true as const, result }),
      }),
    ),
    { signal },
  );
  if (!outcome.ok) throw requestFailure(outcome.error);
  return outcome.result;
}

async function currentPane(client: HerdrClient, signal?: AbortSignal): Promise<JsonRecord> {
  const result = await runRequest(
    client,
    {
      method: "pane.current",
      params: {
        ...(process.env.HERDR_PANE_ID
          ? { caller_pane_id: process.env.HERDR_PANE_ID }
          : {}),
      },
    },
    signal,
  );
  return recordField(result, "pane");
}

async function paneById(
  client: HerdrClient,
  paneId: string,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  return recordField(
    await runRequest(client, { method: "pane.get", params: { pane_id: paneId } }, signal),
    "pane",
  );
}

async function paneLayout(
  client: HerdrClient,
  paneId: string,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  return recordField(
    await runRequest(client, { method: "pane.layout", params: { pane_id: paneId } }, signal),
    "layout",
  );
}

function chooseSplitDirection(layout: JsonRecord, paneId: string): SplitDirection {
  const pane = recordArray(layout, "panes").find(
    (candidate) => requiredStringField(candidate, "pane_id") === paneId,
  );
  if (!pane) throw new Error(`Herdr layout omitted pane ${paneId}`);
  const rect = recordField(pane, "rect");
  const width = requiredNumberField(rect, "width");
  const height = requiredNumberField(rect, "height");
  return width >= 80 && width >= height * 2 ? "right" : "down";
}

function readText(result: HerdrResult): string {
  return requiredStringField(recordField(result, "read"), "text");
}

function toStartWatchParams(params: {
  kind?: "agent_state" | "pane_output";
  label?: string;
  target?: string;
  pane?: string;
  match?: string;
  regex?: boolean;
  until?: AgentStatus[];
  timeout?: number;
  source?: ReadSource;
  lines?: number;
  raw?: boolean;
  wake?: "agent" | "notify" | "silent";
}): StartWatchParams {
  if (params.kind === "agent_state") {
    if (!params.target) throw new Error("target is required for agent_state");
    return {
      kind: "agent_state",
      target: params.target,
      label: params.label,
      until: params.until,
      timeoutMs: params.timeout,
      wake: params.wake,
    };
  }
  if (params.kind === "pane_output") {
    if (!params.pane || !params.match) {
      throw new Error("pane and match are required for pane_output");
    }
    return {
      kind: "pane_output",
      pane: params.pane,
      match: params.match,
      label: params.label,
      regex: params.regex,
      source: params.source,
      lines: params.lines,
      raw: params.raw,
      timeoutMs: params.timeout,
      wake: params.wake,
    };
  }
  throw new Error("kind is required for action=start");
}

function watchReceiptText(receipt: WatchReceipt): string {
  return [
    `Bellwether watch ${receipt.id}: ${receipt.status}`,
    `Kind: ${receipt.kind}`,
    `Label: ${receipt.label}`,
    receipt.failure ? `Failure: ${receipt.failure}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

const WATCH_WIDGET_ID = "bellwether-watch-liveness";
const WATCH_WIDGET_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const WATCH_WIDGET_INTERVAL_MS = 500;
const WATCH_WIDGET_MAX_ROWS = 3;

function watchAge(startedAt: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function renderWatchLivenessWidget(
  receipts: readonly WatchReceipt[],
  now: number,
  frameIndex: number,
  width: number,
  theme: {
    bold: (text: string) => string;
    fg: (color: "accent" | "dim" | "muted", text: string) => string;
  },
): string[] {
  const active = receipts.filter((receipt) => receipt.status === "running");
  if (active.length === 0 || width < 24) return [];

  const oldest = active.reduce((candidate, receipt) =>
    Date.parse(receipt.startedAt) < Date.parse(candidate.startedAt) ? receipt : candidate,
  );
  const frame = WATCH_WIDGET_FRAMES[frameIndex % WATCH_WIDGET_FRAMES.length];
  const noun = active.length === 1 ? "watch" : "watches";
  const lines = [
    theme.fg(
      "accent",
      theme.bold(
        `${frame} Bellwether waiting · ${active.length} ${noun} · oldest ${watchAge(oldest.startedAt, now)}`,
      ),
    ),
  ];

  for (const receipt of active.slice(0, WATCH_WIDGET_MAX_ROWS)) {
    const phase = receipt.phase === "starting" ? "connecting" : "watching";
    const target = receipt.target ?? receipt.pane;
    const detail = [target, watchAge(receipt.startedAt, now)].filter(Boolean).join(" · ");
    lines.push(
      theme.fg("muted", `  ${phase} ${receipt.label}`) +
        (detail ? theme.fg("dim", ` · ${detail}`) : ""),
    );
  }
  if (active.length > WATCH_WIDGET_MAX_ROWS) {
    lines.push(
      theme.fg("dim", `  +${active.length - WATCH_WIDGET_MAX_ROWS} more active`),
    );
  }

  return lines.map((line) => truncateToWidth(line, width));
}

interface PingWaitRecord {
  readonly actor: ReturnType<typeof createPingWaitActor>;
  readonly controller: AbortController;
  completion: Promise<void>;
  finishedAt?: number;
  status: PingWaitStatus;
}

function pingReceipt(record: PingWaitRecord) {
  const context = record.actor.getSnapshot().context as PingWaitContext;
  return {
    id: context.id,
    label: context.label,
    paneIds: context.paneIds,
    startedAt: new Date(context.startedAt).toISOString(),
    finishedAt:
      record.finishedAt === undefined
        ? undefined
        : new Date(record.finishedAt).toISOString(),
    status: record.status,
    wake: context.wake,
    event: context.event,
    failure: context.failure,
  };
}

function showEditor(
  ctx: ExtensionContext,
  title: string,
  text: string,
): Promise<string | undefined> {
  return ctx.ui.editor(title, text);
}

export default function bellwetherExtension(pi: ExtensionAPI) {
  const client = createHerdrClient();
  const pingWaits = new Map<string, PingWaitRecord>();
  let currentContext: ExtensionContext | undefined;
  let coordination: IntercomCoordination | undefined;
  let watchWidgetFrame = 0;
  let watchWidgetTimer: ReturnType<typeof setInterval> | undefined;
  let watchWidgetTui: { requestRender: () => void } | undefined;
  let shuttingDown = false;

  const requestWatchWidgetRender = () => watchWidgetTui?.requestRender();

  const watches = createWatchRegistry({
    client,
    appendEntry: (type, data) => pi.appendEntry(type, data),
    notify: (message, level) => currentContext?.ui.notify(message, level),
    sendMessage: (message, options) => pi.sendMessage(message, options),
    onLifecycle: (lifecycle, receipt) => {
      coordination?.publishWatch(lifecycle, receipt);
      requestWatchWidgetRender();
    },
  });

  const finishPingWait = (
    record: PingWaitRecord,
    status: Exclude<PingWaitStatus, "running">,
  ) => {
    if (record.status !== "running") return;
    record.status = status;
    record.finishedAt = Date.now();
    if (shuttingDown || status === "cancelled") return;
    const receipt = pingReceipt(record);
    pi.appendEntry("herdr-ping-wait-finished", receipt);
    if (receipt.wake === "notify") {
      currentContext?.ui.notify(
        `${receipt.label}: ${receipt.status}`,
        status === "matched" ? "info" : "warning",
      );
      return;
    }
    pi.sendMessage(
      {
        content: `Degraded Herdr ping fallback settled. Inspect the pane and receipt before continuing.\n\n${JSON.stringify(receipt)}`,
        customType: "herdr-ping-wait",
        details: receipt,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const startPingWait = async (
    params: PingWaitParameters,
    ctx: ExtensionContext,
  ): Promise<PingWaitRecord> => {
    if (ctx.mode === "print" || ctx.mode === "json") {
      throw new Error("herdr_ping_wait requires a long-lived Pi process");
    }
    if (!params.paneIds?.length) throw new Error("paneIds is required for action=start");
    const active = [...pingWaits.values()].filter((record) => record.status === "running");
    if (active.length >= MAX_ACTIVE_PING_WAITS) {
      throw new Error(`herdr_ping_wait allows at most ${MAX_ACTIVE_PING_WAITS} active waits`);
    }
    const sessionId = ctx.sessionManager
      .getSessionId()
      .replaceAll(/[^A-Za-z0-9_-]/g, "-");
    const input: PingWaitInput = {
      cursorPath: join(
        homedir(),
        ".local",
        "state",
        "herdr-pings",
        `pi-bellwether-${sessionId}.cursor.json`,
      ),
      id: randomUUID().slice(0, 8),
      label: params.label?.trim() || params.paneIds.join(", "),
      paneIds: [...new Set(params.paneIds)],
      startedAt: Date.now(),
      timeoutMs:
        params.timeoutSeconds === undefined
          ? undefined
          : params.timeoutSeconds * 1_000,
      wake: params.wake ?? "agent",
    };
    const binary = await resolvePingWaitBinary();
    const actor = createPingWaitActor(input);
    const controller = new AbortController();
    const record: PingWaitRecord = {
      actor,
      controller,
      completion: Promise.resolve(),
      status: "running",
    };
    pingWaits.set(input.id, record);
    actor.subscribe((snapshot) => {
      if (snapshot.status !== "done") return;
      const status = terminalPingWaitStatus(snapshot.value);
      if (status) finishPingWait(record, status);
    });
    actor.start();
    record.completion = runPingWait(binary, input, controller.signal).then(
      (outcome) => actor.send(outcome),
      (error) =>
        actor.send({
          type: "FAIL",
          failure: error instanceof Error ? error.message : String(error),
        }),
    );
    pi.appendEntry("herdr-ping-wait-started", pingReceipt(record));
    return record;
  };

  pi.registerTool({
    name: "herdr_layout",
    label: "Herdr Layout",
    description:
      "Create and inspect Herdr terminal topology. Workspaces contain tabs and tabs contain panes. Layout actions are bounded direct socket requests and never start an agent or ordinary command.",
    promptSnippet: "Inspect or create Herdr workspaces, tabs, and panes",
    parameters: herdrLayoutParameters,
    async execute(_id, params, signal) {
      switch (params.action) {
        case "current": {
          const pane = await currentPane(client, signal);
          return toolText(summarizePane(pane, stringField(pane, "pane_id")), {
            action: params.action,
            pane,
          });
        }
        case "workspace_list": {
          const result = await runRequest(client, { method: "workspace.list" }, signal);
          const workspaces = recordArray(result, "workspaces");
          return toolText(
            workspaces.length ? workspaces.map(summarizeWorkspace).join("\n") : "No workspaces.",
            { action: params.action, workspaces },
          );
        }
        case "workspace_create": {
          const current = await currentPane(client, signal);
          const cwd =
            params.cwd ??
            stringField(current, "foreground_cwd") ??
            stringField(current, "cwd") ??
            process.cwd();
          const result = await runRequest(
            client,
            {
              method: "workspace.create",
              params: {
                cwd,
                focus: params.focus === true,
                ...(params.label ? { label: params.label } : {}),
                env: {},
              },
            },
            signal,
          );
          return toolText(
            `Created workspace ${stringField(recordField(result, "workspace"), "workspace_id")}, tab ${stringField(recordField(result, "tab"), "tab_id")}, root pane ${stringField(recordField(result, "root_pane"), "pane_id")}`,
            { action: params.action, result },
          );
        }
        case "workspace_focus": {
          if (!params.workspace) throw new Error("workspace is required for workspace_focus");
          const result = await runRequest(
            client,
            { method: "workspace.focus", params: { workspace_id: params.workspace } },
            signal,
          );
          return toolText(`Focused workspace ${params.workspace}`, {
            action: params.action,
            workspace: recordField(result, "workspace"),
          });
        }
        case "tab_list": {
          const result = await runRequest(
            client,
            {
              method: "tab.list",
              params: params.workspace ? { workspace_id: params.workspace } : {},
            },
            signal,
          );
          const tabs = recordArray(result, "tabs");
          return toolText(tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs.", {
            action: params.action,
            tabs,
          });
        }
        case "tab_create": {
          const current = await currentPane(client, signal);
          const workspaceId = params.workspace ?? stringField(current, "workspace_id");
          const cwd =
            params.cwd ??
            stringField(current, "foreground_cwd") ??
            stringField(current, "cwd") ??
            process.cwd();
          const result = await runRequest(
            client,
            {
              method: "tab.create",
              params: {
                ...(workspaceId ? { workspace_id: workspaceId } : {}),
                cwd,
                focus: params.focus === true,
                ...(params.label ? { label: params.label } : {}),
                env: {},
              },
            },
            signal,
          );
          return toolText(
            `Created tab ${stringField(recordField(result, "tab"), "tab_id")}, root pane ${stringField(recordField(result, "root_pane"), "pane_id")}`,
            { action: params.action, result },
          );
        }
        case "tab_focus": {
          if (!params.tab) throw new Error("tab is required for tab_focus");
          const result = await runRequest(
            client,
            { method: "tab.focus", params: { tab_id: params.tab } },
            signal,
          );
          return toolText(`Focused tab ${params.tab}`, {
            action: params.action,
            tab: recordField(result, "tab"),
          });
        }
        case "pane_list": {
          const current = await currentPane(client, signal);
          const workspaceId = params.workspace ?? stringField(current, "workspace_id");
          const result = await runRequest(
            client,
            {
              method: "pane.list",
              params: workspaceId ? { workspace_id: workspaceId } : {},
            },
            signal,
          );
          const panes = recordArray(result, "panes");
          return toolText(
            panes.length
              ? panes
                  .map((pane) => summarizePane(pane, stringField(current, "pane_id")))
                  .join("\n")
              : "No panes.",
            { action: params.action, panes, workspaceId },
          );
        }
        case "pane_layout": {
          const paneId = params.pane ?? stringField(await currentPane(client, signal), "pane_id");
          if (!paneId) throw new Error("could not resolve current pane");
          const layout = await paneLayout(client, paneId, signal);
          return toolText(JSON.stringify(layout, null, 2), {
            action: params.action,
            layout,
          });
        }
        case "pane_split": {
          const current = await currentPane(client, signal);
          const source = params.pane
            ? await paneById(client, params.pane, signal)
            : current;
          const sourcePaneId = stringField(source, "pane_id");
          if (!sourcePaneId) throw new Error("source pane omitted pane_id");
          const direction =
            params.direction ??
            chooseSplitDirection(await paneLayout(client, sourcePaneId, signal), sourcePaneId);
          const cwd =
            params.cwd ??
            stringField(source, "foreground_cwd") ??
            stringField(source, "cwd") ??
            process.cwd();
          const result = await runRequest(
            client,
            {
              method: "pane.split",
              params: {
                target_pane_id: sourcePaneId,
                direction,
                cwd,
                focus: params.focus === true,
                env: {},
              },
            },
            signal,
          );
          const pane = recordField(result, "pane");
          return toolText(
            `Created pane ${stringField(pane, "pane_id")} by splitting ${sourcePaneId} ${direction}`,
            { action: params.action, pane, sourcePaneId, direction },
          );
        }
      }
    },
  });

  pi.registerTool({
    name: "herdr_pane",
    label: "Herdr Pane",
    description:
      "Run, inspect, read, send to, or close a raw Herdr pane through bounded direct socket requests. Output waiting belongs only in herdr_watch. Close requires confirm=true and refuses this Pi pane.",
    promptSnippet: "Control an ordinary Herdr terminal pane",
    parameters: herdrPaneParameters,
    async execute(_id, params, signal) {
      switch (params.action) {
        case "get": {
          const pane = await paneById(client, params.pane, signal);
          return toolText(summarizePane(pane), { action: params.action, pane });
        }
        case "run": {
          if (!params.command) throw new Error("command is required for run");
          const result = await runRequest(
            client,
            {
              method: "pane.send_input",
              params: { pane_id: params.pane, text: params.command, keys: ["Enter"] },
            },
            signal,
          );
          return toolText(`Submitted command to pane ${params.pane}`, {
            action: params.action,
            pane: params.pane,
            command: params.command,
            result,
          });
        }
        case "read": {
          const format = params.format ?? "text";
          const result = await runRequest(
            client,
            {
              method: "pane.read",
              params: {
                pane_id: params.pane,
                source: wireReadSource(params.source ?? "recent-unwrapped"),
                ...(params.lines === undefined ? {} : { lines: params.lines }),
                format,
                strip_ansi: format !== "ansi",
              },
            },
            signal,
          );
          const text = formatOutput(readText(result));
          return toolText(text || `No output from ${params.pane}.`, {
            action: params.action,
            pane: params.pane,
            read: recordField(result, "read"),
          });
        }
        case "send_text": {
          if (!params.text) throw new Error("text is required for send_text");
          const result = await runRequest(
            client,
            { method: "pane.send_text", params: { pane_id: params.pane, text: params.text } },
            signal,
          );
          return toolText(`Sent literal text to pane ${params.pane}`, {
            action: params.action,
            pane: params.pane,
            result,
          });
        }
        case "send_keys": {
          if (!params.keys?.length) throw new Error("keys is required for send_keys");
          const result = await runRequest(
            client,
            { method: "pane.send_keys", params: { pane_id: params.pane, keys: params.keys } },
            signal,
          );
          return toolText(`Sent ${params.keys.join(" ")} to pane ${params.pane}`, {
            action: params.action,
            pane: params.pane,
            keys: params.keys,
            result,
          });
        }
        case "close": {
          if (params.confirm !== true) {
            throw new Error("close requires confirm=true because it closes a terminal pane");
          }
          const current = await currentPane(client, signal);
          if (params.pane === stringField(current, "pane_id")) {
            throw new Error("Refusing to close the pane Pi is running in");
          }
          const result = await runRequest(
            client,
            { method: "pane.close", params: { pane_id: params.pane } },
            signal,
          );
          return toolText(`Closed pane ${params.pane}`, {
            action: params.action,
            pane: params.pane,
            result,
          });
        }
      }
    },
  });

  pi.registerTool({
    name: "herdr_agent",
    label: "Herdr Agent",
    description:
      "Control a recognized coding agent in an existing Herdr pane. Prompt submits one bounded agent.prompt request with no wait options and starts no watch. External-state observation belongs only in herdr_watch.",
    promptSnippet: "Start, prompt, read, and interact with Herdr coding agents",
    parameters: herdrAgentParameters,
    async execute(_id, params, signal) {
      switch (params.action) {
        case "list": {
          const result = await runRequest(client, { method: "agent.list" }, signal);
          const agents = recordArray(result, "agents");
          return toolText(
            agents.length ? agents.map(summarizeAgent).join("\n") : "No agents.",
            { action: params.action, agents },
          );
        }
        case "get": {
          if (!params.target) throw new Error("target is required for get");
          const result = await runRequest(
            client,
            { method: "agent.get", params: { target: params.target } },
            signal,
          );
          const agent = recordField(result, "agent");
          return toolText(summarizeAgent(agent), { action: params.action, agent });
        }
        case "start": {
          if (!params.name || !params.kind || !params.pane) {
            throw new Error("name, kind, and pane are required for start");
          }
          const result = await runRequest(
            client,
            {
              method: "agent.start",
              params: {
                name: params.name,
                kind: params.kind,
                pane_id: params.pane,
                args: params.agentArgs ?? [],
                ...(params.timeout === undefined ? {} : { timeout_ms: params.timeout }),
              },
              timeoutMs: agentStartClientTimeoutMs(params.timeout),
            },
            signal,
          );
          const agent = recordField(result, "agent");
          return toolText(`Started ${summarizeAgent(agent)}`, {
            action: params.action,
            agent,
          });
        }
        case "prompt": {
          if (!params.target || !params.prompt) {
            throw new Error("target and prompt are required for prompt");
          }
          const result = await runRequest(
            client,
            {
              method: "agent.prompt",
              params: { target: params.target, text: params.prompt },
            },
            signal,
          );
          const agent = recordField(result, "agent");
          return toolText(`Prompt accepted by ${summarizeAgent(agent)}`, {
            action: params.action,
            agent,
          });
        }
        case "read": {
          if (!params.target) throw new Error("target is required for read");
          const format: OutputFormat = params.format ?? "text";
          const result = await runRequest(
            client,
            {
              method: "agent.read",
              params: {
                target: params.target,
                source: wireReadSource(params.source ?? "recent-unwrapped"),
                ...(params.lines === undefined ? {} : { lines: params.lines }),
                format,
                strip_ansi: format !== "ansi",
              },
            },
            signal,
          );
          const text = formatOutput(readText(result));
          return toolText(text || `No output from ${params.target}.`, {
            action: params.action,
            target: params.target,
            read: recordField(result, "read"),
          });
        }
        case "send_keys": {
          if (!params.target || !params.keys?.length) {
            throw new Error("target and keys are required for send_keys");
          }
          const result = await runRequest(
            client,
            {
              method: "agent.send_keys",
              params: { target: params.target, keys: params.keys },
            },
            signal,
          );
          return toolText(`Sent ${params.keys.join(" ")} to ${params.target}`, {
            action: params.action,
            result,
          });
        }
        case "focus": {
          if (!params.target) throw new Error("target is required for focus");
          const result = await runRequest(
            client,
            { method: "agent.focus", params: { target: params.target } },
            signal,
          );
          const agent = recordField(result, "agent");
          return toolText(`Focused ${summarizeAgent(agent)}`, {
            action: params.action,
            agent,
          });
        }
        case "rename": {
          if (!params.target || (!params.clearName && !params.name)) {
            throw new Error("target and name or clearName are required for rename");
          }
          const result = await runRequest(
            client,
            {
              method: "agent.rename",
              params: {
                target: params.target,
                name: params.clearName ? null : params.name,
              },
            },
            signal,
          );
          const agent = recordField(result, "agent");
          return toolText(
            params.clearName ? `Cleared agent name for ${params.target}` : `Renamed agent to ${params.name}`,
            { action: params.action, agent },
          );
        }
      }
    },
  });

  pi.registerTool({
    name: "herdr_watch",
    label: "Herdr Watch",
    description:
      "Start, list, inspect, or cancel session-owned Herdr watches. Each watch owns one direct Herdr wait socket and an XState lifecycle. Start returns a running receipt immediately. Kinds are agent_state and pane_output.",
    promptSnippet: "Start or inspect a non-blocking direct-socket Herdr watch",
    parameters: herdrWatchParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "start") {
        const receipt = watches.start(
          toStartWatchParams({
            kind: params.kind,
            label: params.label,
            target: params.target,
            pane: params.pane,
            match: params.match,
            regex: params.regex,
            until: params.until,
            timeout: params.timeout,
            source: params.source,
            lines: params.lines,
            raw: params.raw,
            wake: params.wake,
          }),
          ctx,
        );
        return toolText(
          `Started ${receipt.kind} watch ${receipt.id} (${receipt.label}) without blocking this turn.`,
          receipt,
        );
      }
      if (params.action === "list") {
        const receipts = watches.list();
        return toolText(
          receipts.length
            ? receipts
                .map(
                  (receipt) =>
                    `${receipt.id}\t${receipt.status}\t${receipt.kind}\t${receipt.label}`,
                )
                .join("\n")
            : "No Herdr watches owned by this Pi session.",
          { watches: receipts },
        );
      }
      if (!params.id) throw new Error(`id is required for action=${params.action}`);
      const receipt =
        params.action === "cancel"
          ? watches.cancel(params.id)
          : watches.status(params.id);
      return toolText(watchReceiptText(receipt), receipt);
    },
  });

  pi.registerTool({
    name: "herdr_ping_wait",
    label: "Herdr Ping Wait (Degraded Fallback)",
    description:
      "Explicit crash and turn fallback backed by herdr-ping-wait. This degraded path starts a child process only for action=start. herdr_watch never calls it.",
    promptSnippet: "Use the degraded Herdr ping fallback only when direct watches cannot express the condition",
    parameters: pingWaitParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      if (params.action === "start") {
        const record = await startPingWait(params, ctx);
        const receipt = pingReceipt(record);
        return toolText(
          `Started degraded Herdr ping fallback ${receipt.id} without blocking this turn.`,
          receipt,
        );
      }
      if (params.action === "list") {
        const receipts = [...pingWaits.values()].map(pingReceipt);
        return toolText(
          receipts.length
            ? receipts
                .map((receipt) => `${receipt.id}\t${receipt.status}\t${receipt.label}`)
                .join("\n")
            : "No degraded Herdr ping waits owned by this session.",
          { waits: receipts },
        );
      }
      if (!params.id) throw new Error(`id is required for action=${params.action}`);
      const record = pingWaits.get(params.id);
      if (!record) throw new Error(`unknown Herdr ping wait: ${params.id}`);
      if (params.action === "cancel" && record.status === "running") {
        record.actor.send({ type: "CANCEL" });
        record.controller.abort();
      }
      return toolText(JSON.stringify(pingReceipt(record), null, 2), pingReceipt(record));
    },
  });

  pi.registerCommand("herdr-status", {
    description: "Show Herdr socket status",
    handler: async (_args, ctx) => {
      try {
        const result = await runRequest(client, { method: "ping" });
        await showEditor(ctx, "Herdr status", JSON.stringify(result, null, 2));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-agents", {
    description: "List Herdr agents; pass --panes to include the current workspace panes",
    handler: async (args, ctx) => {
      try {
        const result = await runRequest(client, { method: "agent.list" });
        const agents = recordArray(result, "agents");
        const sections = [
          agents.length ? agents.map(summarizeAgent).join("\n") : "No agents.",
        ];
        if (args.trim() === "--panes") {
          const current = await currentPane(client);
          const workspaceId = stringField(current, "workspace_id");
          const panesResult = await runRequest(client, {
            method: "pane.list",
            params: workspaceId ? { workspace_id: workspaceId } : {},
          });
          const panes = recordArray(panesResult, "panes");
          sections.push(
            panes.length
              ? panes
                  .map((pane) => summarizePane(pane, stringField(current, "pane_id")))
                  .join("\n")
              : "No panes.",
          );
        } else if (args.trim()) {
          throw new Error("Usage: /herdr-agents [--panes]");
        }
        await showEditor(ctx, "Herdr agents", sections.join("\n\n"));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-read", {
    description: "Read recent output: /herdr-read <agent target>",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /herdr-read <agent target>", "error");
        return;
      }
      try {
        const result = await runRequest(client, {
          method: "agent.read",
          params: {
            target,
            source: "recent_unwrapped",
            lines: 80,
            format: "text",
            strip_ansi: true,
          },
        });
        await showEditor(ctx, `Herdr read: ${target}`, formatOutput(readText(result)));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-focus", {
    description: "Focus a Herdr agent target",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /herdr-focus <agent target>", "error");
        return;
      }
      try {
        await runRequest(client, { method: "agent.focus", params: { target } });
        ctx.ui.notify(`Focused ${target}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-stop", {
    description: "Close a Herdr agent pane after confirmation",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /herdr-stop <agent target>", "error");
        return;
      }
      try {
        const agent = recordField(
          await runRequest(client, { method: "agent.get", params: { target } }),
          "agent",
        );
        const paneId = stringField(agent, "pane_id");
        if (!paneId) throw new Error("agent result omitted pane_id");
        const current = await currentPane(client);
        if (paneId === stringField(current, "pane_id")) {
          throw new Error("Refusing to close the pane Pi is running in");
        }
        const confirmed = await ctx.ui.confirm(
          "Close Herdr pane?",
          `Target: ${target}\nPane: ${paneId}\n\nThis closes the terminal pane.`,
        );
        if (!confirmed) return;
        await runRequest(client, { method: "pane.close", params: { pane_id: paneId } });
        ctx.ui.notify(`Closed ${target} (${paneId}).`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    shuttingDown = false;
    if (event.reason !== "startup") watches.bumpGeneration();
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WATCH_WIDGET_ID, (tui, theme) => {
        watchWidgetTui = tui;
        return {
          render: (width: number) =>
            renderWatchLivenessWidget(
              watches.active(),
              Date.now(),
              watchWidgetFrame,
              width,
              theme,
            ),
          invalidate: () => {},
          dispose: () => {
            if (watchWidgetTui === tui) watchWidgetTui = undefined;
          },
        };
      });
      watchWidgetTimer ??= setInterval(() => {
        if (watches.active().length === 0) return;
        watchWidgetFrame = (watchWidgetFrame + 1) % WATCH_WIDGET_FRAMES.length;
        requestWatchWidgetRender();
      }, WATCH_WIDGET_INTERVAL_MS);
    }
    if (!coordination) {
      coordination = createIntercomCoordination({
        events: pi.events,
        sessionId: ctx.sessionManager.getSessionId(),
        paneId: process.env.HERDR_PANE_ID,
        activeWatches: () => watches.active(),
        wake: (signal) => {
          const details = {
            eventId: signal.eventId,
            sourceSessionId: signal.sourceSessionId,
            watchId: signal.watchId,
          };
          pi.appendEntry("bellwether-intercom-wake-hint", details);
          pi.sendMessage(
            {
              customType: "bellwether-intercom-wake",
              content: "bellwether_intercom_wake",
              display: false,
              details,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
        onSignal: (signal) => {
          pi.appendEntry("bellwether-intercom-signal", {
            eventId: signal.eventId,
            kind: signal.kind,
            sourceSessionId: signal.sourceSessionId,
            ...(signal.kind === "workflow_receipt"
              ? {
                  workflowId: signal.workflowId,
                  itemId: signal.itemId,
                  generation: signal.generation,
                  sequence: signal.sequence,
                }
              : {}),
          });
        },
      });
    } else {
      coordination.announce();
    }
    pi.appendEntry("bellwether-capability", {
      protocol: BELLWETHER_PROTOCOL,
      directSocket: true,
      tools: ["herdr_layout", "herdr_pane", "herdr_agent", "herdr_watch"],
    });
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (watchWidgetTimer) clearInterval(watchWidgetTimer);
    watchWidgetTimer = undefined;
    currentContext?.ui.setWidget(WATCH_WIDGET_ID, undefined);
    watchWidgetTui = undefined;
    coordination?.dispose();
    coordination = undefined;
    await watches.shutdown();

    const activePingWaits = [...pingWaits.values()].filter(
      (record) => record.status === "running",
    );
    for (const record of activePingWaits) {
      record.actor.send({ type: "CANCEL" });
      record.controller.abort();
    }
    await Promise.allSettled(activePingWaits.map((record) => record.completion));
    for (const record of activePingWaits) record.actor.stop();
    pingWaits.clear();
    currentContext = undefined;
  });
}
