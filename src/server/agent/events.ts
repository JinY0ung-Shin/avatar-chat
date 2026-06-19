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

/**
 * The avatar called `mcp__canvas__show` (experimental `canvas` feature, #50).
 * The host forwards the artifact to the client to render in a side panel. When
 * `awaitInput` is true (the avatar declared controls) the runner BLOCKS for the
 * user's submission via the same out-of-band `/api/chat/respond` path used by
 * permission/question prompts; otherwise it returns immediately (display-only).
 */
export interface CanvasRequest {
  /** Stable artifact id, so the client can upsert (live event + persisted copy). */
  artifactId: string;
  title: string;
  content: string;
  contentType: import("../types.js").CanvasContentType;
  /**
   * Declared controls, passed WHENEVER present — not only when blocking — so a
   * non-blocking (async) canvas can still render its form on the client.
   */
  controls?: import("../types.js").CanvasControl[];
  /**
   * The SOLE run-parking signal: true only for a BLOCKING canvas (controls
   * present AND `wait` not false). An async/display-only/editable canvas does
   * NOT park; the user's later answer arrives as a new /api/chat/stream turn.
   */
  awaitInput: boolean;
  /** How input is collected: "blocking" parks the run, "async" does not. Undefined = display-only. */
  interaction?: "blocking" | "async";
  /** The user may edit/annotate the content and send it back as a new turn. */
  editable?: boolean;
}
export type CanvasResult =
  | { behavior: "submitted"; values: Record<string, unknown> }
  | { behavior: "cancelled" }
  | { behavior: "shown" };

/** A concrete tool call (NOT a subagent spawn — those use AgentSpawnEvent). */
export interface ToolEvent {
  toolUseId: string;
  name: string;
  /** MAIN_AGENT_ID or the spawning Task tool_use id. */
  agentId: string;
  /** One-line, human-readable summary of the input (path, command, …). */
  inputSummary?: string;
}

/** A background/foreground SDK task that is not necessarily a subagent. */
export interface TaskEvent {
  taskId: string;
  toolUseId?: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  description?: string;
  prompt?: string;
}

/** Progress or state update for a previously created SDK task. */
export interface TaskUpdateEvent {
  taskId: string;
  status?: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  error?: string;
  isBackgrounded?: boolean;
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
 * The model submitted a plan via ExitPlanMode (plan mode). The host forwards the
 * plan markdown to the client to render as a dedicated plan card (not an
 * interactive prompt — autoApprove turns continue automatically). Display-only.
 */
export interface PlanEvent {
  /** The plan markdown the model proposed. Empty while still planning. */
  plan: string;
  /**
   * True the moment the model ENTERS plan mode (EnterPlanMode), before any plan
   * exists. Lets the UI show a "writing plan…" placeholder so the turn doesn't
   * look stalled during the (tool-row-suppressed) planning phase. The real plan
   * arrives in a later event with `plan` set and this falsy.
   */
  planning?: boolean;
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
  /** A non-subagent SDK task started. */
  onTaskStart?: (event: TaskEvent) => void;
  /** A non-subagent SDK task changed progress/state. */
  onTaskUpdate?: (event: TaskUpdateEvent) => void;
  /** A non-subagent SDK task finished. */
  onTaskEnd?: (event: { taskId: string; ok: boolean; status?: string; summary?: string }) => void;
  /** A subagent was spawned. */
  onAgentStart?: (event: AgentSpawnEvent) => void;
  /** A subagent finished. */
  onAgentEnd?: (event: { agentId: string; ok: boolean }) => void;
  /** A tool was auto-denied (no interactive prompt). */
  onBlocked?: (event: BlockedEvent) => void;
  /** The model submitted a plan via ExitPlanMode (plan mode) — display-only card. */
  onPlan?: (event: PlanEvent) => void;

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
  /**
   * The avatar showed a visual canvas (experimental `canvas` feature). Resolve
   * with the user's submission when controls were declared (`awaitInput`), or
   * immediately for display-only. If omitted, the canvas tool is not registered.
   */
  onCanvas?: (request: CanvasRequest) => Promise<CanvasResult>;
}
