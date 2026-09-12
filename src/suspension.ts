import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { PingWaitInput } from "./ping-wait.ts";
import type { SuspendedWatch } from "./watch.ts";

export const BELLWETHER_SUSPENDED_ENTRY_TYPE = "bellwether-suspended";
export const BELLWETHER_SUSPENSION_VERSION = 1;

const wakeSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("notify"),
  Type.Literal("silent"),
]);

const watchBaseSchema = {
  id: Type.String(),
  label: Type.String(),
  startedAt: Type.Number(),
  wake: wakeSchema,
  timeoutMs: Type.Optional(Type.Number()),
};

const watchInputSchema = Type.Union([
  Type.Object(
    {
      ...watchBaseSchema,
      kind: Type.Literal("agent_state"),
      target: Type.String(),
      until: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("idle"),
            Type.Literal("working"),
            Type.Literal("blocked"),
            Type.Literal("done"),
            Type.Literal("unknown"),
          ]),
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...watchBaseSchema,
      kind: Type.Literal("pane_output"),
      pane: Type.String(),
      match: Type.String(),
      regex: Type.Optional(Type.Boolean()),
      source: Type.Optional(
        Type.Union([
          Type.Literal("visible"),
          Type.Literal("recent"),
          Type.Literal("recent-unwrapped"),
        ]),
      ),
      lines: Type.Optional(Type.Number()),
      raw: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

const suspendedWatchSchema = Type.Object(
  {
    expiresAt: Type.Optional(Type.Number()),
    input: watchInputSchema,
  },
  { additionalProperties: false },
);

const pingWaitInputSchema = Type.Object(
  {
    cursorPath: Type.String(),
    id: Type.String(),
    label: Type.String(),
    paneIds: Type.Array(Type.String()),
    startedAt: Type.Number(),
    timeoutMs: Type.Optional(Type.Number()),
    wake: Type.Union([Type.Literal("agent"), Type.Literal("notify")]),
  },
  { additionalProperties: false },
);

const suspendedPingWaitSchema = Type.Object(
  {
    expiresAt: Type.Optional(Type.Number()),
    input: pingWaitInputSchema,
  },
  { additionalProperties: false },
);

const suspensionDataSchema = Type.Object(
  {
    pingWaits: Type.Array(suspendedPingWaitSchema),
    suspendedAt: Type.String(),
    v: Type.Literal(BELLWETHER_SUSPENSION_VERSION),
    watches: Type.Array(suspendedWatchSchema),
  },
  { additionalProperties: false },
);

export interface SuspendedPingWait {
  readonly expiresAt?: number;
  readonly input: PingWaitInput;
}

export interface BellwetherSuspensionData {
  readonly pingWaits: readonly SuspendedPingWait[];
  readonly suspendedAt: string;
  readonly v: typeof BELLWETHER_SUSPENSION_VERSION;
  readonly watches: readonly SuspendedWatch[];
}

export const bellwetherSuspensionData = (
  watches: readonly SuspendedWatch[],
  pingWaits: readonly SuspendedPingWait[],
  now: number,
): BellwetherSuspensionData => ({
  pingWaits: [...pingWaits],
  suspendedAt: new Date(now).toISOString(),
  v: BELLWETHER_SUSPENSION_VERSION,
  watches: [...watches],
});

const EMPTY_SUSPENSION: BellwetherSuspensionData = {
  pingWaits: [],
  suspendedAt: new Date(0).toISOString(),
  v: BELLWETHER_SUSPENSION_VERSION,
  watches: [],
};

/** The newest suspension entry is authoritative; malformed data restores nothing. */
export const bellwetherSuspensionFrom = (
  entries: readonly SessionEntry[],
): BellwetherSuspensionData => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom"
      || entry.customType !== BELLWETHER_SUSPENDED_ENTRY_TYPE
    ) {
      continue;
    }
    return Value.Check(suspensionDataSchema, entry.data)
      ? entry.data
      : EMPTY_SUSPENSION;
  }
  return EMPTY_SUSPENSION;
};
