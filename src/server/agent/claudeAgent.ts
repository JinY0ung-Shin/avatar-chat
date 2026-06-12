import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../store.js";
import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import logger from "../logger.js";
import { normalizeGithubHost } from "../marketplace.js";
import { knownHostsPath } from "../sshTrust.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
} from "../gitCredentials.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  HEX_SSH_SERVER_NAME,
  allowedHexSshToolsForViewer,
  extractHexSshToolName,
  isHexSshToolAllowed,
  viewerClassForAgentRequest,
  type HexSshToolPolicy,
  type HexSshViewerClass,
} from "../hexSshPolicy.js";

const agentLogger = logger.child({ module: "agent" });
const HISTORY_MESSAGE_LIMIT = 24;
const HISTORY_CHAR_LIMIT = 12_000;
const GIT_CREDENTIAL_ENV_NAMES = [
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const SSH_MCP_SECRET_ENV_NAMES = [
  "SSH_PRIVATE_KEY",
  "SSH_PASSPHRASE",
  "SSH_PASSWORD",
  "SSH_USER",
  "SSH_USERNAME",
  "ALLOWED_HOSTS",
  "ALLOWED_HOST_FINGERPRINTS",
] as const;
const RTK_REWRITE_TIMEOUT_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function compactConversationHistory(history: AgentRequest["conversationHistory"]): NonNullable<AgentRequest["conversationHistory"]> {
  const recent = (history ?? [])
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim())
    .slice(-HISTORY_MESSAGE_LIMIT);
  const compacted: NonNullable<AgentRequest["conversationHistory"]> = [];
  let remaining = HISTORY_CHAR_LIMIT;

  for (let index = recent.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = recent[index];
    let content = message.content.trim();
    if (content.length > remaining) {
      content = `[truncated]\n${content.slice(content.length - remaining)}`;
    }
    compacted.unshift({ role: message.role, content });
    remaining -= content.length;
  }

  return compacted;
}

function conversationHistoryBlock(history: AgentRequest["conversationHistory"]): string | null {
  const compacted = compactConversationHistory(history);
  if (compacted.length === 0) {
    return null;
  }
  return [
    "이전 대화 기록(현재 사용자 메시지 이전, 오래된 순):",
    "```json",
    JSON.stringify(compacted, null, 2),
    "```",
    "이 기록은 같은 대화에 저장된 실제 맥락입니다. 아래 사용자 메시지는 이 기록 다음에 온 새 메시지입니다.",
  ].join("\n");
}

export function withoutGitCredentialEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

export function agentSubprocessEnv(
  baseEnv: Record<string, string | undefined>,
  agentSessionsDir: string,
): Record<string, string | undefined> {
  return {
    ...withoutGitCredentialEnv(baseEnv),
    CLAUDE_CONFIG_DIR: agentSessionsDir,
  };
}

export function sshMcpSecretEnv(ownerSecrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SSH_MCP_SECRET_ENV_NAMES) {
    const value = ownerSecrets[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

export function rewriteBashCommandWithRtk(command: string, rtkCommand = "rtk"): string | null {
  const trimmedCommand = command.trim();
  const trimmedRtkCommand = rtkCommand.trim();
  if (!trimmedCommand || !trimmedRtkCommand) {
    return null;
  }

  const result = spawnSync(trimmedRtkCommand, ["rewrite", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: RTK_REWRITE_TIMEOUT_MS,
  });
  if (result.error) {
    return null;
  }

  const rewritten = result.stdout.trim();
  if (!rewritten || rewritten === trimmedCommand) {
    return null;
  }
  return rewritten;
}

/** Tools that spawn a subagent (shown as an agent node, not a tool row). */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Tools handled by a dedicated UI (not shown as a generic tool row). */
const UI_HANDLED_TOOLS = new Set(["AskUserQuestion"]);

/** SDK orchestration tools that should never trigger the user permission modal. */
const TASK_ORCHESTRATION_TOOLS = new Set([
  "Task",
  "Agent",
  "TaskCreate",
  "TaskCreated",
  "TaskStarted",
  "TaskUpdate",
  "TaskComplete",
  "TaskCompleted",
  "TaskProgress",
  "TaskStatus",
  "TaskList",
  "TaskRead",
  "TaskStop",
]);

/**
 * Tools that run without a permission prompt: read-only built-ins, any MCP tool
 * (only the in-process knowledge server is configured), and orchestration
 * meta-tools. Everything else is gated by the PreToolUse hook.
 */
function isAutoAllowed(toolName: string, readOnlyTools: string[]): boolean {
  if (readOnlyTools.includes(toolName)) return true;
  if (toolName.startsWith("mcp__")) return true;
  return ["Skill", "TodoWrite", "ToolSearch", "SlashCommand"].includes(toolName) || TASK_ORCHESTRATION_TOOLS.has(toolName);
}

/** Render a question answer (from the client) into text the model can read. */
function formatQuestionAnswer(result: unknown): string {
  if (!isRecord(result)) {
    return "사용자가 답변을 제공했습니다.";
  }
  const answers = isRecord(result.answers) ? result.answers : {};
  const lines = Object.entries(answers).map(([q, a]) => `- "${q}" → ${asString(a) || String(a)}`);
  return lines.length
    ? `사용자가 질문에 다음과 같이 답했습니다:\n${lines.join("\n")}`
    : "사용자가 답변을 제공했습니다.";
}

/** One-line, human-readable summary of a tool's input for the activity UI. */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
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

/** Shallow copy with long string fields capped, so we never ship huge inputs to the client. */
function safeToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" ? truncate(value, 2000) : value;
  }
  return out;
}

type TaskKind = "task" | "agent";

interface TaskRecord {
  uiId: string;
  kind: TaskKind;
}

interface LoopState {
  /** tool_use ids that spawned a subagent → distinguishes onAgentEnd from onToolEnd. */
  spawnedAgentIds: Set<string>;
  /** SDK task ids → rendered task/agent ids. */
  tasks: Map<string, TaskRecord>;
  /** Ambient SDK tasks that should not render in the inline transcript. */
  hiddenTasks: Set<string>;
}

