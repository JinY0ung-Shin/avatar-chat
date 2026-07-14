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
import { asString, isRecord, truncate, TOOL_TRACE_ENABLED } from "./agentUtils.js";
import {
  SDK_INTERNAL_HIDDEN_TOOLS,
  SDK_ORCHESTRATION_TOOLS,
} from "../../shared/sdkToolPresentation.js";
import {
  DEFAULT_TOOL_SKILL_POLICY,
  type ToolSkillPolicy,
} from "../toolSkillPolicy.js";

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
 * Git subcommands that change branches/destructively mutate the tree or touch the
 * remote. In an active repo workspace (#47) these are blocked in Bash — NOT for
 * security (the shell has no git credentials, so remote ops fail anyway) but for
 * integrity: sync/push stay app-managed. Local staging + normal commit are
 * intentionally allowed so the avatar can use the repo cwd as a normal working tree. This
 * denylist is advisory and deliberately leaky (`git -C`, aliases, `.git/` writes
 * can evade it) — the real boundary is token-stripping, so we don't over-invest
 * in a perfect parser.
 */
// Only unambiguously tree/state-mutating or remote subcommands. Subcommands with
// a common read-only form (`git branch`/`tag` list, `git remote -v`,
// `git stash list`, `git config --get`) are deliberately omitted so inspection
// isn't over-blocked — the prompt's allow-list steers the avatar, and this
// denylist is an advisory integrity guard, not a security boundary.
const BLOCKED_ACTIVE_REPO_GIT_SUBCOMMANDS = [
  "reset", "checkout", "switch", "merge", "rebase", "cherry-pick",
  "revert", "restore", "clean", "rm", "mv",
  "push", "pull", "fetch", "clone", "am", "apply",
];
// Matches a `git <subcommand>` invocation (optionally wrapped by rtk and/or
// `-C <dir>`) anywhere in the command string, capturing the subcommand.
const GIT_SUBCOMMAND_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-C\s+\S+)*\s+(${BLOCKED_ACTIVE_REPO_GIT_SUBCOMMANDS.join("|")})\b`,
  "i",
);
const GIT_COMMIT_AMEND_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-C\s+\S+)*\s+commit\b(?=[^;&|)]*\s--amend(?:\s|$|[;&|)]))`,
  "i",
);

