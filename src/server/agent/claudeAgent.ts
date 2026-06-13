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
    "Earlier conversation history (before the current user message, oldest first):",
    "```json",
    JSON.stringify(compacted, null, 2),
    "```",
    "This history is the actual context saved in this same conversation. The user message below is a new message that follows this history.",
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

// App-internal secrets the agent subprocess must NEVER be able to read from its
// environment. SESSION_SECRET is the AES-256-GCM master key for EVERY user's
// at-rest secrets (git tokens, the secret vault, the Claude subscription token):
// a Bash-capable elevated viewer that read it out of the subprocess env (or
// /proc) could decrypt all tenants' secrets straight out of the shared DB. The
// subprocess never opens the app DB, so stripping it costs nothing. (Git
// credentials are stripped separately above — they flow only through the
// app-managed git MCP bridge.)
const SENSITIVE_APP_ENV_NAMES = ["SESSION_SECRET"] as const;

export function agentSubprocessEnv(
  baseEnv: Record<string, string | undefined>,
  agentSessionsDir: string,
): Record<string, string | undefined> {
  const env = withoutGitCredentialEnv(baseEnv);
  for (const name of SENSITIVE_APP_ENV_NAMES) {
    delete env[name];
  }
  return {
    ...env,
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

export interface AgentToolAccess {
  viewerIsOwner: boolean;
  headless: boolean;
  allowHeadlessTools: boolean;
  /** Owner-level tool access: owner AND (non-headless OR a headless run that opted in). */
  ownerToolAccess: boolean;
  /** Elevated (owner OR trusted) tool access, with the same headless gating. */
  elevatedToolAccess: boolean;
  /** Owner OR trusted, IGNORING headless — gates the auto-approve path + greeting. */
  elevated: boolean;
  autoApprove: boolean;
  hexSshViewerClass: HexSshViewerClass;
}

/**
 * Derive a run's tool-permission level from the request. Pure and exported so it
 * can be unit-tested directly: because the PreToolUse hook auto-allows every
 * `mcp__*` tool, these booleans are the REAL gate between a run and the owner-only
 * tools. A regression that, e.g., passed raw `viewerIsOwner` through would
 * silently grant headless intro/hashtag-generation runs full owner repo-write
 * access — so the four viewer classes are pinned in tests.
 */
export function deriveAgentToolAccess(request: AgentRequest): AgentToolAccess {
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);
  const allowHeadlessTools = Boolean(request.allowHeadlessTools);
  // A headless run is tool-restricted UNLESS it explicitly opted in (scheduled
  // owner routines do). `!headlessRestricted` === `(!headless || allowHeadlessTools)`.
  const headlessRestricted = headless && !allowHeadlessTools;
  const ownerToolAccess = viewerIsOwner && !headlessRestricted;
  const elevatedToolAccess = (viewerIsOwner || Boolean(request.elevated)) && !headlessRestricted;
  const elevated = viewerIsOwner || Boolean(request.elevated);
  const autoApprove = Boolean(request.autoApprove);
  const hexSshViewerClass = viewerClassForAgentRequest({
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    headless: headlessRestricted,
  });
  return {
    viewerIsOwner,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  };
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
    return "The user provided an answer.";
  }
  const answers = isRecord(result.answers) ? result.answers : {};
  const lines = Object.entries(answers).map(([q, a]) => `- "${q}" → ${asString(a) || String(a)}`);
  return lines.length
    ? `The user answered the question(s) as follows:\n${lines.join("\n")}`
    : "The user provided an answer.";
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
            ? "During a scheduled automated run you cannot ask the user questions. Proceed with reasonable assumptions."
            : "The question feature is unavailable.",
        );
      }
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const answer = await events.onQuestion({ dialogKind: "AskUserQuestion", payload: { questions }, toolUseId });
      return answer.behavior === "completed"
        ? hookDeny(formatQuestionAnswer(answer.result))
        : hookDeny("The user did not answer the question (cancelled). Proceed without an answer.");
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
      return hookDeny(`The hex-ssh tool '${hexSshTool}' is not permitted at your current permission level.`);
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
        : hookDeny("The user denied the use of this tool.");
    }

    events.onBlocked?.({ toolUseId, toolName, agentId, reason: "읽기 전용 대화에서는 쓸 수 없는 도구입니다." });
    agentLogger.info({ toolName, agentId, reason: "read-only" }, "tool blocked");
    return hookDeny(
      headless
        ? "This run is an automated routine (read-only). File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep."
        : "This conversation is read-only. File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep and the information-request tools.",
    );
  };
}

