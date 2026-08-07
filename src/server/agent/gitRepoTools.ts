import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import { decodeExecError, text } from "./mcpTools.js";
import { setWorkspaceRepo } from "../repoWorkspace.js";
import {
  defaultGitRepoName,
  ensureGitRepoClone,
  gitRepoContextFor,
  gitRepoContextFromRecord,
  normalizeGitRepoName,
  pushGitRepo,
  removeGitRepoClone,
} from "../gitRepos.js";

export interface GitRepoToolsContext {
  /** The avatar owner whose registered repos and git tokens are used. */
  avatarUserId: string;
  owner: AgentOwner;
  /** True for the avatar owner in an interactive chat AND in an owner routine run. */
  viewerIsOwner: boolean;
  /**
   * True for owner/trusted-user interactive chats AND owner routine runs (the
   * scheduler passes elevated:true). open_repo/close_repo gate on this, so a
   * routine can open a working repo.
   */
  elevated: boolean;
  config: AppConfig;
  /**
   * The conversation this run belongs to. Needed by `open_repo`/`close_repo` to
   * record the working-repo selection the chat route AND the routine scheduler
   * read on the next turn/run (persisted on conversations.working_repo). Unset
   * only for runs with no conversation (e.g. headless intro generation) —
   * open_repo then reports it cannot open a working repo.
   */
  conversationId?: string;
}

/** MCP server name; tools surface to the model as `mcp__git_repo__<tool>`. */
export const GIT_REPO_SERVER_NAME = "git_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GIT_REPO_TOOL_NAMES = [
  "mcp__git_repo__register_repo",
  "mcp__git_repo__list_repos",
  "mcp__git_repo__sync_repo",
  "mcp__git_repo__remove_repo",
  "mcp__git_repo__open_repo",
  "mcp__git_repo__close_repo",
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
      "Register a general git repository in this avatar owner's repo list and create a local working clone. repo accepts owner/repo, an https URL, a git URL, or a local bare repo path. If branch is specified, subsequent sync/commit/push target that branch; if left empty, the repository's default branch is used. NEW-BRANCH NOTE: a branch that does NOT yet exist on origin cannot be cloned/checked out here, so this call ERRORS (e.g. \"'origin/<branch>' is not a commit\") — but creating a remote branch is the job of `push`, not this tool. The branch you pass is still saved on an ALREADY-registered repo even when this checkout step errors (only a brand-new registration is rolled back on failure), so the normal flow to start a new branch is: set the new branch name here, ignore the checkout error, then `commit` your local HEAD and `push` — push creates the branch on origin. (Alternatively, create the branch on the remote first, then register.) Public repo clone/sync is attempted without a token, and a token is only used if one exists for the configured internal host or github.com. (owner only)",
      {
        repo: z.string().describe("The git repository to register. e.g. owner/repo, https://github.com/owner/repo.git, /path/to/repo.git"),
        name: z.string().optional().describe("A short name to use in the conversation. If empty, it is auto-generated from the repo name."),
        branch: z.string().optional().describe("The branch to use. Not limited to main; if empty, the repository's default branch is used. A branch that does not exist on origin yet cannot be checked out here (this call errors), but `push` will create it on origin — so for a new branch, set the name here and then commit + push."),
      },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        const name = normalizeGitRepoName(args.name || defaultGitRepoName(args.repo));
        // Track whether this name was already registered: on a failed clone we roll
        // back a NEWLY-created row (so a typo'd repo doesn't linger in list_repos),
        // but must leave a pre-existing registration intact. NOTE: this is also what
        // lets a re-register with a not-yet-existing branch "stick" — the branch is
        // upserted before the clone, and an already-existing registration is NOT
        // rolled back on the checkout error, so a later push can create that branch.
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
            `Failed to register/sync git repo: ${errorMessage(error)}\nCheck the repo address, branch name, and access permissions. If you named a branch that does not exist on origin yet, that is expected — the branch setting is still saved for an already-registered repo, so you can now commit and push (push creates the new branch on origin). A private repo requires the token under Settings → Git credentials. Do not work around this with Bash \`git clone\` — the shell has no git credentials.`,
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
      "Fetch a registered git repository and update it by rebasing local commits onto the upstream (uncommitted changes are auto-stashed and restored). A public repo attempts this without a token. If the local commits genuinely conflict with the remote the rebase is rolled back (the clone is left untouched) and this errors — reconcile and sync again. (owner / trusted user only)",
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
            `Sync failed: ${errorMessage(error)}\nIf the rebase conflicted, the clone was rolled back to its previous state — reconcile the conflicting changes (re-apply them on top of the latest remote, or discard local work) and sync again. Do not work around this with Bash git — the shell has no git credentials.`,
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
      "open_repo",
      "Open a registered git repository as THIS conversation's working directory so you can read, edit, and test it with native tools (Read/Edit/Write/Bash). The change takes effect from the NEXT turn — the next message in a chat, or (in a scheduled routine) this routine's next scheduled run — because the working directory is fixed when a turn/run starts and cannot be repointed mid-turn; the selection persists for this conversation until close_repo. So after calling this, in a chat tell the user it is ready and continue on their next message; in a routine, finish this run and the repo applies on the next one. From then on, work the repo natively in the working directory: read/edit files, run tests, and use local git (`git status`/`diff`/`log`/`add`/`commit`); then `push` the result and `sync_repo` to pull updates (those need server-side credentials, so they stay MCP-only). Only one repo is open at a time per conversation — opening another replaces it. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (!ctx.conversationId) {
          return text("Cannot open a working repository in this run (no conversation context).", true);
        }
        try {
          const repoCtx = ownerRepoContext(args.name);
          // Make sure the clone exists now so a bad-repo/access error surfaces
          // immediately — WITHOUT syncing (a fetch/checkout could clobber edits).
          await ensureGitRepoClone(repoCtx);
          setWorkspaceRepo(store, ctx.conversationId, repoCtx.name);
          return text(
            `Opened '${repoCtx.name}' as this conversation's working directory. It becomes your working directory from the NEXT turn — the next message in a chat, or this routine's next scheduled run — so let the user know it is ready and continue from there; then edit/test it with native tools and use \`push\`/\`sync_repo\` for remote git. The selection persists for this conversation until you \`close_repo\`.`,
          );
        } catch (error) {
          return text(
            `Failed to open the working repository: ${errorMessage(error)}\nCheck the repo is registered (list_repos) and reachable. Do not work around this with Bash git — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "close_repo",
      "Close the working repository opened for this conversation so later turns run in the default scratch workspace again. Takes effect from the next message. (owner / trusted user only)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (ctx.conversationId) setWorkspaceRepo(store, ctx.conversationId, null);
        return text(
          "Closed the working repository. From the next turn this conversation runs in the default scratch workspace.",
        );
      },
    ),
    tool(
      "push",
      "Push the registered git repository's current HEAD to the target branch on origin. The target is the branch saved in register_repo; if branch is empty, it's the current/default branch. Not limited to main, AND if the target branch does not exist on origin yet, push CREATES it (this — not register_repo — is how a new remote branch is made). To push to a branch other than the one currently registered, set that name via register_repo's `branch` first (the setting persists even if register's checkout step errors on a not-yet-existing branch), then push. (owner / trusted user only)",
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
