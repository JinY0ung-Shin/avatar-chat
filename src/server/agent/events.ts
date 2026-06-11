export type PluginStatus = "started" | "installed" | "failed" | "completed";

export interface PluginEvent {
  status: PluginStatus;
  name: string;
}

/** A tool/permission/question belongs to the main agent or a named subagent. */
export const MAIN_AGENT_ID = "main";

/**
 * The model asked to use a tool that is NOT pre-approved. The host decides
 * whether to run it. Only ever raised for the avatar's OWNER (colleagues stay
 * read-only and get an `onBlocked` notice instead). The returned decision is
 * fed straight back to the SDK's `canUseTool`.
 */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  /** Short noun phrase from the SDK (e.g. "Read file"), if any. */
  displayName?: string;
  /** Full prompt sentence from the SDK (e.g. "Claude wants to run …"), if any. */
  title?: string;
  description?: string;
  /** Trimmed tool input, for the user to inspect before approving. */
  input: Record<string, unknown>;
  /** Which agent wants the tool: MAIN_AGENT_ID or a subagent's id. */
  agentId: string;
}
export type PermissionDecision = { behavior: "allow" } | { behavior: "deny" };

/**
 * The model invoked AskUserQuestion (or another `request_user_dialog` kind).
 * `payload` is forwarded to the client verbatim; the client's answer becomes
 * the dialog result. `cancelled` lets the SDK apply the dialog's default.
 */
export interface QuestionRequest {
  dialogKind: string;
  payload: Record<string, unknown>;
  toolUseId?: string;
}
export type QuestionAnswer = { behavior: "completed"; result: unknown } | { behavior: "cancelled" };

/** A concrete tool call (NOT a subagent spawn — those use AgentSpawnEvent). */
export interface ToolEvent {
  toolUseId: string;
  name: string;
  /** MAIN_AGENT_ID or the spawning Task tool_use id. */
  agentId: string;
  /** One-line, human-readable summary of the input (path, command, …). */
  inputSummary?: string;
}

/** A subagent was spawned via the Task/Agent tool. `agentId` === its tool_use id. */
export interface AgentSpawnEvent {
  agentId: string;
  subagentType?: string;
  description?: string;
  /** The parent agent that spawned it (MAIN_AGENT_ID for top-level spawns). */
  parentId: string;
}

/** A tool was denied without an interactive prompt (read-only colleague, deny rule, dontAsk). */
export interface BlockedEvent {
  toolUseId?: string;
  toolName: string;
  agentId: string;
  reason?: string;
}

/**
 * Streaming sink passed into the agent runners. Every callback is optional so a
 * caller can subscribe to only the events it cares about. When NO events sink
 * is supplied, the runners must behave exactly like the original non-streaming
 * implementations (so POST /api/chat stays unchanged).
 */
export interface AgentEvents {
  /** Incremental assistant text to APPEND to the live bubble (main agent only). */
  onDelta?: (text: string) => void;
  /** Human-readable Korean activity label. */
  onStatus?: (label: string) => void;
  /** The model the SDK actually initialized with (from the `init` system event). */
  onModel?: (model: string) => void;
  /**
   * The SDK session id for this run (from the `init` system event). Persist it
   * to resume the conversation's context on the next turn.
   */
  onSessionId?: (sessionId: string) => void;
  /** Plugin install lifecycle. */
  onPlugin?: (event: PluginEvent) => void;
  /** A tool/skill invocation started (legacy coarse signal; superseded by onToolStart). */
  onTool?: (name: string) => void;

  /** A concrete tool call started, attributed to its agent. */
  onToolStart?: (event: ToolEvent) => void;
  /** A tool call finished (tool_result observed). */
  onToolEnd?: (event: { toolUseId: string; ok: boolean }) => void;
  /** A subagent was spawned. */
  onAgentStart?: (event: AgentSpawnEvent) => void;
  /** A subagent finished. */
  onAgentEnd?: (event: { agentId: string; ok: boolean }) => void;
  /** A tool was auto-denied (no interactive prompt). */
  onBlocked?: (event: BlockedEvent) => void;

  /**
   * BLOCKING: the model wants a non-pre-approved tool. Resolve with the user's
   * decision. If omitted, the runner falls back to auto-deny semantics.
   */
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * BLOCKING: the model raised a user dialog (AskUserQuestion). Resolve with the
   * user's answer. If omitted, the dialog is cancelled (SDK default applies).
   */
  onQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer>;
}
