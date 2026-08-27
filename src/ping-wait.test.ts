import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createPingWaitActor,
  runPingWait,
  terminalPingWaitStatus,
} from "./ping-wait.ts";
import type { PingWaitInput } from "./ping-wait.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

function input(overrides: Partial<PingWaitInput> = {}): PingWaitInput {
  return {
    cursorPath: "/tmp/test.cursor.json",
    id: "wait-test",
    label: "test wait",
    paneIds: ["w1:p1"],
    startedAt: Date.now(),
    wake: "agent",
    ...overrides,
  };
}

async function executable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-bellwether-wait-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "waiter.js");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("ping wait state machine", () => {
  test("records a matched event as terminal state", () => {
    const actor = createPingWaitActor(input());
    actor.start();
    actor.send({
      event: { pane_id: "w1:p1", type: "turn_ended" },
      rawEvent: '{"type":"turn_ended"}',
      type: "MATCH",
    });

    const snapshot = actor.getSnapshot();
    expect(snapshot.status).toBe("done");
    expect(terminalPingWaitStatus(snapshot.value)).toBe("matched");
    expect(snapshot.context.event).toEqual({
      pane_id: "w1:p1",
      type: "turn_ended",
    });
  });

  test("cancellation is terminal", () => {
    const actor = createPingWaitActor(input());
    actor.start();
    actor.send({ type: "CANCEL" });

    expect(terminalPingWaitStatus(actor.getSnapshot().value)).toBe("cancelled");
  });
});

describe("ping wait process adapter", () => {
  test("parses one JSON event", async () => {
    const binary = await executable(
      'process.stdout.write(JSON.stringify({ type: "turn_ended", pane_id: "w1:p1" }) + "\\n");',
    );

    const outcome = await runPingWait(binary, input(), new AbortController().signal);
    expect(outcome).toEqual({
      event: { pane_id: "w1:p1", type: "turn_ended" },
      rawEvent: '{"type":"turn_ended","pane_id":"w1:p1"}',
      type: "MATCH",
    });
  });

  test("maps waiter exit 2 to timeout", async () => {
    const binary = await executable("process.exit(2);");

    await expect(
      runPingWait(binary, input(), new AbortController().signal),
    ).resolves.toEqual({ type: "TIMEOUT" });
  });

  test("rejects invalid event JSON at the process boundary", async () => {
    const binary = await executable('process.stdout.write("not-json\\n");');

    const outcome = await runPingWait(
      binary,
      input(),
      new AbortController().signal,
    );
    expect(outcome.type).toBe("FAIL");
    if (outcome.type !== "FAIL") throw new Error("expected FAIL outcome");
    expect(outcome.failure).toContain("invalid JSON");
  });

  test("aborting resolves as cancellation", async () => {
    const binary = await executable("setInterval(() => {}, 1_000);");
    const controller = new AbortController();
    const running = runPingWait(binary, input(), controller.signal);
    controller.abort();

    await expect(running).resolves.toEqual({ type: "CANCEL" });
  });
});