/**
 * Standing guidance for every tool-capable run (owner, trusted user, owner
 * routine): remote git work goes through the app-managed MCP bridges ONLY. The
 * agent shell has no git credentials (they're stripped from the subprocess
 * env), so a Bash `git clone`/`git push` fallback can't authenticate — and it
 * bypasses the app's audit/error-scrub path. Injected per turn so the avatar
 * doesn't drift into shell git after an MCP failure.
 */
const GIT_MCP_ONLY_GUIDANCE =
  "**Remote git work goes through MCP tools ONLY**: remote git operations such as clone/pull/push/fetch MUST be performed exclusively via the dedicated MCP tools (`mcp__repo__*` for the personal knowledge repository, `mcp__git_repo__*` for general repos, `mcp__group_repo__*` for group repositories). " +
  "Git credentials are injected by the server into those tools only and are NOT present in your shell — running `git clone`/`git push`/`gh` via Bash cannot authenticate. " +
  "If an MCP tool fails, do NOT work around it or retry with Bash git; instead resolve the cause shown in the failure message (token/permission/branch/URL) or report it to the user. " +
  "Running git commands directly inside the app-managed local clone directories is also forbidden.";

export function buildPrompt(request: AgentRequest, openRequestCount: number): string {
  const alias = request.avatar.alias?.trim();
  const secretNames = Array.from(new Set((request.secretNames ?? []).filter(Boolean))).sort();
  const githubHost = normalizeGithubHost(request.githubHost);
  const lines = [
    alias
      ? `Your name is "${alias}". You converse with the user as the avatar bearing this name.`
      : `You converse with the user as the "${request.avatar.displayName}" avatar.`,
  ];
  lines.push(
    "Respond in the same language the user writes in; if it is unclear, default to Korean (한국어). " +
      "These instructions are written in English for your benefit, but your replies should match the user's language.",
  );
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`Persona/instructions:\n${request.avatar.persona.trim()}`);
  }
  lines.push(
    "System meta-cognition: this service is Noah Almighty (avatar-chat). An avatar operates from a combination of its profile/persona, default skills, owner plugins, a personal knowledge repository, scheduled routines, secret names, and trusted-user settings. " +
      "When you describe system state or what changes are possible, do not guess — base your answer on the provided tools and the current configuration.",
  );
  if (request.confluenceUrlConfigured && request.confluencePatConfigured) {
    lines.push(
      "The shared Confluence tools are enabled. Use the `mcp__confluence__*` tools for Confluence search / page retrieval / space lookup, and only attempt page creation or updates when you have owner or trusted-user permission.",
    );
  } else {
    const missing = [
      request.confluenceUrlConfigured ? "" : "the `CONFLUENCE_URL` environment variable",
      request.confluencePatConfigured ? "" : "the `CONFLUENCE_PAT` secret",
    ].filter(Boolean);
    lines.push(
      `The shared Confluence tools are registered, but still need ${missing.join(" and ")} to be configured. When you receive a Confluence request, first check status with \`mcp__confluence__describe_config\`.`,
    );
  }
  // Standing (every-turn) guidance: the avatar can recommend a better-suited
  // teammate avatar. Phrased for ANY viewer class — in a headless routine there's
  // no user to redirect, but the search tool stays useful for the work itself.
  lines.push(
    "Finding other avatars: if you judge that the user's request falls outside your capabilities (skills, knowledge, capability hashtags), first try to help directly, then use `mcp__avatars__search_avatars` to find other public avatars suited to that topic. " +
      "If a better-suited avatar exists, suggest that the user try talking to that avatar (@username).",
  );
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner reviews gaps, colleagues create them.
  // A headless run has NO ONE on the other side: never claim the owner is
  // present and state read-only.
  if (request.headless) {
    lines.push(
      request.allowHeadlessTools
        ? "This is the **automated execution** of a scheduled routine task. No one is watching the response in real time, so do not ask questions — carry the given task through to completion and report the result."
        : "This is an **automated task**, not a conversation (e.g. generating a profile intro or hashtags). There is no one to answer follow-up questions, so do not ask questions — carry the given task through to completion and output only the result.",
    );
    if (request.allowHeadlessTools) {
      lines.push(
        "This routine runs with the same tool permissions as the owner's normal conversation. Perform the file/remote/repository operations it needs, but since you cannot wait for confirmation questions or permission prompts, keep the scope of your work conservative. If there is an important result the user should be told about separately, leave an app notification with `mcp__system__notify_user`.",
      );
      // Routine self-state (META-COGNITION): owner-level tools ARE registered
      // for this run, so the routine needs the same state an owner chat gets —
      // otherwise it guesses (e.g. calls scaffold_skill with no repo connected,
      // or never realizes its group repo tools exist).
      const routineState: string[] = [
        request.knowledgeRepoConfigured !== false
          ? "Personal knowledge repository: connected — `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit` are available (changes must be committed to be pushed)."
          : request.gitTokenSet
            ? "Personal knowledge repository: none — if a task needs a repository, create and connect one first with `mcp__repo__create_repo` (`scaffold_skill`/`write_file`/`commit` fail before one is connected)."
            : "Personal knowledge repository: none, and `GIT_TOKEN` is also not set — you cannot do tasks that need a repository, so note in your result report that a token needs to be registered.",
      ];
      const routineGroups = request.groupMemberships ?? [];
      if (routineGroups.length > 0) {
        routineState.push(
          `Owner's groups: ${routineGroups
            .map(
              (g) =>
                `${g.name}(${g.role === "admin" ? "admin" : "member"}, shared repository ${g.knowledgeRepoConfigured ? "connected" : "none"})`,
            )
            .join(", ")} — you can use the \`mcp__group_repo__*\` tools (members read, only admins write/commit).`,
        );
      }
      if (secretNames.length > 0) {
        routineState.push(
          `Configured secret names: ${secretNames.map((name) => `\`${name}\``).join(", ")} (the values are not exposed; do not output them).`,
        );
      }
      routineState.push("If you need any other current configuration or state, call `mcp__system__describe_system`.");
      lines.push(`Current self-state: ${routineState.join(" ")}`);
      lines.push(GIT_MCP_ONLY_GUIDANCE);
    } else {
      lines.push(
        "This run is read-only. Do not modify or create files; use only the read tools (Read/Glob/Grep).",
      );
    }
  } else if (request.viewerIsOwner) {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `The person you are talking to right now is this avatar's **owner**, "${name}".`
        : "The person you are talking to right now is this avatar's **owner**.",
    );
    lines.push(
      "When the owner asks about this system itself or requests configuration changes, check the current state with `mcp__system__describe_system`, then directly use `mcp__system__create_routine`/`update_routine`/`delete_routine` or `mcp__system__add_plugin`/`set_plugin_enabled` as appropriate. " +
        "For an important result or required action the user should be told about separately, leave an app notification with `mcp__system__notify_user`. Routine times are based on KST `HH:MM`, and plugin add/enable changes usually load starting from the next conversation.",
    );
    const knowledgeRepoConfigured = request.knowledgeRepoConfigured !== false;
    if (knowledgeRepoConfigured) {
      // The owner can have the avatar manage its connected knowledge repo.
      lines.push(
        "You can directly manage your own **knowledge repository** (an owner-only personal repo): `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit`. " +
          "If you organize work knowledge and skills here, you will use them starting from the next conversation. " +
          "write_file/scaffold_skill changes are **not pushed until you commit**, so commit when a unit of work is finished or the owner asks.",
      );
    } else {
      // No repo yet → the `create_repo` tool IS available (exposed only in this
      // state). STANDING guidance on every owner turn — not just the greeting —
      // so the avatar actually uses it when asked to "make a repo" instead of
      // giving manual setup steps or calling scaffold_skill first (which fails
      // without a connected repo, and previously misled the avatar).
      lines.push(
        request.gitTokenSet
          ? `You do not have a knowledge repository yet. **You have the \`mcp__repo__create_repo\` tool.** The internal GitHub host where repositories are currently created is \`${githubHost}\`. When the owner asks you to create or connect a repository — do not walk them through manual steps — just take a repository name and create and connect a private repo directly with \`create_repo\` (\`GIT_TOKEN\` is already set). \`scaffold_skill\`/\`write_file\`/\`commit\` fail before a repository is connected, so you MUST call \`create_repo\` **first**.`
          : "You do not have a knowledge repository yet, and `GIT_TOKEN` is not set either. If the owner wants to create a repository, first guide them to register an internal Git token (the `GIT_TOKEN` secret) under Settings → **Git credentials** (once registered, you can create one directly with `mcp__repo__create_repo`). `scaffold_skill`/`write_file`/`commit` fail before a repository is connected.",
      );
    }
    lines.push(
      "General **git repo work** is separate from the knowledge-repository tools. When the owner asks you to manage a work/code repository, register it with `mcp__git_repo__register_repo`, then use `sync_repo`/`status`/`list_files`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`. " +
        "`push` is not main-only — it pushes `HEAD` to the registered branch (or, if branch was left empty, the clone's current/default branch). If the owner names a specific branch, set that name as `register_repo`'s `branch`. " +
        "Cloning/syncing internal or external public repos is attempted without a token, so do not demand token setup first. push succeeds only when you have remote write permission. Registration/removal is owner-only, and work on an already-registered repo is possible only in owner or trusted-user conversations. These are pure git tools and do not cover GitHub issue/PR/release management.",
    );
    lines.push(GIT_MCP_ONLY_GUIDANCE);
    // Group meta-cognition: which groups the owner is in, their role, and the
    // shared group knowledge repo (managed via mcp__group_repo__*). Group members
    // auto-trust each other, so teammates' avatars are reachable at elevated level.
    const groups = request.groupMemberships ?? [];
    if (groups.length > 0) {
      const describe = (g: (typeof groups)[number]) =>
        `${g.name}(${g.role === "admin" ? "admin" : "member"}${g.knowledgeRepoConfigured ? ", shared repository connected" : ", no shared repository"})`;
      const adminNoRepo = groups.filter((g) => g.role === "admin" && !g.knowledgeRepoConfigured);
      const groupLines = [
        `The owner belongs to the following groups: ${groups.map(describe).join(", ")}. ` +
          "Members of the same group **automatically trust each other (elevated)**, so when you talk to a same-group colleague's avatar you gain owner-level tool permissions, and even unpublished avatars can find and talk to each other.",
        "Each group may have a **shared knowledge repository**, handled with the `mcp__group_repo__*` tools: use `list_groups` to check groups/roles; all group members can `list_files`/`read_file`, while only **group admins** can `write_file`/`scaffold_skill`/`commit`. Skills organized in a group's shared repository are used by every group member's avatar starting from the next conversation.",
      ];
      if (adminNoRepo.length > 0) {
        groupLines.push(
          `Among the groups where you are an admin, ${adminNoRepo.map((g) => `'${g.name}'`).join(", ")} do not have a shared knowledge repository yet. If the owner wants, you can create a new internal GitHub repository with \`mcp__group_repo__create_repo\` and connect it to that group (you can also connect an existing repository via Group management in Settings).`,
        );
      }
      lines.push(groupLines.join(" "));
    }
    if (secretNames.length > 0) {
      lines.push(
        "Environment-variable names registered in the **Secrets** tab of Settings: " +
          secretNames.map((name) => `\`${name}\``).join(", ") +
          ". You cannot see the values; do not output or guess them. The server injects those values separately into the MCP tools that need them.",
      );
    }
    // SSH (hex-ssh) tools are registered only when the owner has stored an
    // `SSH_PRIVATE_KEY` secret. When it's absent the avatar has no SSH tools, so
    // tell it how the owner enables them — that's how it answers "I want SSH".
    if (!secretNames.includes("SSH_PRIVATE_KEY")) {
      lines.push(
        "Remote **SSH tools are still disabled** (this conversation has no SSH execution / file-transfer tools). " +
          "If the user wants SSH access, first generate an SSH key with `mcp__ssh_identity__generate_key`. The generated private key is stored as the `SSH_PRIVATE_KEY` secret, and the public key is shown to the user and can also be viewed again in Settings. " +
          "If the user wants to use a key they already have, guide them to register the private key (OpenSSH/PEM) under the Settings → **Secrets** tab with the name `SSH_PRIVATE_KEY`. " +
          "Once registered, the SSH tools become active from the next conversation, and host keys for hosts you connect to afterward can be trusted with `mcp__ssh_trust__add_host`. " +
          "(The key value is injected by the server into the SSH tools only and is not exposed to you.)",
      );
    }
    // Greeting-only nudges, surfaced ONLY when the owner opens a fresh chat so
    // they aren't re-injected mid-conversation: pending info requests, plus a
    // one-time suggestion to set up a knowledge repo when none is connected yet.
    if (request.greeting) {
      const greetingParts = [
        openRequestCount > 0
          ? `You are starting a conversation. First greet the owner briefly, then **check the pending information requests with pending_requests (${openRequestCount} open)** and report them concisely, numbered.`
          : "You are starting a conversation. Greet the owner briefly. (There are no pending information requests, so there is no need to mention them.)",
      ];
      if (!knowledgeRepoConfigured) {
        greetingParts.push(
          request.gitTokenSet
            ? "Also, no knowledge repository is connected yet. A personal knowledge repository is needed to accumulate work knowledge, long-term memory, and skills. " +
                `Since \`GIT_TOKEN\` is already set, let the owner know that, if they want, you can create a private repository on the currently configured internal GitHub host (\`${githubHost}\`) with \`mcp__repo__create_repo\` and connect it right away. ` +
                "If the user wants, take a repository name, create it with create_repo, then fill it in the order `scaffold_skill`→`write_file`→`commit`. (If they already have a repo in use, they can connect it directly under the knowledge repository setting.)"
            : "Also, no knowledge repository is connected yet, and `GIT_TOKEN` is not set either. " +
                "First guide them to register an internal Git token (`GIT_TOKEN`, with repo-creation permission) under Settings → **Git credentials**. Once registered, you can create and connect a repository with `mcp__repo__create_repo`. " +
                "If they want to create it themselves, they can make a personal repo on internal GitHub and connect it under the knowledge repository setting. This repository must be in Claude plugin marketplace format: place `.claude-plugin/marketplace.json` at the root, and each skill must have `skills/<name>/SKILL.md` and `skills/<name>/.claude-plugin/plugin.json`.",
        );
      }
      greetingParts.push("Then ask what you can help with.");
      lines.push(greetingParts.join(" "));
    }
  } else {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `The person you are talking to right now is a **colleague**, "${name}". If you do not know information that only the owner would know, do not guess — relay it to the owner via request_info, following the knowledge-backfill skill.`
        : `The person you are talking to right now is a **colleague**. If you do not know information that only the owner would know, do not guess — relay it to the owner via request_info, following the knowledge-backfill skill.`,
    );
    // A trusted user works at the owner's tool level — don't claim read-only.
    // A plain colleague stays read-only.
    if (!request.elevated) {
      lines.push(
        "This conversation is read-only. Do not modify or create files; use only the read tools (Read/Glob/Grep), the permitted remote SSH lookup tools, and the provided information-request tools.",
      );
    } else {
      // Tell the avatar WHY this viewer is elevated when the trust comes from
      // group co-membership (META-COGNITION) — group context changes how the
      // avatar should respond (shared group skills/repo).
      const viaGroups = (request.trustedViaGroups ?? []).filter(Boolean);
      lines.push(
        viaGroups.length > 0
          ? `This person belongs to the same group(s) as the owner (${viaGroups.map((g) => `'${g}'`).join(", ")}), so they are an **automatically trusted (elevated)** user and can use file-editing and command-execution tools. They may share skills from the group's shared knowledge repository. Use remote SSH tools only within the scope the admin has permitted.`
          : "This person is a user the owner trusts and can use file-editing and command-execution tools. Use remote SSH tools only within the scope the admin has permitted.",
      );
      lines.push(
        "You can check the general git repos the owner has pre-registered with `mcp__git_repo__list_repos` and work on them with `sync_repo`/`status`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`. public repo sync is attempted without a token, and configuration changes such as registering/removing repos are owner-only.",
      );
      lines.push(GIT_MCP_ONLY_GUIDANCE);
    }
    lines.push(
      "Changing avatar system settings such as plugins, routines, and the knowledge repository is owner-only. If a colleague requests a change, guide them to ask the owner, or leave the needed context via request_info.",
    );
  }
  const historyBlock = request.greeting ? null : conversationHistoryBlock(request.conversationHistory);
  if (historyBlock) {
    lines.push(historyBlock);
  }
  if (request.greeting) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${request.headless ? "Task instruction" : "User message"}:\n${request.message}`;
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
  // Tool-access derivation lives in deriveAgentToolAccess (a pure, unit-tested
  // helper): because the PreToolUse hook auto-allows every mcp__* tool, these
  // booleans are the real gate between a headless/colleague run and owner-only
  // tools, so the logic must be testable in isolation.
  const {
    viewerIsOwner,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  } = deriveAgentToolAccess(request);
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

  // Owner self-state (secret names, group memberships) flows to every
  // OWNER-DRIVEN turn: interactive owner chats AND owner-scheduled routines
  // (ownerToolAccess) — the same gate that registers the owner-level tools, so
  // prompt awareness and tool availability never diverge. Restricted headless
  // runs (intro/hashtag generation) and colleague/trusted chats keep them empty.
  const promptRequest: AgentRequest = ownerToolAccess
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
