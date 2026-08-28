import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { assign, createActor, fromCallback, setup } from "xstate";
import type { AnyActorRef, EventObject } from "xstate";

import {
  HerdrApiError,
  HerdrTimeoutError,
  HERDR_TRANSPORT_GRACE_MS,
  type HerdrClient,
  type HerdrError,
  type HerdrResult,
} from "./herdr-client.ts";

export const MAX_ACTIVE_WATCHES = 32;
/** Keep only the newest terminal receipts; active actors are stored separately. */
export const MAX_TERMINAL_WATCHES = 64;
/** Leaves room for the transport grace below Node's 2^31-1ms timer ceiling. */
export const MAX_WATCH_TIMEOUT_MS = 2_000_000_000;
/** Re-probe agent identity because a crashed TUI can return to a live shell without a wait event. */
export const DEFAULT_AGENT_PROBE_INTERVAL_MS = 5_000;

export type WatchKind = "agent_state" | "pane_output";
export type WatchWake = "agent" | "notify" | "silent";
export type WatchStatus =
  | "running"
  | "matched"
  | "timedOut"
  | "targetGone"
  | "failed"
  | "cancelled";
export type WatchPhase = "starting" | "running";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type ReadSource = "visible" | "recent" | "recent-unwrapped";

interface WatchBase {
  readonly kind: WatchKind;
  readonly label?: string;
  readonly timeoutMs?: number;
  readonly wake?: WatchWake;
}

export interface AgentStateWatchParams extends WatchBase {
  readonly kind: "agent_state";
  readonly target: string;
  readonly until?: readonly AgentStatus[];
}

export interface PaneOutputWatchParams extends WatchBase {
  readonly kind: "pane_output";
  readonly pane: string;
  readonly match: string;
  readonly regex?: boolean;
  readonly source?: ReadSource;
  readonly lines?: number;
  readonly raw?: boolean;
}

export type StartWatchParams = AgentStateWatchParams | PaneOutputWatchParams;

export interface WatchInput {
  readonly kind: WatchKind;
  readonly generation: number;
  readonly id: string;
  readonly label: string;
  readonly startedAt: number;
  readonly wake: WatchWake;
  readonly timeoutMs?: number;
  readonly target?: string;
  readonly until?: readonly AgentStatus[];
  readonly pane?: string;
  readonly match?: string;
  readonly regex?: boolean;
  readonly source?: ReadSource;
  readonly lines?: number;
  readonly raw?: boolean;
}

export type WatchOutcome =
  | { readonly kind: "matched"; readonly result: HerdrResult }
  | { readonly kind: "timedOut"; readonly failure: string }
  | { readonly kind: "targetGone"; readonly failure: string; readonly code?: string }
  | { readonly kind: "failed"; readonly failure: string; readonly code?: string };

type WatchContext = WatchInput & {
  readonly result?: HerdrResult;
  readonly failure?: string;
  readonly code?: string;
};

type WatchEvent =
  | { readonly type: "WRITTEN" }
  | { readonly type: "SETTLED"; readonly outcome: WatchOutcome }
  | { readonly type: "CANCEL" };

export interface WatchReceipt {
  readonly id: string;
  readonly kind: WatchKind;
  readonly label: string;
  readonly status: WatchStatus;
  readonly phase?: WatchPhase;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly wake: WatchWake;
  readonly target?: string;
  readonly pane?: string;
  readonly failure?: string;
  readonly code?: string;
  readonly result?: HerdrResult;
}

interface WatchRecord {
  readonly actor: AnyActorRef;
  readonly completion: Promise<void>;
  readonly generation: number;
  readonly input: WatchInput;
  subscription?: { unsubscribe(): void };
  failure?: string;
  code?: string;
  finishedAt?: number;
  result?: HerdrResult;
  status: WatchStatus;
  wakeSent: boolean;
}

export interface WorkflowReceiptWatchInput {
  readonly workflowId: string;
  readonly itemId?: string;
  readonly generation: number;
  readonly minimumSequence?: number;
}

/**
 * Deferred adapter seam. Bellwether does not own herdr-workflow leases or receipts.
 * A later adapter may observe that durable authority and return one tagged result.
 */
