import { describe, expect, test } from "vitest";

import { createPromptGate } from "./prompt-gate.ts";

describe("prompt gate", () => {
  test("opens at once when no prompt is pending", () => {
    const gate = createPromptGate();
    expect(gate.gateFor("worker")).toBeUndefined();
  });

  test("holds a watch until the pending prompt proves life", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "worker");
    const pending = gate.gateFor("worker");
    expect(pending).toBeDefined();

    let settled = false;
    void pending?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.settle("call-1", { proven: true, paneId: "w1:p1", agentName: "worker" });
    await expect(pending).resolves.toEqual({ kind: "open" });
  });

  test("fails a watch whose target prompt returned no proof of life", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "worker");
    const pending = gate.gateFor("worker");
    gate.settle("call-1", { proven: false, reason: "agent_prompt_stalled" });
    await expect(pending).resolves.toEqual({
      kind: "unproven",
      target: "worker",
      reason: "agent_prompt_stalled",
    });
  });

  test("matches a pane-id watch to a prompt sent by agent name", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "worker");
    const pending = gate.gateFor("w1:p1");
    gate.settle("call-1", {
      proven: false,
      paneId: "w1:p1",
      agentName: "worker",
      reason: "proof timed out",
    });
    await expect(pending).resolves.toMatchObject({ kind: "unproven" });
  });

  test("an unrelated failed prompt delays but does not fail the watch", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "other");
    const pending = gate.gateFor("worker");
    gate.settle("call-1", { proven: false, paneId: "w1:p9", reason: "stalled" });
    await expect(pending).resolves.toEqual({ kind: "open" });
  });

  test("sweep settles prompt calls that never executed as unproven", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "worker");
    const pending = gate.gateFor("worker");
    gate.sweep("prompt call did not execute");
    await expect(pending).resolves.toEqual({
      kind: "unproven",
      target: "worker",
      reason: "prompt call did not execute",
    });
    expect(gate.gateFor("worker")).toBeUndefined();
  });

  test("announce is idempotent and settle ignores unknown calls", async () => {
    const gate = createPromptGate();
    gate.announce("call-1", "worker");
    gate.announce("call-1", "worker");
    gate.settle("unknown", { proven: true });
    const pending = gate.gateFor("worker");
    gate.settle("call-1", { proven: true, paneId: "w1:p1" });
    await expect(pending).resolves.toEqual({ kind: "open" });
    expect(gate.gateFor("worker")).toBeUndefined();
  });
});
