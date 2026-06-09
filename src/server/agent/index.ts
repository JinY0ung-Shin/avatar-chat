import type { AppConfig, AgentRequest, AgentResponse } from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";
import { runClaudeAgent } from "./claudeAgent.js";
import { isMutatingRequest, runLocalAgent } from "./localRunner.js";

export async function runAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
  config: AppConfig,
): Promise<AgentResponse> {
  if (request.mode === "colleague" && isMutatingRequest(request.message)) {
    return {
      kind: "text",
      runtime: "blocked",
      summary: "동료 모드는 읽기 전용입니다.",
      text: "변경 가능성이 있는 요청은 동료 모드에서 차단했습니다.",
    };
  }

  const shouldUseClaude =
    config.agentRuntime === "claude" ||
    (config.agentRuntime === "auto" && Boolean(config.anthropicApiKey));

  if (shouldUseClaude) {
    try {
      return await runClaudeAgent(request, registry, config);
    } catch (error) {
      if (config.agentRuntime === "claude") {
        throw error;
      }
    }
  }

  return runLocalAgent(request, registry);
}