export interface WorkflowReceiptWatchAdapter {
  readonly watch: (
    input: WorkflowReceiptWatchInput,
    signal: AbortSignal,
  ) => Effect.Effect<HerdrResult, HerdrError>;
}

function defaultLabel(params: StartWatchParams): string {
  if (params.label?.trim()) return params.label.trim();
  return params.kind === "agent_state"
    ? `agent_state ${params.target}`
    : `pane_output ${params.pane}`;
}

function wireReadSource(source: ReadSource): string {
  return source === "recent-unwrapped" ? "recent_unwrapped" : source;
}

function watchRequest(
  client: HerdrClient,
  input: WatchInput,
  onWritten: () => void,
): Effect.Effect<HerdrResult, HerdrError> {
  const clientTimeoutMs =
    input.timeoutMs === undefined
      ? null
      : input.timeoutMs + HERDR_TRANSPORT_GRACE_MS;

  if (input.kind === "agent_state") {
    return client.request({
      method: "agent.wait",
      params: {
        target: input.target ?? "",
        until: input.until ?? [],
        ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
      },
      timeoutMs: clientTimeoutMs,
      onWritten,
    });
  }

  return client.request({
    method: "pane.wait_for_output",
    params: {
      pane_id: input.pane ?? "",
      source: wireReadSource(input.source ?? "recent-unwrapped"),
      ...(input.lines === undefined ? {} : { lines: input.lines }),
      match: {
        type: input.regex ? "regex" : "substring",
        value: input.match ?? "",
      },
      ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
      strip_ansi: input.raw !== true,
    },
    timeoutMs: clientTimeoutMs,
    onWritten,
  });
}

export function classifyWatchError(error: HerdrError): WatchOutcome {
  if (error instanceof HerdrApiError) {
    if (error.code === "timeout") {
      return { kind: "timedOut", failure: error.message };
    }
    if (error.code === "agent_not_running" || error.code === "agent_not_found") {
      return { kind: "targetGone", code: error.code, failure: error.message };
    }
    return { kind: "failed", code: error.code, failure: error.message };
  }
  if (error instanceof HerdrTimeoutError) {
    return { kind: "timedOut", failure: error.message };
  }
  return { kind: "failed", failure: error.message };
}

function watchedAgentStatuses(input: WatchInput): readonly AgentStatus[] {
  return input.until && input.until.length > 0
    ? input.until
    : ["idle", "done", "blocked"];
}

interface ProbedAgentIdentity {
  readonly terminalId: string;
  readonly expectedName?: string;
  readonly expectedAgent?: string;
}

function probedAgentIdentityMatches(
  current: Extract<HerdrResult, { readonly type: "agent_info" }>["agent"],
  expected: ProbedAgentIdentity,
): boolean {
  return (
    current.terminal_id === expected.terminalId &&
    (expected.expectedName === undefined || current.name === expected.expectedName) &&
    (expected.expectedAgent === undefined ||
      current.agent === expected.expectedAgent ||
      (current.agent === undefined && current.name !== undefined))
  );
}

function probeAgent(
  client: HerdrClient,
  input: WatchInput,
  intervalMs: number,
): Effect.Effect<WatchOutcome, never> {
  if (input.kind !== "agent_state") return Effect.never;

  return Effect.gen(function*() {
    let expected: ProbedAgentIdentity | undefined;

    while (true) {
      const observation = yield* client
        .request({
          method: "agent.get",
          params: { target: input.target ?? "" },
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ error } as const),
            onSuccess: (result) => ({ result } as const),
          }),
        );

      if ("error" in observation) {
        const outcome = classifyWatchError(observation.error);
        if (outcome.kind === "targetGone") return outcome;
      } else if (observation.result.type === "agent_info") {
        const current = observation.result.agent;
        if (expected !== undefined && !probedAgentIdentityMatches(current, expected)) {
          return {
            kind: "targetGone",
            code: "agent_replaced",
            failure: "agent identity changed while the watch was active",
          };
        }
        expected ??= {
          terminalId: current.terminal_id,
          expectedName: current.name === input.target ? current.name : undefined,
          expectedAgent: current.agent,
        };
        if (watchedAgentStatuses(input).includes(current.agent_status)) {
          return { kind: "matched", result: observation.result };
        }
      }

      yield* Effect.sleep(intervalMs);
    }
  });
}

