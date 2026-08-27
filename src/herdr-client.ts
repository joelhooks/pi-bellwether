import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

import { Effect, Schema } from "effect";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const HERDR_TRANSPORT_GRACE_MS = 5_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const AgentStatus = Schema.Literals([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);
const StringMap = Schema.Record(Schema.String, Schema.String);
const AgentSession = Schema.Struct({
  source: Schema.String,
  agent: Schema.String,
  kind: Schema.String,
  value: Schema.String,
});
const PaneScroll = Schema.Struct({
  offset_from_bottom: Schema.Number,
  max_offset_from_bottom: Schema.Number,
  viewport_rows: Schema.Number,
});

export const WorkspaceInfoSchema = Schema.Struct({
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  tab_count: Schema.Number,
  active_tab_id: Schema.String,
  agent_status: AgentStatus,
  tokens: Schema.optionalKey(StringMap),
  worktree: Schema.optionalKey(
    Schema.Struct({
      repo_key: Schema.String,
      repo_name: Schema.String,
      repo_root: Schema.String,
      checkout_path: Schema.String,
      is_linked_worktree: Schema.Boolean,
    }),
  ),
});

export const TabInfoSchema = Schema.Struct({
  tab_id: Schema.String,
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  agent_status: AgentStatus,
});

export const PaneInfoSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  focused: Schema.Boolean,
  cwd: Schema.optionalKey(Schema.String),
  foreground_cwd: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  terminal_title: Schema.optionalKey(Schema.String),
  terminal_title_stripped: Schema.optionalKey(Schema.String),
  display_agent: Schema.optionalKey(Schema.String),
  agent_status: AgentStatus,
  state_labels: Schema.optionalKey(StringMap),
  tokens: Schema.optionalKey(StringMap),
  agent_session: Schema.optionalKey(AgentSession),
  scroll: Schema.optionalKey(PaneScroll),
  revision: Schema.Number,
});

export const AgentInfoSchema = Schema.Struct({
  terminal_id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  terminal_title: Schema.optionalKey(Schema.String),
  terminal_title_stripped: Schema.optionalKey(Schema.String),
  display_agent: Schema.optionalKey(Schema.String),
  agent_status: AgentStatus,
  screen_detection_skipped: Schema.optionalKey(Schema.Boolean),
  state_labels: Schema.optionalKey(StringMap),
  tokens: Schema.optionalKey(StringMap),
  agent_session: Schema.optionalKey(AgentSession),
  workspace_id: Schema.String,
  tab_id: Schema.String,
  pane_id: Schema.String,
  focused: Schema.Boolean,
  launch_pending: Schema.optionalKey(Schema.Boolean),
  interactive_ready: Schema.optionalKey(Schema.Boolean),
  state_change_seq: Schema.optionalKey(Schema.Number),
  cwd: Schema.optionalKey(Schema.String),
  foreground_cwd: Schema.optionalKey(Schema.String),
  revision: Schema.Number,
});

const LayoutRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const PaneLayoutSchema = Schema.Struct({
  workspace_id: Schema.String,
  tab_id: Schema.String,
  zoomed: Schema.Boolean,
  area: LayoutRect,
  focused_pane_id: Schema.String,
  panes: Schema.Array(
    Schema.Struct({
      pane_id: Schema.String,
      focused: Schema.Boolean,
      rect: LayoutRect,
    }),
  ),
  splits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      direction: Schema.Literals(["right", "down"]),
      ratio: Schema.Number,
      rect: LayoutRect,
    }),
  ),
});

export const PaneReadSchema = Schema.Struct({
  pane_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  source: Schema.Literals(["visible", "recent", "recent_unwrapped", "detection"]),
  format: Schema.Literals(["text", "ansi"]),
  text: Schema.String,
  revision: Schema.Number,
  truncated: Schema.Boolean,
});

const HerdrResultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pong"),
    version: Schema.String,
    protocol: Schema.Number,
    capabilities: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("workspace_info"), workspace: WorkspaceInfoSchema }),
  Schema.Struct({
    type: Schema.Literal("workspace_created"),
    workspace: WorkspaceInfoSchema,
    tab: TabInfoSchema,
    root_pane: PaneInfoSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("workspace_list"),
    workspaces: Schema.Array(WorkspaceInfoSchema),
  }),
  Schema.Struct({ type: Schema.Literal("tab_info"), tab: TabInfoSchema }),
  Schema.Struct({
    type: Schema.Literal("tab_created"),
    tab: TabInfoSchema,
    root_pane: PaneInfoSchema,
  }),
  Schema.Struct({ type: Schema.Literal("tab_list"), tabs: Schema.Array(TabInfoSchema) }),
  Schema.Struct({ type: Schema.Literal("agent_info"), agent: AgentInfoSchema }),
  Schema.Struct({
    type: Schema.Literal("agent_started"),
    agent: AgentInfoSchema,
    argv: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("agent_prompted"), agent: AgentInfoSchema }),
  Schema.Struct({ type: Schema.Literal("agent_list"), agents: Schema.Array(AgentInfoSchema) }),
  Schema.Struct({ type: Schema.Literal("pane_info"), pane: PaneInfoSchema }),
  Schema.Struct({ type: Schema.Literal("pane_list"), panes: Schema.Array(PaneInfoSchema) }),
  Schema.Struct({ type: Schema.Literal("pane_current"), pane: PaneInfoSchema }),
  Schema.Struct({ type: Schema.Literal("pane_layout"), layout: PaneLayoutSchema }),
  Schema.Struct({ type: Schema.Literal("pane_read"), read: PaneReadSchema }),
  Schema.Struct({
    type: Schema.Literal("output_matched"),
    pane_id: Schema.String,
    revision: Schema.Number,
    matched_line: Schema.NullOr(Schema.String),
    read: PaneReadSchema,
  }),
  Schema.Struct({ type: Schema.Literal("ok") }),
]);

