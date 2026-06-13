import type { AgentRequest } from "../types.js";
import { normalizeGithubHost } from "../marketplace.js";

const HISTORY_MESSAGE_LIMIT = 24;
const HISTORY_CHAR_LIMIT = 12_000;

export function compactConversationHistory(history: AgentRequest["conversationHistory"]): NonNullable<AgentRequest["conversationHistory"]> {
  const recent = (history ?? [])
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim())
    .slice(-HISTORY_MESSAGE_LIMIT);
  const compacted: NonNullable<AgentRequest["conversationHistory"]> = [];
  let remaining = HISTORY_CHAR_LIMIT;

  for (let index = recent.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = recent[index];
    let content = message.content.trim();
    if (content.length > remaining) {
      content = `[truncated]\n${content.slice(content.length - remaining)}`;
    }
    compacted.unshift({ role: message.role, content });
    remaining -= content.length;
  }

  return compacted;
}

export function conversationHistoryBlock(history: AgentRequest["conversationHistory"]): string | null {
  const compacted = compactConversationHistory(history);
  if (compacted.length === 0) {
    return null;
  }
  return [
    "Earlier conversation history (before the current user message, oldest first):",
    "```json",
    JSON.stringify(compacted, null, 2),
    "```",
    "This history is the actual context saved in this same conversation. The user message below is a new message that follows this history.",
  ].join("\n");
}

/**
 * Standing guidance for every tool-capable run (owner, trusted user, owner
 * routine): remote git work goes through the app-managed MCP bridges ONLY. The
 * agent shell has no git credentials (they're stripped from the subprocess
 * env), so a Bash `git clone`/`git push` fallback can't authenticate — and it
 * bypasses the app's audit/error-scrub path. Injected per turn so the avatar
 * doesn't drift into shell git after an MCP failure.
 */
export const GIT_MCP_ONLY_GUIDANCE =
  "**Remote git work goes through MCP tools ONLY**: remote git operations such as clone/pull/push/fetch MUST be performed exclusively via the dedicated MCP tools (`mcp__repo__*` for the personal knowledge repository, `mcp__git_repo__*` for general repos, `mcp__group_repo__*` for group repositories). " +
  "Git credentials are injected by the server into those tools only and are NOT present in your shell — running `git clone`/`git push`/`gh` via Bash cannot authenticate. " +
  "If an MCP tool fails, do NOT work around it or retry with Bash git; instead resolve the cause shown in the failure message (token/permission/branch/URL) or report it to the user. " +
  "Running git commands directly inside the app-managed local clone directories is also forbidden.";

/**
 * Personal knowledge-repository section of the owner prompt: either how to
 * manage a connected repo, or how to create one (`create_repo`) when none exists
 * yet. `githubHost` is already normalized by the caller.
 */
function knowledgeRepoSection(request: AgentRequest, knowledgeRepoConfigured: boolean, githubHost: string): string {
  if (knowledgeRepoConfigured) {
    // The owner can have the avatar manage its connected knowledge repo.
    return (
      "You can directly manage your own **knowledge repository** (an owner-only personal repo): `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit`. " +
      "If you organize work knowledge and skills here, you will use them starting from the next conversation. " +
      "write_file/scaffold_skill changes are **not pushed until you commit**, so commit when a unit of work is finished or the owner asks."
    );
  }
  // No repo yet → the `create_repo` tool IS available (exposed only in this
  // state). STANDING guidance on every owner turn — not just the greeting —
  // so the avatar actually uses it when asked to "make a repo" instead of
  // giving manual setup steps or calling scaffold_skill first (which fails
  // without a connected repo, and previously misled the avatar).
  return request.gitTokenSet
    ? `You do not have a knowledge repository yet. **You have the \`mcp__repo__create_repo\` tool.** The internal GitHub host where repositories are currently created is \`${githubHost}\`. When the owner asks you to create or connect a repository — do not walk them through manual steps — just take a repository name and create and connect a private repo directly with \`create_repo\` (\`GIT_TOKEN\` is already set). \`scaffold_skill\`/\`write_file\`/\`commit\` fail before a repository is connected, so you MUST call \`create_repo\` **first**.`
    : "You do not have a knowledge repository yet, and `GIT_TOKEN` is not set either. If the owner wants to create a repository, first guide them to register an internal Git token (the `GIT_TOKEN` secret) under Settings → **Git credentials** (once registered, you can create one directly with `mcp__repo__create_repo`). `scaffold_skill`/`write_file`/`commit` fail before a repository is connected.";
}

