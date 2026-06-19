import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import type { AgentUsage } from "../types.js";
import logger from "../logger.js";
import { asNumber, asString, isRecord, truncate, TOOL_TRACE_ENABLED } from "./agentUtils.js";
import {
  SDK_PLAN_TOOLS,
  SDK_SUBAGENT_TOOLS,
  SDK_TASK_CREATE_TOOLS,
  SDK_TASK_END_TOOLS,
  SDK_TASK_INSPECTION_TOOLS,
  SDK_TASK_UPDATE_TOOLS,
  SDK_UI_HANDLED_TOOLS,
} from "../../shared/sdkToolPresentation.js";

/** Tools that spawn a subagent (shown as an agent node, not a tool row). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(SDK_SUBAGENT_TOOLS);

/** Tools handled by a dedicated UI (not shown as a generic tool row). */
const UI_HANDLED_TOOLS: ReadonlySet<string> = new Set(SDK_UI_HANDLED_TOOLS);
const PLAN_TOOLS: ReadonlySet<string> = new Set(SDK_PLAN_TOOLS);
const TASK_CREATE_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_CREATE_TOOLS);
const TASK_UPDATE_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_UPDATE_TOOLS);
const TASK_END_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_END_TOOLS);
const TASK_INSPECTION_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_INSPECTION_TOOLS);

const traceLogger = logger.child({ module: "agent", trace: "tool" });

/**
 * Verbose, opt-in trace of one raw SDK message (gated by `AGENT_TOOL_TRACE`, see
 * agentUtils). Called once per message at the top of the run loop so it sees the
 * WHOLE lifecycle in order: streaming `tool_use` block start/stop, the per-turn
 * `stop_reason`, the assembled assistant tool calls, and every `tool_result`.
 *
 * The diagnostic signatures for a vLLM-style stall:
 *  - "tool_use block start" with no matching "content_block stop" → the backend
 *    opened a tool call but never closed its input JSON (the run then hangs).
 *  - `stop_reason: "tool_use"` + an assistant tool call, but NO PreToolUse hook
 *    entry (traced separately) and NO `tool_result` → the SDK never dispatched
 *    the announced call.
 * Wrapped in try/catch: tracing must never break a run.
 */
export function traceSdkMessage(message: Record<string, unknown>): void {
  if (!TOOL_TRACE_ENABLED) {
    return;
  }
  try {
    const type = asString(message.type);
    const agentId = asString(message.parent_tool_use_id) || MAIN_AGENT_ID;
    if (type === "stream_event") {
      const event = isRecord(message.event) ? message.event : undefined;
      const eventType = asString(event?.type);
      if (eventType === "content_block_start") {
        const block = isRecord(event?.content_block) ? event?.content_block : undefined;
        if (asString(block?.type) === "tool_use") {
          traceLogger.info(
            { agentId, index: asNumber(event?.index), toolName: asString(block?.name), toolUseId: asString(block?.id) },
            "trace: tool_use block start",
          );
        }
      } else if (eventType === "content_block_stop") {
        traceLogger.info({ agentId, index: asNumber(event?.index) }, "trace: content_block stop");
      } else if (eventType === "message_delta") {
        const stopReason = asString(isRecord(event?.delta) ? event?.delta.stop_reason : undefined);
        if (stopReason) {
          traceLogger.info({ agentId, stopReason }, "trace: message_delta stop_reason");
        }
      } else if (eventType === "message_start" || eventType === "message_stop") {
        traceLogger.info({ agentId, eventType }, "trace: stream lifecycle");
      }
      return;
    }
    if (type === "assistant") {
      const inner = isRecord(message.message) ? message.message : undefined;
      const content = Array.isArray(inner?.content) ? inner?.content : [];
      const tools = content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_use")
        .map((b) => ({ name: asString(b.name), toolUseId: asString(b.id) }));
      traceLogger.info(
        {
          agentId,
          stopReason: asString(inner?.stop_reason) || null,
          blockTypes: content.filter(isRecord).map((b) => asString(b.type)),
          toolCalls: tools,
        },
        "trace: assistant message assembled",
      );
      return;
    }
    if (type === "user") {
      const inner = isRecord(message.message) ? message.message : undefined;
      const content = Array.isArray(inner?.content) ? inner?.content : [];
      const results = content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_result")
        .map((b) => ({ toolUseId: asString(b.tool_use_id), isError: b.is_error === true }));
      if (results.length) {
        traceLogger.info({ agentId, results }, "trace: tool_result(s) returned");
      }
      return;
    }
    if (type === "result") {
      traceLogger.info({ agentId, subtype: asString(message.subtype) }, "trace: result");
    }
  } catch {
    // Tracing is best-effort diagnostics; never let it throw into the run loop.
  }
}

