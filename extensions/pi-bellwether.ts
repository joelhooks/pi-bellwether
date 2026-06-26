import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const HERDR_BIN_CANDIDATES = [
  join(homedir(), ".local/bin/herdr"),
  "/opt/homebrew/bin/herdr",
  "/usr/local/bin/herdr",
  "herdr",
];

const readSourceEnum = StringEnum(["visible", "recent", "recent-unwrapped"] as const);
const splitDirectionEnum = StringEnum(["right", "down"] as const);

type JsonRecord = Record<string, unknown>;

type HerdrRun = {
  stdout: string;
  stderr: string;
  args: string[];
};

type HerdrJsonRun = HerdrRun & {
  envelope: JsonRecord;
  result: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function getString(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getBoolean(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function shellQuoteForDisplay(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandForDisplay(args: string[]) {
  return ["herdr", ...args].map(shellQuoteForDisplay).join(" ");
}

async function firstExecutable(paths: string[]) {
  for (const path of paths) {
    if (path === "herdr") continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try next candidate.
    }
  }
  return "herdr";
}

function formatHerdrError(stdout: string, stderr: string, fallback: string) {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedStdout) as unknown;
      if (isRecord(parsed) && isRecord(parsed.error)) {
        const code = getString(parsed.error, "code");
        const message = getString(parsed.error, "message");
        return [code, message].filter(Boolean).join(": ");
      }
    } catch {
      // Fall through to stderr/fallback.
    }
  }
  return stderr.trim() || trimmedStdout.slice(0, 1000) || fallback;
}

