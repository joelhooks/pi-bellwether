import { describe, expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  INTERCOM_SIGNAL_ENTRY_TYPE,
  PRESENCE_CHATTER_WARN_THRESHOLD,
  countPresenceChatter,
  isPresenceChatter,
  presenceChatterWarning,
} from "./chatter.ts";

const custom = (customType: string, data: unknown, id = "e1"): SessionEntry =>
  ({
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType,
    data,
  }) as SessionEntry;

const signal = (kind: string, id = "e1") =>
  custom(INTERCOM_SIGNAL_ENTRY_TYPE, { eventId: "x", kind, sourceSessionId: "s" }, id);

describe("presence chatter detection", () => {
  test("counts only capability and binding intercom signals", () => {
    const entries: SessionEntry[] = [
      signal("capability", "a"),
      signal("binding", "b"),
      signal("watch", "c"),
      signal("workflow_receipt", "d"),
      custom("bellwether-suspended", { watches: [] }, "e"),
      custom(INTERCOM_SIGNAL_ENTRY_TYPE, "not an object", "f"),
      { type: "message", id: "g", parentId: null, timestamp: "", message: {} } as unknown as SessionEntry,
    ];
    expect(entries.map(isPresenceChatter)).toEqual([true, true, false, false, false, false, false]);
    expect(countPresenceChatter(entries)).toBe(2);
  });

  test("warns only at or above the threshold and names the script and file", () => {
    const options = { scriptPath: "/pkg/scripts/strip-intercom-chatter.mjs", sessionFile: "/s/a.jsonl" };
    expect(presenceChatterWarning(PRESENCE_CHATTER_WARN_THRESHOLD - 1, options)).toBeUndefined();
    const warning = presenceChatterWarning(525_784, options);
    expect(warning).toContain("525,784");
    expect(warning).toContain("node /pkg/scripts/strip-intercom-chatter.mjs /s/a.jsonl --apply");
    expect(presenceChatterWarning(2_000, { scriptPath: "/pkg/s.mjs" })).toContain("<session.jsonl>");
  });
});
