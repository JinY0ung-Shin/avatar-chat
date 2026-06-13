import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig, UserGroupMembership } from "../types.js";
import { normalizeGithubHost, scrubGitError } from "../marketplace.js";
import {
  commitIdentityFor,
  listTree,
  readFile as readRepoFile,
  scaffoldSkill,
  writeFile as writeRepoFile,
  writeRepoTemplate,
} from "../knowledgeRepo.js";
import {
  ensureGroupClone,
  groupCommitAndPush,
  groupKnowledgeRepoContextFor,
} from "../groupKnowledgeRepo.js";
import { createRemoteRepo } from "./repoTools.js";

/**
 * Per-conversation context the group knowledge-repo tools act within. These let
 * the avatar manage the SHARED knowledge repos of the groups its OWNER belongs
 * to, from chat. They are OWNER-ONLY (a colleague/trusted teammate or a headless
 * routine gets a refusal): a group admin edits their group repo through their
 * OWN avatar. Per-tool the OWNER's role in the named group is then checked —
 * members may read, only group admins may write/commit/create.
 */
export interface GroupRepoToolsContext {
  /** The avatar (== owner) whose group memberships these tools act on. */
  avatarUserId: string;
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__group_repo__<tool>`. */
export const GROUP_REPO_SERVER_NAME = "group_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GROUP_REPO_TOOL_NAMES = [
  "mcp__group_repo__list_groups",
  "mcp__group_repo__list_files",
  "mcp__group_repo__read_file",
  "mcp__group_repo__write_file",
  "mcp__group_repo__scaffold_skill",
  "mcp__group_repo__commit",
  "mcp__group_repo__create_repo",
] as const;

const OWNER_ONLY = "This tool can only be used by the avatar owner.";
const NO_SUCH_GROUP =
  "Could not find a group with that name/ID. First check the groups you belong to with list_groups.";
const ADMIN_ONLY =
  "Only a group admin can modify this group's shared knowledge repository. (Members can only read.)";
const NO_REPO =
  "This group does not have a shared knowledge repository connected yet. If you are a group admin, create a new one with `create_repo`, or connect an existing repository from group management in settings.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function githubHostDescription(host: string): string {
  const normalized = normalizeGithubHost(host);
  return `The current GitHub host is \`${normalized}\`, and create_repo creates the repo with \`GH_HOST=${normalized} gh repo create\`.`;
}

/**
 * Build the group knowledge-repo management tools bound to one conversation's
 * store + context. Exposed separately from the server so handlers can be tested
 * directly. Owner-only + per-group-role gating is enforced in the handlers.
 */