/** One-line, human-readable summary of a tool's input for the activity UI. */
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const path = asString(input.file_path) || asString(input.path) || asString(input.notebook_path);
  const cmd = asString(input.command);
  const pattern = asString(input.pattern);
  const url = asString(input.url);
  const query = asString(input.query) || asString(input.prompt);
  let summary = "";
  if (name === "Bash" && cmd) summary = cmd;
  else if (pattern) summary = pattern + (path ? ` · ${path}` : "");
  else if (path) summary = path;
  else if (url) summary = url;
  else if (query) summary = query;
  else {
    const firstString = Object.values(input).find((v) => typeof v === "string" && v);
    summary = typeof firstString === "string" ? firstString : "";
  }
  return truncate(summary.replace(/\s+/g, " ").trim(), 160);
}

type TaskKind = "task" | "agent";

interface TaskRecord {
  uiId: string;
  kind: TaskKind;
}

export interface LoopState {
  /** tool_use ids that spawned a subagent → distinguishes onAgentEnd from onToolEnd. */
  spawnedAgentIds: Set<string>;
  /** SDK task ids → rendered task/agent ids. */
  tasks: Map<string, TaskRecord>;
  /** Ambient SDK tasks that should not render in the inline transcript. */
  hiddenTasks: Set<string>;
}

export function createLoopState(): LoopState {
  return { spawnedAgentIds: new Set(), tasks: new Map(), hiddenTasks: new Set() };
}

function taskDescription(input: Record<string, unknown>): string {
  return (
    asString(input.task_subject) ||
    asString(input.subject) ||
    asString(input.title) ||
    asString(input.description) ||
    asString(input.task_description) ||
    asString(input.prompt) ||
    asString(input.task)
  );
}

function taskDetails(input: Record<string, unknown>): string {
  const subject = asString(input.task_subject) || asString(input.subject) || asString(input.title);
  const description = asString(input.task_description) || asString(input.description) || asString(input.prompt) || asString(input.task);
  return truncate([subject, description].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim(), 200);
}

function taskType(input: Record<string, unknown>): string {
  return asString(input.task_type) || asString(input.type) || asString(input.kind);
}

function taskIdFromInput(input: Record<string, unknown>, fallback: string): string {
  return asString(input.task_id) || asString(input.taskId) || asString(input.id) || fallback;
}

function isTaskCreateTool(name: string): boolean {
  return TASK_CREATE_TOOLS.has(name);
}

function isTaskUpdateTool(name: string): boolean {
  return TASK_UPDATE_TOOLS.has(name);
}

function isTaskEndTool(name: string): boolean {
  return TASK_END_TOOLS.has(name);
}

function isTaskInspectionTool(name: string): boolean {
  return TASK_INSPECTION_TOOLS.has(name);
}

function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.has(name);
}

function statusIsTerminal(status: string): boolean {
  return ["completed", "failed", "killed", "stopped"].includes(status);
}

function taskOk(status: string): boolean {
  return status === "completed";
}

