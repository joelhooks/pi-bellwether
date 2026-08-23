import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { assign, createActor, setup } from "xstate";

const MAX_BUFFER = 1024 * 1024;

export type PingWaitWake = "agent" | "notify";
export type PingWaitStatus =
  | "running"
  | "matched"
  | "timedOut"
  | "cancelled"
  | "failed";

export interface PingWaitInput {
  readonly cursorPath: string;
  readonly id: string;
  readonly label: string;
  readonly paneIds: readonly string[];
  readonly startedAt: number;
  readonly timeoutMs?: number;
  readonly wake: PingWaitWake;
}

export interface PingWaitContext extends PingWaitInput {
  readonly event?: Record<string, unknown>;
  readonly failure?: string;
  readonly rawEvent?: string;
}

export type PingWaitEvent =
  | {
      readonly event: Record<string, unknown>;
      readonly rawEvent: string;
      readonly type: "MATCH";
    }
  | { readonly type: "TIMEOUT" }
  | { readonly type: "CANCEL" }
  | { readonly failure: string; readonly type: "FAIL" };

export type PingWaitOutcome = PingWaitEvent;

export const pingWaitMachine = setup({
  types: {
    context: {} as PingWaitContext,
    events: {} as PingWaitEvent,
    input: {} as PingWaitInput,
  },
}).createMachine({
  context: ({ input }) => ({ ...input }),
  id: "herdrPingWait",
  initial: "running",
  states: {
    cancelled: { type: "final" },
    failed: { type: "final" },
    matched: { type: "final" },
    running: {
      on: {
        CANCEL: { target: "cancelled" },
        FAIL: {
          actions: assign({ failure: ({ event }) => event.failure }),
          target: "failed",
        },
        MATCH: {
          actions: assign({
            event: ({ event }) => event.event,
            rawEvent: ({ event }) => event.rawEvent,
          }),
          target: "matched",
        },
        TIMEOUT: { target: "timedOut" },
      },
    },
    timedOut: { type: "final" },
  },
});

export function createPingWaitActor(input: PingWaitInput) {
  return createActor(pingWaitMachine, { input });
}

export function terminalPingWaitStatus(value: unknown): Exclude<PingWaitStatus, "running"> | undefined {
  if (
    value === "matched" ||
    value === "timedOut" ||
    value === "cancelled" ||
    value === "failed"
  ) {
    return value;
  }
  return undefined;
}

function binaryCandidates(): string[] {
  return [
    process.env.HERDR_PING_WAIT_BIN,
    join(homedir(), ".local", "bin", "herdr-ping-wait"),
    "/opt/homebrew/bin/herdr-ping-wait",
    "/usr/local/bin/herdr-ping-wait",
  ].filter((path): path is string => Boolean(path));
}

export async function resolvePingWaitBinary(): Promise<string> {
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "herdr-ping-wait"));

  for (const path of [...binaryCandidates(), ...pathCandidates]) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "herdr-ping-wait is not executable; run the herdr-pings setup action first",
  );
}

function parseEvent(stdout: string): PingWaitOutcome {
  const rawEvent = stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!rawEvent) {
    return {
      failure: "herdr-ping-wait exited successfully without an event",
      type: "FAIL",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: `herdr-ping-wait returned invalid JSON: ${message}`,
      type: "FAIL",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      failure: "herdr-ping-wait returned a JSON value that was not an object",
      type: "FAIL",
    };
  }

  return {
    event: parsed as Record<string, unknown>,
    rawEvent,
    type: "MATCH",
  };
}

export function runPingWait(
  binary: string,
  input: PingWaitInput,
  signal: AbortSignal
): Promise<PingWaitOutcome> {
  const args = [...input.paneIds, "--cursor", input.cursorPath];
  if (input.timeoutMs !== undefined) {
    args.push("--timeout", String(input.timeoutMs / 1_000));
  }

  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { maxBuffer: MAX_BUFFER, signal },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          resolve({ type: "CANCEL" });
          return;
        }
        if (!error) {
          resolve(parseEvent(String(stdout)));
          return;
        }

        const nodeError = error as Error & { code?: string | number };
        if (nodeError.code === 2 || nodeError.code === "2") {
          resolve({ type: "TIMEOUT" });
          return;
        }

        const detail = String(stderr).trim() || nodeError.message;
        resolve({
          failure: `herdr-ping-wait failed${nodeError.code === undefined ? "" : ` (${nodeError.code})`}: ${detail.slice(0, 1_000)}`,
          type: "FAIL",
        });
      }
    );
  });
}