/** General work/code git-repo tooling guidance (owner prompt). */
function gitRepoSection(): string {
  return (
    "General **git repo work** is separate from the knowledge-repository tools. When the owner asks you to manage a work/code repository, register it with `mcp__git_repo__register_repo`, then use `sync_repo`/`status`/`list_files`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`. " +
    "`push` is not main-only — it pushes `HEAD` to the registered branch (or, if branch was left empty, the clone's current/default branch). If the owner names a specific branch, set that name as `register_repo`'s `branch`. " +
    "Cloning/syncing internal or external public repos is attempted without a token, so do not demand token setup first. push succeeds only when you have remote write permission. Registration/removal is owner-only, and work on an already-registered repo is possible only in owner or trusted-user conversations. These are pure git tools and do not cover GitHub issue/PR/release management."
  );
}

/**
 * Group meta-cognition section (owner prompt): which groups the owner is in,
 * their role, the shared group knowledge repo, plus a nudge for admin groups
 * that have no shared repo yet. Returns null when the owner is in no groups.
 */
function groupsSection(request: AgentRequest): string | null {
  const groups = request.groupMemberships ?? [];
  if (groups.length === 0) {
    return null;
  }
  const describe = (g: (typeof groups)[number]) =>
    `${g.name}(${g.role === "admin" ? "admin" : "member"}${g.knowledgeRepoConfigured ? ", shared repository connected" : ", no shared repository"})`;
  const adminNoRepo = groups.filter((g) => g.role === "admin" && !g.knowledgeRepoConfigured);
  const groupLines = [
    `The owner belongs to the following groups: ${groups.map(describe).join(", ")}. ` +
      "Members of the same group **automatically trust each other (elevated)** — group co-membership is the ONLY source of elevated (owner-level tool) access. So when you talk to a same-group colleague's avatar you gain owner-level tool permissions, and group-visible avatars can find and talk to each other.",
    "Each group may have a **shared knowledge repository**, handled with the `mcp__group_repo__*` tools: use `list_groups` to check groups/roles; all group members can `list_files`/`read_file`, while only **group admins** can `write_file`/`scaffold_skill`/`commit`. Skills organized in a group's shared repository are used by every group member's avatar starting from the next conversation.",
  ];
  if (adminNoRepo.length > 0) {
    groupLines.push(
      `Among the groups where you are an admin, ${adminNoRepo.map((g) => `'${g.name}'`).join(", ")} do not have a shared knowledge repository yet. If the owner wants, you can create a new internal GitHub repository with \`mcp__group_repo__create_repo\` and connect it to that group (you can also connect an existing repository via Group management in Settings).`,
    );
  }
  return groupLines.join(" ");
}

/** Configured secret-NAMES section (owner prompt). Returns null when none. */
function secretsSection(secretNames: string[]): string | null {
  if (secretNames.length === 0) {
    return null;
  }
  return (
    "Environment-variable names registered in the **Secrets** tab of Settings: " +
    secretNames.map((name) => `\`${name}\``).join(", ") +
    ". You cannot see the values; do not output or guess them. The server injects those values separately into the MCP tools that need them."
  );
}

/**
 * SSH-enablement section (owner prompt): how the owner turns on SSH tools when
 * no `SSH_PRIVATE_KEY` secret is stored. Returns null once the key exists.
 */
