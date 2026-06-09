import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.type !== "assistant") {
    return "";
  }
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (isRecord(block) && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractResultText(message: unknown): string {
  if (isRecord(message) && message.type === "result" && typeof message.result === "string") {
    return message.result;
  }
  return "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a single SDK `stream_event` message and fire matching streaming
 * callbacks. Returns the text delta (if any) so callers can accumulate it.
 */
function handleStreamEvent(message: Record<string, unknown>, events: AgentEvents): string {
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event) {
    return "";
  }
  if (
    event.type === "content_block_delta" &&
    isRecord(event.delta) &&
    event.delta.type === "text_delta"
  ) {
    const text = asString(event.delta.text);
    if (text) {
      events.onDelta?.(text);
    }
    return text;
  }
  if (
    event.type === "content_block_start" &&
    isRecord(event.content_block) &&
    event.content_block.type === "tool_use"
  ) {
    const name = asString(event.content_block.name);
    if (name) {
      events.onTool?.(name);
      events.onStatus?.(`도구 실행 중: ${name}`);
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

function buildPrompt(request: AgentRequest, openRequestCount: number): string {
  const lines = [
    `당신은 "${request.avatar.displayName}" 아바타로서 사용자와 대화합니다.`,
  ];
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`페르소나/지침:\n${request.avatar.persona.trim()}`);
  }
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner answers gaps, colleagues create them.
  if (request.viewerIsOwner) {
    const note =
      openRequestCount > 0
        ? `현재 대기 중인 정보 요청이 ${openRequestCount}건 있습니다. 대화를 시작할 때 pending_requests로 확인해 보고하세요.`
        : "대기 중인 정보 요청은 없습니다.";
    lines.push(`지금 대화 상대는 이 아바타의 **소유자**입니다. ${note}`);
  } else {
    lines.push(
      `지금 대화 상대는 **동료**입니다. 소유자만 알 법한 정보를 모르면 추측하지 말고, knowledge-backfill 스킬에 따라 recall_knowledge로 찾고 없으면 request_info로 소유자에게 전달하세요.`,
    );
  }
  lines.push(
    "이 대화는 읽기 전용입니다. 파일을 수정하거나 생성하지 말고, 읽기 도구(Read/Glob/Grep)와 제공된 knowledge 도구만 사용하세요.",
  );
  return `${lines.join("\n\n")}\n\n사용자 메시지:\n${request.message}`;
}

/**
 * Run the Claude Agent SDK READ-ONLY against the avatar's plugin roots.
 * Streaming is opt-in via the events sink (includePartialMessages).
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

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: Boolean(request.viewerIsOwner),
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  const openRequestCount = request.viewerIsOwner
    ? store.countOpenKnowledgeRequests(request.avatar.id)
    : 0;

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    permissionMode: "dontAsk",
    // Read-only tools + the knowledge MCP tools. dontAsk denies anything not
    // listed here, so the model can call only these.
    allowedTools: [...config.readOnlyTools, ...KNOWLEDGE_TOOL_NAMES],
    disallowedTools: ["Write", "Edit"],
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    skills: "all",
    mcpServers: { [KNOWLEDGE_SERVER_NAME]: knowledgeServer },
    maxTurns: 6,
    // Isolation mode: load NO filesystem settings. Without this the SDK defaults
    // to loading all sources (user `~/.claude`, project `.claude`, local), which
    // would leak the operator's machine config — MCP servers, enabled plugins,
    // env, and CLAUDE.md — into every avatar conversation. Each avatar must run
    // only with our read-only policy + its own plugins (passed via `plugins`,
    // which is independent of settingSources).
    settingSources: [],
  };
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to the avatar's own workspace + its plugin dirs. Reads
  // outside these require a permission prompt, which dontAsk denies.
  if (request.cwd) {
    options.cwd = request.cwd;
  }
  if (pluginRoots.length > 0) {
    options.additionalDirectories = pluginRoots.map((root) => root.path);
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";

  for await (const message of sdk.query({ prompt: buildPrompt(request, openRequestCount), options })) {
    if (events && isRecord(message)) {
      if (message.type === "stream_event") {
        const delta = handleStreamEvent(message, events);
        if (delta) {
          deltaChunks.push(delta);
        }
        continue;
      }
      if (message.type === "system") {
        handleSystemEvent(message, events);
      }
      if (message.type === "tool_progress") {
        const toolName = asString(message.tool_name) || asString(message.toolName);
        events.onStatus?.(toolName ? `실행 중: ${toolName}` : "실행 중…");
        continue;
      }
    }

    const assistantText = extractAssistantText(message);
    if (assistantText) {
      assistantChunks.push(assistantText);
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
