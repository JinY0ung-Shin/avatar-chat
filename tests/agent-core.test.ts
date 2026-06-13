import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { createServices, expandChatSlashCommand } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { applyCustomGithubCa } from "../src/server/tlsCa.js";
import { loadDotEnv } from "../src/server/loadEnv.js";
import {
  buildKnowledgeTools,
  KNOWLEDGE_SERVER_NAME,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolsContext,
} from "../src/server/agent/knowledgeTools.js";
import { normalizeHashtags } from "../src/server/store.js";
import {
  buildAvatarDirectoryTools,
  AVATAR_DIRECTORY_SERVER_NAME,
  AVATAR_DIRECTORY_TOOL_NAMES,
} from "../src/server/agent/avatarDirectoryTools.js";
import {
  gitAuthArgs,
  marketplaceCloneUrl,
  normalizeGithubHost,
  pathExists,
  sanitizeName,
  scrubGitError,
  syncGitRepo,
} from "../src/server/marketplace.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  tokenForGitUrl,
} from "../src/server/gitCredentials.js";
import {
  APP_MANAGED_MCP_SERVERS,
  inspectRepoContents,
  listSkillsInRoots,
  loadAgentPluginRoots,
  loadAvatarPluginRoots,
  loadDefaultPluginRoots,
  resolvePluginRoots,
  stripManagedMcpServers,
} from "../src/server/plugins.js";
import {
  attachRunClient,
  awaitResponse,
  cancelRun,
  CANCELLED,
  closeRun,
  emitRunEvent,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
} from "../src/server/agent/runRegistry.js";
import {
  agentSubprocessEnv,
  buildPreToolUseHook,
  buildPrompt,
  deriveAgentToolAccess,
  interpretResult,
  resultErrorMessage,
  rewriteBashCommandWithRtk,
  sshMcpSecretEnv,
} from "../src/server/agent/claudeAgent.js";
import { executeRoutineJob } from "../src/server/scheduler.js";
import {
  formatMinuteOfDay,
  nextRunIso,
  parseRoutineSchedule,
  parseTimeToMinute,
} from "../src/server/routineSchedule.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { decryptSecret, encryptSecret } from "../src/server/crypto.js";
import {
  commitAndPush,
  commitIdentityFor,
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  resolveInRepo,
  scaffoldSkill,
  readFile as readKnowledgeFile,
  writeFile as writeKnowledgeFile,
  writeRepoTemplate,
} from "../src/server/knowledgeRepo.js";
import {
  buildRepoTools,
  createRemoteRepo,
  REPO_CREATE_TOOL_NAME,
  REPO_SERVER_NAME,
  REPO_TOOL_NAMES,
} from "../src/server/agent/repoTools.js";
import {
  buildGroupRepoTools,
  GROUP_REPO_SERVER_NAME,
  GROUP_REPO_TOOL_NAMES,
} from "../src/server/agent/groupRepoTools.js";
import {
  buildGitRepoTools,
  GIT_REPO_SERVER_NAME,
  GIT_REPO_TOOL_NAMES,
} from "../src/server/agent/gitRepoTools.js";
import { gitRepoClonePath, gitRepoContextFromRecord } from "../src/server/gitRepos.js";
import {
  buildSystemTools,
  SYSTEM_SERVER_NAME,
  SYSTEM_TOOL_NAMES,
  type SystemToolsContext,
} from "../src/server/agent/systemTools.js";
import {
  knownHostsPath,
  parseKnownHosts,
  upsertHostLine,
  addTrustedHost,
  listTrustedHosts,
  removeTrustedHost,
} from "../src/server/sshTrust.js";
import {
  buildSshTrustTools,
  SSH_TRUST_SERVER_NAME,
  SSH_TRUST_TOOL_NAMES,
} from "../src/server/agent/sshTrustTools.js";
import {
  buildSshIdentityTools,
  SSH_IDENTITY_SERVER_NAME,
  SSH_IDENTITY_TOOL_NAMES,
} from "../src/server/agent/sshIdentityTools.js";
import {
  buildConfluenceTools,
  CONFLUENCE_SERVER_NAME,
  CONFLUENCE_TOOL_NAMES,
} from "../src/server/agent/confluenceTools.js";
import { generateSshKeyPair } from "../src/server/sshIdentity.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import type { AppConfig, Plugin } from "../src/server/types.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../src/server/hexSshPolicy.js";

import { rpcClient, gitInit, makeBareRemote, makePluginRepo, makeMarketplaceRepo, makeSkill } from "./helpers.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// chat slash commands — server fallback for stale clients/API callers
// ---------------------------------------------------------------------------

describe("chat slash commands", () => {
  it("expands /learn into the session learning prompt", () => {
    const result = expandChatSlashCommand("/learn");

    expect(result.error).toBeUndefined();
    expect(result.ownerOnly).toBe(true);
    // Agent-facing (the user only sees the literal "/learn"), so it's English and
    // includes the capability/limitation self-record instruction.
    expect(result.message).toContain("update my knowledge repository");
    expect(result.message).toContain("CAN and CANNOT do");
  });

  it("forwards text after /learn as an extra focus hint", () => {
    const result = expandChatSlashCommand("/learn 보안 설정 위주로");

    expect(result.error).toBeUndefined();
    expect(result.ownerOnly).toBe(true);
    // The standing instruction is kept AND the user's trailing text is appended.
    expect(result.message).toContain("update my knowledge repository");
    expect(result.message).toContain("보안 설정 위주로");
  });

  it("expands slash commands with arguments", () => {
    const result = expandChatSlashCommand("/remember 프로젝트 기본 포트는 48787");

    expect(result.error).toBeUndefined();
    expect(result.ownerOnly).toBe(true);
    expect(result.message).toContain("내 지식 저장소에 기록");
    expect(result.message).toContain("프로젝트 기본 포트는 48787");
  });

  it("rejects slash commands that require missing arguments", () => {
    const result = expandChatSlashCommand("/remember");

    expect(result.error).toBe("/remember 뒤에 저장할 내용을 입력해 주세요.");
    expect(result.message).toBe("/remember");
  });

  it("leaves unknown slash text untouched", () => {
    const result = expandChatSlashCommand("/not-a-command");

    expect(result.error).toBeUndefined();
    expect(result.message).toBe("/not-a-command");
  });

  // Client-expanded commands carry their (user-facing, Korean) prompt in BOTH the
  // server (expandChatSlashCommand, the fallback for stale clients/API callers) and
  // the client (public/app.js SLASH_COMMANDS, which expands before sending so the
  // bubble shows the prompt). public/app.js is served raw — no bundler — so they
  // can't share a constant; this guards against the two copies drifting apart.
  // `/learn` is EXCLUDED: it is server-expanded (serverExpand: true), so the client
  // sends the literal "/learn" and intentionally carries no copy of the prompt.
  it("client app.js carries the same slash prompts as the server", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
    const cases = ["/summarize", "/remember 내용", "/routine 작업", "/find 요청"];
    for (const input of cases) {
      const { message } = expandChatSlashCommand(input);
      // Compare the static template, dropping any trailing "\n\n<args>" we injected.
      const staticPart = message.split("\n\n")[0];
      expect(appJs, `slash prompt for "${input}" drifted between server and client`).toContain(staticPart);
    }
    // /learn is server-only: its expanded text must NOT be duplicated in the client.
    expect(appJs).not.toContain(expandChatSlashCommand("/learn").message.split("\n\n")[0]);
  });
});


