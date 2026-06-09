import type { AppConfig, AgentRequest, AgentResponse, PluginRoot } from "../types.js";
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

function buildPrompt(request: AgentRequest): string {
  const lines = [
    `당신은 "${request.avatar.displayName}" 아바타로서 사용자와 대화합니다.`,
  ];
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`페르소나/지침:\n${request.avatar.persona.trim()}`);
  }
  lines.push(
    "이 대화는 읽기 전용입니다. 파일을 수정하거나 생성하지 말고, 읽기 도구(Read/Glob/Grep)만 사용하세요.",
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
  events?: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown>;
  };

  const streaming = Boolean(events);

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    permissionMode: "dontAsk",
    allowedTools: config.readOnlyTools,
    disallowedTools: ["Write", "Edit"],
    maxTurns: 6,
  };
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  const assistantChunks: string[] = [];
  const deltaChunks: string[] = [];
  let resultText = "";

  for await (const message of sdk.query({ prompt: buildPrompt(request), options })) {
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