function stateChangingGitInBash(command: string): string | null {
  if (GIT_COMMIT_AMEND_RE.test(command)) {
    return "commit --amend";
  }
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
  toolSkillPolicy: ToolSkillPolicy = DEFAULT_TOOL_SKILL_POLICY,
) {
  return async (
    input: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; agent_id?: string },
    toolUseID?: string,
  ): Promise<HookOutput> => {
    const toolName = asString(input.tool_name);
    let toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const toolUseId = toolUseID || asString(input.tool_use_id);
    const agentId = asString(input.agent_id) || MAIN_AGENT_ID;

    // Opt-in (AGENT_TOOL_TRACE) lifecycle trace: log that the hook fired for this
    // tool call, then pass every return through `trace()` so the decision is
    // logged too. The pair answers "did the announced tool call reach dispatch,
    // and what did the gate decide?" — the key question when a vLLM-style backend
    // emits a tool_use that never executes. No-op unless the flag is set.
    if (TOOL_TRACE_ENABLED) {
      agentLogger.info({ trace: "tool", toolName, toolUseId, agentId }, "trace: PreToolUse hook entry");
    }
    const trace = (out: HookOutput): HookOutput => {
      if (TOOL_TRACE_ENABLED) {
        agentLogger.info(
          { trace: "tool", toolName, toolUseId, agentId, decision: out.hookSpecificOutput.permissionDecision },
          "trace: PreToolUse hook decision",
        );
      }
      return out;
    };

    // AskUserQuestion: surface the question, await the answer, inject it back.
    // (onUserDialog never fires headlessly, so we answer via a deny+reason that
    // the model reads as the user's response.)
    if (toolName === "AskUserQuestion") {
      if (headless || !events.onQuestion) {
        return trace(
          hookDeny(
            headless
              ? "During a scheduled automated run you cannot ask the user questions. Proceed with reasonable assumptions."
              : "The question feature is unavailable.",
          ),
        );
      }
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const answer = await events.onQuestion({ dialogKind: "AskUserQuestion", payload: { questions }, toolUseId });
      return trace(
        answer.behavior === "completed"
          ? hookDeny(formatQuestionAnswer(answer.result))
          : hookDeny("The user did not answer the question (cancelled). Proceed without an answer."),
      );
    }

    // ExitPlanMode: the avatar finished planning and proposed a plan. For a PRESENT
    // owner (interactive, non-auto-approve) we PARK for explicit approval — approve
    // → allow (the avatar proceeds to implement); reject → deny carrying the user's
    // feedback, which the model reads as a tool result and uses to revise the plan
    // before re-proposing. Headless / colleague / auto-approve runs keep the
    // original display-only behavior (fall through to the auto-allow below). An
    // empty plan (degenerate ExitPlanMode) has nothing to approve, so it skips too.
    if (toolName === "ExitPlanMode") {
      const plan = asString((toolInput as Record<string, unknown>).plan);
      const canReview =
        plan && !headless && elevated && !autoApprove && Boolean(events.onPlanReview);
      if (canReview) {
        const decision = await events.onPlanReview!({ plan, toolUseId });
        if (decision.behavior === "approved") {
          return trace(hookAllow());
        }
        const feedback = decision.feedback?.trim();
        return trace(
          hookDeny(
            "The user REJECTED this plan and did NOT approve proceeding." +
              (feedback
                ? ` Their feedback: ${feedback}`
                : " They gave no specific feedback.") +
              " Revise the plan to address this, then call ExitPlanMode again with the" +
              " updated plan. Do NOT begin implementing until a plan is approved.",
          ),
        );
      }
    }

    let updatedToolInput: Record<string, unknown> | undefined;
    if (toolName === "Bash") {
      const rewrittenCommand = rewriteBashCommandWithRtk(asString(toolInput.command), rtkCommand);
      if (rewrittenCommand) {
        updatedToolInput = { ...toolInput, command: rewrittenCommand };
        toolInput = updatedToolInput;
      }
      // Active repo workspace (#47): block remote/branch/destructive Bash git so
      // sync/push stay app-managed. Read-only git and local add/commit are allowed.
      if (activeRepoMode) {
        const gitSub = stateChangingGitInBash(asString(toolInput.command));
        if (gitSub) {
          const reason = `'git ${gitSub}'은(는) 활성 저장소 작업공간에서 셸로 실행할 수 없습니다. 원격/동기화 작업은 mcp__git_repo__* 도구를 사용하고, 위험한 로컬 git 작업은 피하세요.`;
          events.onBlocked?.({ toolUseId, toolName, agentId, reason });
          agentLogger.info({ toolName, agentId, gitSub }, "active-repo bash git blocked");
          return trace(hookDeny(
            `Running 'git ${gitSub}' via Bash is not allowed in the active repo workspace. ` +
              "Remote/sync git must go through the mcp__git_repo__* tools (push/sync_repo) because the shell has no git credentials. " +
              "Branch-changing, history-rewriting, or destructive git is blocked to protect the active working tree. " +
              "Read-only git (status/diff/log/show/rev-parse/ls-files/grep) and local staging/normal commit (add/commit) are allowed.",
          ));
        }
      }
    }

    // Admin tool/skill policy — enforced HERE (the single gate) regardless of
    // what the CLI advertises: a disabled skill can still be listed (stale
    // discovery cache), and `Skill` is otherwise auto-allowed as a meta tool
    // below, so this check must come before the auto-allow.
    if (toolName === "Skill" && toolSkillPolicy.disabledSkills.length > 0) {
      const skillName = asString(toolInput.skill);
      const bareName = skillName.includes(":")
        ? skillName.slice(skillName.lastIndexOf(":") + 1)
        : skillName;
      if (
        skillName &&
        (toolSkillPolicy.disabledSkills.includes(skillName) ||
          toolSkillPolicy.disabledSkills.includes(bareName))
      ) {
        const reason = `관리자가 비활성화한 스킬입니다: ${skillName}`;
        events.onBlocked?.({ toolUseId, toolName, agentId, reason });
        agentLogger.info({ toolName, agentId, skillName }, "admin-disabled skill blocked");
        return trace(
          hookDeny(
            `The skill '${skillName}' is disabled by the system administrator for this deployment, even if it appears in the skill list. ` +
              "Do not retry it or work around the restriction; if the user asked for it, explain that it is administratively disabled.",
          ),
        );
      }
    }
    if (toolSkillPolicy.disabledTools.includes(toolName)) {
      const reason = `관리자가 비활성화한 도구입니다: ${toolName}`;
      events.onBlocked?.({ toolUseId, toolName, agentId, reason });
      agentLogger.info({ toolName, agentId }, "admin-disabled tool blocked");
      return trace(
        hookDeny(
          `The built-in tool '${toolName}' is disabled by the system administrator for this deployment. Use the available alternatives instead.`,
        ),
      );
    }

    const hexSshTool = extractHexSshToolName(toolName);
    if (hexSshTool) {
      if (isHexSshToolAllowed(toolName, hexSshViewerClass, hexSshPolicy)) {
        return trace(hookAllow(updatedToolInput));
      }
      const reason = `현재 권한에서는 hex-ssh 도구 '${hexSshTool}' 사용이 허용되지 않습니다.`;
      events.onBlocked?.({ toolUseId, toolName, agentId, reason });
      agentLogger.info({ toolName, agentId, viewerClass: hexSshViewerClass }, "hex-ssh tool blocked");
      return trace(hookDeny(`The hex-ssh tool '${hexSshTool}' is not permitted at your current permission level.`));
    }

    // Read-only / knowledge / orchestration tools run without a prompt.
    if (isAutoAllowed(toolName, readOnlyTools)) {
      return trace(hookAllow(updatedToolInput));
    }

    const canRunElevatedTools = elevated && (!headless || allowHeadlessTools);

    // Any other tool: a PRESENT elevated viewer (owner or trusted user) may run
    // it; owner-scheduled routines may also run it when they explicitly opt into
    // owner-level headless tools. Plain headless runs and colleagues stay read-only.
    // Auto-approval opted in: run the tool without prompting.
    if (canRunElevatedTools && autoApprove) {
      return trace(hookAllow(updatedToolInput));
    }
    if (!headless && elevated && events.onPermission) {
      const decision = await events.onPermission({
        toolUseId,
        toolName,
        input: safeToolInput(toolInput),
        agentId,
      });
      return trace(
        decision.behavior === "allow"
          ? hookAllow(updatedToolInput)
          : hookDeny("The user denied the use of this tool."),
      );
    }

    events.onBlocked?.({ toolUseId, toolName, agentId, reason: "읽기 전용 대화에서는 쓸 수 없는 도구입니다." });
    agentLogger.info({ toolName, agentId, reason: "read-only" }, "tool blocked");
    return trace(
      hookDeny(
        headless
          ? "This run is an automated routine (read-only). File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep."
          : "This conversation is read-only. File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep and the information-request tools.",
      ),
    );
  };
}