// ---------------------------------------------------------------------------
// runRegistry — in-memory parking of interactive-tool responses
// ---------------------------------------------------------------------------

describe("runRegistry", () => {
  function sseSink() {
    const chunks: string[] = [];
    const handlers = new Map<string, () => void>();
    let ended = false;
    const res = {
      get writableEnded() {
        return ended;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {
        ended = true;
        handlers.get("close")?.();
      },
      on(event: string, cb: () => void) {
        handlers.set(event, cb);
        return this;
      },
    } as Response;
    return { res, chunks };
  }

  it("parks a request and resolves it when the user responds", async () => {
    openRun("run1", "user1");
    const parked = awaitResponse("run1", "req1");

    expect(submitResponse("run1", "req1", "user1", { behavior: "allow" })).toBe(true);
    await expect(parked).resolves.toEqual({ behavior: "allow" });

    closeRun("run1");
  });

  it("resolves CANCELLED when awaiting an unknown or ended run", async () => {
    await expect(awaitResponse("ghost", "req")).resolves.toBe(CANCELLED);

    openRun("run2", "user2");
    closeRun("run2");
    await expect(awaitResponse("run2", "req")).resolves.toBe(CANCELLED);
  });

  it("rejects responses for unknown runs, wrong users, and unknown requests", () => {
    expect(submitResponse("nope", "req", "user", {})).toBe(false); // unknown run

    openRun("run3", "owner");
    void awaitResponse("run3", "req3");
    expect(submitResponse("run3", "req3", "intruder", {})).toBe(false); // wrong user
    expect(submitResponse("run3", "other-req", "owner", {})).toBe(false); // unknown request id
    expect(submitResponse("run3", "req3", "owner", { ok: true })).toBe(true);
    closeRun("run3");
  });

  it("cancels every outstanding request when a run closes", async () => {
    openRun("run4", "user4");
    const a = awaitResponse("run4", "a");
    const b = awaitResponse("run4", "b");

    closeRun("run4");
    await expect(a).resolves.toBe(CANCELLED);
    await expect(b).resolves.toBe(CANCELLED);

    // Closing an unknown run is a no-op (must not throw).
    expect(() => closeRun("never-opened")).not.toThrow();
  });

  it("buffers SSE events and replays them to attached clients", () => {
    openRun("run5", "user5", { conversationId: "conv5", avatarId: "avatar5" });
    expect(getActiveRunForConversation("user5", "conv5")?.runId).toBe("run5");
    expect(emitRunEvent("run5", "status", { label: "작업 중" })).toBe(true);

    const first = sseSink();
    expect(attachRunClient("run5", "user5", first.res)).toBe(true);
    expect(first.chunks.join("")).toContain("event: status");
    expect(first.chunks.join("")).toContain("작업 중");

    const second = sseSink();
    expect(attachRunClient("run5", "user5", second.res, 1)).toBe(true);
    expect(second.chunks.join("")).not.toContain("작업 중");
    expect(emitRunEvent("run5", "delta", { text: "hello" })).toBe(true);
    expect(first.chunks.join("")).toContain("hello");
    expect(second.chunks.join("")).toContain("hello");

    closeRun("run5");
    expect(getActiveRunForConversation("user5", "conv5")).toBeNull();
  });

  it("marks cancellation, aborts the controller, and unparks prompts", async () => {
    const abortController = new AbortController();
    openRun("run6", "user6", { conversationId: "conv6", abortController });
    const parked = awaitResponse("run6", "req6");

    expect(cancelRun("run6", "intruder")).toBe(false);
    expect(cancelRun("run6", "user6")).toBe(true);
    expect(isRunCancelled("run6")).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    await expect(parked).resolves.toBe(CANCELLED);

    closeRun("run6");
  });
});


// ---------------------------------------------------------------------------
// workspace dirs — per-conversation agent cwd isolation
// ---------------------------------------------------------------------------

describe("workspace dirs", () => {
  it("isolates workspaces by avatar and conversation with safe path segments", () => {
    const dataDir = path.join(tempDir, "ws");
    const { config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const base = path.join(config.dataDir, "workspaces");

    const first = workspaceDirFor(config, "avatar/../x", "conv-1");
    const second = workspaceDirFor(config, "avatar/../x", "conv-2");
    const otherAvatar = workspaceDirFor(config, "other-avatar", "conv-1");

    expect(first).not.toBe(second);
    expect(first).not.toBe(otherAvatar);
    for (const dir of [first, second, otherAvatar]) {
      const rel = path.relative(base, dir);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel.startsWith("..")).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// marketplace — URL/name helpers and git sync
// ---------------------------------------------------------------------------

describe("marketplace helpers", () => {
  it("sanitizes names into safe directory segments", () => {
    expect(sanitizeName("owner/repo")).toBe("owner-repo");
    expect(sanitizeName("a b!@#z")).toBe("a-b---z");
    expect(sanitizeName("keep.dots_and-dashes")).toBe("keep.dots_and-dashes");
  });

  it("resolves clone URLs for shorthand and full URLs (token never in URL)", () => {
    expect(marketplaceCloneUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
    expect(marketplaceCloneUrl("owner/repo", "github.enterprise.local")).toBe(
      "https://github.enterprise.local/owner/repo.git",
    );
    expect(marketplaceCloneUrl("owner/repo", "https://github.enterprise.local/")).toBe(
      "https://github.enterprise.local/owner/repo.git",
    );
    expect(marketplaceCloneUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    // ssh / arbitrary sources pass through untouched.
    const ssh = "git@github.com:owner/repo.git";
    expect(marketplaceCloneUrl(ssh)).toBe(ssh);
    expect(marketplaceCloneUrl("https://example.com/x.git")).toBe("https://example.com/x.git");
  });

  it("normalizes configured GitHub hosts", () => {
    expect(normalizeGithubHost("")).toBe("github.com");
    expect(normalizeGithubHost("https://github.enterprise.local/")).toBe("github.enterprise.local");
    expect(normalizeGithubHost("github.enterprise.local:8443")).toBe("github.enterprise.local:8443");
  });

  it("supplies token auth via an http header arg, not the URL", () => {
    // No token, or non-https transport → no auth args.
    expect(gitAuthArgs("https://github.com/o/r.git")).toEqual([]);
    expect(gitAuthArgs("git@github.com:o/r.git", "tok")).toEqual([]);
    // https + token → an Authorization: Basic header git uses but never persists.
    const args = gitAuthArgs("https://github.com/o/r.git", "tok");
    const basic = Buffer.from("x-access-token:tok").toString("base64");
    expect(args).toEqual(["-c", `http.extraHeader=Authorization: Basic ${basic}`]);
  });

  it("selects internal vs external git tokens by clone URL host", () => {
    const config = { githubHost: "github.enterprise.local" };
    const tokens = { internal: "internal-token", external: "external-token" };
    expect(tokenForGitUrl("https://github.enterprise.local/o/r.git", config, tokens)).toBe("internal-token");
    expect(tokenForGitUrl("https://github.com/o/r.git", config, tokens)).toBe("external-token");
    expect(tokenForGitUrl("https://gitlab.example.com/o/r.git", config, tokens)).toBeUndefined();
    expect(tokenForGitUrl("git@github.com:o/r.git", config, tokens)).toBeUndefined();
  });

  it("strips git credentials and SESSION_SECRET from the agent subprocess env", () => {
    const env = agentSubprocessEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-test",
        SESSION_SECRET: "aes-master-key",
        GIT_TOKEN: "internal-secret",
        GITHUB_TOKEN: "external-secret",
        GH_TOKEN: "gh-secret",
        GH_ENTERPRISE_TOKEN: "ghe-secret",
        GITHUB_ENTERPRISE_TOKEN: "github-enterprise-secret",
      },
      "/tmp/agent-sessions",
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/agent-sessions");
    // SESSION_SECRET is the AES master key for every at-rest secret — it must
    // never reach the subprocess env where the agent's Bash/`env` could read it.
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.GIT_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it("only forwards SSH-specific secrets to the SSH MCP subprocess", () => {
    expect(
      sshMcpSecretEnv({
        SSH_PRIVATE_KEY: "private-key",
        ALLOWED_HOSTS: "prod",
        GIT_TOKEN: "internal-secret",
        GITHUB_TOKEN: "external-secret",
        CONFLUENCE_PAT: "pat",
        API_TOKEN: "api-secret",
      }),
    ).toEqual({
      SSH_PRIVATE_KEY: "private-key",
      ALLOWED_HOSTS: "prod",
    });
  });

  it("scrubs the auth header (token) from git error text", () => {
    const basic = Buffer.from("x-access-token:ghp_secret").toString("base64");
    const err = new Error(
      `Command failed: git -c http.extraHeader=Authorization: Basic ${basic} clone -- https://github.com/o/r.git /tmp/x`,
    );
    const scrubbed = scrubGitError(err);
    expect(scrubbed).not.toContain(basic);
    expect(scrubbed).not.toContain("ghp_secret");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("refuses to clone a repo value that git would read as an option", async () => {
    // `--upload-pack=…` would be an RCE if passed as a positional without `--`.
    await expect(
      syncGitRepo("--upload-pack=touch /tmp/pwn", path.join(tempDir, "dest-inj")),
    ).rejects.toThrow(/must not start with/);
  });

  it("reports path existence", async () => {
    expect(await pathExists(tempDir)).toBe(true);
    expect(await pathExists(path.join(tempDir, "missing"))).toBe(false);
  });

  it("clones, re-fetches, and checks out a ref", async () => {
    const src = path.join(tempDir, "src");
    const sha = gitInit(src);

    const dest = path.join(tempDir, "dest");
    await syncGitRepo(src, dest);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);

    // Second call hits the fetch (already-cloned) branch without throwing.
    await syncGitRepo(src, dest);

    // A fresh clone with an explicit ref exercises the checkout branch.
    const destRef = path.join(tempDir, "dest-ref");
    await syncGitRepo(src, destRef, sha);
    expect(fs.existsSync(path.join(destRef, "README.md"))).toBe(true);
  });

  it("removes files deleted upstream when re-syncing", async () => {
    const src = path.join(tempDir, "del-src");
    gitInit(src);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", src, ...args], { stdio: "pipe" });
    // Add a second tracked file and commit it.
    fs.writeFileSync(path.join(src, "stale.txt"), "old skill");
    git("add", "-A");
    git("commit", "-q", "-m", "add stale");

    const dest = path.join(tempDir, "del-dest");
    await syncGitRepo(src, dest);
    expect(fs.existsSync(path.join(dest, "stale.txt"))).toBe(true);

    // Delete it upstream, then re-sync — the clone must drop it too.
    git("rm", "-q", "stale.txt");
    git("commit", "-q", "-m", "remove stale");
    await syncGitRepo(src, dest);
    expect(fs.existsSync(path.join(dest, "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// plugins — cloning enabled avatar plugins, default plugin loading
// ---------------------------------------------------------------------------

describe("deriveAgentToolAccess", () => {
  // The PreToolUse hook auto-allows every mcp__* tool, so these booleans are the
  // real gate between a run and owner-only tools. Pin all four viewer classes.
  const base = {
    message: "hi",
    avatar: { id: "u1", displayName: "U", alias: "", persona: "" },
  };

  it("owner, interactive chat → owner + elevated tools, auto-approve, owner ssh class", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: true, autoApprove: true });
    expect(a.ownerToolAccess).toBe(true);
    expect(a.elevatedToolAccess).toBe(true);
    expect(a.elevated).toBe(true);
    expect(a.autoApprove).toBe(true);
    expect(a.hexSshViewerClass).toBe("owner");
  });

  it("owner, headless WITHOUT opt-in → no tool access (read-only)", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: true, headless: true });
    expect(a.ownerToolAccess).toBe(false);
    expect(a.elevatedToolAccess).toBe(false);
    expect(a.hexSshViewerClass).toBe("colleague");
  });

  it("owner, headless WITH allowHeadlessTools → full owner tools (scheduled routine)", () => {
    const a = deriveAgentToolAccess({
      ...base,
      viewerIsOwner: true,
      headless: true,
      allowHeadlessTools: true,
    });
    expect(a.ownerToolAccess).toBe(true);
    expect(a.elevatedToolAccess).toBe(true);
    expect(a.hexSshViewerClass).toBe("owner");
  });

  it("trusted (not owner), interactive → elevated tools but NOT owner tools", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: false, elevated: true });
    expect(a.ownerToolAccess).toBe(false);
    expect(a.elevatedToolAccess).toBe(true);
    expect(a.elevated).toBe(true);
    expect(a.hexSshViewerClass).toBe("trusted");
  });

  it("plain colleague → neither owner nor elevated tools", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: false });
    expect(a.ownerToolAccess).toBe(false);
    expect(a.elevatedToolAccess).toBe(false);
    expect(a.elevated).toBe(false);
    expect(a.hexSshViewerClass).toBe("colleague");
  });
});


describe("loadAvatarPluginRoots", () => {
  const plugin = (repo: string): Plugin => ({
    id: "p1",
    repo,
    ref: null,
    label: null,
    enabled: true,
    selected: null,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("clones a single-plugin repo into the avatar's data dir", async () => {
    const src = path.join(tempDir, "plugin-src");
    makePluginRepo(src);
    const { config } = createServices({ dataDir: path.join(tempDir, "data"), agentRuntime: "local", sessionSecret: "t" });

    const warns: string[] = [];
    const roots = await loadAvatarPluginRoots("user-1", [plugin(src)], config, (m) => warns.push(m));

    expect(warns).toEqual([]);
    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe("local");
    expect(fs.existsSync(path.join(roots[0].path, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("tolerates a clone failure with a warning instead of throwing", async () => {
    const { config } = createServices({ dataDir: path.join(tempDir, "data2"), agentRuntime: "local", sessionSecret: "t" });
    const warns: string[] = [];
    const missing = path.join(tempDir, "does-not-exist-repo");

    const roots = await loadAvatarPluginRoots("user-2", [plugin(missing)], config, (m) => warns.push(m));

    expect(roots).toEqual([]);
    expect(warns.some((w) => w.includes("clone failed"))).toBe(true);
  });
});


describe("loadDefaultPluginRoots", () => {
  it("returns [] when the default plugins dir is missing", async () => {
    const { config } = createServices({ dataDir: path.join(tempDir, "d"), agentRuntime: "local", sessionSecret: "t" });
    const roots = await loadDefaultPluginRoots({ ...config, defaultPluginsDir: path.join(tempDir, "nope") });
    expect(roots).toEqual([]);
  });
});


describe("loadAgentPluginRoots", () => {
  // Regression guard: the chat endpoint AND the routine scheduler both build
  // their agent plugin roots through THIS one helper, so a routine can USE the
  // same skills (the personal knowledge repo, group repos) an owner chat can.
  // Routines once loaded only default + avatar plugins and silently missed
  // knowledge-repo skills; this test is the canary if the two ever drift again.
  function setupKnowledgeRepo(dir: string) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({
      dataDir,
      agentRuntime: "claude",
      sessionSecret: "t",
      // Isolate the knowledge-repo assertion from any bundled default plugins.
      defaultPluginsDir: path.join(dataDir, "no-default-plugins"),
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    // A bare remote knowledge repo that is itself a valid plugin
    // (.claude-plugin/plugin.json) carrying one skill, pushed to `main` so
    // ensureClone has a branch to track.
    const remote = makeBareRemote(path.join(dataDir, "remote.git"));
    const seed = path.join(dataDir, "seed");
    makePluginRepo(seed, "knowledge"); // git init + commit with .claude-plugin/plugin.json
    makeSkill(seed, "daily-summary", "---\nname: daily-summary\ndescription: Summarize the day\n---");
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("add", "-A");
    g("commit", "-q", "-m", "add skill");
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    store.setKnowledgeRepo(owner.id, remote, "main");
    return { store, config, ownerId: owner.id };
  }

  it("includes the connected knowledge repo's skill root (chat/routine parity)", async () => {
    const { store, config, ownerId } = setupKnowledgeRepo("lapr-kr");
    const warns: string[] = [];
    const roots = await loadAgentPluginRoots(store, ownerId, config, (m) => warns.push(m));

    const clone = knowledgeClonePath(ownerId, config);
    expect(roots.map((r) => r.path)).toContain(clone);
    expect(fs.existsSync(path.join(clone, "skills", "daily-summary", "SKILL.md"))).toBe(true);
  });

  it("returns [] in local runtime even with a knowledge repo connected", async () => {
    const { store, config, ownerId } = setupKnowledgeRepo("lapr-local");
    const roots = await loadAgentPluginRoots(store, ownerId, { ...config, agentRuntime: "local" }, () => {});
    expect(roots).toEqual([]);
  });
});


describe("inspectRepoContents", () => {
  it("reports a single-plugin repo", async () => {
    const dir = path.join(tempDir, "single");
    makePluginRepo(dir, "solo");
    const info = await inspectRepoContents(dir);
    expect(info.kind).toBe("single");
    expect(info.plugins).toHaveLength(1);
    expect(info.plugins[0].loadable).toBe(true);
  });

  it("lists every plugin in a marketplace repo", async () => {
    const dir = path.join(tempDir, "mkt");
    makeMarketplaceRepo(dir, ["alpha", "beta"]);
    const info = await inspectRepoContents(dir);
    expect(info.kind).toBe("marketplace");
    expect(info.plugins.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(info.plugins.every((p) => p.loadable)).toBe(true);
  });

  it("returns kind 'none' for a non-plugin repo", async () => {
    const dir = path.join(tempDir, "plain");
    gitInit(dir);
    const info = await inspectRepoContents(dir);
    expect(info.kind).toBe("none");
  });
});


describe("resolvePluginRoots selection", () => {
  it("loads all marketplace plugins when selected is null", async () => {
    const dir = path.join(tempDir, "mkt-all");
    makeMarketplaceRepo(dir, ["alpha", "beta"]);
    const roots = await resolvePluginRoots(dir, "mkt", undefined, null);
    expect(roots).toHaveLength(2);
  });

  it("loads only the selected marketplace plugins", async () => {
    const dir = path.join(tempDir, "mkt-sel");
    makeMarketplaceRepo(dir, ["alpha", "beta", "gamma"]);
    const roots = await resolvePluginRoots(dir, "mkt", undefined, ["beta"]);
    expect(roots).toHaveLength(1);
    expect(roots[0].endsWith(path.join("plugins", "beta"))).toBe(true);
  });

  it("ignores selection for a single-plugin repo", async () => {
    const dir = path.join(tempDir, "single-sel");
    makePluginRepo(dir, "solo");
    const roots = await resolvePluginRoots(dir, "solo", undefined, ["nonexistent"]);
    expect(roots).toEqual([dir]);
  });
});


describe("stripManagedMcpServers", () => {
  const mcpPath = (dir: string) => path.join(dir, ".mcp.json");
  const readMcp = (dir: string) => JSON.parse(fs.readFileSync(mcpPath(dir), "utf8"));

  it("removes an app-managed server (hex-ssh) but keeps others", async () => {
    const dir = path.join(tempDir, "strip1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      mcpPath(dir),
      JSON.stringify({
        "hex-ssh": { command: "npx", args: ["-y", "@levnikolaevich/hex-ssh-mcp"] },
        other: { command: "x" },
      }),
    );
    const changed = await stripManagedMcpServers(dir);
    expect(changed).toBe(true);
    expect(readMcp(dir)).toEqual({ other: { command: "x" } });
  });

  it("is a no-op when no managed server is present", async () => {
    const dir = path.join(tempDir, "strip2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpPath(dir), JSON.stringify({ other: { command: "x" } }));
    expect(await stripManagedMcpServers(dir)).toBe(false);
    expect(readMcp(dir)).toEqual({ other: { command: "x" } });
  });

  it("is a no-op when there is no .mcp.json", async () => {
    const dir = path.join(tempDir, "strip3");
    fs.mkdirSync(dir, { recursive: true });
    expect(await stripManagedMcpServers(dir)).toBe(false);
    expect(fs.existsSync(mcpPath(dir))).toBe(false);
  });

  it("strips hex-ssh from a plugin dir when resolved via resolvePluginRoots", async () => {
    const dir = path.join(tempDir, "strip-resolve");
    makePluginRepo(dir, "ops");
    fs.writeFileSync(
      mcpPath(dir),
      JSON.stringify({ "hex-ssh": { command: "npx" }, keep: { command: "y" } }),
    );
    const roots = await resolvePluginRoots(dir, "ops");
    expect(roots).toEqual([dir]);
    expect(readMcp(dir)).toEqual({ keep: { command: "y" } });
  });

  it("hex-ssh is in the managed list (documents the collision fix)", () => {
    expect(APP_MANAGED_MCP_SERVERS).toContain("hex-ssh");
  });
});


describe("listSkillsInRoots", () => {
  it("parses name/description from SKILL.md frontmatter and tags the source", async () => {
    const root = path.join(tempDir, "skills-basic");
    makeSkill(root, "alpha", "---\nname: Alpha\ndescription: Does alpha things\n---", "# body");
    const skills = await listSkillsInRoots([{ path: root, source: "default" }]);
    expect(skills).toEqual([{ name: "Alpha", description: "Does alpha things", source: "default" }]);
  });

  it("strips surrounding quotes from frontmatter values", async () => {
    const root = path.join(tempDir, "skills-quoted");
    makeSkill(root, "q", `---\nname: "Quoted"\ndescription: 'has: a colon'\n---`);
    const skills = await listSkillsInRoots([{ path: root, source: "s" }]);
    expect(skills[0]).toMatchObject({ name: "Quoted", description: "has: a colon" });
  });

  it("falls back to the directory name when frontmatter omits name", async () => {
    const root = path.join(tempDir, "skills-noname");
    makeSkill(root, "from-dir", "---\ndescription: no name field\n---");
    const skills = await listSkillsInRoots([{ path: root, source: "s" }]);
    expect(skills[0]).toMatchObject({ name: "from-dir", description: "no name field" });
  });

  it("tolerates a missing skills/ directory and a SKILL.md without frontmatter", async () => {
    const empty = path.join(tempDir, "skills-empty");
    fs.mkdirSync(empty, { recursive: true });
    const noFm = path.join(tempDir, "skills-nofm");
    makeSkill(noFm, "plain", "# Just a heading, no frontmatter");
    const skills = await listSkillsInRoots([
      { path: empty, source: "a" },
      { path: noFm, source: "b" },
    ]);
    // The missing dir contributes nothing; the no-frontmatter skill still
    // surfaces with a dir-name fallback and empty description.
    expect(skills).toEqual([{ name: "plain", description: "", source: "b" }]);
  });

  it("de-duplicates by name (first root wins) and sorts by name", async () => {
    const rootA = path.join(tempDir, "skills-a");
    const rootB = path.join(tempDir, "skills-b");
    makeSkill(rootA, "dup", "---\nname: Dup\ndescription: from A\n---");
    makeSkill(rootB, "dup2", "---\nname: Dup\ndescription: from B\n---");
    makeSkill(rootB, "zeta", "---\nname: Zeta\ndescription: z\n---");
    const skills = await listSkillsInRoots([
      { path: rootA, source: "a" },
      { path: rootB, source: "b" },
    ]);
    expect(skills.map((s) => s.name)).toEqual(["Dup", "Zeta"]);
    expect(skills.find((s) => s.name === "Dup")?.description).toBe("from A");
  });

  it("does not end frontmatter early on a body line that merely starts with ---", async () => {
    const root = path.join(tempDir, "skills-rule");
    // A markdown horizontal rule (`---`) and a `----` line live in the body; the
    // closing fence is the standalone `---`, so name/description still parse.
    makeSkill(
      root,
      "ruled",
      "---\nname: Ruled\ndescription: has a rule below\n---",
      "intro\n\n---\n\nmore\n\n----\n",
    );
    const skills = await listSkillsInRoots([{ path: root, source: "s" }]);
    expect(skills[0]).toMatchObject({ name: "Ruled", description: "has a rule below" });
  });
});


describe("interpretResult", () => {
  it("returns the text of a successful result", () => {
    expect(interpretResult({ type: "result", subtype: "success", result: "hi" })).toEqual({
      text: "hi",
    });
  });

  it("flags an error result (no result field, e.g. max turns)", () => {
    const r = interpretResult({
      type: "result",
      subtype: "error_max_turns",
      errors: ["Reached maximum number of turns (6)"],
    });
    expect(r.errorSubtype).toBe("error_max_turns");
    expect(r.text).toBeUndefined();
  });

  it("extracts per-turn token usage (input incl. cache, output, context window)", () => {
    const r = interpretResult({
      type: "result",
      subtype: "success",
      result: "hi",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      },
      modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } },
    });
    expect(r.text).toBe("hi");
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 40, contextWindow: 200000 });
  });

  it("omits usage when the result carries no counts", () => {
    expect(interpretResult({ type: "result", subtype: "success", result: "hi" })).toEqual({ text: "hi" });
  });

  it("ignores non-result messages", () => {
    expect(interpretResult({ type: "assistant" })).toEqual({});
    expect(interpretResult(null)).toEqual({});
  });

  it("maps max-turns to a friendly Korean message, not the raw SDK string", () => {
    const msg = resultErrorMessage("error_max_turns");
    expect(msg).toContain("최대 처리 단계");
    expect(msg).not.toContain("maximum number of turns");
  });
});


describe("buildPrompt", () => {
  const avatar = (over = {}) => ({ id: "a1", displayName: "도우미", alias: "", persona: "", ...over });
  const req = (over = {}) => ({ message: "안녕", avatar: avatar(), ...over });

  it("opens with displayName when no alias is set", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain('the "도우미" avatar');
    expect(p).not.toContain("Your name is");
  });

  it("gives the avatar its alias as a self-name when set", () => {
    const p = buildPrompt(req({ avatar: avatar({ alias: "세바스찬" }) }), 0);
    expect(p).toContain('Your name is "세바스찬"');
    // displayName no longer seeds the opening line.
    expect(p).not.toContain('the "도우미" avatar');
  });

  it("treats a whitespace-only alias as unset", () => {
    const p = buildPrompt(req({ avatar: avatar({ alias: "   " }) }), 0);
    expect(p).toContain('the "도우미" avatar');
    expect(p).not.toContain("Your name is");
  });

  it("names the owner in the prompt when the viewer is the owner", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("**owner**");
    expect(p).toContain('"신진영"');
  });

  it("injects system awareness and owner system-management tool guidance", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("Noah Almighty (avatar-chat)");
    expect(p).toContain("mcp__system__describe_system");
    expect(p).toContain("mcp__system__create_routine");
    expect(p).toContain("mcp__system__add_plugin");
    expect(p).toContain("load starting from the next conversation");
  });

  it("offers to create the knowledge repo via the repo tool on a greeting when GIT_TOKEN is set", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: true,
        viewerName: "신진영",
        knowledgeRepoConfigured: false,
        gitTokenSet: true,
        greeting: true,
      }),
      0,
    );
    expect(p).toContain("no knowledge repository is connected yet");
    expect(p).toContain("mcp__repo__create_repo");
    // The pending-requests nudge composes into the same greeting line.
    expect(p).toContain("Then ask what you can help with");
  });

  it("guides the owner to set GIT_TOKEN first on a greeting when none is set", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: true,
        viewerName: "신진영",
        knowledgeRepoConfigured: false,
        gitTokenSet: false,
        greeting: true,
      }),
      0,
    );
    expect(p).toContain("`GIT_TOKEN` is not set either");
    expect(p).toContain("Git credentials");
    // Falls back to the manual marketplace-format guidance when there's no token.
    expect(p).toContain(".claude-plugin/marketplace.json");
    expect(p).toContain("skills/<name>/SKILL.md");
  });

  it("gives standing create_repo guidance mid-conversation when no repo is connected", () => {
    const mid = buildPrompt(
      req({
        viewerIsOwner: true,
        viewerName: "신진영",
        knowledgeRepoConfigured: false,
        gitTokenSet: true,
        githubHost: "github.enterprise.local",
      }),
      0,
    );
    // Standing (every owner turn, not just greeting): the avatar is told it HAS
    // create_repo and to use it directly instead of manual setup / scaffold-first.
    expect(mid).toContain("mcp__repo__create_repo");
    expect(mid).toContain("github.enterprise.local");
    expect(mid).toContain("do not walk them through manual steps");
    // The greeting-only proactive suggestion is NOT injected mid-conversation.
    expect(mid).not.toContain("no knowledge repository is connected yet");
    // The manage-capability blurb is withheld until a repo is connected.
    expect(mid).not.toContain("directly manage your own **knowledge repository**");
  });

  it("guides the owner to set GIT_TOKEN mid-conversation when none is set and no repo exists", () => {
    const mid = buildPrompt(
      req({ viewerIsOwner: true, knowledgeRepoConfigured: false, gitTokenSet: false }),
      0,
    );
    expect(mid).toContain("`GIT_TOKEN` is not set either");
    expect(mid).toContain("Git credentials");
  });

  it("shows the repo-management capability to the owner once a repo is connected", () => {
    const p = buildPrompt(
      req({ viewerIsOwner: true, viewerName: "신진영", knowledgeRepoConfigured: true }),
      0,
    );
    expect(p).toContain("directly manage your own **knowledge repository** (an owner-only personal repo)");
    expect(p).not.toContain("no knowledge repository is connected yet");
  });

  it("tells the owner general git repo push is not main-only", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("General **git repo work**");
    expect(p).toContain("`push` is not main-only");
    expect(p).toContain("set that name as `register_repo`'s `branch`");
  });

  it("tells the owner how to enable SSH tools when no SSH key is configured", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("SSH tools are still disabled");
    expect(p).toContain("SSH_PRIVATE_KEY");
    expect(p).toContain("mcp__ssh_identity__generate_key");
    expect(p).toContain("mcp__ssh_trust__add_host");
  });

  it("omits the SSH enablement guidance once an SSH key is configured", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, secretNames: ["SSH_PRIVATE_KEY"] }), 0);
    expect(p).not.toContain("SSH tools are still disabled");
    // The key name still appears in the secret-names listing, not the nudge.
    expect(p).toContain("SSH_PRIVATE_KEY");
  });

  it("does not show SSH enablement guidance to colleagues", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, viewerName: "김철수" }), 0);
    expect(p).not.toContain("SSH tools are still disabled");
  });

  it("does not show the missing knowledge repo guidance to colleagues or headless runs", () => {
    const colleague = buildPrompt(
      req({ viewerIsOwner: false, viewerName: "김철수", knowledgeRepoConfigured: false }),
      0,
    );
    expect(colleague).not.toContain("no knowledge repository is connected yet");

    const headless = buildPrompt(
      req({ viewerIsOwner: true, headless: true, knowledgeRepoConfigured: false }),
      0,
    );
    expect(headless).not.toContain("no knowledge repository is connected yet");
  });

  it("names the colleague in the prompt for a non-owner viewer", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, viewerName: "김철수" }), 0);
    expect(p).toContain("**colleague**");
    expect(p).toContain('"김철수"');
    expect(p).toContain("read-only");
  });

  it("does not mark the chat read-only for a trusted (elevated) non-owner viewer", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, elevated: true, viewerName: "김철수" }), 0);
    expect(p).toContain("**colleague**");
    expect(p).not.toContain("read-only");
    expect(p).toContain("a user the owner trusts");
    expect(p).toContain("Changing avatar system settings");
  });

  it("falls back to the unnamed wording when viewerName is absent", () => {
    const owner = buildPrompt(req({ viewerIsOwner: true }), 0);
    expect(owner).toContain("**owner**.");
    const colleague = buildPrompt(req({ viewerIsOwner: false }), 0);
    expect(colleague).toContain("**colleague**.");
  });

  it("shows configured secret names only to the owner, never values", () => {
    const owner = buildPrompt(
      req({ viewerIsOwner: true, secretNames: ["SSH_PRIVATE_KEY", "API_TOKEN"] }),
      0,
    );
    expect(owner).toContain("Secrets");
    expect(owner).toContain("SSH_PRIVATE_KEY");
    expect(owner).toContain("API_TOKEN");
    expect(owner).not.toContain("secret-value");

    const colleague = buildPrompt(
      req({ viewerIsOwner: false, elevated: true, secretNames: ["SSH_PRIVATE_KEY"] }),
      0,
    );
    expect(colleague).not.toContain("SSH_PRIVATE_KEY");

    const headless = buildPrompt(
      req({ viewerIsOwner: true, headless: true, secretNames: ["SSH_PRIVATE_KEY"] }),
      0,
    );
    expect(headless).not.toContain("SSH_PRIVATE_KEY");
  });

  it("does not append the user message on a greeting turn", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영", greeting: true }), 2);
    expect(p).not.toContain("User message:");
    // The pending-request count is surfaced in the greeting.
    expect(p).toContain("2");
  });

  it("injects restored conversation history before the current user message", () => {
    const p = buildPrompt(
      req({
        message: "방금 말한 내용을 이어서 처리해줘",
        conversationHistory: [
          { role: "user", content: "첫 요청: 배포 체크리스트를 만들어줘" },
          { role: "assistant", content: "초안 작성 중이었습니다." },
        ],
      }),
      0,
    );
    expect(p).toContain("Earlier conversation history");
    expect(p).toContain('"role": "user"');
    expect(p).toContain("첫 요청: 배포 체크리스트를 만들어줘");
    expect(p.indexOf("첫 요청: 배포 체크리스트를 만들어줘")).toBeLessThan(
      p.indexOf("User message:\n방금 말한 내용을 이어서 처리해줘"),
    );
  });

  it("gives an owner-scheduled routine its self-state and the git-MCP-only rule", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: true,
        headless: true,
        allowHeadlessTools: true,
        knowledgeRepoConfigured: true,
        secretNames: ["GIT_TOKEN", "SSH_PRIVATE_KEY"],
        groupMemberships: [
          { id: "g1", name: "플랫폼팀", role: "admin", knowledgeRepoConfigured: true },
        ],
      }),
      0,
    );
    expect(p).toContain("scheduled routine task");
    expect(p).toContain("Current self-state");
    expect(p).toContain("Personal knowledge repository: connected");
    expect(p).toContain("플랫폼팀(admin, shared repository connected)");
    expect(p).toContain("`GIT_TOKEN`");
    expect(p).toContain("mcp__system__describe_system");
    expect(p).toContain("Remote git work goes through MCP tools ONLY");
  });

  it("points a routine without a knowledge repo at create_repo instead of letting it guess", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: true,
        headless: true,
        allowHeadlessTools: true,
        knowledgeRepoConfigured: false,
        gitTokenSet: true,
      }),
      0,
    );
    expect(p).toContain("Personal knowledge repository: none");
    expect(p).toContain("mcp__repo__create_repo");
  });

  it("keeps restricted headless runs (intro/hashtag generation) free of owner self-state", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: true,
        headless: true,
        secretNames: ["GIT_TOKEN"],
        knowledgeRepoConfigured: true,
      }),
      0,
    );
    // Not falsely framed as a scheduled routine, and no owner-state leakage.
    expect(p).toContain("automated task");
    expect(p).not.toContain("scheduled routine task");
    expect(p).not.toContain("Current self-state");
    expect(p).not.toContain("GIT_TOKEN");
    expect(p).toContain("read-only");
  });

  it("injects the git-MCP-only rule for owners and trusted users but not plain colleagues", () => {
    const owner = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(owner).toContain("Remote git work goes through MCP tools ONLY");
    expect(owner).toContain("do NOT work around it or retry with Bash git");
    const trusted = buildPrompt(req({ viewerIsOwner: false, elevated: true, viewerName: "김철수" }), 0);
    expect(trusted).toContain("Remote git work goes through MCP tools ONLY");
    const colleague = buildPrompt(req({ viewerIsOwner: false, viewerName: "김철수" }), 0);
    expect(colleague).not.toContain("Remote git work goes through MCP tools ONLY");
  });

  it("explains group-sourced trust when the elevated viewer shares a group with the owner", () => {
    const p = buildPrompt(
      req({
        viewerIsOwner: false,
        elevated: true,
        viewerName: "김철수",
        trustedViaGroups: ["플랫폼팀"],
      }),
      0,
    );
    expect(p).toContain("'플랫폼팀'");
    expect(p).toContain("automatically trusted");
    // Without a shared group the original direct-trust wording is kept.
    const direct = buildPrompt(req({ viewerIsOwner: false, elevated: true, viewerName: "김철수" }), 0);
    expect(direct).toContain("a user the owner trusts");
    expect(direct).not.toContain("automatically trusted");
  });
});