function terminalStatus(value: unknown): Exclude<WatchStatus, "running"> | undefined {
  if (
    value === "matched" ||
    value === "timedOut" ||
    value === "targetGone" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}

function activePhase(value: unknown): WatchPhase | undefined {
  if (typeof value !== "object" || value === null || !("active" in value)) {
    return undefined;
  }
  const phase = (value as { active?: unknown }).active;
  return phase === "starting" || phase === "running" ? phase : undefined;
}

function receiptText(receipt: WatchReceipt): string {
  const lines = [
    `Bellwether watch ${receipt.id}: ${receipt.status}`,
    `Kind: ${receipt.kind}`,
    `Label: ${receipt.label}`,
  ];
  if (receipt.failure) lines.push(`Failure: ${receipt.failure}`);
  return lines.join("\n");
}

function wakeInstruction(status: Exclude<WatchStatus, "running">): string {
  if (status === "matched") {
    return "A Herdr watch matched. Inspect the receipt before continuing.";
  }
  if (status === "timedOut") {
    return "A Herdr watch timed out. Inspect the receipt and decide what to do next.";
  }
  if (status === "targetGone") {
    return "A Herdr watch target disappeared. Inspect the receipt before continuing.";
  }
  return "A Herdr watch failed. Inspect the receipt and decide what to do next.";
}

export interface WatchRegistryOptions {
  readonly client: HerdrClient;
  /** Internal health cadence. The public tool does not expose this tuning knob. */
  readonly agentProbeIntervalMs?: number;
  readonly sendMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: WatchReceipt;
    },
    options: { deliverAs: "followUp"; triggerTurn: true },
  ) => void;
  readonly notify?: (message: string, level: "info" | "warning" | "error") => void;
  readonly appendEntry?: (customType: string, data: unknown) => void;
  readonly onLifecycle?: (
    lifecycle: "started" | "settled" | "cancelled" | "failed",
    receipt: WatchReceipt,
  ) => void;
  readonly createId?: () => string;
  readonly now?: () => number;
}

export interface WatchToolContext {
  readonly mode?: string;
}

