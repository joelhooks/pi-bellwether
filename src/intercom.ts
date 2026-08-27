import { randomUUID } from "node:crypto";

import type { WatchReceipt } from "./watch.ts";

export const BELLWETHER_INTERCOM_NAMESPACE = "bellwether/herdr/v1";
export const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
export const INTERCOM_EXTENSION_REGISTRY_READY_EVENT =
  "intercom:extension-registry-ready";
export const INTERCOM_DEDUPE_LIMIT = 256;

interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): (() => void) | void;
}

interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): { connected: boolean; supported: boolean };
  publish(
    payload: unknown,
    options?: { audience?: "owner" | "capable"; ownerOnly?: boolean },
  ): void;
}

interface SessionInfo {
  readonly id: string;
}

type IntercomExtensionEvent =
  | { readonly type: "connection"; readonly connected: boolean; readonly supported: boolean }
  | { readonly type: "message"; readonly fromSessionId: string; readonly payload: unknown }
  | { readonly type: "session_joined"; readonly session: SessionInfo }
  | { readonly type: "session_left"; readonly sessionId: string }
  | { readonly type: "presence_update"; readonly session: SessionInfo }
  | { readonly type: string; readonly [key: string]: unknown };

interface SignalBase {
  readonly version: 1;
  readonly eventId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId?: string;
  readonly targetPaneId?: string;
}

export type BellwetherWakeHint = SignalBase & {
  readonly kind: "wake_hint";
  readonly watchId?: string;
};

export type BellwetherWorkflowReceiptHint = SignalBase & {
  readonly kind: "workflow_receipt";
  readonly workflowId: string;
  readonly itemId?: string;
  readonly generation: number;
  readonly sequence: number;
};

export type BellwetherSignal =
  | (SignalBase & { readonly kind: "capability"; readonly protocol: 1 })
  | (SignalBase & { readonly kind: "binding"; readonly paneId?: string })
  | (SignalBase & {
      readonly kind: "watch";
      readonly watchId: string;
      readonly watchKind: WatchReceipt["kind"];
      readonly status: WatchReceipt["status"];
      readonly phase?: WatchReceipt["phase"];
      readonly pane?: string;
      readonly target?: string;
      readonly lifecycle:
        | "started"
        | "settled"
        | "cancelled"
        | "failed"
        | "reconciled";
    })
  | BellwetherWakeHint
  | BellwetherWorkflowReceiptHint;

export interface TargetedSignal {
  readonly targetSessionId?: string;
  readonly targetPaneId?: string;
}

export interface IntercomCoordinationOptions {
  readonly events: EventBus;
  readonly sessionId: string;
  readonly paneId?: string;
  readonly activeWatches: () => readonly WatchReceipt[];
  readonly wake: (signal: BellwetherWakeHint) => void;
  readonly onSignal?: (signal: BellwetherSignal) => void;
  readonly createEventId?: () => string;
}

