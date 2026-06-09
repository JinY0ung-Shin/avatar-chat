export type PluginStatus = "started" | "installed" | "failed" | "completed";

export interface PluginEvent {
  status: PluginStatus;
  name: string;
}

/**
 * Streaming sink passed into the agent runners. Every callback is optional so a
 * caller can subscribe to only the events it cares about. When NO events sink
 * is supplied, the runners must behave exactly like the original non-streaming
 * implementations (so POST /api/chat stays unchanged).
 */
export interface AgentEvents {
  /** Incremental assistant text to APPEND to the live bubble. */
  onDelta?: (text: string) => void;
  /** Human-readable Korean activity label. */
  onStatus?: (label: string) => void;
  /** Plugin install lifecycle. */
  onPlugin?: (event: PluginEvent) => void;
  /** A tool/skill invocation started. */
  onTool?: (name: string) => void;
}