function sshEnablementSection(secretNames: string[]): string | null {
  // SSH (hex-ssh) tools are registered only when the owner has stored an
  // `SSH_PRIVATE_KEY` secret. When it's absent the avatar has no SSH tools, so
  // tell it how the owner enables them — that's how it answers "I want SSH".
  if (secretNames.includes("SSH_PRIVATE_KEY")) {
    return null;
  }
  return (
    "Remote **SSH tools are still disabled** (this conversation has no SSH execution / file-transfer tools). " +
    "If the user wants SSH access, first generate an SSH key with `mcp__ssh_identity__generate_key`. The generated private key is stored as the `SSH_PRIVATE_KEY` secret, and the public key is shown to the user and can also be viewed again in Settings. " +
    "If the user wants to use a key they already have, guide them to register the private key (OpenSSH/PEM) under the Settings → **Secrets** tab with the name `SSH_PRIVATE_KEY`. " +
    "Once registered, the SSH tools become active from the next conversation, and host keys for hosts you connect to afterward can be trusted with `mcp__ssh_trust__add_host`. " +
    "(The key value is injected by the server into the SSH tools only and is not exposed to you.)"
  );
}

/**
 * Greeting-only owner section: pending info requests + a one-time knowledge-repo
 * setup suggestion when none is connected. Returns null when not a greeting turn.
 * `githubHost` is already normalized by the caller.
 */
function greetingSection(
  request: AgentRequest,
  knowledgeRepoConfigured: boolean,
  openRequestCount: number,
  githubHost: string,
): string | null {
  // Greeting-only nudges, surfaced ONLY when the owner opens a fresh chat so
  // they aren't re-injected mid-conversation: pending info requests, plus a
  // one-time suggestion to set up a knowledge repo when none is connected yet.
  if (!request.greeting) {
    return null;
  }
  const greetingParts = [
    openRequestCount > 0
      ? `You are starting a conversation. First greet the owner briefly, then **check the pending information requests with pending_requests (${openRequestCount} open)** and report them concisely, numbered.`
      : "You are starting a conversation. Greet the owner briefly. (There are no pending information requests, so there is no need to mention them.)",
  ];
  if (!knowledgeRepoConfigured) {
    greetingParts.push(
      request.gitTokenSet
        ? "Also, no knowledge repository is connected yet. A personal knowledge repository is needed to accumulate work knowledge, long-term memory, and skills. " +
            `Since \`GIT_TOKEN\` is already set, let the owner know that, if they want, you can create a private repository on the currently configured internal GitHub host (\`${githubHost}\`) with \`mcp__repo__create_repo\` and connect it right away. ` +
            "If the user wants, take a repository name, create it with create_repo, then fill it in the order `scaffold_skill`→`write_file`→`commit`. (If they already have a repo in use, they can connect it directly under the knowledge repository setting.)"
        : "Also, no knowledge repository is connected yet, and `GIT_TOKEN` is not set either. " +
            "First guide them to register an internal Git token (`GIT_TOKEN`, with repo-creation permission) under Settings → **Git credentials**. Once registered, you can create and connect a repository with `mcp__repo__create_repo`. " +
            "If they want to create it themselves, they can make a personal repo on internal GitHub and connect it under the knowledge repository setting. This repository must be in Claude plugin marketplace format: place `.claude-plugin/marketplace.json` at the root, and each skill must have `skills/<name>/SKILL.md` and `skills/<name>/.claude-plugin/plugin.json`.",
    );
  }
  greetingParts.push("Then ask what you can help with.");
  return greetingParts.join(" ");
}