describe("buildPreToolUseHook auto-approve safety contract", () => {
  const READONLY = ["Read", "Glob", "Grep"];
  const fakeRtk = () => {
    const script = path.join(tempDir, "fake-rtk.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh
if [ "$1" = "rewrite" ]; then
  shift
  case "$*" in
    "git status && git diff")
      printf '%s\\n' 'rtk git status && rtk git diff'
      exit 3
      ;;
    "npm run build")
      printf '%s\\n' 'rtk npm run build'
      exit 3
      ;;
    "rtk git status")
      printf '%s\\n' 'rtk git status'
      exit 3
      ;;
  esac
fi
exit 1
`,
    );
    fs.chmodSync(script, 0o755);
    return script;
  };

  // Invoke the hook for a non-read-only tool and return the permission decision.
  // `elevated` = owner OR trusted user (the tool-permission level).
  const decide = (
    opts: { elevated: boolean; headless: boolean; autoApprove: boolean; allowHeadlessTools?: boolean },
    events: AgentEvents = {},
  ) => {
    const hook = buildPreToolUseHook(
      events,
      opts.elevated,
      READONLY,
      opts.headless,
      opts.allowHeadlessTools === true,
      opts.autoApprove,
    );
    return hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "t1" }, "t1");
  };

  it("auto-approves a write tool for a present elevated viewer who opted in (no prompt)", async () => {
    let prompted = false;
    const out = await decide(
      { elevated: true, headless: false, autoApprove: true },
      { onPermission: async () => { prompted = true; return { behavior: "allow" }; } },
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(prompted).toBe(false); // auto-approve must short-circuit the prompt
  });

  it("rewrites supported Bash commands through rtk before allowing execution", async () => {
    const hook = buildPreToolUseHook({}, true, READONLY, false, false, true, "owner", DEFAULT_HEX_SSH_TOOL_POLICY, fakeRtk());
    const out = await hook(
      {
        tool_name: "Bash",
        tool_input: { command: "git status && git diff", description: "Inspect local changes" },
        tool_use_id: "t-rtk",
      },
      "t-rtk",
    );

    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      command: "rtk git status && rtk git diff",
      description: "Inspect local changes",
    });
  });

  it("surfaces the rewritten Bash command in the permission prompt", async () => {
    let promptedInput: Record<string, unknown> | undefined;
    const hook = buildPreToolUseHook(
      {
        onPermission: async ({ input }) => {
          promptedInput = input;
          return { behavior: "allow" };
        },
      },
      true,
      READONLY,
      false,
      false,
      false,
      "owner",
      DEFAULT_HEX_SSH_TOOL_POLICY,
      fakeRtk(),
    );
    const out = await hook(
      { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: "t-rtk-prompt" },
      "t-rtk-prompt",
    );

    expect(promptedInput?.command).toBe("rtk npm run build");
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "rtk npm run build" });
  });

  it("leaves Bash commands unchanged when rtk has no rewrite", () => {
    expect(rewriteBashCommandWithRtk("echo hi", fakeRtk())).toBeNull();
    expect(rewriteBashCommandWithRtk("rtk git status", fakeRtk())).toBeNull();
    expect(rewriteBashCommandWithRtk("git status", path.join(tempDir, "missing-rtk"))).toBeNull();
  });

  it("still prompts an elevated viewer when auto-approve is off", async () => {
    let prompted = false;
    const out = await decide(
      { elevated: true, headless: false, autoApprove: false },
      { onPermission: async () => { prompted = true; return { behavior: "deny" }; } },
    );
    expect(prompted).toBe(true);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("NEVER auto-approves a headless run, even with autoApprove=true", async () => {
    const out = await decide({ elevated: true, headless: true, autoApprove: true });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("auto-approves an elevated headless routine only when explicitly allowed", async () => {
    const out = await decide({ elevated: true, headless: true, allowHeadlessTools: true, autoApprove: true });
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("NEVER auto-approves a non-elevated colleague, even with autoApprove=true", async () => {
    const out = await decide({ elevated: false, headless: false, autoApprove: true });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("auto-allows a read-only tool regardless of autoApprove", async () => {
    const hook = buildPreToolUseHook({}, false, READONLY, false, false, false);
    const out = await hook({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "t2" }, "t2");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("filters hex-ssh MCP tools before the blanket MCP auto-allow", async () => {
    const policy = normalizeHexSshToolPolicy({
      owner: ["remote-ssh", "ssh-read-lines"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    });
    const trustedHook = buildPreToolUseHook({}, true, READONLY, false, false, true, "trusted", policy);
    const read = await trustedHook(
      { tool_name: "mcp__hex-ssh__ssh-read-lines", tool_input: { host: "prod", filePath: "/var/log/app.log" }, tool_use_id: "hex1" },
      "hex1",
    );
    const exec = await trustedHook(
      { tool_name: "mcp__hex-ssh__remote-ssh", tool_input: { host: "prod", command: "id" }, tool_use_id: "hex2" },
      "hex2",
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(exec.hookSpecificOutput.permissionDecision).toBe("deny");

    const ownerHook = buildPreToolUseHook({}, true, READONLY, false, false, true, "owner", policy);
    const ownerExec = await ownerHook(
      { tool_name: "mcp__hex-ssh__remote-ssh", tool_input: { host: "prod", command: "id" }, tool_use_id: "hex3" },
      "hex3",
    );
    expect(ownerExec.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("auto-allows TaskCreate orchestration without prompting", async () => {
    let prompted = false;
    const hook = buildPreToolUseHook(
      { onPermission: async () => { prompted = true; return { behavior: "deny" }; } },
      false,
      READONLY,
      false,
      false,
      false,
    );
    const out = await hook(
      { tool_name: "TaskCreate", tool_input: { task_subject: "검증", task_description: "테스트 실행" }, tool_use_id: "task-1" },
      "task-1",
    );

    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(prompted).toBe(false);
  });
});


describe("hex-ssh policy proxy", () => {
  it("filters tools/list and blocks disallowed tools/call", async () => {
    const upstreamPath = path.join(tempDir, "fake-hex-upstream.mjs");
    fs.writeFileSync(
      upstreamPath,
      `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "ssh-read-lines", inputSchema: { type: "object" } },
            { name: "remote-ssh", inputSchema: { type: "object" } }
          ]
        }
      }) + "\\n");
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "called " + msg.params.name }] }
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    }
  }
});
`,
    );
    const proxyPath = path.join(process.cwd(), "scripts", "hex-ssh-policy-proxy.mjs");
    const proxy = spawn(process.execPath, [proxyPath], {
      env: {
        ...process.env,
        HEX_SSH_UPSTREAM_COMMAND: `${process.execPath} ${upstreamPath}`,
        HEX_SSH_ALLOWED_TOOLS: "ssh-read-lines",
      },
    });
    try {
      const rpc = rpcClient(proxy);
      const listed = await rpc.request("tools/list", {});
      const result = listed.result as { tools: { name: string }[] };
      expect(result.tools.map((tool) => tool.name)).toEqual(["ssh-read-lines"]);

      const allowed = await rpc.request("tools/call", { name: "ssh-read-lines", arguments: {} });
      expect(JSON.stringify(allowed.result)).toContain("called ssh-read-lines");

      const blocked = await rpc.request("tools/call", { name: "remote-ssh", arguments: {} });
      expect(blocked.error).toMatchObject({
        code: -32603,
        message: "hex-ssh tool 'remote-ssh' is not allowed by policy",
      });
    } finally {
      proxy.kill();
    }
  });
});
