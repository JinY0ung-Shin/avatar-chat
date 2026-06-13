import { spawnSync } from "node:child_process";
import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import logger from "../logger.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  extractHexSshToolName,
  isHexSshToolAllowed,
  type HexSshToolPolicy,
  type HexSshViewerClass,
} from "../hexSshPolicy.js";
import { asString, isRecord, truncate } from "./agentUtils.js";

const agentLogger = logger.child({ module: "agent" });
const RTK_REWRITE_TIMEOUT_MS = 1_000;

/** SDK orchestration tools that should never trigger the user permission modal. */
export const TASK_ORCHESTRATION_TOOLS = new Set([
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