export function buildPrompt(request: AgentRequest, openRequestCount: number): string {
  const alias = request.avatar.alias?.trim();
  const secretNames = Array.from(new Set((request.secretNames ?? []).filter(Boolean))).sort();
  const githubHost = normalizeGithubHost(request.githubHost);
  const lines = [
    alias
      ? `Your name is "${alias}". You converse with the user as the avatar bearing this name.`
      : `You converse with the user as the "${request.avatar.displayName}" avatar.`,
  ];
  lines.push(
    "Respond in the same language the user writes in; if it is unclear, default to Korean (한국어). " +
      "These instructions are written in English for your benefit, but your replies should match the user's language.",
  );
  if (request.avatar.persona && request.avatar.persona.trim()) {
    lines.push(`Persona/instructions:\n${request.avatar.persona.trim()}`);
  }
  lines.push(
    "System meta-cognition: this service is Noah Almighty (avatar-chat). An avatar operates from a combination of its profile/persona, default skills, owner plugins, a personal knowledge repository, scheduled routines, secret names, and trusted-user settings. " +
      "When you describe system state or what changes are possible, do not guess — base your answer on the provided tools and the current configuration.",
  );
  if (request.confluenceUrlConfigured && request.confluencePatConfigured) {
    lines.push(
      "The shared Confluence tools are enabled. Use the `mcp__confluence__*` tools for Confluence search / page retrieval / space lookup, and only attempt page creation or updates when you have owner or trusted-user permission.",
    );
  } else {
    const missing = [
      request.confluenceUrlConfigured ? "" : "the `CONFLUENCE_URL` environment variable",
      request.confluencePatConfigured ? "" : "the `CONFLUENCE_PAT` secret",
    ].filter(Boolean);
    lines.push(
      `The shared Confluence tools are registered, but still need ${missing.join(" and ")} to be configured. When you receive a Confluence request, first check status with \`mcp__confluence__describe_config\`.`,
    );
  }
  // Standing (every-turn) guidance: the avatar can recommend a better-suited
  // teammate avatar. Phrased for ANY viewer class — in a headless routine there's
  // no user to redirect, but the search tool stays useful for the work itself.
  lines.push(
    "Finding other avatars: if you judge that the user's request falls outside your capabilities (skills, knowledge, capability hashtags), first try to help directly, then use `mcp__avatars__search_avatars` to find other public avatars suited to that topic. " +
      "If a better-suited avatar exists, suggest that the user try talking to that avatar (@username).",
  );
  // Who is on the other side decides the knowledge-backfill behavior (see the
  // knowledge-backfill skill): the owner reviews gaps, colleagues create them.
  // A headless run has NO ONE on the other side: never claim the owner is
  // present and state read-only.
  if (request.headless) {
    lines.push(
      request.allowHeadlessTools
        ? "This is the **automated execution** of a scheduled routine task. No one is watching the response in real time, so do not ask questions — carry the given task through to completion and report the result."
        : "This is an **automated task**, not a conversation (e.g. generating a profile intro or hashtags). There is no one to answer follow-up questions, so do not ask questions — carry the given task through to completion and output only the result.",
    );
    if (request.allowHeadlessTools) {
      lines.push(
        "This routine runs with the same tool permissions as the owner's normal conversation. Perform the file/remote/repository operations it needs, but since you cannot wait for confirmation questions or permission prompts, keep the scope of your work conservative. If there is an important result the user should be told about separately, leave an app notification with `mcp__system__notify_user`.",
      );
      // Routine self-state (META-COGNITION): owner-level tools ARE registered
      // for this run, so the routine needs the same state an owner chat gets —
      // otherwise it guesses (e.g. calls scaffold_skill with no repo connected,
      // or never realizes its group repo tools exist).
      const routineState: string[] = [
        request.knowledgeRepoConfigured !== false
          ? "Personal knowledge repository: connected — `mcp__repo__list_files`/`read_file`/`write_file`/`scaffold_skill`/`commit` are available (changes must be committed to be pushed)."
          : request.gitTokenSet
            ? "Personal knowledge repository: none — if a task needs a repository, create and connect one first with `mcp__repo__create_repo` (`scaffold_skill`/`write_file`/`commit` fail before one is connected)."
            : "Personal knowledge repository: none, and `GIT_TOKEN` is also not set — you cannot do tasks that need a repository, so note in your result report that a token needs to be registered.",
      ];
      const routineGroups = request.groupMemberships ?? [];
      if (routineGroups.length > 0) {
        routineState.push(
          `Owner's groups: ${routineGroups
            .map(
              (g) =>
                `${g.name}(${g.role === "admin" ? "admin" : "member"}, shared repository ${g.knowledgeRepoConfigured ? "connected" : "none"})`,
            )
            .join(", ")} — you can use the \`mcp__group_repo__*\` tools (members read, only admins write/commit).`,
        );
      }
      if (secretNames.length > 0) {
        routineState.push(
          `Configured secret names: ${secretNames.map((name) => `\`${name}\``).join(", ")} (the values are not exposed; do not output them).`,
        );
      }
      routineState.push("If you need any other current configuration or state, call `mcp__system__describe_system`.");
      lines.push(`Current self-state: ${routineState.join(" ")}`);
      lines.push(GIT_MCP_ONLY_GUIDANCE);
    } else {
      lines.push(
        "This run is read-only. Do not modify or create files; use only the read tools (Read/Glob/Grep).",
      );
    }
  } else if (request.viewerIsOwner) {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `The person you are talking to right now is this avatar's **owner**, "${name}".`
        : "The person you are talking to right now is this avatar's **owner**.",
    );
    lines.push(
      "When the owner asks about this system itself or requests configuration changes, check the current state with `mcp__system__describe_system`, then directly use `mcp__system__create_routine`/`update_routine`/`delete_routine` or `mcp__system__add_plugin`/`set_plugin_enabled` as appropriate. " +
        "For an important result or required action the user should be told about separately, leave an app notification with `mcp__system__notify_user`. Routine times are based on KST `HH:MM`, and plugin add/enable changes usually load starting from the next conversation.",
    );
    const knowledgeRepoConfigured = request.knowledgeRepoConfigured !== false;
    lines.push(knowledgeRepoSection(request, knowledgeRepoConfigured, githubHost));
    lines.push(gitRepoSection());
    lines.push(GIT_MCP_ONLY_GUIDANCE);
    // Group meta-cognition: which groups the owner is in, their role, and the
    // shared group knowledge repo (managed via mcp__group_repo__*). Group members
    // auto-trust each other, so teammates' avatars are reachable at elevated level.
    const groupBlock = groupsSection(request);
    if (groupBlock) {
      lines.push(groupBlock);
    }
    const secretsBlock = secretsSection(secretNames);
    if (secretsBlock) {
      lines.push(secretsBlock);
    }
    const sshBlock = sshEnablementSection(secretNames);
    if (sshBlock) {
      lines.push(sshBlock);
    }
    const greetingBlock = greetingSection(request, knowledgeRepoConfigured, openRequestCount, githubHost);
    if (greetingBlock) {
      lines.push(greetingBlock);
    }
  } else {
    const name = request.viewerName?.trim();
    lines.push(
      name
        ? `The person you are talking to right now is a **colleague**, "${name}". If you do not know information that only the owner would know, do not guess — relay it to the owner via request_info, following the knowledge-backfill skill.`
        : `The person you are talking to right now is a **colleague**. If you do not know information that only the owner would know, do not guess — relay it to the owner via request_info, following the knowledge-backfill skill.`,
    );
    // A trusted user works at the owner's tool level — don't claim read-only.
    // A plain colleague stays read-only.
    if (!request.elevated) {
      lines.push(
        "This conversation is read-only. Do not modify or create files; use only the read tools (Read/Glob/Grep), the permitted remote SSH lookup tools, and the provided information-request tools.",
      );
    } else {
      // Tell the avatar WHY this viewer is elevated when the trust comes from
      // group co-membership (META-COGNITION) — group context changes how the
      // avatar should respond (shared group skills/repo).
      const viaGroups = (request.trustedViaGroups ?? []).filter(Boolean);
      lines.push(
        viaGroups.length > 0
          ? `This person belongs to the same group(s) as the owner (${viaGroups.map((g) => `'${g}'`).join(", ")}), so they are an **automatically trusted (elevated)** user and can use file-editing and command-execution tools. They may share skills from the group's shared knowledge repository. Use remote SSH tools only within the scope the admin has permitted.`
          : "This person is a user the owner trusts and can use file-editing and command-execution tools. Use remote SSH tools only within the scope the admin has permitted.",
      );
      lines.push(
        "You can check the general git repos the owner has pre-registered with `mcp__git_repo__list_repos` and work on them with `sync_repo`/`status`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`. public repo sync is attempted without a token, and configuration changes such as registering/removing repos are owner-only.",
      );
      lines.push(GIT_MCP_ONLY_GUIDANCE);
    }
    lines.push(
      "Changing avatar system settings such as plugins, routines, and the knowledge repository is owner-only. If a colleague requests a change, guide them to ask the owner, or leave the needed context via request_info.",
    );
  }
  const historyBlock = request.greeting ? null : conversationHistoryBlock(request.conversationHistory);
  if (historyBlock) {
    lines.push(historyBlock);
  }
  if (request.greeting) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${request.headless ? "Task instruction" : "User message"}:\n${request.message}`;
}
