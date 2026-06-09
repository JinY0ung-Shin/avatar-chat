import type { AgentRequest, AgentResponse } from "../types.js";

/**
 * Deterministic offline stub used when AGENT_RUNTIME=local. Executes no plugins
 * and never touches the network, keeping tests fast and reproducible.
 */
export function runLocalAgent(request: AgentRequest): AgentResponse {
  return {
    kind: "text",
    runtime: "local",
    summary: "(로컬 런타임 응답)",
    text: `[local] ${request.message}`,
  };
}
