import fs from "node:fs";
import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import logger from "../logger.js";
import { knownHostsPath } from "../sshTrust.js";

const agentLogger = logger.child({ module: "agent" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
  };
};
const hookAllow = (): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
});
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
  autoApprove: boolean,
) {
  return async (
    input: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; agent_id?: string },
    toolUseID?: string,
  ): Promise<HookOutput> => {
    const toolName = asString(input.tool_name);
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
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

    // Read-only / knowledge / orchestration tools run without a prompt.
    if (isAutoAllowed(toolName, readOnlyTools)) {
      return hookAllow();
    }

    // Any other tool: a PRESENT elevated viewer (owner or trusted user) may run
    // it; an unattended (headless) run and a plain colleague chat are read-only.
    // Auto-approval opted in: run the tool without prompting.
    if (!headless && elevated && autoApprove) {
      return hookAllow();
    }
    if (!headless && elevated && events.onPermission) {
      const decision = await events.onPermission({
        toolUseId,
        toolName,
        input: safeToolInput(toolInput),
        agentId,
      });
      return decision.behavior === "allow"
        ? hookAllow()
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
  const lines = [
    alias
      ? `당신의 이름은 "${alias}"입니다. 이 이름을 가진 아바타로서 사용자와 대화합니다.`
      : `당신은 "${request.avatar.displayName}" 아바타로서 사용자와 대화합니다.`,
  ];
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`페르소나/지침:\n${request.avatar.persona.trim()}`);
  }
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner reviews gaps, colleagues create them.
  // A headless run has NO ONE on the other side: never claim the owner is
  // present and state read-only.
  if (request.headless) {
    lines.push(
      "이것은 예약된 루틴 작업의 **자동 실행**입니다. 응답을 실시간으로 보는 사람이 없으므로 질문하지 말고, 주어진 작업을 끝까지 수행해 결과를 보고하세요.",
    );
    lines.push(
      "이 실행은 읽기 전용입니다. 파일을 수정/생성하지 말고, 읽기 도구(Read/Glob/Grep)만 사용하세요.",
    );
  } else if (request.viewerIsOwner) {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `지금 대화 상대는 이 아바타의 **소유자** "${name}"님입니다.`
        : "지금 대화 상대는 이 아바타의 **소유자**입니다.",
    );
    // The owner can have the avatar manage its own knowledge repo from chat.
    lines.push(
      "당신은 자신의 **지식 저장소**(소유자 전용 개인 repo)를 직접 관리할 수 있습니다: `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit`. " +
        "여기에 업무 지식·스킬을 정리해 두면 다음 대화부터 당신이 그것을 사용합니다. " +
        "write_file/scaffold_skill 변경은 **commit 하기 전까지는 푸시되지 않으니**, 작업 단위가 끝났거나 소유자가 요청하면 commit 하세요.",
    );
    if (request.knowledgeRepoConfigured === false) {
      lines.push(
        "아직 지식 저장소가 연결되어 있지 않습니다. 새 대화를 시작하거나 소유자가 업무 지식·장기 기억·스킬 축적을 기대하는 요청을 하면, " +
          "먼저 GitHub에 개인 지식 저장소를 만들거나 기존 repo를 설정의 지식 저장소에 연결하라고 짧게 안내하세요. " +
          "이 저장소는 Claude plugin marketplace 형식이어야 합니다: 루트에 `.claude-plugin/marketplace.json`을 두고, " +
          "각 스킬은 `skills/<name>/SKILL.md`와 `skills/<name>/.claude-plugin/plugin.json`을 갖춰야 합니다. " +
          "저장소가 연결되기 전에는 repo 도구를 호출하지 말고, 연결된 뒤 새 스킬은 가능하면 `scaffold_skill`로 만들라고 안내하세요.",
      );
    }
    if (secretNames.length > 0) {
      lines.push(
        "설정의 **시크릿** 탭에 등록된 환경변수 이름: " +
          secretNames.map((name) => `\`${name}\``).join(", ") +
          ". 값은 볼 수 없으며 출력하거나 추측하지 마세요. 필요한 MCP 도구에는 서버가 해당 값을 별도로 주입합니다.",
      );
    }
    // Pending requests are surfaced ONLY when the owner opens a fresh chat
    // (greeting). On every other owner turn we stay quiet so the reminder
    // isn't re-injected mid-conversation.
    if (request.greeting) {
      lines.push(
        openRequestCount > 0
          ? `대화를 시작합니다. 먼저 소유자에게 짧게 인사한 뒤, **pending_requests로 대기 중인 정보 요청(${openRequestCount}건)을 확인해** 번호를 붙여 간결하게 보고하세요. 그런 다음 무엇을 도와줄지 물어보세요.`
          : "대화를 시작합니다. 소유자에게 짧게 인사하고 무엇을 도와줄지 물어보세요. (대기 중인 정보 요청은 없으니 굳이 언급하지 마세요.)",
      );
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
        "이 대화는 읽기 전용입니다. 파일을 수정하거나 생성하지 말고, 읽기 도구(Read/Glob/Grep)와 제공된 정보 요청 도구만 사용하세요.",
      );
    } else {
      lines.push(
        "이 대화 상대는 소유자가 신뢰하는 사용자로, 파일 수정·명령 실행 도구를 사용할 수 있습니다. 요청에 따라 필요한 도구를 사용해 작업을 수행하세요.",
      );
    }
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
  const { buildRepoServer, REPO_SERVER_NAME, REPO_TOOL_NAMES } = await import("./repoTools.js");
  const { buildSshTrustServer, SSH_TRUST_SERVER_NAME, SSH_TRUST_TOOL_NAMES } = await import(
    "./sshTrustTools.js"
  );

  const streaming = Boolean(events);
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);
  const autoApprove = Boolean(request.autoApprove);
  // Tool-permission level: the owner OR a designated trusted user. Distinct from
  // viewerIsOwner, which still gates the owner-only knowledge inbox + greeting.
  const elevated = viewerIsOwner || Boolean(request.elevated);
  const agentStart = Date.now();

  agentLogger.info(
    { avatarId: request.avatar.id, viewerUserId: request.viewerUserId, headless, elevated, autoApprove, model: config.anthropicModel ?? undefined },
    "agent run started",
  );

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  // Headless runs get COLLEAGUE-level access even when run as the owner:
  // request_info stays available, but pending_requests is denied — no human is
  // present to review the gap inbox.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: viewerIsOwner && !headless,
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  // Only needed for the owner's opening greeting — every other turn stays quiet.
  const openRequestCount =
    request.greeting && viewerIsOwner && !headless
      ? store.countOpenKnowledgeRequests(request.avatar.id)
      : 0;

  // Knowledge-repo management tools (list/read/write/scaffold/commit). OWNER-ONLY:
  // a colleague, a trusted user, or a headless routine gets a refusal from every
  // tool. Registered unconditionally — the per-handler `viewerIsOwner` gate is the
  // safety boundary, mirroring the knowledge server above. The owner identity for
  // commits is resolved from the avatar's own user row (viewer == owner here).
  const ownerRow = store.getUserById(request.avatar.id);
  const repoServer = buildRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner: {
      id: request.avatar.id,
      username: ownerRow?.username ?? "",
      displayName: ownerRow?.displayName ?? request.avatar.displayName,
      alias: ownerRow?.alias ?? request.avatar.alias,
    },
    viewerIsOwner: viewerIsOwner && !headless,
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
  // hex-ssh (remote-server access MCP, ssh2-based — no system ssh binary needed):
  // registered explicitly (not via a plugin's .mcp.json) so we can inject the
  // owner's per-user SSH identity. Only when the owner has stored a private key;
  // without one the server is keyless and useless, so we skip it. Auto-approval
  // of `mcp__*` tools means key-holders can run remote-ssh without a prompt
  // (intended: the avatar fully acts for its owner). `safe` mode still blocks
  // dangerous patterns (rm -rf /, mkfs, fork bombs, …).
  const sshServers = ownerSecrets.SSH_PRIVATE_KEY
    ? {
        "hex-ssh": {
          type: "stdio" as const,
          // Installed into the image at build time (see Dockerfile) and exposed
          // under this fixed name — NOT `npx`-downloaded at runtime, which fails
          // on a closed network where the public npm registry is unreachable.
          // Overridable for dev where the global bin isn't present.
          command: config.hexSshCommand,
          // KNOWN_HOSTS_PATH points hex-ssh at the owner's persistent trust file
          // (under the data volume). hex-ssh re-reads it on every connection, so
          // the `mcp__ssh_trust__*` tools can add a host mid-session and it takes
          // effect immediately. ownerSecrets may also carry ALLOWED_HOST_FINGER-
          // PRINTS, etc.; later keys win, so put ours first.
          env: {
            REMOTE_SSH_MODE: "safe",
            KNOWN_HOSTS_PATH: knownHostsPath(request.avatar.id, config),
            ...ownerSecrets,
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
      ...sshServers,
      ...(ownerSecrets.SSH_PRIVATE_KEY ? { [SSH_TRUST_SERVER_NAME]: sshTrustServer } : {}),
    },
    maxTurns: config.maxTurns,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  // Persist session transcripts under dataDir (not the SDK's default ~/.claude)
  // so a conversation's session can be resumed after a server/container restart.
  // `env` REPLACES the subprocess environment, so spread process.env first.
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  options.env = { ...process.env, CLAUDE_CONFIG_DIR: config.agentSessionsDir };
  // Resume the conversation's prior session so the model keeps its context. Only
  // a real follow-up turn passes one (greeting/regenerate start fresh — see app.ts).
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
  }
  // Pin the model when configured; otherwise the SDK picks its default.
  if (config.anthropicModel) {
    options.model = config.anthropicModel;
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
      PreToolUse: [{ hooks: [buildPreToolUseHook(events, elevated, config.readOnlyTools, headless, autoApprove)] }],
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
          knowledgeRepoConfigured: Boolean(store.getKnowledgeRepo(request.avatar.id).repo),
        }
      : {
          ...request,
          secretNames: [],
          knowledgeRepoConfigured: Boolean(store.getKnowledgeRepo(request.avatar.id).repo),
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

  // Prefer the partial answer the model already streamed; only show the error
  // fallback when the run errored AND produced no usable text.
  const partialText = assistantChunks.join("\n\n").trim() || deltaChunks.join("").trim();
  const text =
    resultText ||
    partialText ||
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