function createLoopState(): LoopState {
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
  return name === "TaskCreate" || name === "TaskCreated" || name === "TaskStarted";
}

function isTaskUpdateTool(name: string): boolean {
  return name === "TaskUpdate" || name === "TaskProgress" || name === "TaskStatus";
}

function isTaskEndTool(name: string): boolean {
  return name === "TaskComplete" || name === "TaskCompleted" || name === "TaskStop";
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
function handleAssistantMessage(
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
function handleUserMessage(
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
export function interpretResult(message: unknown): { text?: string; errorSubtype?: string } {
  if (!isRecord(message) || message.type !== "result") {
    return {};
  }
  if (message.subtype === "success" && typeof message.result === "string") {
    return { text: message.result };
  }
  if (typeof message.subtype === "string" && message.subtype.startsWith("error")) {
    return { errorSubtype: message.subtype };
  }
  return {};
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
function handleStreamEvent(message: Record<string, unknown>, events: AgentEvents): string {
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

function handleSystemEvent(message: Record<string, unknown>, events: AgentEvents, state: LoopState): void {
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

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};
const hookAllow = (updatedInput?: Record<string, unknown>): HookOutput => {
  const hookSpecificOutput: HookOutput["hookSpecificOutput"] = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
  };
  if (updatedInput) {
    hookSpecificOutput.updatedInput = updatedInput;
  }
  return { hookSpecificOutput };
};
const hookDeny = (reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/**
 * The single tool gate. Fires before every tool call (main thread + subagents),
 * can block, and can await the user. See the runClaudeAgent doc comment for why
 * this replaces canUseTool/onUserDialog.
 */
export function buildPreToolUseHook(
  events: AgentEvents,
  elevated: boolean,
  readOnlyTools: string[],
  headless: boolean,
  allowHeadlessTools: boolean,
  autoApprove: boolean,
  hexSshViewerClass: HexSshViewerClass = "colleague",
  hexSshPolicy: HexSshToolPolicy = DEFAULT_HEX_SSH_TOOL_POLICY,
  rtkCommand = "rtk",
) {
  return async (
    input: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; agent_id?: string },
    toolUseID?: string,
  ): Promise<HookOutput> => {
    const toolName = asString(input.tool_name);
    let toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const toolUseId = toolUseID || asString(input.tool_use_id);
    const agentId = asString(input.agent_id) || MAIN_AGENT_ID;

    // AskUserQuestion: surface the question, await the answer, inject it back.
    // (onUserDialog never fires headlessly, so we answer via a deny+reason that
    // the model reads as the user's response.)
    if (toolName === "AskUserQuestion") {
      if (headless || !events.onQuestion) {
        return hookDeny(
          headless
            ? "예약된 자동 실행 중에는 사용자에게 질문할 수 없습니다. 합리적인 가정으로 진행하세요."
            : "질문 기능을 사용할 수 없습니다.",
        );
      }
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const answer = await events.onQuestion({ dialogKind: "AskUserQuestion", payload: { questions }, toolUseId });
      return answer.behavior === "completed"
        ? hookDeny(formatQuestionAnswer(answer.result))
        : hookDeny("사용자가 질문에 답하지 않았습니다(취소됨). 답변 없이 진행하세요.");
    }

    let updatedToolInput: Record<string, unknown> | undefined;
    if (toolName === "Bash") {
      const rewrittenCommand = rewriteBashCommandWithRtk(asString(toolInput.command), rtkCommand);
      if (rewrittenCommand) {
        updatedToolInput = { ...toolInput, command: rewrittenCommand };
        toolInput = updatedToolInput;
      }
    }

    const hexSshTool = extractHexSshToolName(toolName);
    if (hexSshTool) {
      if (isHexSshToolAllowed(toolName, hexSshViewerClass, hexSshPolicy)) {
        return hookAllow(updatedToolInput);
      }
      const reason = `현재 권한에서는 hex-ssh 도구 '${hexSshTool}' 사용이 허용되지 않습니다.`;
      events.onBlocked?.({ toolUseId, toolName, agentId, reason });
      agentLogger.info({ toolName, agentId, viewerClass: hexSshViewerClass }, "hex-ssh tool blocked");
      return hookDeny(reason);
    }

    // Read-only / knowledge / orchestration tools run without a prompt.
    if (isAutoAllowed(toolName, readOnlyTools)) {
      return hookAllow(updatedToolInput);
    }

    const canRunElevatedTools = elevated && (!headless || allowHeadlessTools);

    // Any other tool: a PRESENT elevated viewer (owner or trusted user) may run
    // it; owner-scheduled routines may also run it when they explicitly opt into
    // owner-level headless tools. Plain headless runs and colleagues stay read-only.
    // Auto-approval opted in: run the tool without prompting.
    if (canRunElevatedTools && autoApprove) {
      return hookAllow(updatedToolInput);
    }
    if (!headless && elevated && events.onPermission) {
      const decision = await events.onPermission({
        toolUseId,
        toolName,
        input: safeToolInput(toolInput),
        agentId,
      });
      return decision.behavior === "allow"
        ? hookAllow(updatedToolInput)
        : hookDeny("사용자가 이 도구 사용을 거부했습니다.");
    }

    events.onBlocked?.({ toolUseId, toolName, agentId, reason: "읽기 전용 대화에서는 쓸 수 없는 도구입니다." });
    agentLogger.info({ toolName, agentId, reason: "read-only" }, "tool blocked");
    return hookDeny(
      headless
        ? "이 실행은 자동 루틴(읽기 전용)입니다. 파일 수정/명령 실행 도구는 사용할 수 없으니 Read/Glob/Grep만 사용하세요."
        : "이 대화는 읽기 전용입니다. 파일 수정/명령 실행 도구는 사용할 수 없으니 Read/Glob/Grep과 정보 요청 도구만 사용하세요.",
    );
  };
}

export function buildPrompt(request: AgentRequest, openRequestCount: number): string {
  const alias = request.avatar.alias?.trim();
  const secretNames = Array.from(new Set((request.secretNames ?? []).filter(Boolean))).sort();
  const githubHost = normalizeGithubHost(request.githubHost);
  const lines = [
    alias
      ? `당신의 이름은 "${alias}"입니다. 이 이름을 가진 아바타로서 사용자와 대화합니다.`
      : `당신은 "${request.avatar.displayName}" 아바타로서 사용자와 대화합니다.`,
  ];
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`페르소나/지침:\n${request.avatar.persona.trim()}`);
  }
  lines.push(
    "시스템 메타 인지: 이 서비스는 Noah Almighty avatar-chat입니다. 아바타는 프로필/페르소나, 기본 스킬, 소유자 플러그인, 개인 지식 저장소, 예약 루틴, 시크릿 이름, 신뢰 사용자 설정을 조합해 동작합니다. " +
      "시스템 상태나 가능한 변경 작업을 말할 때는 추측하지 말고 제공된 도구와 현재 설정을 근거로 답하세요.",
  );
  if (request.confluenceUrlConfigured && request.confluencePatConfigured) {
    lines.push(
      "공용 Confluence 도구가 활성화되어 있습니다. Confluence 검색/페이지 조회/space 조회는 `mcp__confluence__*` 도구를 사용하고, 페이지 생성/수정은 소유자 또는 신뢰 사용자 권한이 있을 때만 시도하세요.",
    );
  } else {
    const missing = [
      request.confluenceUrlConfigured ? "" : "`CONFLUENCE_URL` 환경변수",
      request.confluencePatConfigured ? "" : "`CONFLUENCE_PAT` 시크릿",
    ].filter(Boolean);
    lines.push(
      `공용 Confluence 도구는 등록되어 있지만 아직 ${missing.join("와 ")} 설정이 필요합니다. Confluence 요청을 받으면 먼저 \`mcp__confluence__describe_config\`로 상태를 확인하세요.`,
    );
  }
  // Standing (every-turn) guidance: the avatar can recommend a better-suited
  // teammate avatar. Phrased for ANY viewer class — in a headless routine there's
  // no user to redirect, but the search tool stays useful for the work itself.
  lines.push(
    "다른 아바타 찾기: 사용자가 요청한 작업이 당신의 역량(스킬·지식·역량 해시태그) 범위를 벗어난다고 판단되면, 먼저 직접 도울 수 있는지 시도한 뒤 `mcp__avatars__search_avatars`로 그 주제에 맞는 다른 공개 아바타를 검색하세요. " +
      "더 적합한 아바타가 있으면 사용자에게 그 아바타(@사용자명)와 대화해 보라고 안내하세요.",
  );
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner reviews gaps, colleagues create them.
  // A headless run has NO ONE on the other side: never claim the owner is
  // present and state read-only.
  if (request.headless) {
    lines.push(
      "이것은 예약된 루틴 작업의 **자동 실행**입니다. 응답을 실시간으로 보는 사람이 없으므로 질문하지 말고, 주어진 작업을 끝까지 수행해 결과를 보고하세요.",
    );
    if (request.allowHeadlessTools) {
      lines.push(
        "이 루틴은 소유자의 일반 대화와 같은 도구 권한으로 실행됩니다. 필요한 파일/원격/저장소 작업은 수행하되, 확인 질문이나 권한 프롬프트를 기다릴 수 없으므로 작업 범위를 보수적으로 지키세요. 사용자에게 따로 알려야 할 중요한 결과가 있으면 `mcp__system__notify_user`로 알림을 남기세요.",
      );
    } else {
      lines.push(
        "이 실행은 읽기 전용입니다. 파일을 수정/생성하지 말고, 읽기 도구(Read/Glob/Grep)만 사용하세요.",
      );
    }
  } else if (request.viewerIsOwner) {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `지금 대화 상대는 이 아바타의 **소유자** "${name}"님입니다.`
        : "지금 대화 상대는 이 아바타의 **소유자**입니다.",
    );
    lines.push(
      "소유자가 이 시스템 자체에 대해 묻거나 설정 변경을 요청하면 `mcp__system__describe_system`으로 현재 상태를 확인하고, 요청에 맞게 `mcp__system__create_routine`/`update_routine`/`delete_routine` 또는 `mcp__system__add_plugin`/`set_plugin_enabled`를 직접 사용하세요. " +
        "사용자에게 따로 알려야 할 중요한 결과나 조치 필요 사항은 `mcp__system__notify_user`로 앱 알림을 남기세요. 루틴 시간은 KST `HH:MM` 기준이고, 플러그인 추가/활성화 변경은 보통 다음 대화부터 로드됩니다.",
    );
    const knowledgeRepoConfigured = request.knowledgeRepoConfigured !== false;
    if (knowledgeRepoConfigured) {
      // The owner can have the avatar manage its connected knowledge repo.
      lines.push(
        "당신은 자신의 **지식 저장소**(소유자 전용 개인 repo)를 직접 관리할 수 있습니다: `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit`. " +
          "여기에 업무 지식·스킬을 정리해 두면 다음 대화부터 당신이 그것을 사용합니다. " +
          "write_file/scaffold_skill 변경은 **commit 하기 전까지는 푸시되지 않으니**, 작업 단위가 끝났거나 소유자가 요청하면 commit 하세요.",
      );
    } else {
      // No repo yet → the `create_repo` tool IS available (exposed only in this
      // state). STANDING guidance on every owner turn — not just the greeting —
      // so the avatar actually uses it when asked to "make a repo" instead of
      // giving manual setup steps or calling scaffold_skill first (which fails
      // without a connected repo, and previously misled the avatar).
      lines.push(
        request.gitTokenSet
          ? `아직 지식 저장소가 없습니다. **당신에게는 \`mcp__repo__create_repo\` 도구가 있습니다.** 현재 저장소 생성 대상 사내 GitHub host는 \`${githubHost}\`입니다. 소유자가 저장소를 만들거나 연결해 달라고 하면 — 수동 절차를 안내하지 말고 — 저장소 이름만 받아 \`create_repo\`로 직접 비공개 repo를 만들어 연결하세요(\`GIT_TOKEN\`은 이미 설정돼 있습니다). 저장소가 연결되기 전에는 \`scaffold_skill\`/\`write_file\`/\`commit\`이 실패하므로, 반드시 \`create_repo\`를 **먼저** 호출하세요.`
          : "아직 지식 저장소가 없고 `GIT_TOKEN`도 설정돼 있지 않습니다. 소유자가 저장소 생성을 원하면 먼저 설정 → **Git 자격증명**에서 사내 Git 토큰(`GIT_TOKEN` 시크릿)을 등록해 달라고 안내하세요(등록되면 `mcp__repo__create_repo`로 직접 만들 수 있습니다). 저장소가 연결되기 전에는 `scaffold_skill`/`write_file`/`commit`이 실패합니다.",
      );
    }
    lines.push(
      "일반 **git repo 작업**은 지식 저장소 도구와 별개입니다. 소유자가 업무/코드 저장소를 관리해 달라고 하면 `mcp__git_repo__register_repo`로 repo를 등록한 뒤, `sync_repo`/`status`/`list_files`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`를 사용하세요. " +
        "`push`는 main 전용이 아니라 등록된 branch(또는 branch를 비운 경우 clone의 현재/default branch)로 `HEAD`를 푸시합니다. 소유자가 특정 브랜치를 말하면 `register_repo`의 `branch`에 그 이름을 지정하세요. " +
        "사내/사외 public repo의 clone/sync는 토큰 없이 시도하므로 토큰 설정을 먼저 요구하지 마세요. push는 원격 쓰기 권한이 있는 경우에만 성공합니다. 등록/삭제는 소유자 전용이고, 이미 등록된 repo 작업은 소유자 또는 신뢰 사용자 대화에서만 가능합니다. GitHub issue/PR/release 관리는 포함하지 않는 순수 git 작업 도구입니다.",
    );
    // Group meta-cognition: which groups the owner is in, their role, and the
    // shared group knowledge repo (managed via mcp__group_repo__*). Group members
    // auto-trust each other, so teammates' avatars are reachable at elevated level.
    const groups = request.groupMemberships ?? [];
    if (groups.length > 0) {
      const describe = (g: (typeof groups)[number]) =>
        `${g.name}(${g.role === "admin" ? "관리자" : "멤버"}${g.knowledgeRepoConfigured ? ", 공용 저장소 연결됨" : ", 공용 저장소 없음"})`;
      const adminNoRepo = groups.filter((g) => g.role === "admin" && !g.knowledgeRepoConfigured);
      const groupLines = [
        `소유자는 다음 그룹에 속해 있습니다: ${groups.map(describe).join(", ")}. ` +
          "같은 그룹의 멤버끼리는 **자동으로 서로 신뢰(elevated)**하므로, 같은 그룹 동료의 아바타와 대화할 때 소유자 수준의 도구 권한을 얻고, 비공개 아바타도 서로 찾고 대화할 수 있습니다.",
        "각 그룹에는 **공용 지식 저장소**가 있을 수 있고, `mcp__group_repo__*` 도구로 다룹니다: `list_groups`로 그룹/역할을 확인하고, `list_files`/`read_file`은 그룹 멤버 전원이, `write_file`/`scaffold_skill`/`commit`은 **그룹 관리자만** 사용할 수 있습니다. 그룹 공용 저장소에 정리한 스킬은 그룹 멤버 전원의 아바타가 다음 대화부터 사용합니다.",
      ];
      if (adminNoRepo.length > 0) {
        groupLines.push(
          `당신이 관리자인 그룹 중 ${adminNoRepo.map((g) => `'${g.name}'`).join(", ")}에는 아직 공용 지식 저장소가 없습니다. 소유자가 원하면 \`mcp__group_repo__create_repo\`로 새 사내 GitHub 저장소를 만들어 그 그룹에 연결할 수 있습니다(설정의 그룹 관리에서 기존 저장소를 연결할 수도 있습니다).`,
        );
      }
      lines.push(groupLines.join(" "));
    }
    if (secretNames.length > 0) {
      lines.push(
        "설정의 **시크릿** 탭에 등록된 환경변수 이름: " +
          secretNames.map((name) => `\`${name}\``).join(", ") +
          ". 값은 볼 수 없으며 출력하거나 추측하지 마세요. 필요한 MCP 도구에는 서버가 해당 값을 별도로 주입합니다.",
      );
    }
    // SSH (hex-ssh) tools are registered only when the owner has stored an
    // `SSH_PRIVATE_KEY` secret. When it's absent the avatar has no SSH tools, so
    // tell it how the owner enables them — that's how it answers "I want SSH".
    if (!secretNames.includes("SSH_PRIVATE_KEY")) {
      lines.push(
        "원격 **SSH 도구는 아직 비활성화** 상태입니다(이 대화에는 SSH 실행·파일전송 도구가 없습니다). " +
          "사용자가 SSH 접속을 원하면 먼저 `mcp__ssh_identity__generate_key`로 SSH 키를 생성하세요. 생성된 개인키는 `SSH_PRIVATE_KEY` 시크릿으로 저장되고, 공개키는 사용자에게 보여주며 설정에서도 다시 확인할 수 있습니다. " +
          "사용자가 이미 가진 키를 쓰려는 경우에는 설정 → **시크릿** 탭에 `SSH_PRIVATE_KEY`라는 이름으로 개인 키(OpenSSH/PEM)를 등록하라고 안내하세요. " +
          "등록하면 다음 대화부터 SSH 도구가 활성화되고, 이후 접속할 호스트의 키는 `mcp__ssh_trust__add_host`로 신뢰 등록할 수 있습니다. " +
          "(키 값은 서버에서 SSH 도구에만 주입되며 당신에게는 노출되지 않습니다.)",
      );
    }
    // Greeting-only nudges, surfaced ONLY when the owner opens a fresh chat so
    // they aren't re-injected mid-conversation: pending info requests, plus a
    // one-time suggestion to set up a knowledge repo when none is connected yet.
    if (request.greeting) {
      const greetingParts = [
        openRequestCount > 0
          ? `대화를 시작합니다. 먼저 소유자에게 짧게 인사한 뒤, **pending_requests로 대기 중인 정보 요청(${openRequestCount}건)을 확인해** 번호를 붙여 간결하게 보고하세요.`
          : "대화를 시작합니다. 소유자에게 짧게 인사하세요. (대기 중인 정보 요청은 없으니 굳이 언급하지 마세요.)",
      ];
      if (!knowledgeRepoConfigured) {
        greetingParts.push(
          request.gitTokenSet
            ? "또한 아직 지식 저장소가 연결되어 있지 않습니다. 업무 지식·장기 기억·스킬을 축적하려면 개인 지식 저장소가 필요합니다. " +
                `\`GIT_TOKEN\`이 이미 설정돼 있으니, 원하시면 제가 \`mcp__repo__create_repo\`로 현재 설정된 사내 GitHub host(\`${githubHost}\`)에 비공개 저장소를 만들어 바로 연결해 드릴 수 있다고 안내하세요. ` +
                "사용자가 원하면 저장소 이름을 받아 create_repo로 만든 뒤 `scaffold_skill`→`write_file`→`commit` 순으로 채우세요. (이미 쓰던 repo가 있으면 설정의 지식 저장소에 직접 연결해도 됩니다.)"
            : "또한 아직 지식 저장소가 연결되어 있지 않고, `GIT_TOKEN`도 설정돼 있지 않습니다. " +
                "먼저 설정 → **Git 자격증명**에서 사내 Git 토큰(`GIT_TOKEN`, repo 생성 권한)을 등록하라고 안내하세요. 등록되면 제가 `mcp__repo__create_repo`로 저장소를 만들어 연결해 드릴 수 있습니다. " +
                "직접 만들고 싶다면 사내 GitHub에 개인 repo를 만들어 설정의 지식 저장소에 연결해도 됩니다. 이 저장소는 Claude plugin marketplace 형식이어야 합니다: 루트에 `.claude-plugin/marketplace.json`을 두고, 각 스킬은 `skills/<name>/SKILL.md`와 `skills/<name>/.claude-plugin/plugin.json`을 갖춰야 합니다.",
        );
      }
      greetingParts.push("그런 다음 무엇을 도와줄지 물어보세요.");
      lines.push(greetingParts.join(" "));
    }
  } else {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `지금 대화 상대는 **동료** "${name}"님입니다. 소유자만 알 법한 정보를 모르면 추측하지 말고, knowledge-backfill 스킬에 따라 request_info로 소유자에게 전달하세요.`
        : `지금 대화 상대는 **동료**입니다. 소유자만 알 법한 정보를 모르면 추측하지 말고, knowledge-backfill 스킬에 따라 request_info로 소유자에게 전달하세요.`,
    );
    // A trusted user works at the owner's tool level — don't claim read-only.
    // A plain colleague stays read-only.
    if (!request.elevated) {
      lines.push(
        "이 대화는 읽기 전용입니다. 파일을 수정하거나 생성하지 말고, 읽기 도구(Read/Glob/Grep), 허용된 원격 SSH 조회 도구, 제공된 정보 요청 도구만 사용하세요.",
      );
    } else {
      lines.push(
        "이 대화 상대는 소유자가 신뢰하는 사용자로, 파일 수정·명령 실행 도구를 사용할 수 있습니다. 원격 SSH 도구는 관리자가 허용한 범위에서만 사용하세요.",
      );
      lines.push(
        "소유자가 미리 등록한 일반 git repo는 `mcp__git_repo__list_repos`로 확인하고 `sync_repo`/`status`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`로 작업할 수 있습니다. public repo sync는 토큰 없이 시도하며, 새 repo 등록/삭제 같은 설정 변경은 소유자 전용입니다.",
      );
    }
    lines.push(
      "플러그인, 루틴, 지식 저장소 같은 아바타 시스템 설정 변경은 소유자 전용입니다. 동료가 변경을 요청하면 소유자에게 요청하도록 안내하거나 필요한 맥락을 request_info로 남기세요.",
    );
  }
  const historyBlock = request.greeting ? null : conversationHistoryBlock(request.conversationHistory);
  if (historyBlock) {
    lines.push(historyBlock);
  }
  if (request.greeting) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${request.headless ? "작업 지시" : "사용자 메시지"}:\n${request.message}`;
}

/**
 * Run the Claude Agent SDK against the avatar's plugin roots.
 *
 * Permission model — enforced by a PreToolUse hook, NOT canUseTool/onUserDialog.
 * (Empirically, the SDK's interactive control callbacks `canUseTool`/`onUserDialog`
 * do NOT fire in this headless `query()` setup — verified against v0.3.169 — but
 * PreToolUse hooks DO fire and can block asynchronously, so the hook is our gate.)
 *
 *  - Read-only tools / knowledge MCP / orchestration meta-tools → allowed silently.
 *  - AskUserQuestion → intercepted: we surface the question, await the user's
 *    answer, and inject it back as the tool result (via a deny+reason, which the
 *    model reads as the answer).
 *  - Any other tool (Write/Edit/Bash/WebFetch/…):
 *      • OWNER  → interactive permission prompt (approve → allow, else deny).
 *      • COLLEAGUE → denied (read-only) and surfaced as a "blocked" notice.
 *
 * Streaming + interactivity are opt-in via the events sink.
 */
export async function runClaudeAgent(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events?: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown>;
  };
  const { buildKnowledgeServer, KNOWLEDGE_SERVER_NAME, KNOWLEDGE_TOOL_NAMES } = await import(
    "./knowledgeTools.js"
  );
  const { buildRepoServer, REPO_SERVER_NAME, REPO_TOOL_NAMES, REPO_CREATE_TOOL_NAME } = await import(
    "./repoTools.js"
  );
  const { buildSshTrustServer, SSH_TRUST_SERVER_NAME, SSH_TRUST_TOOL_NAMES } = await import(
    "./sshTrustTools.js"
  );
  const { buildSshIdentityServer, SSH_IDENTITY_SERVER_NAME, SSH_IDENTITY_TOOL_NAMES } = await import(
    "./sshIdentityTools.js"
  );
  const { buildSystemServer, SYSTEM_SERVER_NAME, SYSTEM_TOOL_NAMES } = await import(
    "./systemTools.js"
  );
  const { buildConfluenceServer, CONFLUENCE_SERVER_NAME, CONFLUENCE_TOOL_NAMES } = await import(
    "./confluenceTools.js"
  );
  const { buildAvatarDirectoryServer, AVATAR_DIRECTORY_SERVER_NAME, AVATAR_DIRECTORY_TOOL_NAMES } =
    await import("./avatarDirectoryTools.js");
  const { buildGitRepoServer, GIT_REPO_SERVER_NAME, GIT_REPO_TOOL_NAMES } = await import(
    "./gitRepoTools.js"
  );
  const { buildGroupRepoServer, GROUP_REPO_SERVER_NAME, GROUP_REPO_TOOL_NAMES } = await import(
    "./groupRepoTools.js"
  );

  const streaming = Boolean(events);
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);
  const allowHeadlessTools = Boolean(request.allowHeadlessTools);
  const ownerToolAccess = viewerIsOwner && (!headless || allowHeadlessTools);
  const elevatedToolAccess = (viewerIsOwner || Boolean(request.elevated)) && (!headless || allowHeadlessTools);
  const autoApprove = Boolean(request.autoApprove);
  // Tool-permission level: the owner OR a designated trusted user. Distinct from
  // viewerIsOwner, which still gates the owner-only knowledge inbox + greeting.
  const elevated = viewerIsOwner || Boolean(request.elevated);
  const hexSshViewerClass = viewerClassForAgentRequest({
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    headless: headless && !allowHeadlessTools,
  });
  const hexSshPolicy = store.getHexSshToolPolicy();
  const hexSshAllowedTools = allowedHexSshToolsForViewer(hexSshPolicy, hexSshViewerClass);
  // Effective model: an env-pinned ANTHROPIC_MODEL wins (mirrors the API-key vs.
  // subscription rule), otherwise the admin-selected override, otherwise the SDK default.
  const effectiveModel = config.anthropicModel ?? store.getModelOverride() ?? undefined;
  const agentStart = Date.now();

  agentLogger.info(
    {
      avatarId: request.avatar.id,
      viewerUserId: request.viewerUserId,
      headless,
      allowHeadlessTools,
      elevated,
      autoApprove,
      hexSshViewerClass,
      hexSshAllowedToolCount: hexSshAllowedTools.length,
      model: effectiveModel,
    },
    "agent run started",
  );

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  // Generic headless runs stay at colleague-level access, while scheduled owner
  // routines can opt into owner-level tools through allowHeadlessTools.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  // Only needed for the owner's opening greeting — every other turn stays quiet.
  const openRequestCount =
    request.greeting && viewerIsOwner && !headless
      ? store.countOpenKnowledgeRequests(request.avatar.id)
      : 0;

  // Knowledge-repo management tools (list/read/write/scaffold/commit). OWNER-ONLY:
  // a colleague, a trusted user, or a generic headless run gets a refusal from
  // every tool. Scheduled owner routines use ownerToolAccess above. Registered
  // unconditionally — the per-handler `viewerIsOwner` gate is the safety boundary,
  // mirroring the knowledge server above. The owner identity for commits is
  // resolved from the avatar's own user row (viewer == owner here).
  const ownerRow = store.getUserById(request.avatar.id);
  // Computed once and reused for the prompt (below). The repo-creation tool is
  // exposed ONLY for an owner-driven, non-headless chat with NO repo yet — once
  // one is connected, hiding it keeps the unused tool out of every prompt.
  const knowledgeRepoConfigured = Boolean(store.getKnowledgeRepo(request.avatar.id).repo);
  const allowRepoCreate = ownerToolAccess && !knowledgeRepoConfigured;
  const repoServer = buildRepoServer(
    store,
    {
      avatarUserId: request.avatar.id,
      owner: {
        id: request.avatar.id,
        username: ownerRow?.username ?? "",
        displayName: ownerRow?.displayName ?? request.avatar.displayName,
        alias: ownerRow?.alias ?? request.avatar.alias,
      },
      viewerIsOwner: ownerToolAccess,
      config,
    },
    { allowCreate: allowRepoCreate },
  );
  const systemServer = buildSystemServer(store, {
    avatarUserId: request.avatar.id,
    owner: {
      id: request.avatar.id,
      username: ownerRow?.username ?? "",
      displayName: ownerRow?.displayName ?? request.avatar.displayName,
      alias: ownerRow?.alias ?? request.avatar.alias,
    },
    viewerIsOwner: ownerToolAccess,
    config,
  });
  // Cross-avatar discovery (read-only): lets the avatar look up OTHER published
  // avatars by capability so it can point the user at a teammate avatar for
  // things outside its own expertise. Visibility is from the VIEWER's POV (the
  // person chatting), and the current avatar is excluded from its own results.
  const avatarDirectoryServer = buildAvatarDirectoryServer(store, {
    avatarUserId: request.avatar.id,
    viewerUserId: request.viewerUserId ?? request.avatar.id,
  });
  const sshIdentityServer = buildSshIdentityServer(store, {
    avatarUserId: request.avatar.id,
    owner: {
      id: request.avatar.id,
      username: ownerRow?.username ?? "",
      displayName: ownerRow?.displayName ?? request.avatar.displayName,
      alias: ownerRow?.alias ?? request.avatar.alias,
    },
    viewerIsOwner: ownerToolAccess,
  });
  const gitRepoServer = buildGitRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner: {
      id: request.avatar.id,
      username: ownerRow?.username ?? "",
      displayName: ownerRow?.displayName ?? request.avatar.displayName,
      alias: ownerRow?.alias ?? request.avatar.alias,
    },
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    config,
  });
  // Group knowledge-repo tools (per group the OWNER belongs to). OWNER-ONLY like
  // the personal repo tools — a group admin edits their group repo through their
  // own avatar; each tool then checks the owner's role in the named group (member
  // reads, admin writes). Registered only for an owner-driven turn where the
  // owner actually belongs to ≥1 group, to keep the tools out of other prompts.
  const ownerGroups = store.listUserGroups(request.avatar.id);
  const groupRepoActive = ownerToolAccess && ownerGroups.length > 0;
  const groupRepoServer = buildGroupRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner: {
      id: request.avatar.id,
      username: ownerRow?.username ?? "",
      displayName: ownerRow?.displayName ?? request.avatar.displayName,
      alias: ownerRow?.alias ?? request.avatar.alias,
    },
    viewerIsOwner: ownerToolAccess,
    config,
  });

  // SSH host-trust tools (add/list/remove the hosts hex-ssh will connect to).
  // NOT owner-only: host fingerprints are public, and a viewer who can drive
  // hex-ssh can manage its trust. The trust file is keyed to the owner
  // (avatar.id) and injected into hex-ssh below as KNOWN_HOSTS_PATH.
  const sshTrustServer = buildSshTrustServer({ avatarUserId: request.avatar.id, config });

  // The avatar acts on its OWNER's behalf, so it uses the OWNER's secrets
  // (avatar.id) regardless of who is chatting — a colleague talking to the
  // owner's avatar still operates with the owner's credentials. The values are
  // decrypted only here and handed to the MCP subprocess as env, so they never
  // surface to the agent (Bash/`env` runs in a different process) nor to `toUser`.
  const ownerSecrets = store.getUserSecrets(request.avatar.id);
  const sshSecrets = sshMcpSecretEnv(ownerSecrets);
  const confluenceServer = buildConfluenceServer({
    config,
    ownerSecrets,
    elevated: elevatedToolAccess,
  });
  // hex-ssh (remote-server access MCP, ssh2-based — no system ssh binary needed):
  // registered explicitly (not via a plugin's .mcp.json) so we can inject the
  // owner's per-user SSH identity. The policy proxy filters tools/list before
  // the model sees it, and the PreToolUse hook below enforces the same allowlist
  // again on tools/call.
  const hexSshProxyPath = path.join(process.cwd(), "scripts", "hex-ssh-policy-proxy.mjs");
  const sshActive = Boolean(ownerSecrets.SSH_PRIVATE_KEY && hexSshAllowedTools.length > 0);
  const sshServers = sshActive
    ? {
        [HEX_SSH_SERVER_NAME]: {
          type: "stdio" as const,
          command: process.execPath,
          args: [hexSshProxyPath],
          // KNOWN_HOSTS_PATH points hex-ssh at the owner's persistent trust file
          // (under the data volume). hex-ssh re-reads it on every connection, so
          // the `mcp__ssh_trust__*` tools can add a host mid-session and it takes
          // effect immediately. Only SSH-specific secrets are forwarded here:
          // git credentials stay inside the app-managed git MCP handlers.
          env: {
            REMOTE_SSH_MODE: "safe",
            KNOWN_HOSTS_PATH: knownHostsPath(request.avatar.id, config),
            ...sshSecrets,
            HEX_SSH_UPSTREAM_COMMAND: config.hexSshCommand,
            HEX_SSH_ALLOWED_TOOLS: hexSshAllowedTools.join(","),
          },
        },
      }
    : {};

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    // The PreToolUse hook (below) is the real gate. `default` mode is required —
    // it's the mode in which the hook's deny decision is honored.
    permissionMode: "default",
    // Auto-approve (no prompt) the read-only + knowledge + meta tools. NOTE: this
    // is only an auto-approve list, NOT a restriction — the hook does enforcement.
    allowedTools: [
      ...config.readOnlyTools,
      ...KNOWLEDGE_TOOL_NAMES,
      ...REPO_TOOL_NAMES,
      ...(allowRepoCreate ? [REPO_CREATE_TOOL_NAME] : []),
      ...SYSTEM_TOOL_NAMES,
      ...CONFLUENCE_TOOL_NAMES,
      ...AVATAR_DIRECTORY_TOOL_NAMES,
      ...SSH_IDENTITY_TOOL_NAMES,
      ...GIT_REPO_TOOL_NAMES,
      ...(groupRepoActive ? GROUP_REPO_TOOL_NAMES : []),
      ...SSH_TRUST_TOOL_NAMES,
      "Skill",
      "TodoWrite",
      ...TASK_ORCHESTRATION_TOOLS,
    ],
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    skills: "all",
    // Register the SSH host-trust server alongside hex-ssh, and only when hex-ssh
    // itself is active (the owner stored a key) — trust management is pointless
    // without a server to connect.
    mcpServers: {
      [KNOWLEDGE_SERVER_NAME]: knowledgeServer,
      [REPO_SERVER_NAME]: repoServer,
      [SYSTEM_SERVER_NAME]: systemServer,
      [CONFLUENCE_SERVER_NAME]: confluenceServer,
      [AVATAR_DIRECTORY_SERVER_NAME]: avatarDirectoryServer,
      [SSH_IDENTITY_SERVER_NAME]: sshIdentityServer,
      [GIT_REPO_SERVER_NAME]: gitRepoServer,
      ...(groupRepoActive ? { [GROUP_REPO_SERVER_NAME]: groupRepoServer } : {}),
      ...sshServers,
      ...(sshActive ? { [SSH_TRUST_SERVER_NAME]: sshTrustServer } : {}),
    },
    maxTurns: config.maxTurns,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  // Persist session transcripts under dataDir (not the SDK's default ~/.claude)
  // so a conversation's session can be resumed after a server/container restart.
  // `env` REPLACES the subprocess environment. Start from process.env for SDK
  // auth/proxy settings, but strip git credentials: git auth is only available
  // through the app-managed in-process MCP bridge.
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  options.env = agentSubprocessEnv(process.env, config.agentSessionsDir);
  // Subscription auth: when no ANTHROPIC_API_KEY is configured, fall back to the
  // admin-pasted `claude setup-token` token (stored encrypted in app_config),
  // injecting it as CLAUDE_CODE_OAUTH_TOKEN. Precedence is API key (.env) > stored
  // subscription token, matching the authMode reported by /api/admin/system. The
  // token is decrypted only here into the subprocess env — never exposed to the
  // agent (Bash/`env` run in a separate process), same as the secret vault. We
  // also drop any empty ANTHROPIC_API_KEY left over from `.env` so it can't shadow
  // the OAuth token.
  if (!config.anthropicApiKey) {
    const oauthToken = store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    if (oauthToken) {
      delete (options.env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
      (options.env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  // Resume the conversation's prior session so the model keeps its context. Only
  // a real follow-up turn passes one (greeting/regenerate start fresh — see app.ts).
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
  }
  // Pin the model when configured (env or admin override); otherwise the SDK default.
  if (effectiveModel) {
    options.model = effectiveModel;
  }
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to this session's workspace + the avatar's plugin dirs.
  if (request.cwd) {
    options.cwd = request.cwd;
  }
  if (pluginRoots.length > 0) {
    options.additionalDirectories = pluginRoots.map((root) => root.path);
  }

  // PreToolUse hook: enforcement + interactivity. Runs in-process, so it can call
  // straight into the events sink and await the user.
  if (events) {
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            buildPreToolUseHook(
              events,
              elevated,
              config.readOnlyTools,
              headless,
              allowHeadlessTools,
              autoApprove,
              hexSshViewerClass,
              hexSshPolicy,
              config.rtkCommand,
            ),
          ],
        },
      ],
    };
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  const state = createLoopState();
  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";
  let resultErrorSubtype = "";

  const promptRequest: AgentRequest =
    viewerIsOwner && !headless
      ? {
          ...request,
          secretNames: store.listUserSecretNames(request.avatar.id),
          knowledgeRepoConfigured,
          gitTokenSet: Boolean(store.getGitToken(request.avatar.id)),
          githubHost: config.githubHost,
          confluenceUrlConfigured: Boolean(config.confluenceUrl),
          confluencePatConfigured: Boolean(ownerSecrets.CONFLUENCE_PAT || ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN),
          groupMemberships: ownerGroups,
        }
      : {
          ...request,
          secretNames: [],
          knowledgeRepoConfigured,
          gitTokenSet: Boolean(store.getGitToken(request.avatar.id)),
          githubHost: config.githubHost,
          confluenceUrlConfigured: Boolean(config.confluenceUrl),
          confluencePatConfigured: Boolean(ownerSecrets.CONFLUENCE_PAT || ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN),
          groupMemberships: [],
        };

  for await (const message of sdk.query({ prompt: buildPrompt(promptRequest, openRequestCount), options })) {
    if (!isRecord(message)) {
      continue;
    }
    if (events) {
      if (message.type === "stream_event") {
        const delta = handleStreamEvent(message, events);
        if (delta) {
          deltaChunks.push(delta);
        }
        continue;
      }
      if (message.type === "system") {
        handleSystemEvent(message, events, state);
        continue;
      }
      if (message.type === "user") {
        handleUserMessage(message, events, state);
        continue;
      }
      if (message.type === "tool_progress") {
        const toolName = asString(message.tool_name) || asString(message.toolName);
        events.onStatus?.(toolName ? `실행 중: ${toolName}` : "실행 중…");
        continue;
      }
    }

    if (message.type === "assistant") {
      // With an events sink this also emits tool/agent start events.
      const assistantText = events
        ? handleAssistantMessage(message, events, state)
        : extractMainAssistantText(message);
      if (assistantText) {
        assistantChunks.push(assistantText);
      }
      continue;
    }

    const { text: extractedResult, errorSubtype } = interpretResult(message);
    if (extractedResult) {
      resultText = extractedResult;
    }
    if (errorSubtype) {
      resultErrorSubtype = errorSubtype;
    }
  }

  // Prefer the full text the model actually STREAMED (every main-agent assistant
  // text block / delta across ALL turns) over the SDK's terminal `result` string,
  // which is only the LAST assistant turn's text. The streamed transcript is what
  // the user watched appear live; finalizing/persisting from `resultText` instead
  // dropped any narration emitted before the final turn (preambles, text between
  // tool calls) the instant the run completed — and kept it gone on reload, since
  // this value is what gets stored. resultText is only a fallback for the rare
  // case nothing streamed; the error fallback applies when neither produced text.
  const partialText = assistantChunks.join("\n\n").trim() || deltaChunks.join("").trim();
  const text =
    partialText ||
    resultText ||
    (resultErrorSubtype
      ? resultErrorMessage(resultErrorSubtype)
      : "Claude Agent SDK 응답이 비어 있습니다.");
  agentLogger.info(
    { avatarId: request.avatar.id, runtime: "claude", textLength: text.length, durationMs: Date.now() - agentStart },
    "agent run completed",
  );
  return {
    kind: "text",
    runtime: "claude",
    summary: "Claude Agent SDK 실행이 완료되었습니다.",
    text,
  };
}

/** Non-streaming text extraction (main agent only); used when no events sink. */
function extractMainAssistantText(message: Record<string, unknown>): string {
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
