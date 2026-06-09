import type { AppConfig, AgentRequest, AgentResponse } from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";

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

function buildPrompt(request: AgentRequest): string {
  const common = [
    `사용자: ${request.user.name}`,
    `프로젝트 범위: ${request.user.projectScope}`,
    `모드: ${request.mode}`,
    "marketplace plugin/skill을 사용해서 요청을 처리하고, 어떤 skill을 사용했는지 짧게 밝혀라.",
  ];
  if (request.mode === "colleague") {
    common.push(
      "동료 모드는 읽기 전용이다. 재시작, 재배포, 삭제, 생성, 권한 변경, 외부 전송 등 변경 작업은 수행하지 말고 거절하라.",
      "다른 프로젝트 정보는 노출하지 말고, 가능하면 상태표 형태로 답하라.",
    );
  } else {
    common.push("소유자 모드다. marketplace skill의 자체 정책과 지침을 따른다.");
  }
  return `${common.join("\n")}\n\n요청:\n${request.message}`;
}

export async function runClaudeAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
): Promise<AgentResponse> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown>;
  };
  const pluginRoots = registry.plugins
    .filter((plugin) => {
      if (request.mode === "owner") {
        return true;
      }
      return plugin.commands.some(
        (command) =>
          command.readOnly &&
          command.projectScoped === true &&
          (command.mode === "colleague" || command.mode === "both"),
      );
    })
    .map((plugin) => ({ type: "local", path: plugin.rootPath }));

  const options =
    request.mode === "colleague"
      ? {
          plugins: pluginRoots,
          permissionMode: "dontAsk",
          allowedTools: config.colleagueAllowedTools,
          disallowedTools: ["Write", "Edit"],
          maxTurns: 4,
        }
      : {
          plugins: pluginRoots,
          permissionMode: config.ownerPermissionMode,
          maxTurns: 8,
        };

  const assistantChunks: string[] = [];
  let resultText = "";
  for await (const message of sdk.query({
    prompt: buildPrompt(request),
    options,
  })) {
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      assistantChunks.push(assistantText);
    }
    const extractedResult = extractResultText(message);
    if (extractedResult) {
      resultText = extractedResult;
    }
  }

  const text = resultText || assistantChunks.join("\n\n").trim() || "Claude Agent SDK 응답이 비어 있습니다.";
  return {
    kind: "text",
    runtime: "claude",
    summary: "Claude Agent SDK 실행이 완료되었습니다.",
    text,
  };
}