export function createWatchRegistry(options: WatchRegistryOptions) {
  const activeRecords = new Map<string, WatchRecord>();
  const terminalReceipts = new Map<string, WatchReceipt>();
  const now = options.now ?? Date.now;
  const agentProbeIntervalMs = Math.max(
    1,
    options.agentProbeIntervalMs ?? DEFAULT_AGENT_PROBE_INTERVAL_MS,
  );
  let generation = 0;
  let shuttingDown = false;

  const machine = setup({
    actors: {
      agentProbe: fromCallback<EventObject, WatchInput>(({ input, sendBack }) => {
        const controller = new AbortController();
        let disposed = false;
        void Effect.runPromise(
          probeAgent(options.client, input, agentProbeIntervalMs),
          { signal: controller.signal },
        ).then(
          (outcome) => {
            if (!disposed) sendBack({ type: "SETTLED", outcome });
          },
          () => {
            // Interruption is owned by a terminal transition or session shutdown.
          },
        );
        return () => {
          disposed = true;
          controller.abort();
        };
      }),
      waitSocket: fromCallback<EventObject, WatchInput>(({ input, sendBack }) => {
        const controller = new AbortController();
        let disposed = false;
        const effect = watchRequest(options.client, input, () => {
          if (!disposed) sendBack({ type: "WRITTEN" });
        }).pipe(
          Effect.match({
            onFailure: classifyWatchError,
            onSuccess: (result): WatchOutcome => ({ kind: "matched", result }),
          }),
        );
        void Effect.runPromise(effect, { signal: controller.signal }).then(
          (outcome) => {
            if (!disposed) sendBack({ type: "SETTLED", outcome });
          },
          () => {
            // Interruption is owned by CANCEL or session shutdown.
          },
        );
        return () => {
          disposed = true;
          controller.abort();
        };
      }),
    },
    types: {
      context: {} as WatchContext,
      events: {} as WatchEvent,
      input: {} as WatchInput,
    },
  }).createMachine({
    context: ({ input }) => ({ ...input }),
    id: "bellwetherHerdrWatch",
    initial: "active",
    states: {
      active: {
        initial: "starting",
        invoke: [
          {
            input: ({ context }) => context,
            src: "waitSocket",
          },
          {
            input: ({ context }) => context,
            src: "agentProbe",
          },
        ],
        states: {
          starting: {
            on: { WRITTEN: { target: "running" } },
          },
          running: {},
        },
        on: {
          CANCEL: { target: "#bellwetherHerdrWatch.cancelled" },
          SETTLED: [
            {
              actions: assign({
                result: ({ event }) =>
                  event.outcome.kind === "matched" ? event.outcome.result : undefined,
              }),
              guard: ({ event }) => event.outcome.kind === "matched",
              target: "#bellwetherHerdrWatch.matched",
            },
            {
              actions: assign({
                failure: ({ event }) =>
                  "failure" in event.outcome ? event.outcome.failure : undefined,
              }),
              guard: ({ event }) => event.outcome.kind === "timedOut",
              target: "#bellwetherHerdrWatch.timedOut",
            },
            {
              actions: assign({
                code: ({ event }) =>
                  event.outcome.kind === "targetGone" ? event.outcome.code : undefined,
                failure: ({ event }) =>
                  "failure" in event.outcome ? event.outcome.failure : undefined,
              }),
              guard: ({ event }) => event.outcome.kind === "targetGone",
              target: "#bellwetherHerdrWatch.targetGone",
            },
            {
              actions: assign({
                code: ({ event }) =>
                  event.outcome.kind === "failed" ? event.outcome.code : undefined,
                failure: ({ event }) =>
                  "failure" in event.outcome ? event.outcome.failure : undefined,
              }),
              target: "#bellwetherHerdrWatch.failed",
            },
          ],
        },
      },
      cancelled: { type: "final" },
      failed: { type: "final" },
      matched: { type: "final" },
      targetGone: { type: "final" },
      timedOut: { type: "final" },
    },
  });

  const activeWatches = () => [...activeRecords.values()];

  const toReceipt = (record: WatchRecord): WatchReceipt => {
    const snapshot = record.actor.getSnapshot() as {
      context: WatchContext;
      value: unknown;
    };
    return {
      id: record.input.id,
      kind: record.input.kind,
      label: record.input.label,
      status: record.status,
      phase: record.status === "running" ? activePhase(snapshot.value) : undefined,
      startedAt: new Date(record.input.startedAt).toISOString(),
      finishedAt:
        record.finishedAt === undefined
          ? undefined
          : new Date(record.finishedAt).toISOString(),
      wake: record.input.wake,
      target: record.input.kind === "agent_state" ? record.input.target : undefined,
      pane: record.input.kind === "pane_output" ? record.input.pane : undefined,
      failure: record.failure,
      code: record.code,
      result: record.result,
    };
  };

  const retainTerminal = (receipt: WatchReceipt) => {
    terminalReceipts.set(receipt.id, receipt);
    while (terminalReceipts.size > MAX_TERMINAL_WATCHES) {
      const oldest = terminalReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      terminalReceipts.delete(oldest);
    }
  };

  const finishWatch = (
    record: WatchRecord,
    status: Exclude<WatchStatus, "running">,
    actorFailure?: string,
  ) => {
    if (record.status !== "running") return;
    const snapshot = record.actor.getSnapshot() as { context: WatchContext };
    record.status = status;
    record.finishedAt = now();
    record.failure = actorFailure ?? snapshot.context.failure ?? record.failure;
    record.code = snapshot.context.code ?? record.code;
    record.result = snapshot.context.result ?? record.result;

    const receipt = toReceipt(record);
    activeRecords.delete(record.input.id);
    record.subscription?.unsubscribe();
    record.subscription = undefined;
    record.actor.stop();
    retainTerminal(receipt);

    const lifecycle =
      status === "cancelled"
        ? "cancelled"
        : status === "failed"
          ? "failed"
          : "settled";
    options.onLifecycle?.(lifecycle, receipt);
    if (shuttingDown || status === "cancelled" || record.generation !== generation) {
      return;
    }

    options.appendEntry?.("bellwether-herdr-watch-finished", receipt);
    if (receipt.wake === "silent") return;
    if (receipt.wake === "notify") {
      options.notify?.(
        `${receipt.label}: ${receipt.status}`,
        status === "matched" ? "info" : "warning",
      );
      return;
    }
    if (record.wakeSent) return;
    record.wakeSent = true;
    options.sendMessage(
      {
        content: `${wakeInstruction(status)}\n\n${receiptText(receipt)}`,
        customType: "bellwether-herdr-watch",
        details: receipt,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const receiptFor = (id: string): WatchReceipt => {
    const active = activeRecords.get(id);
    if (active) return toReceipt(active);
    const terminal = terminalReceipts.get(id);
    if (terminal) return terminal;
    throw new Error(`unknown Herdr watch: ${id}`);
  };

  return {
    bumpGeneration() {
      generation += 1;
    },
    cancel(id: string): WatchReceipt {
      const record = activeRecords.get(id);
      if (!record) return receiptFor(id);
      record.actor.send({ type: "CANCEL" });
      return receiptFor(id);
    },
    list(): WatchReceipt[] {
      return [
        ...terminalReceipts.values(),
        ...activeWatches().map(toReceipt),
      ];
    },
    active(): WatchReceipt[] {
      return activeWatches().map(toReceipt);
    },
    stats() {
      return {
        active: activeRecords.size,
        retained: terminalReceipts.size,
        subscriptions: [...activeRecords.values()].filter(
          (record) => record.subscription !== undefined,
        ).length,
      };
    },
    async shutdown() {
      shuttingDown = true;
      const active = activeWatches();
      for (const record of active) record.actor.send({ type: "CANCEL" });
      await Promise.allSettled(active.map((record) => record.completion));
      for (const record of activeRecords.values()) {
        record.subscription?.unsubscribe();
        record.actor.stop();
      }
      activeRecords.clear();
      terminalReceipts.clear();
    },
    start(params: StartWatchParams, ctx: WatchToolContext): WatchReceipt {
      if (ctx.mode === "print" || ctx.mode === "json") {
        throw new Error("herdr_watch requires a long-lived interactive or RPC Pi process");
      }
      if (activeWatches().length >= MAX_ACTIVE_WATCHES) {
        throw new Error(`herdr_watch allows at most ${MAX_ACTIVE_WATCHES} active watches`);
      }
      if (params.timeoutMs !== undefined && params.timeoutMs < 1) {
        throw new Error("watch timeout must be at least 1ms");
      }
      if (
        params.timeoutMs !== undefined &&
        params.timeoutMs > MAX_WATCH_TIMEOUT_MS
      ) {
        throw new Error(`watch timeout must be at most ${MAX_WATCH_TIMEOUT_MS}ms`);
      }
      if (params.kind === "agent_state" && !params.target.trim()) {
        throw new Error("target is required for agent_state");
      }
      if (params.kind === "pane_output" && (!params.pane.trim() || !params.match)) {
        throw new Error("pane and match are required for pane_output");
      }

      const id = (options.createId ?? (() => randomUUID().slice(0, 8)))();
      const input: WatchInput = {
        ...params,
        generation,
        id,
        label: defaultLabel(params),
        startedAt: now(),
        wake: params.wake ?? "agent",
      };
      const actor = createActor(machine, { input });
      let resolveCompletion: () => void = () => {};
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const record: WatchRecord = {
        actor,
        completion,
        generation,
        input,
        status: "running",
        wakeSent: false,
      };
      activeRecords.set(id, record);
      record.subscription = actor.subscribe({
        error(error) {
          if (record.status === "running") {
            finishWatch(
              record,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
          }
          resolveCompletion();
        },
        next(snapshot) {
          const status = terminalStatus(snapshot.value);
          if (snapshot.status === "done" && status) {
            finishWatch(record, status);
            resolveCompletion();
          }
        },
      });
      actor.start();
      const receipt = toReceipt(record);
      options.appendEntry?.("bellwether-herdr-watch-started", receipt);
      options.onLifecycle?.("started", receipt);
      return receipt;
    },
    status: receiptFor,
  };
}

export type WatchRegistry = ReturnType<typeof createWatchRegistry>;
