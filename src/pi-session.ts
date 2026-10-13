function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Herdr records a Pi session file as `<timestamp>_<session id>.jsonl`. */
export function piSessionIdFromAgent(agent: Record<string, unknown>): string | undefined {
  const session = agent.agent_session;
  if (!isRecord(session) || session.agent !== "pi" || typeof session.value !== "string") {
    return undefined;
  }
  return /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    session.value,
  )?.[1];
}
