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

/**
 * Opt-in verbose tracing of the SDK tool-call lifecycle. Set `AGENT_TOOL_TRACE=1`
 * to diagnose tool-calling STALLS — e.g. an OpenAI-compatible backend such as
 * vLLM that announces a tool call but emits a malformed / never-closed `tool_use`
 * block, so the run hangs with no tool ever executing. The trace prints, per turn:
 * each `tool_use` content-block start/stop, the message `stop_reason`, the
 * assembled assistant tool calls, every PreToolUse hook entry+decision, and every
 * `tool_result`. Logged at INFO so it surfaces without flipping the whole app to
 * `debug` (which is very noisy). Off by default; read once at process start.
 */
export const TOOL_TRACE_ENABLED = /^(1|true|yes|on)$/i.test(process.env.AGENT_TOOL_TRACE ?? "");
