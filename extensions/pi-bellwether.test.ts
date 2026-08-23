import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import bellwetherExtension from "./pi-bellwether.ts";

const temporaryDirectories: string[] = [];
const originalWaiterBinary = process.env.HERDR_PING_WAIT_BIN;

afterEach(async () => {
  if (originalWaiterBinary === undefined) {
    delete process.env.HERDR_PING_WAIT_BIN;
  } else {
    process.env.HERDR_PING_WAIT_BIN = originalWaiterBinary;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

interface TestTool {
  readonly name: string;
  readonly execute: (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly text: string }[];
  }>;
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

test("herdr_ping_wait returns before the waiter event and wakes Pi later", async () => {
  process.env.HERDR_PING_WAIT_BIN = await waiterExecutable();

  const tools = new Map<string, TestTool>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: unknown[] = [];
  const apiDouble = {
    appendEntry() {},
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
  // SAFETY: the extension factory only uses the five methods supplied above.
  bellwetherExtension(apiDouble as unknown as ExtensionAPI);

  const tool = tools.get("herdr_ping_wait");
  if (!tool) throw new Error("herdr_ping_wait was not registered");
  const context = {
    mode: "tui",
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify() {} },
  };

  const startedAt = performance.now();
  const result = await tool.execute(
    "call-1",
    { action: "start", paneIds: ["w1:p1"] },
    undefined,
    undefined,
    context,
  );
  const elapsedMs = performance.now() - startedAt;

  expect(elapsedMs).toBeLessThan(200);
  expect(result.content[0]?.text).toContain("without blocking this turn");
  expect(messages).toHaveLength(0);

  const deadline = Date.now() + 2_000;
  while (messages.length === 0 && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ customType: "herdr-ping-wait" });

  await handlers.get("session_shutdown")?.();
});
