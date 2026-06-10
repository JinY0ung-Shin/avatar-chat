import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";

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

/**
 * Tools that run without a permission prompt: read-only built-ins, any MCP tool
 * (only the in-process knowledge server is configured), and orchestration
 * meta-tools. Everything else is gated by the PreToolUse hook.
 */
function isAutoAllowed(toolName: string, readOnlyTools: string[]): boolean {
  if (readOnlyTools.includes(toolName)) return true;
  if (toolName.startsWith("mcp__")) return true;
  return ["Skill", "Task", "Agent", "TodoWrite", "ToolSearch", "SlashCommand"].includes(toolName);
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

interface LoopState {
  /** tool_use ids that spawned a subagent → distinguishes onAgentEnd from onToolEnd. */
  spawnedAgentIds: Set<string>;
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

function extractResultText(message: unknown): string {
  if (isRecord(message) && message.type === "result" && typeof message.result === "string") {
    return message.result;
  }
  return "";
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

function handleSystemEvent(message: Record<string, unknown>, events: AgentEvents): void {
  const subtype = asString(message.subtype);
  if (subtype === "init") {
    const model = asString(message.model);
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
function buildPreToolUseHook(
  events: AgentEvents,
  viewerIsOwner: boolean,
  readOnlyTools: string[],
  headless: boolean,
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

    // Any other tool: a PRESENT owner may approve interactively; an unattended
    // (headless) run and a colleague chat are both read-only.
    if (!headless && viewerIsOwner && events.onPermission) {
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
    return hookDeny(
      headless
        ? "이 실행은 자동 루틴(읽기 전용)입니다. 파일 수정/명령 실행 도구는 사용할 수 없으니 Read/Glob/Grep과 knowledge 검색만 사용하세요."
        : "이 대화는 읽기 전용입니다. 파일 수정/명령 실행 도구는 사용할 수 없으니 Read/Glob/Grep과 knowledge 도구만 사용하세요.",
    );
  };
}

function buildPrompt(request: AgentRequest, openRequestCount: number): string {
  const lines = [
    `당신은 "${request.avatar.displayName}" 아바타로서 사용자와 대화합니다.`,
  ];
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`페르소나/지침:\n${request.avatar.persona.trim()}`);
  }
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner answers gaps, colleagues create them.
  // A headless run has NO ONE on the other side: never claim the owner is
  // present (that invites unattended knowledge writes) and state read-only.
  if (request.headless) {
    lines.push(
      "이것은 예약된 루틴 작업의 **자동 실행**입니다. 응답을 실시간으로 보는 사람이 없으므로 질문하지 말고, 주어진 작업을 끝까지 수행해 결과를 보고하세요.",
    );
    lines.push(
      "이 실행은 읽기 전용입니다. 파일을 수정/생성하거나 지식을 저장하지 말고, 읽기 도구(Read/Glob/Grep)와 지식 검색(recall_knowledge)만 사용하세요.",
    );
  } else if (request.viewerIsOwner) {
    const note =
      openRequestCount > 0
        ? `현재 대기 중인 정보 요청이 ${openRequestCount}건 있습니다. 대화를 시작할 때 pending_requests로 확인해 보고하세요.`
        : "대기 중인 정보 요청은 없습니다.";
    lines.push(`지금 대화 상대는 이 아바타의 **소유자**입니다. ${note}`);
  } else {
    lines.push(
      `지금 대화 상대는 **동료**입니다. 소유자만 알 법한 정보를 모르면 추측하지 말고, knowledge-backfill 스킬에 따라 recall_knowledge로 찾고 없으면 request_info로 소유자에게 전달하세요.`,
    );
    lines.push(
      "이 대화는 읽기 전용입니다. 파일을 수정하거나 생성하지 말고, 읽기 도구(Read/Glob/Grep)와 제공된 knowledge 도구만 사용하세요.",
    );
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

  const streaming = Boolean(events);
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  // Headless runs get COLLEAGUE-level knowledge access even when run as the
  // owner: recall stays available, but save_knowledge/pending_requests are
  // denied — no human is present to vouch for unattended knowledge writes.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: viewerIsOwner && !headless,
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  const openRequestCount =
    viewerIsOwner && !headless ? store.countOpenKnowledgeRequests(request.avatar.id) : 0;

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    // The PreToolUse hook (below) is the real gate. `default` mode is required —
    // it's the mode in which the hook's deny decision is honored.
    permissionMode: "default",
    // Auto-approve (no prompt) the read-only + knowledge + meta tools. NOTE: this
    // is only an auto-approve list, NOT a restriction — the hook does enforcement.
    allowedTools: [...config.readOnlyTools, ...KNOWLEDGE_TOOL_NAMES, "Skill", "Task", "Agent", "TodoWrite"],
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    skills: "all",
    mcpServers: { [KNOWLEDGE_SERVER_NAME]: knowledgeServer },
    maxTurns: 6,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to the avatar's own workspace + its plugin dirs.
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
      PreToolUse: [{ hooks: [buildPreToolUseHook(events, viewerIsOwner, config.readOnlyTools, headless)] }],
    };
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  const state: LoopState = { spawnedAgentIds: new Set() };
  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";

  for await (const message of sdk.query({ prompt: buildPrompt(request, openRequestCount), options })) {
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
        handleSystemEvent(message, events);
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

    const extractedResult = extractResultText(message);
    if (extractedResult) {
      resultText = extractedResult;
    }
  }

  const text =
    resultText ||
    assistantChunks.join("\n\n").trim() ||
    deltaChunks.join("").trim() ||
    "Claude Agent SDK 응답이 비어 있습니다.";
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
