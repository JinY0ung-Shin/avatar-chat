/**
 * Tiny value-coercion primitives shared by the agent run loop's internal modules
 * (prompt assembly, SDK-message handlers, the PreToolUse hook). Not exported from
 * the public agent surface — purely an internal de-dup of helpers that were
 * previously private to claudeAgent.ts. Behavior is unchanged.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