function taskRecord(state: LoopState, taskId: string): TaskRecord {
  let record = state.tasks.get(taskId);
  if (!record) {
    record = { uiId: taskId, kind: "task" };
    state.tasks.set(taskId, record);
  }
  return record;
}

function emitTaskUpdate(
  events: AgentEvents,
  state: LoopState,
  taskId: string,
  update: { status?: string; description?: string; summary?: string; lastToolName?: string; error?: string; isBackgrounded?: boolean },
): void {
  const record = taskRecord(state, taskId);
  if (record.kind === "agent") {
    if (statusIsTerminal(update.status || "")) {
      events.onAgentEnd?.({ agentId: record.uiId, ok: taskOk(update.status || "") });
    } else {
      const detail = update.summary || update.description || update.lastToolName;
      if (detail) {
        events.onStatus?.(`에이전트 작업 중: ${truncate(detail.replace(/\s+/g, " ").trim(), 120)}`);
      }
    }
    return;
  }
  if (statusIsTerminal(update.status || "")) {
    events.onTaskEnd?.({ taskId: record.uiId, ok: taskOk(update.status || ""), status: update.status, summary: update.summary || update.error });
    return;
  }
  events.onTaskUpdate?.({ taskId: record.uiId, ...update });
}

function handleTaskToolUse(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): boolean {
  if (isPlanTool(name)) {
    // ExitPlanMode carries the proposed plan markdown in `input.plan`. Surface it
    // as a dedicated plan card (display-only — autoApprove turns just continue);
    // without this the plan content was discarded and only a status line showed.
    if (name === "ExitPlanMode") {
      const plan = asString(input.plan);
      if (plan) {
        events.onPlan?.({ plan });
      }
    } else {
      // EnterPlanMode: no plan exists yet. Signal the UI to show a "writing plan…"
      // placeholder so the planning phase (which suppresses tool rows) doesn't look
      // like a stalled/disconnected turn.
      events.onPlan?.({ plan: "", planning: true });
    }
    events.onStatus?.(name === "ExitPlanMode" ? "계획을 확인하는 중…" : "계획 모드로 전환 중…");
    return true;
  }
  if (isTaskInspectionTool(name)) {
    return true;
  }
  if (!isTaskCreateTool(name) && !isTaskUpdateTool(name) && !isTaskEndTool(name)) {
    return false;
  }
  const taskId = taskIdFromInput(input, toolUseId);
  if (isTaskCreateTool(name)) {
    const record = { uiId: taskId, kind: "task" as const };
    state.tasks.set(taskId, record);
    if (toolUseId !== taskId) {
      state.tasks.set(toolUseId, record);
    }
    events.onTaskStart?.({
      taskId,
      toolUseId,
      taskType: taskType(input) || undefined,
      subagentType: asString(input.subagent_type) || asString(input.agent_type) || undefined,
      workflowName: asString(input.workflow_name) || undefined,
      description: taskDescription(input) || undefined,
      prompt: asString(input.prompt) || undefined,
    });
    return true;
  }
  if (isTaskEndTool(name)) {
    const status = name === "TaskStop" ? "stopped" : "completed";
    emitTaskUpdate(events, state, taskId, { status, summary: taskDetails(input) || undefined });
    return true;
  }
  emitTaskUpdate(events, state, taskId, {
    status: asString(input.status) || undefined,
    description: taskDescription(input) || undefined,
    summary: taskDetails(input) || undefined,
  });
  return true;
}