export function buildGroupRepoTools(
  store: Store,
  ctx: GroupRepoToolsContext,
  opts: { createRemoteRepo?: typeof createRemoteRepo } = {},
) {
  const create = opts.createRemoteRepo ?? createRemoteRepo;

  /** The owner's groups (id/name/role/repo flag). */
  const ownerGroups = (): UserGroupMembership[] => store.listUserGroups(ctx.avatarUserId);

  /** Resolve a `group` argument (id or name, case-insensitive) among the owner's groups. */
  const resolveGroup = (arg: string): UserGroupMembership | null => {
    const a = arg.trim().toLowerCase();
    if (!a) return null;
    const groups = ownerGroups();
    return (
      groups.find((g) => g.id.toLowerCase() === a) ??
      groups.find((g) => g.name.toLowerCase() === a) ??
      null
    );
  };

  const repoCtx = (groupId: string, groupName?: string) =>
    groupKnowledgeRepoContextFor(store, groupId, ctx.avatarUserId, ctx.config, groupName);

  return [
    tool(
      "list_groups",
      "List the groups I belong to, my role in each group (admin/member), and whether a shared knowledge repository is connected. Call this first, before working on a group knowledge repository, to confirm the group name. (owner only)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const groups = ownerGroups();
        if (groups.length === 0) {
          return text("You do not belong to any group. Groups are created and have members added by the system admin.");
        }
        const body = groups
          .map(
            (g) =>
              `- ${g.name} (role: ${g.role === "admin" ? "admin" : "member"}, shared repository: ${
                g.knowledgeRepoConfigured ? "connected" : "none"
              })`,
          )
          .join("\n");
        return text(`${groups.length} group(s) I belong to:\n${body}`);
      },
    ),
    tool(
      "list_files",
      "Get the file list of the specified group's shared knowledge repository. (group member only)",
      { group: z.string().describe("Group name or ID (confirm with list_groups)") },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          const entries = await listTree(repoRoot);
          if (entries.length === 0) return text("(The repository is empty.)");
          const list = entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
          return text(`File list of the '${group.name}' group knowledge repository:\n${list}`);
        } catch (error) {
          return text(
            `Failed to load the repository: ${scrubGitError(error)}\nCheck the repository address/branch and token permissions. Do not clone directly with Bash git — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "read_file",
      "Read the content of a file from the specified group's shared knowledge repository. (group member only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Path relative to the repository root (e.g. skills/foo/SKILL.md)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          return text(await readRepoFile(repoRoot, args.path));
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "INVALID_PATH") return text("Invalid path.", true);
          if (detail === "FILE_TOO_LARGE") return text("The file is too large.", true);
          if (detail === "NOT_A_FILE") return text("Not a file.", true);
          return text(`Failed to read the file: ${detail}`, true);
        }
      },
    ),
    tool(
      "write_file",
      "Create/modify a file in the specified group's shared knowledge repository (creates it if it doesn't exist). Changes apply only to the working tree and are **saved only temporarily until commit**. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Path relative to the repository root"),
        content: z.string().describe("The full file content"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          await writeRepoFile(repoRoot, args.path, args.content);
          return text(`Saved the file ${args.path}. (Not committed yet — push it with commit.)`);
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "INVALID_PATH") return text("Invalid path.", true);
          if (detail === "FILE_TOO_LARGE") return text("The content is too large.", true);
          return text(`Failed to save the file: ${detail}`, true);
        }
      },
    ),
    tool(
      "scaffold_skill",
      "Create a new skill (skills/<name>/SKILL.md + marketplace registration) in the specified group's shared knowledge repository. After that, fill it in with write_file and push with commit, and the avatars of all group members can use that skill. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        name: z.string().describe("Skill name (e.g. team-runbook)"),
        description: z.string().optional().describe("One-line description of the skill"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureGroupClone(c);
          const filePath = await scaffoldSkill(repoRoot, args.name, args.description ?? "");
          return text(`Created a new skill: ${filePath} (fill in the content with write_file, then push with commit.)`);
        } catch (error) {
          const detail = scrubGitError(error);
          if (detail === "SKILL_EXISTS") return text("A skill with the same name already exists.", true);
          if (detail === "INVALID_PATH") return text("Invalid path.", true);
          return text(`Failed to create the skill: ${detail}`, true);
        }
      },
    ),
    tool(
      "commit",
      "Commit the changes in the specified group's shared knowledge repository and push to the remote. Call this when a unit of work is finished. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        message: z.string().describe("Commit message"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        if (!c.token) {
          return text("To push, please first register an internal Git token (GIT_TOKEN) in settings.", true);
        }
        try {
          const committed = await groupCommitAndPush(c, args.message, commitIdentityFor(store, ctx.owner));
          if (!committed) return text("There are no changes to commit.");
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_push",
            status: "success",
            detail: `group=${group.name} pushed to ${c.repo}`,
          });
          return text(`Committed and pushed the changes to the '${group.name}' group knowledge repository: ${c.repo}`);
        } catch (error) {
          return text(
            `Commit/push failed: ${scrubGitError(error)}\nCheck the write permission of the token (GIT_TOKEN) and the remote branch protection settings. Do not work around this with Bash \`git push\` — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "create_repo",
      `**Use this tool when a group admin asks you to create the group's shared knowledge repository.** ${githubHostDescription(
        ctx.config.githubHost,
      )} Using the configured internal Git token (GIT_TOKEN), it creates a new internal GitHub repository (private by default, initialized from the Claude plugin marketplace template) and connects it to that group right away. It only works when the group does not have a repository yet. (group admin only)`,
      {
        group: z.string().describe("Group name or ID"),
        name: z.string().describe("New repository name (letters/digits and - _ . only, e.g. team-knowledge)"),
        private: z.boolean().optional().describe("Whether it is private (default true)"),
        description: z.string().optional().describe("Repository description (optional)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        if (group.knowledgeRepoConfigured) {
          return text("This group already has a shared knowledge repository connected.", true);
        }
        const token = store.getGitToken(ctx.avatarUserId);
        if (!token) {
          return text(
            "To create a GitHub repository, please first register an internal Git token (GIT_TOKEN) under Settings → Git credentials.",
            true,
          );
        }
        const name = args.name.trim();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
          return text("The repository name may only use letters/digits and the characters - _ .", true);
        }
        const targetHost = normalizeGithubHost(ctx.config.githubHost);
        try {
          const result = await create(
            targetHost,
            token,
            name,
            args.private ?? true,
            (args.description ?? "").trim(),
            ctx.config.githubCaCert,
          );
          if (!result.ok) {
            const status = result.status ? `, HTTP ${result.status}` : "";
            const exitCode = result.exitCode ? `, exit ${result.exitCode}` : "";
            return text(
              `Failed to create GitHub repository (host: ${targetHost}${status}${exitCode}): ${result.message}\nCheck whether the token (GIT_TOKEN) has repo-creation permission and whether a repository with the same name already exists. Do not work around this with Bash \`gh\`/git — the shell has no git credentials.`,
              true,
            );
          }
          store.setGroupKnowledgeRepo(group.id, result.fullName, result.defaultBranch);
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_create",
            status: "success",
            detail: `group=${group.name} created ${result.fullName}`,
          });
          let seeded = false;
          let seedNote = "";
          try {
            const c = repoCtx(group.id, group.name);
            if (c) {
              const repoRoot = await ensureGroupClone(c);
              if (await writeRepoTemplate(repoRoot, result.fullName)) {
                await groupCommitAndPush(c, "Initialize group knowledge repo", commitIdentityFor(store, ctx.owner));
                seeded = true;
              }
            }
          } catch (error) {
            seedNote = ` (Skipped initializing the default template: ${scrubGitError(error)})`;
          }
          const kind = result.isPrivate ? "private" : "public";
          return text(
            seeded
              ? `Created the ${kind} shared knowledge repository \`${result.fullName}\` for the '${group.name}' group and initialized it with the default template. Now add your first skill with scaffold_skill and push with commit.`
              : `Created and connected the ${kind} shared knowledge repository \`${result.fullName}\` for the '${group.name}' group.${seedNote}`,
          );
        } catch (error) {
          return text(`Error while creating GitHub repository (host: ${targetHost}): ${scrubGitError(error)}`, true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the group knowledge-repo tools. */
export function buildGroupRepoServer(store: Store, ctx: GroupRepoToolsContext) {
  return createSdkMcpServer({
    name: GROUP_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGroupRepoTools(store, ctx),
  });
}