export type HerdrResult = typeof HerdrResultSchema.Type;

export const HERDR_METHOD_RESULT_TAGS = {
  ping: ["pong"],
  "workspace.list": ["workspace_list"],
  "workspace.create": ["workspace_created"],
  "workspace.focus": ["workspace_info"],
  "tab.list": ["tab_list"],
  "tab.create": ["tab_created"],
  "tab.focus": ["tab_info"],
  "pane.list": ["pane_list"],
  "pane.current": ["pane_current"],
  "pane.get": ["pane_info"],
  "pane.layout": ["pane_layout"],
  "pane.split": ["pane_info"],
  "pane.send_input": ["ok"],
  "pane.read": ["pane_read"],
  "pane.send_text": ["ok"],
  "pane.send_keys": ["ok"],
  "pane.close": ["ok"],
  "pane.wait_for_output": ["output_matched"],
  "agent.list": ["agent_list"],
  "agent.get": ["agent_info"],
  "agent.start": ["agent_started"],
  "agent.prompt": ["agent_prompted"],
  "agent.read": ["pane_read"],
  "agent.send_keys": ["ok"],
  "agent.focus": ["agent_info"],
  "agent.rename": ["agent_info"],
  "agent.wait": ["agent_info"],
} as const;

export type HerdrMethod = keyof typeof HERDR_METHOD_RESULT_TAGS;
type ResultTagFor<M extends HerdrMethod> =
  (typeof HERDR_METHOD_RESULT_TAGS)[M][number];
export type HerdrResultFor<M extends HerdrMethod> = Extract<
  HerdrResult,
  { readonly type: ResultTagFor<M> }
>;

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const WireEnvelope = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String }),
  [UnknownRecord],
);
const ErrorEnvelope = Schema.Struct({
  id: Schema.String,
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

export class HerdrTransportError extends Schema.TaggedErrorClass<HerdrTransportError>()(
  "HerdrTransportError",
  { operation: Schema.String, message: Schema.String },
) {}

export class HerdrProtocolError extends Schema.TaggedErrorClass<HerdrProtocolError>()(
  "HerdrProtocolError",
  { operation: Schema.String, message: Schema.String },
) {}

export class HerdrApiError extends Schema.TaggedErrorClass<HerdrApiError>()(
  "HerdrApiError",
  { operation: Schema.String, code: Schema.String, message: Schema.String },
) {}

export class HerdrTimeoutError extends Schema.TaggedErrorClass<HerdrTimeoutError>()(
  "HerdrTimeoutError",
  { operation: Schema.String, timeoutMs: Schema.Number, message: Schema.String },
) {}

export type HerdrError =
  | HerdrTransportError
  | HerdrProtocolError
  | HerdrApiError
  | HerdrTimeoutError;

export interface HerdrClientOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly requestId?: () => string;
  readonly session?: string;
  readonly socketPath?: string;
}

export interface HerdrRequest<M extends HerdrMethod = HerdrMethod> {
  readonly method: M;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Null disables the client-side timeout for a server-held watch socket. */
  readonly timeoutMs?: number | null;
  readonly onWritten?: () => void;
}

export interface HerdrClient {
  readonly request: <M extends HerdrMethod>(
    request: HerdrRequest<M>,
  ) => Effect.Effect<HerdrResultFor<M>, HerdrError>;
  readonly socketPath: () => string;
}

export function resolveHerdrSocketPath(options: HerdrClientOptions = {}): string {
  if (options.socketPath?.trim()) return options.socketPath;

  const home = options.home ?? homedir();
  if (options.session?.trim()) {
    return join(home, ".config", "herdr", "sessions", options.session, "herdr.sock");
  }

  const env = options.env ?? process.env;
  if (env.HERDR_SOCKET_PATH?.trim()) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SESSION?.trim()) {
    return join(home, ".config", "herdr", "sessions", env.HERDR_SESSION, "herdr.sock");
  }
  return join(home, ".config", "herdr", "herdr.sock");
}