/** Process a full `assistant` message: emit tool/agent starts, return main-agent text. */
export function handleAssistantMessage(
  message: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): string {
  const agentId = asString(message.parent_tool_use_id) || MAIN_AGENT_ID;
  const isMain = agentId === MAIN_AGENT_ID;
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      if (isMain) {
        textParts.push(block.text);
      }
      continue;
    }
    if (block.type === "tool_use") {
      const toolUseId = asString(block.id);
      const name = asString(block.name);
      const input = isRecord(block.input) ? block.input : {};
      if (!toolUseId || !name) {
        continue;
      }
      if (handleTaskToolUse(name, toolUseId, input, events, state)) {
        continue;
      }
      if (SUBAGENT_TOOLS.has(name)) {
        state.spawnedAgentIds.add(toolUseId);
        events.onAgentStart?.({
          agentId: toolUseId,
          parentId: agentId,
          subagentType: asString(input.subagent_type) || undefined,
          description: (asString(input.description) || asString(input.prompt) || "").slice(0, 200) || undefined,
        });
      } else if (!UI_HANDLED_TOOLS.has(name)) {
        // AskUserQuestion (and similar) are shown as their own card, not a tool row.
        events.onToolStart?.({
          toolUseId,
          name,
          agentId,
          inputSummary: summarizeToolInput(name, input),
        });
      }
    }
  }
  return textParts.filter(Boolean).join("\n");
}

/** Process a full `user` message: emit tool/agent ends from tool_result blocks. */
export function handleUserMessage(
  message: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): void {
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId = asString(block.tool_use_id);
    if (!toolUseId) {
      continue;
    }
    const ok = block.is_error !== true;
    if (state.spawnedAgentIds.has(toolUseId)) {
      events.onAgentEnd?.({ agentId: toolUseId, ok });
    } else {
      events.onToolEnd?.({ toolUseId, ok });
    }
  }
}

/**
 * Interpret the SDK's terminal `result` message.
 * - success → `{ text }` with the final answer.
 * - error (e.g. `error_max_turns`, which carries `errors[]` but NO `result`
 *   field) → `{ errorSubtype }` so the caller can fall back to the partial
 *   answer streamed so far instead of leaking a raw "Reached maximum number of
 *   turns" string into the chat.
 */
export function interpretResult(message: unknown): { text?: string; errorSubtype?: string; usage?: AgentUsage } {
  if (!isRecord(message) || message.type !== "result") {
    return {};
  }
  const usage = extractUsage(message);
  const withUsage = usage ? { usage } : {};
  if (message.subtype === "success" && typeof message.result === "string") {
    return { text: message.result, ...withUsage };
  }
  if (typeof message.subtype === "string" && message.subtype.startsWith("error")) {
    return { errorSubtype: message.subtype, ...withUsage };
  }
  return withUsage;
}

/**
 * Pull per-turn token usage out of the SDK's terminal `result` message.
 * `usage` (snake_case) carries the input/output/cache counts; `modelUsage`
 * (camelCase, keyed by model) carries the `contextWindow` size. Returns
 * undefined when the message has no usable counts (e.g. error results).
 *
 * IMPORTANT: the result `usage` is CUMULATIVE across every model request the
 * turn made (one per tool round, each re-sending the resumed transcript), NOT
 * a snapshot — so `inputTokens` here sums many overlapping prompts and dividing
 * it by `contextWindow` overstates context fill (the % runs past 100% on
 * tool-heavy turns). `runClaudeAgent` therefore OVERRIDES `inputTokens` with
 * `mainAssistantContextTokens` (the final request's prompt size ≈ live context
 * occupancy) for display; `outputTokens` stays cumulative (total generated this
 * turn). The cumulative value is kept here so the unit test / fallback path
 * still works when no assistant snapshot is available.
 */
function extractUsage(message: Record<string, unknown>): AgentUsage | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const inputTokens = usage
    ? asNumber(usage.input_tokens) +
      asNumber(usage.cache_read_input_tokens) +
      asNumber(usage.cache_creation_input_tokens)
    : 0;
  const outputTokens = usage ? asNumber(usage.output_tokens) : 0;
  let contextWindow = 0;
  if (isRecord(message.modelUsage)) {
    for (const entry of Object.values(message.modelUsage)) {
      if (isRecord(entry)) contextWindow = Math.max(contextWindow, asNumber(entry.contextWindow));
    }
  }
  if (!inputTokens && !outputTokens && !contextWindow) {
    return undefined;
  }
  return { inputTokens, outputTokens, ...(contextWindow ? { contextWindow } : {}) };
}