export interface IntercomCoordination {
  readonly announce: () => void;
  readonly publishWatch: (
    lifecycle: "started" | "settled" | "cancelled" | "failed",
    receipt: WatchReceipt,
  ) => void;
  readonly publishWake: (
    target: TargetedSignal & { readonly watchId?: string },
  ) => void;
  readonly publishWorkflowReceipt: (
    hint: TargetedSignal & {
      readonly workflowId: string;
      readonly itemId?: string;
      readonly generation: number;
      readonly sequence: number;
    },
  ) => void;
  readonly dispose: () => void;
  readonly snapshot: () => { connected: boolean; supported: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWatchStatus(value: unknown): value is WatchReceipt["status"] {
  return (
    value === "running" ||
    value === "matched" ||
    value === "timedOut" ||
    value === "targetGone" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isWatchLifecycle(
  value: unknown,
): value is "started" | "settled" | "cancelled" | "failed" | "reconciled" {
  return (
    value === "started" ||
    value === "settled" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "reconciled"
  );
}

function validBase(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    typeof value.eventId === "string" &&
    typeof value.sourceSessionId === "string" &&
    typeof value.kind === "string" &&
    (value.targetSessionId === undefined || typeof value.targetSessionId === "string") &&
    (value.targetPaneId === undefined || typeof value.targetPaneId === "string")
  );
}

export function decodeBellwetherSignal(value: unknown): BellwetherSignal | undefined {
  if (!isRecord(value) || !validBase(value)) return undefined;

  const base = {
    version: 1 as const,
    eventId: value.eventId as string,
    sourceSessionId: value.sourceSessionId as string,
    targetSessionId: value.targetSessionId as string | undefined,
    targetPaneId: value.targetPaneId as string | undefined,
  };
  if (value.kind === "capability" && value.protocol === 1) {
    return { ...base, kind: "capability", protocol: 1 };
  }
  if (
    value.kind === "binding" &&
    (value.paneId === undefined || typeof value.paneId === "string")
  ) {
    return { ...base, kind: "binding", paneId: value.paneId };
  }
  if (
    value.kind === "wake_hint" &&
    (value.watchId === undefined || typeof value.watchId === "string")
  ) {
    return { ...base, kind: "wake_hint", watchId: value.watchId };
  }
  if (
    value.kind === "workflow_receipt" &&
    typeof value.workflowId === "string" &&
    (value.itemId === undefined || typeof value.itemId === "string") &&
    Number.isInteger(value.generation) &&
    (value.generation as number) >= 1 &&
    Number.isInteger(value.sequence) &&
    (value.sequence as number) >= 0
  ) {
    return {
      ...base,
      kind: "workflow_receipt",
      workflowId: value.workflowId,
      itemId: value.itemId,
      generation: value.generation as number,
      sequence: value.sequence as number,
    };
  }
  if (
    value.kind === "watch" &&
    typeof value.watchId === "string" &&
    (value.watchKind === "agent_state" || value.watchKind === "pane_output") &&
    isWatchStatus(value.status) &&
    isWatchLifecycle(value.lifecycle) &&
    (value.phase === undefined || value.phase === "starting" || value.phase === "running") &&
    (value.pane === undefined || typeof value.pane === "string") &&
    (value.target === undefined || typeof value.target === "string")
  ) {
    return {
      ...base,
      kind: "watch",
      watchId: value.watchId,
      watchKind: value.watchKind,
      status: value.status,
      lifecycle: value.lifecycle,
      phase: value.phase,
      pane: value.pane,
      target: value.target,
    };
  }
  return undefined;
}

function hasTarget(target: TargetedSignal): boolean {
  return Boolean(target.targetSessionId?.trim() || target.targetPaneId?.trim());
}

export function createIntercomCoordination(
  options: IntercomCoordinationOptions,
): IntercomCoordination {
  const makeEventId = options.createEventId ?? (() => randomUUID());
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let channel: IntercomExtensionChannel | undefined;
  let disposed = false;
  let registered = false;

  const remember = (eventId: string) => {
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    seenOrder.push(eventId);
    if (seenOrder.length > INTERCOM_DEDUPE_LIMIT) {
      const oldest = seenOrder.shift();
      if (oldest) seen.delete(oldest);
    }
    return true;
  };

  const publish = (signal: BellwetherSignal) => {
    const snapshot = channel?.snapshot();
    if (!snapshot?.connected || !snapshot.supported) return;
    try {
      channel?.publish(signal, { audience: "capable" });
    } catch {
      // Live hints are optional. Herdr and herdr-workflow remain authority.
    }
  };

  const announceTo = (targetSessionId?: string) => {
    publish({
      version: 1,
      eventId: makeEventId(),
      sourceSessionId: options.sessionId,
      targetSessionId,
      kind: "capability",
      protocol: 1,
    });
    publish({
      version: 1,
      eventId: makeEventId(),
      sourceSessionId: options.sessionId,
      targetSessionId,
      kind: "binding",
      paneId: options.paneId,
    });
  };

  const publishWatchTo = (
    lifecycle: "started" | "settled" | "cancelled" | "failed" | "reconciled",
    receipt: WatchReceipt,
    targetSessionId?: string,
  ) => {
    publish({
      version: 1,
      eventId: makeEventId(),
      sourceSessionId: options.sessionId,
      targetSessionId,
      kind: "watch",
      watchId: receipt.id,
      watchKind: receipt.kind,
      status: receipt.status,
      phase: receipt.phase,
      pane: receipt.pane,
      target: receipt.target,
      lifecycle,
    });
  };

  const reconcile = (targetSessionId?: string) => {
    announceTo(targetSessionId);
    for (const receipt of options.activeWatches()) {
      publishWatchTo("reconciled", receipt, targetSessionId);
    }
  };

  const onEvent = (event: IntercomExtensionEvent) => {
    if (disposed) return;
    if (event.type === "connection" && event.connected && event.supported) {
      reconcile();
      return;
    }
    if (
      (event.type === "session_joined" || event.type === "presence_update") &&
      isRecord(event.session) &&
      typeof event.session.id === "string" &&
      event.session.id !== options.sessionId
    ) {
      reconcile(event.session.id);
      return;
    }
    if (event.type === "session_left" && typeof event.sessionId === "string") {
      reconcile();
      return;
    }
    if (event.type !== "message" || typeof event.fromSessionId !== "string") return;
    const signal = decodeBellwetherSignal(event.payload);
    if (
      !signal ||
      signal.sourceSessionId !== event.fromSessionId ||
      signal.sourceSessionId === options.sessionId
    ) {
      return;
    }
    if (
      signal.targetSessionId !== undefined &&
      signal.targetSessionId !== options.sessionId
    ) {
      return;
    }
    if (
      signal.targetPaneId !== undefined &&
      signal.targetPaneId !== options.paneId
    ) {
      return;
    }
    if (!remember(signal.eventId)) return;
    if (signal.kind === "wake_hint") options.wake(signal);
    options.onSignal?.(signal);
  };

  const register = () => {
    if (disposed || registered) return;
    options.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
      namespace: BELLWETHER_INTERCOM_NAMESPACE,
      ownerEligible: false,
      onReady(value: IntercomExtensionChannel) {
        if (disposed) return;
        channel = value;
        registered = true;
        reconcile();
      },
      onEvent,
    });
  };

  const unsubscribe = options.events.on(
    INTERCOM_EXTENSION_REGISTRY_READY_EVENT,
    register,
  );
  register();

  return {
    announce: () => announceTo(),
    publishWatch: (lifecycle, receipt) => publishWatchTo(lifecycle, receipt),
    publishWake(target) {
      if (!hasTarget(target)) throw new Error("wake_hint requires a target session or pane");
      publish({
        version: 1,
        eventId: makeEventId(),
        sourceSessionId: options.sessionId,
        targetSessionId: target.targetSessionId,
        targetPaneId: target.targetPaneId,
        kind: "wake_hint",
        watchId: target.watchId,
      });
    },
    publishWorkflowReceipt(hint) {
      publish({
        version: 1,
        eventId: makeEventId(),
        sourceSessionId: options.sessionId,
        targetSessionId: hint.targetSessionId,
        targetPaneId: hint.targetPaneId,
        kind: "workflow_receipt",
        workflowId: hint.workflowId,
        itemId: hint.itemId,
        generation: hint.generation,
        sequence: hint.sequence,
      });
    },
    snapshot: () => channel?.snapshot() ?? { connected: false, supported: false },
    dispose() {
      disposed = true;
      channel = undefined;
      seen.clear();
      seenOrder.splice(0);
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}