async function runHerdr(args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HerdrRun> {
  const herdr = await firstExecutable(HERDR_BIN_CANDIDATES);

  return new Promise((resolve, reject) => {
    execFile(
      herdr,
      args,
      {
        signal: options.signal,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const out = String(stdout);
        const err = String(stderr);
        if (error) {
          const nodeError = error as Error & { code?: string | number };
          const reason = formatHerdrError(out, err, nodeError.message);
          reject(new Error(`${commandForDisplay(args)} failed${nodeError.code ? ` (${nodeError.code})` : ""}: ${reason}`));
          return;
        }
        resolve({ stdout: out, stderr: err, args });
      },
    );
  });
}

async function runHerdrJson(args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HerdrJsonRun> {
  const run = await runHerdr(args, options);
  const stdout = run.stdout.trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${commandForDisplay(args)} returned non-JSON output: ${message}\n${stdout.slice(0, 1000)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${commandForDisplay(args)} returned unexpected JSON: ${stdout.slice(0, 1000)}`);
  }

  if (isRecord(parsed.error)) {
    const code = getString(parsed.error, "code");
    const message = getString(parsed.error, "message") || "Unknown Herdr error";
    throw new Error(`${commandForDisplay(args)} failed${code ? ` (${code})` : ""}: ${message}`);
  }

  return {
    ...run,
    envelope: parsed,
    result: parsed.result,
  };
}

function toolText(text: string, details: JsonRecord = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function clampLines(lines: unknown, fallback = 80) {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return fallback;
  return Math.max(1, Math.min(500, Math.round(lines)));
}

function formatAgent(record: JsonRecord, index: number) {
  const agent = getString(record, "agent") || "terminal";
  const status = getString(record, "agent_status") || "unknown";
  const cwd = getString(record, "cwd") || getString(record, "foreground_cwd") || "?";
  const terminalId = getString(record, "terminal_id") || "?";
  const paneId = getString(record, "pane_id") || "?";
  const workspaceId = getString(record, "workspace_id") || "?";
  const tabId = getString(record, "tab_id") || "?";
  const focused = getBoolean(record, "focused") ? " focused" : "";
  return `${index + 1}. ${agent} ${status}${focused}\n   terminal: ${terminalId}\n   pane:     ${paneId}\n   tab:      ${tabId}\n   workspace:${workspaceId}\n   cwd:      ${cwd}`;
}

function resultRecord(run: HerdrJsonRun) {
  return isRecord(run.result) ? run.result : {};
}

function formatAgentList(agentRun: HerdrJsonRun, paneRun?: HerdrJsonRun) {
  const agents = asRecords(resultRecord(agentRun).agents);
  const lines = [`Herdr agents (${agents.length})`];

  if (agents.length === 0) {
    lines.push("No detected agents.");
  } else {
    lines.push(...agents.map(formatAgent));
  }

  if (paneRun) {
    const panes = asRecords(resultRecord(paneRun).panes);
    lines.push("", `Herdr panes (${panes.length})`);
    if (panes.length === 0) {
      lines.push("No panes.");
    } else {
      lines.push(...panes.map(formatAgent));
    }
  }

  return lines.join("\n");
}

function prettyResult(run: HerdrJsonRun) {
  return JSON.stringify(run.result ?? run.envelope, null, 2);
}

async function listAgents(includePanes: boolean, signal?: AbortSignal) {
  const agentRun = await runHerdrJson(["agent", "list"], { signal });
  const paneRun = includePanes ? await runHerdrJson(["pane", "list"], { signal }) : undefined;
  return { agentRun, paneRun, summary: formatAgentList(agentRun, paneRun) };
}

async function resolvePaneId(target: string, signal?: AbortSignal) {
  const run = await runHerdrJson(["agent", "get", target], { signal });
  const result = resultRecord(run);
  const agent = isRecord(result.agent) ? result.agent : undefined;
  const paneId = agent ? getString(agent, "pane_id") : undefined;
  if (!paneId) throw new Error(`Could not resolve '${target}' to a Herdr pane id.`);
  return { paneId, run };
}

function buildStartArgs(params: {
  name: string;
  command: string[];
  cwd?: string;
  workspaceId?: string;
  tabId?: string;
  split?: "right" | "down";
  env?: string[];
  focus?: boolean;
}) {
  const command = params.command.filter((part) => part.length > 0);
  if (!params.name.trim()) throw new Error("herdr_start_agent requires a non-empty name.");
  if (command.length === 0) throw new Error("herdr_start_agent requires a non-empty command array.");

  const args = ["agent", "start", params.name.trim()];
  if (params.cwd) args.push("--cwd", params.cwd);
  if (params.workspaceId) args.push("--workspace", params.workspaceId);
  if (params.tabId) args.push("--tab", params.tabId);
  if (params.split) args.push("--split", params.split);
  for (const env of params.env ?? []) {
    if (env.trim()) args.push("--env", env);
  }
  if (params.focus === true) args.push("--focus");
  if (params.focus === false) args.push("--no-focus");
  args.push("--", ...command);
  return args;
}

function splitCommandArgs(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`Unclosed ${quote} quote.`);
  if (current) tokens.push(current);
  return tokens;
}

function takeOptionValue(tokens: string[], index: number, token: string, flag: string) {
  if (token.startsWith(`${flag}=`)) return { value: token.slice(flag.length + 1), next: index + 1 };
  if (token === flag) {
    const value = tokens[index + 1];
    if (!value) throw new Error(`${flag} requires a value.`);
    return { value, next: index + 2 };
  }
  return undefined;
}

function parseStartCommand(input: string) {
  const tokens = splitCommandArgs(input);
  let name = "";
  let cwd: string | undefined;
  let workspaceId: string | undefined;
  let tabId: string | undefined;
  let split: "right" | "down" | undefined;
  const env: string[] = [];
  let focus: boolean | undefined;
  let command: string[] = [];

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (token === "--") {
      command = tokens.slice(index + 1);
      break;
    }

    const cwdOption = takeOptionValue(tokens, index, token, "--cwd");
    if (cwdOption) {
      cwd = cwdOption.value;
      index = cwdOption.next;
      continue;
    }

    const workspaceOption = takeOptionValue(tokens, index, token, "--workspace");
    if (workspaceOption) {
      workspaceId = workspaceOption.value;
      index = workspaceOption.next;
      continue;
    }

    const tabOption = takeOptionValue(tokens, index, token, "--tab");
    if (tabOption) {
      tabId = tabOption.value;
      index = tabOption.next;
      continue;
    }

    const splitOption = takeOptionValue(tokens, index, token, "--split");
    if (splitOption) {
      if (splitOption.value !== "right" && splitOption.value !== "down") throw new Error("--split must be right or down.");
      split = splitOption.value;
      index = splitOption.next;
      continue;
    }

    const envOption = takeOptionValue(tokens, index, token, "--env");
    if (envOption) {
      env.push(envOption.value);
      index = envOption.next;
      continue;
    }

    if (token === "--focus") {
      focus = true;
      index += 1;
      continue;
    }
    if (token === "--no-focus") {
      focus = false;
      index += 1;
      continue;
    }

    if (!name) {
      name = token;
      index += 1;
      continue;
    }

    throw new Error(`Unexpected token before --: ${token}`);
  }

  return { name, command, cwd, workspaceId, tabId, split, env, focus };
}

function parseReadCommand(input: string) {
  const tokens = splitCommandArgs(input);
  const target = tokens.shift();
  if (!target) throw new Error("Usage: /herdr-read <target> [--lines N] [--source visible|recent|recent-unwrapped] [--ansi]");

  let lines = 80;
  let source: "visible" | "recent" | "recent-unwrapped" = "recent-unwrapped";
  let ansi = false;

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    const linesOption = takeOptionValue(tokens, index, token, "--lines");
    if (linesOption) {
      lines = clampLines(Number(linesOption.value));
      index = linesOption.next;
      continue;
    }

    const sourceOption = takeOptionValue(tokens, index, token, "--source");
    if (sourceOption) {
      if (!["visible", "recent", "recent-unwrapped"].includes(sourceOption.value)) {
        throw new Error("--source must be visible, recent, or recent-unwrapped.");
      }
      source = sourceOption.value as "visible" | "recent" | "recent-unwrapped";
      index = sourceOption.next;
      continue;
    }

    if (token === "--ansi") {
      ansi = true;
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${token}`);
  }

  return { target, lines, source, ansi };
}

function parseTargetAndText(input: string, usage: string) {
  const tokens = splitCommandArgs(input);
  const target = tokens.shift();
  if (!target || tokens.length === 0) throw new Error(usage);
  return { target, text: tokens.join(" ") };
}

function parseSingleTarget(input: string, usage: string) {
  const tokens = splitCommandArgs(input);
  if (tokens.length !== 1) throw new Error(usage);
  return tokens[0];
}

async function showEditor(ctx: { ui: { editor: (title: string, text: string) => Promise<string | undefined>; notify: (message: string, type: "info" | "warning" | "error") => void } }, title: string, text: string) {
  await ctx.ui.editor(title, text);
}

export default function bellwetherExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "herdr_status",
    label: "Herdr Status",
    description: "Show Herdr client/server status and compatibility information.",
    promptSnippet: "Check Herdr client/server health before managing Herdr agents or panes.",
    promptGuidelines: [
      "Use herdr_status when Herdr commands fail or before diagnosing Herdr agent/pane control problems.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const run = await runHerdr(["status"], { signal });
      return toolText(run.stdout.trim() || "Herdr status returned no output.", {
        command: commandForDisplay(run.args),
        stderr: run.stderr.trim(),
      });
    },
  });

  pi.registerTool({
    name: "herdr_list_agents",
    label: "List Herdr Agents",
    description: "List Herdr-detected agents and optionally all panes.",
    promptSnippet: "List Herdr agents/panes before sending, reading, focusing, or stopping a target.",
    promptGuidelines: [
      "Use herdr_list_agents before herdr_send_message, herdr_submit, herdr_focus_agent, or herdr_stop_agent when the target is not already known.",
    ],
    parameters: Type.Object({
      includePanes: Type.Optional(Type.Boolean({ description: "Also include raw Herdr panes. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      const { agentRun, paneRun, summary } = await listAgents(Boolean(params.includePanes), signal);
      return toolText(summary, {
        agents: resultRecord(agentRun).agents,
        panes: paneRun ? resultRecord(paneRun).panes : undefined,
      });
    },
  });

  pi.registerTool({
    name: "herdr_start_agent",
    label: "Start Herdr Agent",
    description: "Start a managed Herdr agent/process in a pane.",
    promptSnippet: "Start a managed Herdr agent/process with explicit argv and optional cwd/workspace/tab placement.",
    parameters: Type.Object({
      name: Type.String({ description: "Herdr agent/process label." }),
      command: Type.Array(Type.String(), { description: "Command argv. Example: [\"pi\", \"-p\", \"hello\"]" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new process." })),
      workspaceId: Type.Optional(Type.String({ description: "Existing Herdr workspace id." })),
      tabId: Type.Optional(Type.String({ description: "Existing Herdr tab id." })),
      split: Type.Optional(splitDirectionEnum),
      env: Type.Optional(Type.Array(Type.String(), { description: "Environment entries as KEY=VALUE strings." })),
      focus: Type.Optional(Type.Boolean({ description: "Whether Herdr should focus the new pane." })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = buildStartArgs({
        name: params.name,
        command: params.command,
        cwd: params.cwd,
        workspaceId: params.workspaceId,
        tabId: params.tabId,
        split: params.split,
        env: params.env,
        focus: params.focus,
      });
      const run = await runHerdrJson(args, { signal });
      return toolText(`Started Herdr agent '${params.name}'.\n\n${prettyResult(run)}`, {
        command: commandForDisplay(run.args),
        result: run.result,
      });
    },
  });

  pi.registerTool({
    name: "herdr_send_message",
    label: "Send Herdr Message",
    description: "Send literal text to a Herdr agent target without pressing Enter.",
    promptSnippet: "Send literal text to a Herdr target; call herdr_submit separately to press Enter.",
    parameters: Type.Object({
      target: Type.String({ description: "Herdr target: terminal id, unique agent name, detected label, pane id, or legacy pane id." }),
      message: Type.String({ description: "Literal text to send. Does not press Enter." }),
    }),
    async execute(_toolCallId, params, signal) {
      if (!params.message) throw new Error("herdr_send_message requires non-empty message text.");
      const run = await runHerdrJson(["agent", "send", params.target, params.message], { signal });
      return toolText(`Sent ${params.message.length} chars to ${params.target}.`, {
        command: commandForDisplay(run.args),
        result: run.result,
      });
    },
  });

  pi.registerTool({
    name: "herdr_submit",
    label: "Submit Herdr Agent",
    description: "Press Enter in a Herdr agent target's pane.",
    promptSnippet: "Press Enter in a Herdr target after herdr_send_message writes text.",
    parameters: Type.Object({
      target: Type.String({ description: "Herdr target to resolve to a pane before pressing Enter." }),
    }),
    async execute(_toolCallId, params, signal) {
      const { paneId, run: targetRun } = await resolvePaneId(params.target, signal);
      const run = await runHerdrJson(["pane", "send-keys", paneId, "Enter"], { signal });
      return toolText(`Pressed Enter in ${params.target} (${paneId}).`, {
        target: targetRun.result,
        command: commandForDisplay(run.args),
        result: run.result,
      });
    },
  });

  pi.registerTool({
    name: "herdr_read_agent",
    label: "Read Herdr Agent",
    description: "Read recent output from a Herdr agent target.",
    promptSnippet: "Read recent Herdr target output before deciding whether to send or submit more text.",
    parameters: Type.Object({
      target: Type.String({ description: "Herdr target to read." }),
      source: Type.Optional(readSourceEnum),
      lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Line count. Defaults to 80, capped at 500." })),
      ansi: Type.Optional(Type.Boolean({ description: "Return ANSI formatted output instead of plain text." })),
    }),
    async execute(_toolCallId, params, signal) {
      const source = params.source || "recent-unwrapped";
      const lines = clampLines(params.lines);
      const format = params.ansi ? "ansi" : "text";
      const run = await runHerdrJson(["agent", "read", params.target, "--source", source, "--lines", String(lines), "--format", format], { signal });
      const result = resultRecord(run);
      const read = isRecord(result.read) ? result.read : {};
      const text = getString(read, "text") || "";
      return toolText(text || `No output from ${params.target}.`, {
        command: commandForDisplay(run.args),
        read,
      });
    },
  });

  pi.registerTool({
    name: "herdr_focus_agent",
    label: "Focus Herdr Agent",
    description: "Focus a Herdr agent target.",
    parameters: Type.Object({
      target: Type.String({ description: "Herdr target to focus." }),
    }),
    async execute(_toolCallId, params, signal) {
      const run = await runHerdrJson(["agent", "focus", params.target], { signal });
      return toolText(`Focused Herdr target ${params.target}.`, {
        command: commandForDisplay(run.args),
        result: run.result,
      });
    },
  });

  pi.registerTool({
    name: "herdr_stop_agent",
    label: "Stop Herdr Agent",
    description: "Close the pane for a Herdr agent target. Requires confirm=true because this is destructive.",
    promptSnippet: "Close a Herdr target's pane only after reading/listing and only with confirm=true.",
    promptGuidelines: [
      "Use herdr_stop_agent only when the user explicitly asks to close/stop a Herdr pane, and set confirm=true only after checking the target.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Herdr target to resolve to a pane and close." }),
      confirm: Type.Boolean({ description: "Must be true. This closes a terminal pane." }),
    }),
    async execute(_toolCallId, params, signal) {
      if (params.confirm !== true) throw new Error("herdr_stop_agent requires confirm=true because it closes a terminal pane.");
      const { paneId, run: targetRun } = await resolvePaneId(params.target, signal);
      const run = await runHerdrJson(["pane", "close", paneId], { signal });
      return toolText(`Closed Herdr target ${params.target} (${paneId}).`, {
        target: targetRun.result,
        command: commandForDisplay(run.args),
        result: run.result,
      });
    },
  });

  pi.registerCommand("herdr-status", {
    description: "Show Herdr client/server status",
    handler: async (_args, ctx) => {
      try {
        const run = await runHerdr(["status"]);
        await showEditor(ctx, "Herdr status", run.stdout.trim() || "Herdr status returned no output.");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-agents", {
    description: "List Herdr agents/panes",
    handler: async (args, ctx) => {
      try {
        const includePanes = splitCommandArgs(args).includes("--panes");
        const { summary } = await listAgents(includePanes);
        await showEditor(ctx, "Herdr agents", summary);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-start", {
    description: "Start a managed Herdr process: /herdr-start <name> -- <cmd ...>",
    handler: async (args, ctx) => {
      try {
        const parsed = parseStartCommand(args);
        const run = await runHerdrJson(buildStartArgs(parsed));
        ctx.ui.notify(`Started Herdr agent '${parsed.name}'.`, "info");
        await showEditor(ctx, "Herdr start result", prettyResult(run));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-send", {
    description: "Send literal text to a Herdr target without Enter",
    handler: async (args, ctx) => {
      try {
        const { target, text } = parseTargetAndText(args, "Usage: /herdr-send <target> <message>");
        await runHerdrJson(["agent", "send", target, text]);
        ctx.ui.notify(`Sent ${text.length} chars to ${target}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-submit", {
    description: "Press Enter in a Herdr target pane",
    handler: async (args, ctx) => {
      try {
        const target = parseSingleTarget(args, "Usage: /herdr-submit <target>");
        const { paneId } = await resolvePaneId(target);
        await runHerdrJson(["pane", "send-keys", paneId, "Enter"]);
        ctx.ui.notify(`Pressed Enter in ${target} (${paneId}).`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-read", {
    description: "Read recent output from a Herdr target",
    handler: async (args, ctx) => {
      try {
        const parsed = parseReadCommand(args);
        const format = parsed.ansi ? "ansi" : "text";
        const run = await runHerdrJson(["agent", "read", parsed.target, "--source", parsed.source, "--lines", String(parsed.lines), "--format", format]);
        const result = resultRecord(run);
        const read = isRecord(result.read) ? result.read : {};
        await showEditor(ctx, `Herdr read: ${parsed.target}`, getString(read, "text") || "");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-focus", {
    description: "Focus a Herdr agent target",
    handler: async (args, ctx) => {
      try {
        const target = parseSingleTarget(args, "Usage: /herdr-focus <target>");
        await runHerdrJson(["agent", "focus", target]);
        ctx.ui.notify(`Focused ${target}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("herdr-stop", {
    description: "Close a Herdr target pane after confirmation",
    handler: async (args, ctx) => {
      try {
        const target = parseSingleTarget(args, "Usage: /herdr-stop <target>");
        const { paneId } = await resolvePaneId(target);
        const ok = await ctx.ui.confirm("Close Herdr pane?", `Target: ${target}\nPane: ${paneId}\n\nThis closes the terminal pane.`);
        if (!ok) {
          ctx.ui.notify("Herdr stop cancelled.", "info");
          return;
        }
        await runHerdrJson(["pane", "close", paneId]);
        ctx.ui.notify(`Closed ${target} (${paneId}).`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