/**
 * Prompt-token count of a MAIN-agent assistant message — `input_tokens` +
 * cache reads + cache creation, i.e. the size of the prompt sent on THAT model
 * request. The LAST main-agent assistant message of a turn was prompted with
 * the full transcript so far, so its prompt size ≈ the live context-window
 * occupancy at the end of the turn — a true snapshot, unlike the CUMULATIVE
 * `result` usage (see extractUsage). Returns undefined for subagent messages
 * (`parent_tool_use_id` set — their context is separate) or when the message
 * carries no usage. `runClaudeAgent` tracks the latest value across the turn
 * and feeds it into the usage badge's context %.
 */
export function mainAssistantContextTokens(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== "assistant") {
    return undefined;
  }
  if (asString(message.parent_tool_use_id)) {
    return undefined;
  }
  const inner = isRecord(message.message) ? message.message : undefined;
  const usage = inner && isRecord(inner.usage) ? inner.usage : undefined;
  if (!usage) {
    return undefined;
  }
  const tokens =
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_read_input_tokens) +
    asNumber(usage.cache_creation_input_tokens);
  return tokens > 0 ? tokens : undefined;
}

/**
 * Context-occupancy snapshot from a streaming `message_start` event. In
 * streaming mode (`includePartialMessages`) the prompt-size counts
 * (`input_tokens` + cache reads/creation) ride on the `message_start` event's
 * `message.usage`; the FINAL assembled `assistant` message's usage carries only
 * the `message_delta` counts (output, with `input_tokens` null), so
 * `mainAssistantContextTokens` reads 0 there and the occupancy snapshot is
 * never captured during streaming. Reading it here is the streaming counterpart
 * of `mainAssistantContextTokens`: same sum, same MAIN-agent-only gate
 * (`parent_tool_use_id` unset), but off the `stream_event`/`message_start`
 * envelope. The LAST main-agent `message_start` of a turn = the final request's
 * prompt size ≈ live context occupancy. Returns undefined for subagent streams,
 * non-`message_start` events, or a usage-less/zero start.
 */
export function streamStartContextTokens(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== "stream_event") {
    return undefined;
  }
  if (asString(message.parent_tool_use_id)) {
    return undefined;
  }
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event || event.type !== "message_start") {
    return undefined;
  }
  const inner = isRecord(event.message) ? event.message : undefined;
  const usage = inner && isRecord(inner.usage) ? inner.usage : undefined;
  if (!usage) {
    return undefined;
  }
  const tokens =
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_read_input_tokens) +
    asNumber(usage.cache_creation_input_tokens);
  return tokens > 0 ? tokens : undefined;
}

/** Largest standard Claude input window — Opus 4.8 / Sonnet 4.x are natively 1M. */
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * The SDK's `modelUsage.contextWindow` is a STATIC model-table figure that can
 * read a stale base (e.g. 200000) for a model whose true window is larger — Opus
 * 4.8 is natively 1M, not beta-gated. On long/resumed turns the real prompt
 * snapshot (`mainAssistantContextTokens`) then overflows the reported window and
 * the context-occupancy badge % ran PAST 100% on every long turn. Current Claude
 * windows are the 200K or 1M tier, so when the snapshot overflows the reported
 * window the true window must be the 1M tier — lift the denominator there (never
 * below the snapshot itself). Returns the reported window unchanged when it
 * already accommodates the snapshot, or 0 when no window was reported.
 */
export function correctContextWindow(reportedWindow: number, snapshotTokens: number): number {
  if (reportedWindow && snapshotTokens > reportedWindow) {
    return Math.max(MAX_CONTEXT_WINDOW_TOKENS, snapshotTokens);
  }
  return reportedWindow;
}

