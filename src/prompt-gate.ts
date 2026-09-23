/**
 * Orders `herdr_agent prompt` before `agent_state` watches from the same turn.
 *
 * Pi runs tool calls in parallel by default, and Herdr `agent.wait` returns at
 * once when the agent already sits in a requested state. A watch that races its
 * own prompt therefore matches the previous task's leftover idle state. The
 * extension announces every prompt call when the assistant message ends, before
 * any tool executes, so a watch can wait for that prompt's proof of life.
 */

export interface PromptProofSummary {
  readonly proven: boolean;
  readonly paneId?: string;
  readonly agentName?: string;
  readonly reason?: string;
}

export type PromptGateOutcome =
  | { readonly kind: "open" }
  | { readonly kind: "unproven"; readonly target: string; readonly reason: string };

interface PendingPrompt {
  readonly target: string;
  readonly settled: Promise<PromptProofSummary>;
  readonly resolve: (proof: PromptProofSummary) => void;
}

export interface PromptGate {
  /** Record a prompt call before it executes. Repeated announcements are ignored. */
  readonly announce: (callId: string, target: string) => void;
  /** Record the prompt call's proof-of-life outcome. Unknown calls are ignored. */
  readonly settle: (callId: string, proof: PromptProofSummary) => void;
  /** Settle every pending prompt as unproven, e.g. calls that never executed. */
  readonly sweep: (reason: string) => void;
  /** Undefined when no prompt is pending; the watch may arm at once. */
  readonly gateFor: (target: string) => Promise<PromptGateOutcome> | undefined;
}

function targets(prompt: PendingPrompt, proof: PromptProofSummary, target: string) {
  return (
    prompt.target === target ||
    proof.paneId === target ||
    proof.agentName === target
  );
}

export function createPromptGate(): PromptGate {
  const pending = new Map<string, PendingPrompt>();

  const settle = (callId: string, proof: PromptProofSummary) => {
    const prompt = pending.get(callId);
    if (!prompt) return;
    pending.delete(callId);
    prompt.resolve(proof);
  };

  return {
    announce(callId, target) {
      if (pending.has(callId)) return;
      let resolve: (proof: PromptProofSummary) => void = () => {};
      const settled = new Promise<PromptProofSummary>((done) => {
        resolve = done;
      });
      pending.set(callId, { target, settled, resolve });
    },
    settle,
    sweep(reason) {
      for (const callId of [...pending.keys()]) {
        settle(callId, { proven: false, reason });
      }
    },
    gateFor(target) {
      // Wait for every prompt pending now. An unrelated prompt only delays
      // arming by its bounded proof deadline; the name-versus-pane match is
      // known only after a prompt resolves its target.
      const snapshot = [...pending.values()];
      if (snapshot.length === 0) return undefined;
      return Promise.all(
        snapshot.map(async (prompt) => ({ prompt, proof: await prompt.settled })),
      ).then((results) => {
        const failed = results.find(
          ({ prompt, proof }) => !proof.proven && targets(prompt, proof, target),
        );
        return failed
          ? {
              kind: "unproven",
              target,
              reason: failed.proof.reason ?? "prompt returned no proof of life",
            }
          : { kind: "open" };
      });
    },
  };
}
