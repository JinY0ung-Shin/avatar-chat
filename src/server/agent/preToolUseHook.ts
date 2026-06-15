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
import {
  SDK_INTERNAL_HIDDEN_TOOLS,
  SDK_ORCHESTRATION_TOOLS,
} from "../../shared/sdkToolPresentation.js";

const agentLogger = logger.child({ module: "agent" });
const RTK_REWRITE_TIMEOUT_MS = 1_000;

/** SDK orchestration tools that should never trigger the user permission modal. */
export const TASK_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set(SDK_ORCHESTRATION_TOOLS);
const AUTO_ALLOWED_META_TOOLS: ReadonlySet<string> = new Set(["Skill", ...SDK_INTERNAL_HIDDEN_TOOLS]);

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
  return AUTO_ALLOWED_META_TOOLS.has(toolName) || TASK_ORCHESTRATION_TOOLS.has(toolName);
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
/**
 * Git subcommands that change repository/working-tree state or touch the remote.
 * In an active repo workspace (#47) these are blocked in Bash — NOT for security
 * (the shell has no git credentials, so remote ops fail anyway) but for
 * INTEGRITY: the app's `mcp__git_repo__*` commit/push lifecycle owns the staging
 * it controls, and a shell mutation would break it. This denylist is advisory
 * and deliberately leaky (`git -C`, aliases, `.git/` writes can evade it) — the
 * real boundary is token-stripping, so we don't over-invest in a perfect parser.
 */
// Only unambiguously tree/state-mutating or remote subcommands. Subcommands with
// a common read-only form (`git branch`/`tag` list, `git remote -v`,
// `git stash list`, `git config --get`) are deliberately omitted so inspection
// isn't over-blocked — the prompt's allow-list steers the avatar, and this
// denylist is an advisory integrity guard, not a security boundary.
const STATE_CHANGING_GIT_SUBCOMMANDS = [
  "add", "commit", "reset", "checkout", "switch", "merge", "rebase", "cherry-pick",
  "revert", "restore", "clean", "rm", "mv",
  "push", "pull", "fetch", "clone", "am", "apply",
];
// Matches a `git <subcommand>` invocation (optionally wrapped by rtk and/or
// `-C <dir>`) anywhere in the command string, capturing the subcommand.
const GIT_SUBCOMMAND_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-C\s+\S+)*\s+(${STATE_CHANGING_GIT_SUBCOMMANDS.join("|")})\b`,
  "i",
);

function stateChangingGitInBash(command: string): string | null {
  const match = GIT_SUBCOMMAND_RE.exec(command);
  return match ? match[1].toLowerCase() : null;
}

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
  activeRepoMode = false,
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
      // Active repo workspace (#47): block state-changing/remote Bash git so the
      // avatar persists through mcp__git_repo__* (integrity, not security). Read-
      // only git (status/diff/log/…) is intentionally allowed and falls through.
      if (activeRepoMode) {
        const gitSub = stateChangingGitInBash(asString(toolInput.command));
        if (gitSub) {
          const reason = `'git ${gitSub}'은(는) 활성 저장소 작업공간에서 셸로 실행할 수 없습니다. mcp__git_repo__* 도구를 사용하세요.`;
          events.onBlocked?.({ toolUseId, toolName, agentId, reason });
          agentLogger.info({ toolName, agentId, gitSub }, "active-repo bash git blocked");
          return hookDeny(
            `Running 'git ${gitSub}' via Bash is not allowed in the active repo workspace. ` +
              "State-changing and remote git must go through the mcp__git_repo__* tools (commit/push/sync_repo) — the shell has no git credentials and would break the commit/push lifecycle. " +
              "Read-only git (status/diff/log/show/rev-parse/ls-files/grep) is allowed for inspection.",
          );
        }
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