/**
 * Reconcile a turn's usage for display. `runUsage` carries `extractUsage`'s
 * fields: `inputTokens` there is the CUMULATIVE sum across every tool-round
 * request (each re-sends the resumed transcript), and `contextWindow` is the
 * SDK's STATIC model-table figure (a stale 200K base for Opus 4.8's real 1M).
 * `snapshotTokens` is the last MAIN-agent request's prompt size — true live
 * context occupancy — or `undefined` when no such snapshot was seen this turn
 * (an `error_max_turns` result, or a turn whose only assistant messages were
 * subagents).
 *
 * With a snapshot: it becomes the occupancy numerator and the (possibly stale)
 * window is lifted to fit it — so `inputTokens / contextWindow` is a real
 * fraction in [0, 1]. WITHOUT one: the cumulative `inputTokens` has no meaning
 * as "current fill", so we DON'T divide it by the window — zero out both
 * context numbers (`inputTokens: 0`, `contextWindow: 0`) and let the badge fall
 * back to its output-only label rather than show a fabricated ratio.
 * `outputTokens` (cumulative total generated) is preserved either way.
 */
export function finalizeTurnUsage(runUsage: AgentUsage, snapshotTokens: number | undefined): AgentUsage {
  if (snapshotTokens === undefined) {
    return { ...runUsage, inputTokens: 0, contextWindow: 0 };
  }
  const contextWindow = correctContextWindow(runUsage.contextWindow ?? 0, snapshotTokens);
  return {
    ...runUsage,
    inputTokens: snapshotTokens,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** Human-facing fallback when the run ended on an error with no usable text. */
export function resultErrorMessage(subtype: string): string {
  if (subtype === "error_max_turns") {
    return "응답이 최대 처리 단계에 도달해 중단되었습니다. 질문을 더 작게 나눠 다시 시도해 주세요.";
  }
  return "응답 생성 중 오류가 발생해 완료하지 못했습니다. 다시 시도해 주세요.";
}

/**
 * Parse a single SDK `stream_event` message and fire matching streaming
 * callbacks. Returns the text delta (if any) so callers can accumulate it.
 * Subagent deltas (parent_tool_use_id set) are NOT appended to the main bubble.
 */
export function handleStreamEvent(message: Record<string, unknown>, events: AgentEvents): string {
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event) {
    return "";
  }
  const isMain = !asString(message.parent_tool_use_id);
  if (
    event.type === "content_block_delta" &&
    isRecord(event.delta) &&
    event.delta.type === "text_delta"
  ) {
    const text = asString(event.delta.text);
    if (text && isMain) {
      events.onDelta?.(text);
      return text;
    }
  }
  return "";
}

function handleTaskSystemEvent(message: Record<string, unknown>, events: AgentEvents, state: LoopState): boolean {
  const subtype = asString(message.subtype);
  const taskId = asString(message.task_id);
  if (!taskId) {
    return false;
  }

  if (subtype === "task_started") {
    if (message.skip_transcript === true) {
      state.hiddenTasks.add(taskId);
      return true;
    }
    const toolUseId = asString(message.tool_use_id);
    const existing = state.tasks.get(taskId) || (toolUseId ? state.tasks.get(toolUseId) : undefined);
    const uiId = existing?.uiId || toolUseId || taskId;
    const taskKind: TaskKind =
      asString(message.task_type) === "subagent" || Boolean(asString(message.subagent_type))
        ? "agent"
        : existing?.kind || "task";
    const record = { uiId, kind: taskKind };
    state.tasks.set(taskId, record);
    if (toolUseId) {
      state.tasks.set(toolUseId, record);
    }
    if (taskKind === "agent") {
      state.spawnedAgentIds.add(uiId);
      events.onAgentStart?.({
        agentId: uiId,
        parentId: MAIN_AGENT_ID,
        subagentType: asString(message.subagent_type) || undefined,
        description: asString(message.description) || asString(message.prompt) || undefined,
      });
    } else {
      events.onTaskStart?.({
        taskId: uiId,
        toolUseId: asString(message.tool_use_id) || undefined,
        taskType: asString(message.task_type) || undefined,
        subagentType: asString(message.subagent_type) || undefined,
        workflowName: asString(message.workflow_name) || undefined,
        description: asString(message.description) || undefined,
        prompt: asString(message.prompt) || undefined,
      });
    }
    return true;
  }

  if (state.hiddenTasks.has(taskId)) {
    return true;
  }

  if (subtype === "task_progress") {
    emitTaskUpdate(events, state, taskId, {
      description: asString(message.description) || undefined,
      summary: asString(message.summary) || undefined,
      lastToolName: asString(message.last_tool_name) || undefined,
    });
    return true;
  }

  if (subtype === "task_updated") {
    const patch = isRecord(message.patch) ? message.patch : {};
    emitTaskUpdate(events, state, taskId, {
      status: asString(patch.status) || undefined,
      description: asString(patch.description) || undefined,
      error: asString(patch.error) || undefined,
      isBackgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : undefined,
    });
    return true;
  }

  if (subtype === "task_notification") {
    emitTaskUpdate(events, state, taskId, {
      status: asString(message.status) || undefined,
      summary: asString(message.summary) || undefined,
    });
    return true;
  }

  return false;
}

export function handleSystemEvent(message: Record<string, unknown>, events: AgentEvents, state: LoopState): void {
  const subtype = asString(message.subtype);
  if (handleTaskSystemEvent(message, events, state)) {
    return;
  }
  if (subtype === "init") {
    const model = asString(message.model);
    if (model) {
      events.onModel?.(model);
    }
    const sessionId = asString(message.session_id);
    if (sessionId) {
      events.onSessionId?.(sessionId);
    }
    events.onStatus?.(model ? `Claude 준비 완료 (${model})` : "Claude 준비 완료");
    const pluginList =
      (Array.isArray(message.plugins) && message.plugins) ||
      (Array.isArray(message.loadedPlugins) && message.loadedPlugins) ||
      [];
    for (const entry of pluginList) {
      let name = "";
      if (typeof entry === "string") {
        name = entry;
      } else if (isRecord(entry)) {
        name = asString(entry.name);
      }
      if (name) {
        events.onPlugin?.({ status: "completed", name });
      }
    }
    return;
  }
  if (subtype === "plugin_install") {
    const name = asString(message.name);
    const status = asString(message.status);
    const normalized: "started" | "installed" | "failed" | "completed" =
      status === "started" || status === "installed" || status === "failed" || status === "completed"
        ? status
        : "started";
    events.onPlugin?.({ status: normalized, name });
    events.onStatus?.(name ? `플러그인 불러오는 중… (${name})` : "플러그인 불러오는 중…");
    return;
  }
  if (subtype === "permission_denied") {
    // A tool was auto-denied without an interactive prompt (read-only colleague,
    // dontAsk, or a deny rule). Surface it so the client can show "blocked".
    events.onBlocked?.({
      toolUseId: asString(message.tool_use_id) || undefined,
      toolName: asString(message.tool_name),
      agentId: asString(message.agent_id) || MAIN_AGENT_ID,
      reason: asString(message.decision_reason) || asString(message.message) || undefined,
    });
    return;
  }
  if (subtype === "status") {
    const status = asString(message.status);
    const label =
      status === "requesting"
        ? "응답 생성 중…"
        : status === "compacting"
          ? "맥락 정리 중…"
          : "처리 중…";
    events.onStatus?.(label);
  }
}

/** Non-streaming text extraction (main agent only); used when no events sink. */
export function extractMainAssistantText(message: Record<string, unknown>): string {
  if (asString(message.parent_tool_use_id)) {
    return "";
  }
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}
