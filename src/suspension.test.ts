import { describe, expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  BELLWETHER_SUSPENDED_ENTRY_TYPE,
  bellwetherSuspensionData,
  bellwetherSuspensionFrom,
} from "./suspension.ts";
import type { SuspendedWatch } from "./watch.ts";
import type { SuspendedPingWait } from "./suspension.ts";

const watch: SuspendedWatch = {
  expiresAt: 70_000,
  input: {
    id: "watch-1",
    kind: "pane_output",
    label: "worker done",
    match: "DONE",
    pane: "w1:p1",
    startedAt: 10_000,
    timeoutMs: 60_000,
    wake: "agent",
  },
};

const pingWait: SuspendedPingWait = {
  expiresAt: 70_000,
  input: {
    cursorPath: "/tmp/watch.cursor.json",
    id: "ping-1",
    label: "fallback",
    paneIds: ["w1:p1"],
    startedAt: 10_000,
    timeoutMs: 60_000,
    wake: "notify",
  },
};

const entry = (data: unknown): SessionEntry => ({
  type: "custom",
  id: "entry-1",
  parentId: null,
  timestamp: new Date(0).toISOString(),
  customType: BELLWETHER_SUSPENDED_ENTRY_TYPE,
  data,
} as SessionEntry);

describe("Bellwether reload suspension", () => {
  test("round-trips active direct and degraded waits", () => {
    const data = bellwetherSuspensionData([watch], [pingWait], 20_000);
    expect(bellwetherSuspensionFrom([entry(data)])).toEqual(data);
  });

  test("the newest suspension is authoritative, including empty and malformed entries", () => {
    const stale = entry(bellwetherSuspensionData([watch], [pingWait], 20_000));
    const empty = entry(bellwetherSuspensionData([], [], 21_000));
    expect(bellwetherSuspensionFrom([stale, empty])).toMatchObject({
      watches: [],
      pingWaits: [],
    });
    expect(bellwetherSuspensionFrom([stale, entry({ bad: true })])).toMatchObject({
      watches: [],
      pingWaits: [],
    });
  });

  test("does not restore a reload entry on an unrelated custom entry", () => {
    const unrelated = {
      ...entry(bellwetherSuspensionData([watch], [pingWait], 20_000)),
      customType: "other-extension",
    } as SessionEntry;
    expect(bellwetherSuspensionFrom([unrelated])).toMatchObject({
      watches: [],
      pingWaits: [],
    });
  });
});
