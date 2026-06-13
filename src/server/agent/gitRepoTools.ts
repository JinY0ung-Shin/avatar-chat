import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import { commitIdentityFor } from "../knowledgeRepo.js";
import { decodeExecError, text } from "./mcpTools.js";
import {
  commitGitRepo,
  defaultGitRepoName,
  deleteGitRepoFile,
  ensureGitRepoClone,
  gitRepoContextFor,
  gitRepoContextFromRecord,
  gitRepoDiff,
  gitRepoStatus,
  listGitRepoTree,
  normalizeGitRepoName,
  pushGitRepo,
  readGitRepoFile,
  removeGitRepoClone,
  writeGitRepoFile,
} from "../gitRepos.js";

export interface GitRepoToolsContext {
  /** The avatar owner whose registered repos and git tokens are used. */
  avatarUserId: string;
  owner: AgentOwner;
  /** True only for the avatar owner in an interactive chat. */
  viewerIsOwner: boolean;
  /** True for owner/trusted-user interactive chats. */
  elevated: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__git_repo__<tool>`. */
export const GIT_REPO_SERVER_NAME = "git_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GIT_REPO_TOOL_NAMES = [
  "mcp__git_repo__register_repo",
  "mcp__git_repo__list_repos",
  "mcp__git_repo__sync_repo",
  "mcp__git_repo__remove_repo",
  "mcp__git_repo__status",
  "mcp__git_repo__list_files",
  "mcp__git_repo__read_file",
  "mcp__git_repo__write_file",
  "mcp__git_repo__delete_file",
  "mcp__git_repo__diff",
  "mcp__git_repo__commit",
  "mcp__git_repo__push",
] as const;

const OWNER_ONLY = "This tool can only be used in a conversation the avatar owner is taking part in.";
const ELEVATED_ONLY = "This git repo tool can only be used in a conversation with the avatar owner or a trusted user.";

function errorMessage(error: unknown): string {
  return decodeExecError(error).message;
}

function renderRepo(repo: ReturnType<Store["listGitRepos"]>[number]): string {
  return [
    `name=${repo.name}`,
    `repo=${repo.repo}`,
    repo.branch ? `branch=${repo.branch}` : "branch=(default)",
    repo.lastSyncedAt ? `lastSyncedAt=${repo.lastSyncedAt}` : "lastSyncedAt=null",
  ].join(" | ");
}

function renderStatus(status: Awaited<ReturnType<typeof gitRepoStatus>>): string {
  if (!status.cloned) {
    return [
      `name=${status.name}`,
      `repo=${status.repo}`,
      status.branch ? `branch=${status.branch}` : "branch=(default)",
      "cloned=false",
      "Run clone/sync first with sync_repo.",
    ].join(" | ");
  }
  const aheadBehind =
    status.ahead === null || status.behind === null
      ? "upstream=(unknown)"
      : `ahead=${status.ahead} behind=${status.behind}`;
  const dirty = status.dirty.length ? status.dirty.join(", ") : "(clean)";
  return [
    `name=${status.name}`,
    `repo=${status.repo}`,
    `branch=${status.branch ?? "(detached)"}`,
    `head=${status.head ?? "(unknown)"}`,
    aheadBehind,
    `dirty=${dirty}`,
  ].join(" | ");
}

/**
 * Build general git repository tools. Persistent repo registration is
 * owner-only; work on already-registered repos is owner/trusted-only.
 */
export function buildGitRepoTools(store: Store, ctx: GitRepoToolsContext) {
  const ownerRepoContext = (name: string) => {
    const repoCtx = gitRepoContextFor(store, ctx.avatarUserId, name, ctx.config);
    if (!repoCtx) {
      throw new Error(`Could not find a registered git repo named '${normalizeGitRepoName(name)}'. Use register_repo first.`);
    }
    return repoCtx;
  };

  const elevatedGuard = () => {
    if (!ctx.elevated) {
      return text(ELEVATED_ONLY, true);
    }
    return null;
  };
  const ownerGuard = () => {
    if (!ctx.viewerIsOwner) {
      return text(OWNER_ONLY, true);
    }
    return null;
  };

  return [
    tool(
      "register_repo",
      "Register a general git repository in this avatar owner's repo list and create a local working clone. repo accepts owner/repo, an https URL, a git URL, or a local bare repo path. If branch is specified, subsequent sync/commit/push target that branch; if left empty, the repository's default branch is used. Public repo clone/sync is attempted without a token, and a token is only used if one exists for the configured internal host or github.com. (owner only)",
      {
        repo: z.string().describe("The git repository to register. e.g. owner/repo, https://github.com/owner/repo.git, /path/to/repo.git"),
        name: z.string().optional().describe("A short name to use in the conversation. If empty, it is auto-generated from the repo name."),
        branch: z.string().optional().describe("The branch to use. Not limited to main; if empty, the repository's default branch is used."),
      },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        const name = normalizeGitRepoName(args.name || defaultGitRepoName(args.repo));
        // Track whether this name was already registered: on a failed clone we roll
        // back a NEWLY-created row (so a typo'd repo doesn't linger in list_repos),
        // but must leave a pre-existing registration intact.
        const existed = Boolean(store.getGitRepo(ctx.avatarUserId, name));
        try {
          const record = store.upsertGitRepo(ctx.avatarUserId, name, args.repo, args.branch || null);
          const repoCtx = gitRepoContextFromRecord(store, record, ctx.config);
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, name);
          return text(`Registered and synced the git repo: ${renderRepo(store.getGitRepo(ctx.avatarUserId, name)!)}.`);
        } catch (error) {
          if (!existed) store.deleteGitRepo(ctx.avatarUserId, name);
          return text(
            `Failed to register/sync git repo: ${errorMessage(error)}\nCheck the repo address, branch name, and access permissions. A private repo requires the token under Settings → Git credentials. Do not work around this with Bash \`git clone\` — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "list_repos",
      "List the general git repositories registered for this avatar owner. (owner / trusted user only)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        const repos = store.listGitRepos(ctx.avatarUserId);
        if (repos.length === 0) {
          return text("There are no registered general git repos. The owner must register one first with register_repo.");
        }
        return text(`${repos.length} registered git repo(s):\n${repos.map(renderRepo).join("\n")}`);
      },
    ),
    tool(
      "sync_repo",
      "Fetch a registered git repository and update it via fast-forward. A public repo attempts fetch/pull without a token; this fails if there are uncommitted changes or conflicts. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, repoCtx.name);
          return text(`Synced the git repo: ${repoCtx.name}`);
        } catch (error) {
          return text(
            `Sync failed: ${errorMessage(error)}\nThis fails if there are uncommitted changes or conflicts — check the working tree with status. Do not work around this with Bash git.`,
            true,
          );
        }
      },
    ),
    tool(
      "remove_repo",
      "Remove a registered general git repository from the list and delete its local working clone. Does not delete the remote repository. (owner only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const removed = store.deleteGitRepo(ctx.avatarUserId, repoCtx.name);
          await removeGitRepoClone(repoCtx);
          return text(removed ? `Removed the git repo registration: ${repoCtx.name}` : `No registered git repo found: ${repoCtx.name}`);
        } catch (error) {
          return text(`Failed to remove repo: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "status",
      "Show a registered git repository's current branch, HEAD, ahead/behind, and uncommitted changed files. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          return text(renderStatus(await gitRepoStatus(ownerRepoContext(args.name))));
        } catch (error) {
          return text(`status failed: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "list_files",
      "List the file tree of a registered git repository. `.git` is excluded. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const entries = await listGitRepoTree(ownerRepoContext(args.name));
          if (entries.length === 0) return text("The repository is empty.");
          return text(entries.map((e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}`).join("\n"));
        } catch (error) {
          return text(`Failed to list files: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "read_file",
      "Read a text file from a registered git repository. (owner / trusted user only)",
      {
        name: z.string().describe("Registered repo name"),
        path: z.string().describe("Path relative to the repo root"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          return text(await readGitRepoFile(ownerRepoContext(args.name), args.path));
        } catch (error) {
          return text(`Failed to read file: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "write_file",
      "Create/modify a text file in a registered git repository. Changes apply only to the local working tree and are not reflected on the remote until commit/push. (owner / trusted user only)",
      {
        name: z.string().describe("Registered repo name"),
        path: z.string().describe("Path relative to the repo root"),
        content: z.string().describe("The full file content"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          await writeGitRepoFile(ownerRepoContext(args.name), args.path, args.content);
          return text(`Saved the file: ${args.path}\nNot committed/pushed yet. If needed, run diff and then commit/push.`);
        } catch (error) {
          return text(`Failed to write file: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "delete_file",
      "Delete a file from a registered git repository. The deletion applies only to the local working tree. (owner / trusted user only)",
      {
        name: z.string().describe("Registered repo name"),
        path: z.string().describe("Path relative to the repo root"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          await deleteGitRepoFile(ownerRepoContext(args.name), args.path);
          return text(`Deleted the file: ${args.path}\nNot committed/pushed yet.`);
        } catch (error) {
          return text(`Failed to delete file: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "diff",
      "Show the unstaged diff of a registered git repository. If paths are given, the diff is limited to those paths. (owner / trusted user only)",
      {
        name: z.string().describe("Registered repo name"),
        paths: z.array(z.string()).optional().describe("Optional list of paths"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const diff = await gitRepoDiff(ownerRepoContext(args.name), args.paths);
          return text(diff.trim() ? diff : "There is no changed diff. Check new untracked files with status before commit.");
        } catch (error) {
          return text(`diff failed: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "commit",
      "Commit the changes in a registered git repository. If paths are given, only those paths are staged. Pushing is done with the separate push tool. (owner / trusted user only)",
      {
        name: z.string().describe("Registered repo name"),
        message: z.string().describe("Commit message"),
        paths: z.array(z.string()).optional().describe("Optional list of paths"),
      },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const committed = await commitGitRepo(repoCtx, args.message, commitIdentityFor(store, ctx.owner), args.paths);
          return text(committed ? `Committed the changes: ${repoCtx.name}` : "There are no changes to commit.");
        } catch (error) {
          return text(
            `commit failed: ${errorMessage(error)}\nCheck the working tree state with status/diff. Do not work around this with Bash git.`,
            true,
          );
        }
      },
    ),
    tool(
      "push",
      "Push the registered git repository's current HEAD to the target branch on origin. The target is the branch saved in register_repo; if branch is empty, it's the current/default branch. Not limited to main. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const branch = await pushGitRepo(repoCtx);
          return text(`Pushed the changes: ${repoCtx.name} -> ${branch}`);
        } catch (error) {
          return text(
            `push failed: ${errorMessage(error)}\nCheck remote write permission, token, and whether the branch is protected (even a public repo needs write permission to push). Do not work around this with Bash \`git push\` — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
  ];
}

export function buildGitRepoServer(store: Store, ctx: GitRepoToolsContext) {
  return createSdkMcpServer({
    name: GIT_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGitRepoTools(store, ctx),
  });
}