function readOneLine(
  socketPath: string,
  line: string,
  operation: string,
  timeoutMs: number,
  onWritten?: () => void,
): Effect.Effect<string, HerdrTransportError | HerdrProtocolError | HerdrTimeoutError> {
  return Effect.callback((resume) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;

    const close = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const finish = (
      effect: Effect.Effect<
        string,
        HerdrTransportError | HerdrProtocolError | HerdrTimeoutError
      >,
    ) => {
      if (settled) return;
      settled = true;
      close();
      resume(effect);
    };

    if (timeoutMs > 0) socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(line, "utf8", (error) => {
        if (error) {
          finish(Effect.fail(new HerdrTransportError({ operation, message: error.message })));
          return;
        }
        onWritten?.();
      });
    });
    socket.on("data", (chunk: Buffer) => {
      byteCount += chunk.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        finish(
          Effect.fail(
            new HerdrProtocolError({
              operation,
              message: `response exceeded ${MAX_RESPONSE_BYTES} bytes`,
            }),
          ),
        );
        return;
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const newline = combined.indexOf(0x0a);
      if (newline < 0) return;
      finish(Effect.succeed(combined.subarray(0, newline).toString("utf8")));
    });
    socket.once("timeout", () => {
      finish(
        Effect.fail(
          new HerdrTimeoutError({
            operation,
            timeoutMs,
            message: `${operation} timed out after ${timeoutMs}ms`,
          }),
        ),
      );
    });
    socket.once("error", (error) => {
      finish(Effect.fail(new HerdrTransportError({ operation, message: error.message })));
    });
    socket.once("end", () => {
      finish(
        Effect.fail(
          new HerdrProtocolError({
            operation,
            message: "socket ended before one response line arrived",
          }),
        ),
      );
    });

    return Effect.sync(close);
  });
}

function isResultForMethod<M extends HerdrMethod>(
  method: M,
  result: HerdrResult,
): result is HerdrResultFor<M> {
  return (HERDR_METHOD_RESULT_TAGS[method] as readonly string[]).includes(result.type);
}

function decodeResponse<M extends HerdrMethod>(
  raw: string,
  requestId: string,
  operation: M,
): Effect.Effect<HerdrResultFor<M>, HerdrProtocolError | HerdrApiError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (error) =>
        new HerdrProtocolError({
          operation,
          message: `invalid JSON response: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    const envelope = yield* Schema.decodeUnknownEffect(WireEnvelope)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new HerdrProtocolError({
            operation,
            message: `invalid response envelope: ${String(error)}`,
          }),
      ),
    );
    if (envelope.id !== requestId) {
      return yield* new HerdrProtocolError({
        operation,
        message: `response id ${envelope.id} did not match request id ${requestId}`,
      });
    }

    if ("error" in envelope) {
      const decoded = yield* Schema.decodeUnknownEffect(ErrorEnvelope)(parsed).pipe(
        Effect.mapError(
          (error) =>
            new HerdrProtocolError({
              operation,
              message: `invalid error envelope: ${String(error)}`,
            }),
        ),
      );
      return yield* new HerdrApiError({
        operation,
        code: decoded.error.code,
        message: decoded.error.message,
      });
    }

    if (!("result" in envelope)) {
      return yield* new HerdrProtocolError({
        operation,
        message: "response contained neither result nor error",
      });
    }
    const result = yield* Schema.decodeUnknownEffect(HerdrResultSchema)(
      envelope.result,
    ).pipe(
      Effect.mapError(
        (error) =>
          new HerdrProtocolError({
            operation,
            message: `invalid Herdr result: ${String(error)}`,
          }),
      ),
    );
    if (!isResultForMethod(operation, result)) {
      return yield* new HerdrProtocolError({
        operation,
        message: `${operation} returned disallowed result tag ${result.type}; expected ${HERDR_METHOD_RESULT_TAGS[operation].join(" or ")}`,
      });
    }
    return result;
  });
}

export function createHerdrClient(options: HerdrClientOptions = {}): HerdrClient {
  const makeRequestId = options.requestId ?? (() => `bellwether-${randomUUID()}`);

  return {
    socketPath: () => resolveHerdrSocketPath(options),
    request<M extends HerdrMethod>(input: HerdrRequest<M>) {
      const requestId = makeRequestId();
      const wireRequest = {
        id: requestId,
        method: input.method,
        params: input.params ?? {},
      };
      const line = `${JSON.stringify(wireRequest)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_REQUEST_BYTES) {
        return Effect.fail(
          new HerdrProtocolError({
            operation: input.method,
            message: `request exceeded ${MAX_REQUEST_BYTES} bytes`,
          }),
        );
      }
      const timeoutMs =
        input.timeoutMs === null
          ? 0
          : (input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      return readOneLine(
        resolveHerdrSocketPath(options),
        line,
        input.method,
        timeoutMs,
        input.onWritten,
      ).pipe(
        Effect.flatMap((raw) => decodeResponse(raw, requestId, input.method)),
      );
    },
  };
}
