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

import { gitInit, makeBareRemote, callTool } from "./helpers.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// knowledgeTools — MCP handlers exercised directly
// ---------------------------------------------------------------------------


describe("knowledge tools", () => {
  function ownerCtx(avatarUserId: string): KnowledgeToolsContext {
    return { avatarUserId, viewerIsOwner: true, askerUserId: avatarUserId, askerName: "소유자" };
  }
  function visitorCtx(avatarUserId: string): KnowledgeToolsContext {
    return { avatarUserId, viewerIsOwner: false, askerUserId: "visitor", askerName: "동료B" };
  }

  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "kb"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("exposes the documented server + tool names", () => {
    expect(KNOWLEDGE_SERVER_NAME).toBe("knowledge");
    const { store, ownerId } = makeStore();
    const names = buildKnowledgeTools(store, ownerCtx(ownerId)).map((t) => t.name);
    expect(names).toEqual(["request_info", "pending_requests", "resolve_request"]);
    expect(KNOWLEDGE_TOOL_NAMES).toContain("mcp__knowledge__request_info");
  });

  it("request_info records a request attributed to the asker", async () => {
    const { store, ownerId } = makeStore();
    const tools = buildKnowledgeTools(store, visitorCtx(ownerId));

    const res = await callTool(tools, "request_info", { question: "다음 출시일은?" });
    expect(res.content[0].text).toContain("request id");

    const open = store.listKnowledgeRequests(ownerId, "open");
    expect(open).toHaveLength(1);
    expect(open[0].askerName).toBe("동료B");
  });

  it("pending_requests is owner-only and lists open requests", async () => {
    const { store, ownerId } = makeStore();

    const denied = await callTool(buildKnowledgeTools(store, visitorCtx(ownerId)), "pending_requests", {});
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("can only be used by the avatar owner");

    const ownerTools = buildKnowledgeTools(store, ownerCtx(ownerId));
    const empty = await callTool(ownerTools, "pending_requests", {});
    expect(empty.content[0].text).toContain("There are no pending information requests");

    store.addKnowledgeRequest(ownerId, { question: "비밀 질문", askerName: "동료C" });
    const listed = await callTool(ownerTools, "pending_requests", {});
    expect(listed.content[0].text).toContain("pending information request(s)");
    expect(listed.content[0].text).toContain("비밀 질문");
    expect(listed.content[0].text).toContain("동료C");
  });

  it("resolve_request is owner-only and closes an open request", async () => {
    const { store, ownerId } = makeStore();

    // Non-owner is refused.
    const denied = await callTool(buildKnowledgeTools(store, visitorCtx(ownerId)), "resolve_request", {
      request_id: "x",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("can only be used by the avatar owner");

    const ownerTools = buildKnowledgeTools(store, ownerCtx(ownerId));

    // Unknown / already-handled id → error.
    const bad = await callTool(ownerTools, "resolve_request", { request_id: "ghost" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("Could not find request id");

    // A real open request is resolved and no longer listed as open.
    const req = store.addKnowledgeRequest(ownerId, { question: "넘길 질문", askerName: "동료D" });
    const ok = await callTool(ownerTools, "resolve_request", { request_id: req.id });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("Closed the information request as resolved");
    expect(store.listKnowledgeRequests(ownerId, "open")).toHaveLength(0);
    expect(store.listKnowledgeRequests(ownerId, "resolved")).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// confluenceTools — app-managed Confluence MCP handlers
// ---------------------------------------------------------------------------

describe("confluence tools", () => {
  function makeConfig(confluenceUrl?: string): AppConfig {
    return createServices({
      dataDir: path.join(tempDir, "confluence"),
      agentRuntime: "local",
      sessionSecret: "t",
      confluenceUrl,
    }).config;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the documented server + tool names", () => {
    expect(CONFLUENCE_SERVER_NAME).toBe("confluence");
    expect(CONFLUENCE_TOOL_NAMES).toContain("mcp__confluence__search");
    const names = buildConfluenceTools({
      config: makeConfig("https://confluence.internal"),
      ownerSecrets: { CONFLUENCE_PAT: "pat" },
      elevated: false,
    }).map((t) => t.name);
    expect(names).toEqual([
      "describe_config",
      "list_spaces",
      "search",
      "get_page",
      "create_page",
      "update_page",
    ]);
  });

  it("reports missing URL/PAT without exposing secret values", async () => {
    const missingUrl = await callTool(
      buildConfluenceTools({ config: makeConfig(), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: false }),
      "search",
      { text: "auth" },
    );
    expect(missingUrl.isError).toBe(true);
    expect(missingUrl.content[0].text).toContain("CONFLUENCE_URL");

    const missingPat = await callTool(
      buildConfluenceTools({ config: makeConfig("https://confluence.internal"), ownerSecrets: {}, elevated: false }),
      "search",
      { text: "auth" },
    );
    expect(missingPat.isError).toBe(true);
    expect(missingPat.content[0].text).toContain("CONFLUENCE_PAT");
  });

  it("searches with Bearer PAT and formats page summaries", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response(
        JSON.stringify({
          size: 1,
          results: [
            {
              id: "123",
              type: "page",
              title: "API Guide",
              space: { key: "DEV" },
              version: { number: 7 },
              _links: { webui: "/pages/123" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await callTool(
      buildConfluenceTools({
        config: makeConfig("https://confluence.internal/confluence"),
        ownerSecrets: { CONFLUENCE_PAT: "super-secret-pat" },
        elevated: false,
      }),
      "search",
      { space: "DEV", text: "auth", limit: 5 },
    );

    expect(result.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/confluence/rest/api/content/search");
    expect(calls[0].url.searchParams.get("cql")).toBe('space = "DEV" AND text ~ "auth" AND type = "page"');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer super-secret-pat");
    expect(result.content[0].text).toContain("API Guide");
    expect(result.content[0].text).toContain("https://confluence.internal/confluence/pages/123");
  });

  it("blocks write tools when the viewer is not elevated", async () => {
    const result = await callTool(
      buildConfluenceTools({
        config: makeConfig("https://confluence.internal"),
        ownerSecrets: { CONFLUENCE_PAT: "pat" },
        elevated: false,
      }),
      "create_page",
      { space_key: "DEV", title: "Draft", body_storage: "<p>Hello</p>" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("avatar owner or trusted user conversations");
  });
});


describe("repo tools (knowledge-repo management)", () => {
  // A store + owner pointed at a local bare git remote, so commit/push works
  // offline. Returns the config so tools can resolve the clone path.
  function setup(dir: string) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    // A bare remote + an initial commit so `ensureClone` has a branch to track.
    const remote = makeBareRemote(path.join(tempDir, dir, "remote.git"));
    const seed = path.join(tempDir, dir, "seed");
    gitInit(seed);
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    store.setKnowledgeRepo(owner.id, remote, "main");
    store.setGitToken(owner.id, "tok"); // gate for commit; local file remote ignores it
    const owns = { id: owner.id, username: "owner", displayName: "Owner" };
    return { store, config, ownerId: owner.id, owner: owns };
  }

  function ownerTools(s: ReturnType<typeof setup>) {
    return buildRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: true,
      config: s.config,
    });
  }

  it("exposes the documented server + tool names", () => {
    expect(REPO_SERVER_NAME).toBe("repo");
    expect(REPO_TOOL_NAMES).toContain("mcp__repo__write_file");
    const s = setup("rt0");
    const names = ownerTools(s).map((t) => t.name);
    expect(names).toEqual(["list_files", "read_file", "write_file", "delete_file", "move_file", "scaffold_skill", "commit"]);
  });

  it("refuses every tool for a non-owner viewer", async () => {
    const s = setup("rt1");
    const tools = buildRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: false,
      config: s.config,
    });
    for (const name of ["list_files", "read_file", "write_file", "delete_file", "move_file", "scaffold_skill", "commit"]) {
      const res = await callTool(tools, name, { path: "x", content: "y", name: "x", message: "m", from: "x", to: "z" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("can only be used by the avatar owner");
    }
  });

  it("errors clearly when no knowledge repo is configured", async () => {
    const dataDir = path.join(tempDir, "rt2");
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "o", displayName: "O", password: "password123" });
    const tools = buildRepoTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: "o", displayName: "O" },
      viewerIsOwner: true,
      config,
    });
    const res = await callTool(tools, "list_files", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No knowledge repository is connected yet");
    // The error redirects to create_repo, not manual setup.
    expect(res.content[0].text).toContain("create_repo");
  });

  it("writes, scaffolds, lists, reads, then commits & pushes", async () => {
    const s = setup("rt3");
    const tools = ownerTools(s);

    const w = await callTool(tools, "write_file", { path: "notes/onboarding.md", content: "# 온보딩\n절차" });
    expect(w.isError).toBeFalsy();
    expect(w.content[0].text).toContain("Not committed yet");

    const sk = await callTool(tools, "scaffold_skill", { name: "Deploy Runbook", description: "배포" });
    expect(sk.content[0].text).toContain("skills/deploy-runbook/SKILL.md");

    const ls = await callTool(tools, "list_files", {});
    expect(ls.content[0].text).toContain("notes/onboarding.md");
    expect(ls.content[0].text).toContain("skills/deploy-runbook/SKILL.md");

    const rd = await callTool(tools, "read_file", { path: "notes/onboarding.md" });
    expect(rd.content[0].text).toContain("# 온보딩");

    // Rename a note via move_file (works on files).
    const mv = await callTool(tools, "move_file", { from: "notes/onboarding.md", to: "notes/setup.md" });
    expect(mv.isError).toBeFalsy();
    expect(mv.content[0].text).toContain("Moved notes/onboarding.md → notes/setup.md");
    const moved = await callTool(tools, "read_file", { path: "notes/setup.md" });
    expect(moved.content[0].text).toContain("# 온보딩");

    // move_file on a missing source surfaces the NOT_FOUND message.
    const mvMissing = await callTool(tools, "move_file", { from: "notes/onboarding.md", to: "notes/x.md" });
    expect(mvMissing.isError).toBe(true);
    expect(mvMissing.content[0].text).toContain("source path does not exist");

    // delete_file removes a whole directory recursively (the entire skill folder).
    const del = await callTool(tools, "delete_file", { path: "skills/deploy-runbook" });
    expect(del.isError).toBeFalsy();
    expect(del.content[0].text).toContain("Deleted skills/deploy-runbook");
    const lsAfter = await callTool(tools, "list_files", {});
    expect(lsAfter.content[0].text).not.toContain("skills/deploy-runbook");

    const commit = await callTool(tools, "commit", { message: "지식 추가" });
    expect(commit.isError).toBeFalsy();
    expect(commit.content[0].text).toContain("Committed and pushed the changes");

    // A second commit with no changes reports nothing to commit.
    const noop = await callTool(tools, "commit", { message: "재시도" });
    expect(noop.content[0].text).toContain("no changes to commit");

    // The push reached the remote — clone it fresh and verify the file landed.
    const verify = path.join(tempDir, "rt3", "verify");
    const { repo } = s.store.getKnowledgeRepo(s.ownerId) as { repo: string };
    execFileSync("git", ["clone", "-q", repo, verify], { stdio: "pipe" });
    expect(fs.existsSync(path.join(verify, "notes/setup.md"))).toBe(true);
    expect(fs.existsSync(path.join(verify, "notes/onboarding.md"))).toBe(false);
    expect(fs.existsSync(path.join(verify, "skills/deploy-runbook"))).toBe(false);
  });

  it("re-clones when the connected repo changes (stale origin not reused)", async () => {
    // Regression: changing the connected repo in settings left the on-disk
    // clone's `origin` pointing at the OLD repo, so `git fetch origin` kept
    // pulling it (e.g. a personal repo lingering after switching to an org one).
    const dataDir = path.join(tempDir, "rt-switch");
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "o", displayName: "O", password: "password123" });

    // Two distinct bare remotes, each with a uniquely-named file on `main`.
    const seedRemote = (name: string, file: string) => {
      const remote = makeBareRemote(path.join(dataDir, `${name}.git`));
      const seed = path.join(dataDir, `${name}-seed`);
      gitInit(seed);
      fs.writeFileSync(path.join(seed, file), "x");
      const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
      g("add", "-A");
      g("commit", "-q", "-m", "seed");
      g("branch", "-M", "main");
      g("remote", "add", "origin", remote);
      g("push", "-q", "origin", "main");
      return remote;
    };
    const remoteA = seedRemote("a", "from-a.txt");
    const remoteB = seedRemote("b", "from-b.txt");

    store.setKnowledgeRepo(owner.id, remoteA, "main");
    const clone = knowledgeClonePath(owner.id, config);
    await ensureClone(knowledgeRepoContextFor(store, owner.id, config)!);
    expect(fs.existsSync(path.join(clone, "from-a.txt"))).toBe(true);

    // Switch the connected repo; the next ensure must track B, not stale A.
    store.setKnowledgeRepo(owner.id, remoteB, "main");
    await ensureClone(knowledgeRepoContextFor(store, owner.id, config)!);
    const origin = execFileSync("git", ["-C", clone, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    expect(origin).toBe(remoteB);
    expect(fs.existsSync(path.join(clone, "from-b.txt"))).toBe(true);
    expect(fs.existsSync(path.join(clone, "from-a.txt"))).toBe(false);
  });

  it("commits knowledge-repo changes with the avatar alias by default", async () => {
    const s = setup("rt-alias");
    s.store.updateProfile(s.ownerId, { alias: "Knowledge Bot" });
    const tools = ownerTools(s);

    await callTool(tools, "write_file", { path: "notes/identity.md", content: "uses alias" });
    const commit = await callTool(tools, "commit", { message: "identity check" });
    expect(commit.isError).toBeFalsy();

    const verify = path.join(tempDir, "rt-alias", "verify");
    const { repo } = s.store.getKnowledgeRepo(s.ownerId) as { repo: string };
    execFileSync("git", ["clone", "-q", repo, verify], { stdio: "pipe" });
    const author = execFileSync("git", ["-C", verify, "log", "-1", "--format=%an"], { encoding: "utf8" }).trim();
    expect(author).toBe("Knowledge Bot");
  });

  it("never pushes the load-time hex-ssh strip back to the user's repo", async () => {
    const s = setup("rt-strip");
    const ctx = knowledgeRepoContextFor(s.store, s.ownerId, s.config)!;
    // Seed the remote with a committed .mcp.json containing the keyless hex-ssh,
    // exactly like the ops plugin ships it.
    const original = {
      "hex-ssh": { command: "npx", args: ["-y", "@levnikolaevich/hex-ssh-mcp"] },
    };
    const clone = knowledgeClonePath(s.ownerId, s.config);
    await ensureClone(ctx);
    fs.writeFileSync(path.join(clone, ".mcp.json"), JSON.stringify(original, null, 2));
    await commitAndPush(ctx, "seed mcp", { name: "Owner", email: "o@x.local" });

    // Simulate a chat turn: load-time strip removes hex-ssh from the working tree.
    await stripManagedMcpServers(clone);
    expect(JSON.parse(fs.readFileSync(path.join(clone, ".mcp.json"), "utf8"))).toEqual({});

    // The avatar then commits an unrelated edit. commitAndPush must restore
    // .mcp.json from HEAD first, so the strip is NOT pushed.
    fs.writeFileSync(path.join(clone, "note.md"), "hi");
    await commitAndPush(ctx, "add note", { name: "Owner", email: "o@x.local" });

    // Fresh clone of the remote: .mcp.json still has hex-ssh, note.md landed.
    const verify = path.join(tempDir, "rt-strip", "verify");
    execFileSync("git", ["clone", "-q", ctx.repo, verify], { stdio: "pipe" });
    expect(JSON.parse(fs.readFileSync(path.join(verify, ".mcp.json"), "utf8"))).toEqual(original);
    expect(fs.existsSync(path.join(verify, "note.md"))).toBe(true);
  });

  // ---- create_repo: a store with GIT_TOKEN but NO repo configured yet. The
  // GitHub API call is stubbed (a local git remote can't model it). -----------
  function setupNoRepo(dir: string, configOverrides: Partial<AppConfig> = {}) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({
      dataDir,
      agentRuntime: "local",
      sessionSecret: "t",
      ...configOverrides,
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, config, ownerId: owner.id, owner: { id: owner.id, username: "owner", displayName: "Owner" } };
  }
  function createTools(
    s: ReturnType<typeof setupNoRepo>,
    viewerIsOwner = true,
    opts: Parameters<typeof buildRepoTools>[2] = {},
  ) {
    return buildRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner, config: s.config },
      { allowCreate: true, ...opts },
    );
  }

  it("exposes create_repo only when allowCreate is set", () => {
    const s = setupNoRepo("rt-create-flag");
    expect(createTools(s).map((t) => t.name)).toContain("create_repo");
    const without = buildRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: true,
      config: s.config,
    }).map((t) => t.name);
    expect(without).not.toContain("create_repo");
    expect(REPO_CREATE_TOOL_NAME).toBe("mcp__repo__create_repo");
  });

  it("create_repo refuses a non-owner viewer", async () => {
    const s = setupNoRepo("rt-create-owner");
    s.store.setGitToken(s.ownerId, "tok");
    const res = await callTool(createTools(s, false), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("can only be used by the avatar owner");
  });

  it("create_repo requires a git token", async () => {
    const s = setupNoRepo("rt-create-notoken");
    const res = await callTool(createTools(s), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("internal Git token (GIT_TOKEN)");
  });

  it("create_repo rejects an invalid repo name", async () => {
    const s = setupNoRepo("rt-create-badname");
    s.store.setGitToken(s.ownerId, "tok");
    const res = await callTool(createTools(s), "create_repo", { name: "bad name!" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("letters/digits");
  });

  it("create_repo refuses when a repo is already connected", async () => {
    const s = setupNoRepo("rt-create-exists");
    s.store.setGitToken(s.ownerId, "tok");
    s.store.setKnowledgeRepo(s.ownerId, "owner/existing", "main");
    const res = await callTool(createTools(s), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("A knowledge repository is already connected");
  });

  it("create_repo creates a repo through the configured creator and connects it", async () => {
    const s = setupNoRepo("rt-create-ok");
    s.store.setGitToken(s.ownerId, "tok");
    const create = vi.fn(async () => ({
      ok: true as const,
      fullName: "owner/my-knowledge",
      defaultBranch: "main",
      isPrivate: true,
    }));

    const res = await callTool(createTools(s, true, { createRemoteRepo: create }), "create_repo", {
      name: "my-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("owner/my-knowledge");
    expect(create).toHaveBeenCalledWith("github.com", "tok", "my-knowledge", true, "", undefined, undefined);
    expect(s.store.getKnowledgeRepo(s.ownerId)).toMatchObject({ repo: "owner/my-knowledge", branch: "main" });
  });

  it("create_repo description exposes the configured GitHub host", () => {
    const s = setupNoRepo("rt-create-desc", { githubHost: "github.enterprise.local" });
    const createRepo = createTools(s).find((t) => t.name === "create_repo");
    expect(createRepo?.description).toContain("github.enterprise.local");
    expect(createRepo?.description).toContain("GH_HOST=github.enterprise.local gh repo create");
  });

  it("createRemoteRepo invokes gh with host token and CA env", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner = vi.fn(async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env });
      if (args[0] === "api") {
        return { stdout: "owner\n", stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "create") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: JSON.stringify({
          nameWithOwner: "owner/my-knowledge",
          defaultBranchRef: { name: "main" },
          isPrivate: true,
        }),
        stderr: "",
      };
    });

    const res = await createRemoteRepo(
      "https://github.enterprise.local/",
      "tok-secret",
      "my-knowledge",
      true,
      "desc",
      "/tmp/ca.pem",
      undefined,
      runner,
    );

    expect(res).toMatchObject({
      ok: true,
      fullName: "owner/my-knowledge",
      defaultBranch: "main",
      isPrivate: true,
    });
    expect(calls.map((c) => c.args)).toEqual([
      ["api", "user", "--jq", ".login"],
      ["repo", "create", "owner/my-knowledge", "--private", "--add-readme", "--description", "desc"],
      ["repo", "view", "owner/my-knowledge", "--json", "nameWithOwner,defaultBranchRef,isPrivate"],
    ]);
    for (const call of calls) {
      expect(call.env.GH_HOST).toBe("github.enterprise.local");
      expect(call.env.GH_TOKEN).toBe("tok-secret");
      expect(call.env.GH_ENTERPRISE_TOKEN).toBe("tok-secret");
      expect(call.env.SSL_CERT_FILE).toBe(path.resolve("/tmp/ca.pem"));
    }
  });

  it("createRemoteRepo connects an already-created repo on retry", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "api") {
        return { stdout: "owner\n", stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "create") {
        throw Object.assign(new Error("GraphQL: name already exists on this account"), {
          code: 1,
          stderr: "GraphQL: name already exists on this account",
        });
      }
      return {
        stdout: JSON.stringify({
          nameWithOwner: "owner/my-knowledge",
          defaultBranchRef: { name: "main" },
          isPrivate: true,
        }),
        stderr: "",
      };
    });

    const res = await createRemoteRepo("github.enterprise.local", "tok", "my-knowledge", true, "", undefined, undefined, runner);

    expect(res).toMatchObject({
      ok: true,
      fullName: "owner/my-knowledge",
      defaultBranch: "main",
      isPrivate: true,
    });
    expect(calls).toEqual([
      ["api", "user", "--jq", ".login"],
      ["repo", "create", "owner/my-knowledge", "--private", "--add-readme"],
      ["repo", "view", "owner/my-knowledge", "--json", "nameWithOwner,defaultBranchRef,isPrivate"],
    ]);
  });

  it("createRemoteRepo targets an org and skips the personal-login lookup", async () => {
    const calls: string[][] = [];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "repo" && args[1] === "create") {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: JSON.stringify({
          nameWithOwner: "acme/team-knowledge",
          defaultBranchRef: { name: "main" },
          isPrivate: true,
        }),
        stderr: "",
      };
    });

    const res = await createRemoteRepo("github.enterprise.local", "tok", "team-knowledge", true, "", undefined, "acme", runner);

    expect(res).toMatchObject({ ok: true, fullName: "acme/team-knowledge", isPrivate: true });
    // No `gh api user` call — the org IS the owner.
    expect(calls).toEqual([
      ["repo", "create", "acme/team-knowledge", "--private", "--add-readme"],
      ["repo", "view", "acme/team-knowledge", "--json", "nameWithOwner,defaultBranchRef,isPrivate"],
    ]);
  });

  it("createRemoteRepo redacts tokens from gh errors", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("failed with tok-secret"), {
        code: 1,
        stderr: "bad credentials tok-secret",
      });
    });

    const res = await createRemoteRepo("github.com", "tok-secret", "dup", true, "", undefined, undefined, runner);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.exitCode).toBe(1);
      expect(res.message).toContain("[REDACTED]");
      expect(res.message).not.toContain("tok-secret");
    }
  });

  it("create_repo surfaces a GitHub creation error and leaves the repo unconnected", async () => {
    const s = setupNoRepo("rt-create-fail");
    s.store.setGitToken(s.ownerId, "tok");
    const create = vi.fn(async () => ({
      ok: false as const,
      exitCode: 1,
      message: "name already exists on this account",
    }));

    const res = await callTool(createTools(s, true, { createRemoteRepo: create }), "create_repo", { name: "dup" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("host: github.com");
    expect(res.content[0].text).toContain("exit 1");
    expect(res.content[0].text).toContain("already exists");
    expect(s.store.getKnowledgeRepo(s.ownerId).repo).toBeNull();
  });

  it("writeRepoTemplate seeds a valid Claude marketplace + README, idempotently", async () => {
    const dir = path.join(tempDir, "rt-template");
    fs.mkdirSync(dir, { recursive: true });
    expect(await writeRepoTemplate(dir, "owner/my-knowledge")).toBe(true);
    const mp = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin/marketplace.json"), "utf8"));
    expect(mp).toMatchObject({ name: "my-knowledge", plugins: [] });
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    // No-op once a manifest exists — never clobbers an established repo.
    expect(await writeRepoTemplate(dir, "owner/my-knowledge")).toBe(false);
  });

  it("create_repo seeds the marketplace template as the repo's initial content", async () => {
    const s = setupNoRepo("rt-create-seed");
    s.store.setGitToken(s.ownerId, "tok");
    // A bare remote that already has a `main` branch — mimics GitHub auto_init.
    const remote = makeBareRemote(path.join(tempDir, "rt-create-seed", "remote.git"));
    const seed = path.join(tempDir, "rt-create-seed", "seed");
    gitInit(seed);
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    // The creator returns the local bare remote as fullName, so the post-create
    // clone → seed → push runs fully offline against it.
    const create = vi.fn(async () => ({
      ok: true as const,
      fullName: remote,
      defaultBranch: "main",
      isPrivate: true,
    }));

    const res = await callTool(createTools(s, true, { createRemoteRepo: create }), "create_repo", {
      name: "my-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("initialized it with the default template");
    // The template landed on the remote as a real commit.
    const verify = path.join(tempDir, "rt-create-seed", "verify");
    execFileSync("git", ["clone", "-q", remote, verify], { stdio: "pipe" });
    const mp = JSON.parse(fs.readFileSync(path.join(verify, ".claude-plugin/marketplace.json"), "utf8"));
    expect(mp.plugins).toEqual([]);
  });
});


describe("git repo tools (general git repository management)", () => {
  function setup(dir: string) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const remote = makeBareRemote(path.join(tempDir, dir, "remote.git"));
    const seed = path.join(tempDir, dir, "seed");
    gitInit(seed);
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    const ownerShape = { id: owner.id, username: "owner", displayName: "Owner" };
    return { store, config, ownerId: owner.id, owner: ownerShape, remote };
  }

  function tools(s: ReturnType<typeof setup>, opts: { viewerIsOwner?: boolean; elevated?: boolean } = {}) {
    return buildGitRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: opts.viewerIsOwner ?? true,
      elevated: opts.elevated ?? true,
      config: s.config,
    });
  }

  it("exposes the documented server + tool names", () => {
    expect(GIT_REPO_SERVER_NAME).toBe("git_repo");
    expect(GIT_REPO_TOOL_NAMES).toContain("mcp__git_repo__register_repo");
    expect(tools(setup("gr-names")).map((t) => t.name)).toEqual([
      "register_repo",
      "list_repos",
      "sync_repo",
      "remove_repo",
      "status",
      "list_files",
      "read_file",
      "write_file",
      "delete_file",
      "diff",
      "commit",
      "push",
    ]);
  });

  it("keeps registration/removal owner-only but allows trusted users to work registered repos", async () => {
    const s = setup("gr-auth");
    const trustedTools = tools(s, { viewerIsOwner: false, elevated: true });

    const deniedRegister = await callTool(trustedTools, "register_repo", { repo: s.remote, name: "app", branch: "main" });
    expect(deniedRegister.isError).toBe(true);
    expect(deniedRegister.content[0].text).toContain("avatar owner is taking part in");

    await callTool(tools(s), "register_repo", { repo: s.remote, name: "app", branch: "main" });
    const status = await callTool(trustedTools, "status", { name: "app" });
    expect(status.isError).toBeFalsy();
    expect(status.content[0].text).toContain("branch=main");

    const deniedRemove = await callTool(trustedTools, "remove_repo", { name: "app" });
    expect(deniedRemove.isError).toBe(true);
  });

  it("registers, edits, commits, pushes, and removes a general git repo", async () => {
    const s = setup("gr-flow");
    const ownerTools = tools(s);

    const register = await callTool(ownerTools, "register_repo", { repo: s.remote, name: "work", branch: "main" });
    expect(register.isError).toBeFalsy();
    expect(register.content[0].text).toContain("work");
    expect(s.store.listGitRepos(s.ownerId)).toHaveLength(1);

    const list = await callTool(ownerTools, "list_files", { name: "work" });
    expect(list.content[0].text).toContain("README.md");

    const write = await callTool(ownerTools, "write_file", {
      name: "work",
      path: "docs/runbook.md",
      content: "# Runbook\n",
    });
    expect(write.isError).toBeFalsy();

    const status = await callTool(ownerTools, "status", { name: "work" });
    expect(status.content[0].text).toContain("docs/runbook.md");

    const commit = await callTool(ownerTools, "commit", { name: "work", message: "add runbook" });
    expect(commit.isError).toBeFalsy();
    expect(commit.content[0].text).toContain("Committed the changes");

    const push = await callTool(ownerTools, "push", { name: "work" });
    expect(push.isError).toBeFalsy();
    expect(push.content[0].text).toContain("main");

    const verify = path.join(tempDir, "gr-flow", "verify");
    execFileSync("git", ["clone", "-q", s.remote, verify], { stdio: "pipe" });
    expect(fs.existsSync(path.join(verify, "docs/runbook.md"))).toBe(true);

    const clonePath = gitRepoClonePath(s.ownerId, "work", s.config);
    expect(fs.existsSync(clonePath)).toBe(true);
    const remove = await callTool(ownerTools, "remove_repo", { name: "work" });
    expect(remove.isError).toBeFalsy();
    expect(s.store.listGitRepos(s.ownerId)).toHaveLength(0);
    expect(fs.existsSync(clonePath)).toBe(false);
  });

  it("pushes a general git repo to the registered non-main branch", async () => {
    const s = setup("gr-feature-branch");
    const ownerTools = tools(s);
    const branch = "feature/docs";

    const seed = path.join(tempDir, "gr-feature-branch", "seed-worktree");
    execFileSync("git", ["clone", "-q", s.remote, seed], { stdio: "pipe" });
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("checkout", "-b", branch);
    g("push", "-q", "origin", branch);

    const register = await callTool(ownerTools, "register_repo", { repo: s.remote, name: "work", branch });
    expect(register.isError).toBeFalsy();

    await callTool(ownerTools, "write_file", {
      name: "work",
      path: "docs/branch.md",
      content: "# Branch\n",
    });
    const commit = await callTool(ownerTools, "commit", { name: "work", message: "add branch doc" });
    expect(commit.isError).toBeFalsy();

    const push = await callTool(ownerTools, "push", { name: "work" });
    expect(push.isError).toBeFalsy();
    expect(push.content[0].text).toContain(branch);

    const verify = path.join(tempDir, "gr-feature-branch", "verify");
    execFileSync("git", ["clone", "-q", "--branch", branch, s.remote, verify], { stdio: "pipe" });
    expect(fs.existsSync(path.join(verify, "docs/branch.md"))).toBe(true);
  });

  it("clones and syncs public-style repos without stored git tokens", async () => {
    const s = setup("gr-public-sync");
    const ownerTools = tools(s);
    const publicUrl = `file://${s.remote}`;

    const register = await callTool(ownerTools, "register_repo", { repo: publicUrl, name: "public", branch: "main" });
    expect(register.isError).toBeFalsy();

    const updater = path.join(tempDir, "gr-public-sync", "updater");
    execFileSync("git", ["clone", "-q", s.remote, updater], { stdio: "pipe" });
    fs.mkdirSync(path.join(updater, "docs"), { recursive: true });
    fs.writeFileSync(path.join(updater, "docs", "public.md"), "# Public\n");
    const g = (...a: string[]) => execFileSync("git", ["-C", updater, ...a], { stdio: "pipe" });
    g("config", "user.name", "Updater");
    g("config", "user.email", "updater@example.com");
    g("add", "docs/public.md");
    g("commit", "-q", "-m", "add public doc");
    g("push", "-q", "origin", "main");

    const sync = await callTool(ownerTools, "sync_repo", { name: "public" });
    expect(sync.isError).toBeFalsy();
    const read = await callTool(ownerTools, "read_file", { name: "public", path: "docs/public.md" });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toContain("# Public");
  });

  it("does not require tokens for public HTTPS git repo contexts", () => {
    const { store, config } = createServices({
      dataDir: path.join(tempDir, "gr-public-token-context"),
      agentRuntime: "local",
      sessionSecret: "t",
      githubHost: "github.enterprise.local",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const repos = [
      store.upsertGitRepo(owner.id, "internal-public", "https://github.enterprise.local/org/repo.git", null),
      store.upsertGitRepo(owner.id, "github-public", "https://github.com/org/repo.git", null),
      store.upsertGitRepo(owner.id, "other-public", "https://gitlab.example.com/org/repo.git", null),
    ];

    expect(repos.map((repo) => gitRepoContextFromRecord(store, repo, config).token)).toEqual([null, null, null]);
  });

  it("blocks plain colleagues from registered repo contents", async () => {
    const s = setup("gr-colleague");
    await callTool(tools(s), "register_repo", { repo: s.remote, name: "app", branch: "main" });

    const colleagueTools = tools(s, { viewerIsOwner: false, elevated: false });
    const list = await callTool(colleagueTools, "list_repos", {});
    expect(list.isError).toBe(true);
    expect(list.content[0].text).toContain("avatar owner or a trusted user");
  });

  it("rolls back a newly-registered repo when the clone fails, but keeps a prior registration", async () => {
    const s = setup("gr-rollback");
    const ownerTools = tools(s);

    // A repo that cannot be cloned (path does not exist) → the registration row is
    // rolled back rather than left dangling in list_repos.
    const bogus = path.join(tempDir, "gr-rollback", "nope.git");
    const failed = await callTool(ownerTools, "register_repo", { repo: bogus, name: "bad" });
    expect(failed.isError).toBe(true);
    expect(s.store.getGitRepo(s.ownerId, "bad")).toBeNull();
    expect(s.store.listGitRepos(s.ownerId)).toHaveLength(0);

    // A FAILED re-register of an existing repo (bad branch) must NOT delete it.
    await callTool(ownerTools, "register_repo", { repo: s.remote, name: "app", branch: "main" });
    const reReg = await callTool(ownerTools, "register_repo", { repo: s.remote, name: "app", branch: "does-not-exist" });
    expect(reReg.isError).toBe(true);
    expect(s.store.getGitRepo(s.ownerId, "app")).not.toBeNull();
  });
});


describe("system tools (avatar system management)", () => {
  function setup(dir: string) {
    const { store, config } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const baseCtx: Omit<SystemToolsContext, "viewerIsOwner"> = {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      config,
    };
    return { store, config, owner, baseCtx };
  }

  function toolsFor(s: ReturnType<typeof setup>, viewerIsOwner = true) {
    return buildSystemTools(s.store, { ...s.baseCtx, viewerIsOwner });
  }

  it("exposes the documented server + tool names", () => {
    const s = setup("st0");
    expect(SYSTEM_SERVER_NAME).toBe("system");
    expect(SYSTEM_TOOL_NAMES).toContain("mcp__system__create_routine");
    expect(SYSTEM_TOOL_NAMES).toContain("mcp__system__add_plugin");
    expect(SYSTEM_TOOL_NAMES).toContain("mcp__system__notify_user");
    expect(toolsFor(s).map((t) => t.name)).toEqual([
      "describe_system",
      "notify_user",
      "list_routines",
      "create_routine",
      "update_routine",
      "delete_routine",
      "list_plugins",
      "add_plugin",
      "set_plugin_enabled",
    ]);
  });

  it("describes public system behavior to non-owners without private state", async () => {
    const s = setup("st-public");
    s.store.setGitToken(s.owner.id, "ghp_secretvalue");
    s.store.setUserSecret(s.owner.id, "SSH_PRIVATE_KEY", "private-key");
    const res = await callTool(toolsFor(s, false), "describe_system", {});

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Noah Almighty avatar-chat system summary");
    expect(res.content[0].text).toContain("conversation partner is not the owner");
    expect(res.content[0].text).not.toContain("ghp_secretvalue");
    expect(res.content[0].text).not.toContain("SSH_PRIVATE_KEY");
  });

  it("lets the owner inspect current system state", async () => {
    const s = setup("st-describe");
    s.store.setKnowledgeRepo(s.owner.id, "owner/knowledge", "main");
    s.store.setGitToken(s.owner.id, "ghp_secretvalue");
    s.store.setUserSecret(s.owner.id, "SSH_PRIVATE_KEY", "private-key");
    s.store.addPlugin(s.owner.id, { repo: "owner/plugin" });
    s.store.createRoutineJob(s.owner.id, { prompt: "매일 요약", minuteOfDay: 9 * 60 });

    const res = await callTool(toolsFor(s), "describe_system", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("runtime: local");
    expect(res.content[0].text).toContain("owner/knowledge @ main");
    expect(res.content[0].text).toContain("Internal Git token (GIT_TOKEN): set");
    expect(res.content[0].text).toContain("SSH_PRIVATE_KEY");
    expect(res.content[0].text).toContain("Plugins: 1");
    expect(res.content[0].text).toContain("Routines: 1");
    expect(res.content[0].text).not.toContain("ghp_secretvalue");
    expect(res.content[0].text).not.toContain("private-key");
    // SSH key present → the dedicated status line reports SSH tools as active.
    expect(res.content[0].text).toContain("Remote SSH tools: enabled");
  });

  it("reports the effective model, groups, profile visibility and pending requests", async () => {
    const s = setup("st-describe-full");
    // No env model pin in tests → the admin override is the effective model.
    s.store.setModelOverride("claude-test-model");
    const group = s.store.createGroup({ name: "플랫폼팀" });
    s.store.addGroupMember(group.id, s.owner.id, "admin");
    s.store.addKnowledgeRequest(s.owner.id, { question: "다음 출시일은?", askerName: "동료" });

    const res = await callTool(toolsFor(s), "describe_system", {});
    expect(res.isError).toBeFalsy();
    const body = res.content[0].text;
    expect(body).toContain("claude-test-model (admin setting)");
    expect(body).toContain("플랫폼팀(admin, shared repository none)");
    // New avatars default to group visibility.
    expect(body).toContain("group (discoverable by group teammates only)");
    expect(body).toContain("Remote SSH tools: disabled");
    expect(body).toContain("Pending information requests: 1");
  });

  it("refuses routine and plugin mutations for non-owner viewers", async () => {
    const s = setup("st-deny");
    const nonOwner = toolsFor(s, false);
    const routine = await callTool(nonOwner, "create_routine", { prompt: "p", time: "09:00" });
    const plugin = await callTool(nonOwner, "add_plugin", { repo: "owner/repo" });
    const notification = await callTool(nonOwner, "notify_user", { message: "확인 필요" });

    expect(routine.isError).toBe(true);
    expect(routine.content[0].text).toContain("avatar owner is participating in");
    expect(plugin.isError).toBe(true);
    expect(plugin.content[0].text).toContain("avatar owner is participating in");
    expect(notification.isError).toBe(true);
    expect(notification.content[0].text).toContain("avatar owner is participating in");
    expect(s.store.listRoutineJobs(s.owner.id)).toHaveLength(0);
    expect(s.store.listPlugins(s.owner.id)).toHaveLength(0);
  });

  it("lets the owner send an in-app notification", async () => {
    const s = setup("st-notify");
    const tools = toolsFor(s);

    const sent = await callTool(tools, "notify_user", {
      title: "점검 필요",
      message: "배치 서버 상태를 확인하세요.",
    });
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0].text).toContain("점검 필요");

    const notifications = s.store.listAvatarNotifications(s.owner.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "점검 필요",
      message: "배치 서버 상태를 확인하세요.",
      readAt: null,
    });
  });

  it("creates, updates, lists, and deletes owner routines", async () => {
    const s = setup("st-routine");
    const tools = toolsFor(s);

    const bad = await callTool(tools, "create_routine", { prompt: "p", time: "25:00" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("HH:MM");

    const created = await callTool(tools, "create_routine", {
      prompt: "오늘 해야 할 일을 정리해줘",
      time: "09:30",
    });
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toContain("schedule=daily at 09:30 KST");

    const job = s.store.listRoutineJobs(s.owner.id)[0];
    expect(job.prompt).toBe("오늘 해야 할 일을 정리해줘");

    const updated = await callTool(tools, "update_routine", {
      id: job.id,
      prompt: "오늘 일정과 미해결 작업을 정리해줘",
      time: "10:15",
      enabled: false,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.content[0].text).toContain("schedule=daily at 10:15 KST");
    expect(updated.content[0].text).toContain("enabled=false");

    const listed = await callTool(tools, "list_routines", {});
    expect(listed.content[0].text).toContain(job.id);
    expect(listed.content[0].text).toContain("오늘 일정");

    const deleted = await callTool(tools, "delete_routine", { id: job.id });
    expect(deleted.isError).toBeFalsy();
    expect(s.store.listRoutineJobs(s.owner.id)).toHaveLength(0);
  });

  it("creates weekly and interval routines and names them", async () => {
    const s = setup("st-routine-flex");
    const tools = toolsFor(s);

    const weekly = await callTool(tools, "create_routine", {
      name: "주간 리뷰",
      prompt: "주간 회고를 정리해줘",
      scheduleKind: "weekly",
      time: "09:00",
      daysOfWeek: [1, 3, 5],
    });
    expect(weekly.isError).toBeFalsy();
    expect(weekly.content[0].text).toContain('name="주간 리뷰"');
    expect(weekly.content[0].text).toContain("schedule=weekly on Mon,Wed,Fri at 09:00 KST");

    const interval = await callTool(tools, "create_routine", {
      prompt: "30분마다 점검",
      scheduleKind: "interval",
      intervalMinutes: 30,
    });
    expect(interval.isError).toBeFalsy();
    expect(interval.content[0].text).toContain("name=(unnamed)");
    expect(interval.content[0].text).toContain("schedule=every 30m");

    const hourly = await callTool(tools, "create_routine", {
      prompt: "매시간 점검",
      scheduleKind: "interval",
      intervalMinutes: 120,
    });
    expect(hourly.isError).toBeFalsy();
    expect(hourly.content[0].text).toContain("schedule=every 2h");

    const stored = s.store.listRoutineJobs(s.owner.id);
    const weeklyJob = stored.find((j) => j.name === "주간 리뷰");
    expect(weeklyJob?.scheduleKind).toBe("weekly");
    expect(weeklyJob?.daysOfWeek).toEqual([1, 3, 5]);
    const intervalJob = stored.find((j) => j.prompt === "30분마다 점검");
    expect(intervalJob?.scheduleKind).toBe("interval");
    expect(intervalJob?.intervalMinutes).toBe(30);
  });

  it("rejects a weekly routine without weekdays with the English error", async () => {
    const s = setup("st-routine-noweekday");
    const tools = toolsFor(s);
    const res = await callTool(tools, "create_routine", {
      prompt: "p",
      scheduleKind: "weekly",
      time: "09:00",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "weekly schedules require at least one weekday in daysOfWeek.",
    );
    expect(s.store.listRoutineJobs(s.owner.id)).toHaveLength(0);
  });

  it("describes routines as daily/weekly/interval, not daily-only", async () => {
    const s = setup("st-routine-describe");
    const res = await callTool(toolsFor(s), "describe_system", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("daily, weekly, or interval schedule in KST");
    expect(res.content[0].text).not.toContain("once a day");
  });

  it("adds and toggles owner plugins", async () => {
    const s = setup("st-plugin");
    const tools = toolsFor(s);

    const bad = await callTool(tools, "add_plugin", { repo: "not a repo!!" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("owner/repo");

    const added = await callTool(tools, "add_plugin", {
      repo: "owner/plugin",
      ref: "main",
      label: "Ops Plugin",
    });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain("starting from the next conversation");

    const plugin = s.store.listPlugins(s.owner.id)[0];
    expect(plugin.repo).toBe("owner/plugin");
    expect(plugin.enabled).toBe(true);

    const listed = await callTool(tools, "list_plugins", {});
    expect(listed.content[0].text).toContain("owner/plugin");
    expect(listed.content[0].text).toContain("Ops Plugin");

    const disabled = await callTool(tools, "set_plugin_enabled", { id: plugin.id, enabled: false });
    expect(disabled.isError).toBeFalsy();
    expect(disabled.content[0].text).toContain("enabled=false");
    expect(s.store.getPlugin(s.owner.id, plugin.id)?.enabled).toBe(false);
  });
});


describe("avatar directory tools (cross-avatar search)", () => {
  function setup() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "dir"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const me = store.createUser({ username: "me", displayName: "나", password: "password123" });
    const k8s = store.createUser({ username: "kuber", displayName: "쿠버박사", password: "password123" });
    // Public so `me` (sharing no group) can discover it cross-avatar.
    store.updateProfile(k8s.id, { hashtags: ["쿠버네티스", "데브옵스"], bio: "클러스터 운영", visibility: "public" });
    return { store, meId: me.id };
  }

  it("exposes the documented server + tool names", () => {
    expect(AVATAR_DIRECTORY_SERVER_NAME).toBe("avatars");
    expect(AVATAR_DIRECTORY_TOOL_NAMES).toContain("mcp__avatars__search_avatars");
    const { store, meId } = setup();
    const names = buildAvatarDirectoryTools(store, { avatarUserId: meId, viewerUserId: meId }).map((t) => t.name);
    expect(names).toEqual(["search_avatars"]);
  });

  it("finds a teammate avatar by capability and excludes the current avatar", async () => {
    const { store, meId } = setup();
    const tools = buildAvatarDirectoryTools(store, { avatarUserId: meId, viewerUserId: meId });
    const res = await callTool(tools, "search_avatars", { query: "쿠버네티스" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("@kuber");
    expect(res.content[0].text).toContain("#쿠버네티스");
    expect(res.content[0].text).not.toContain("@me");
  });

  it("reports when nothing matches", async () => {
    const { store, meId } = setup();
    const tools = buildAvatarDirectoryTools(store, { avatarUserId: meId, viewerUserId: meId });
    const res = await callTool(tools, "search_avatars", { query: "존재하지않는역량xyz" });
    expect(res.content[0].text).toContain("Could not find any visible avatar matching");
  });
});


describe("group repo tools (mcp__group_repo__*)", () => {
  function setup(dir: string, opts: { role?: "admin" | "member" } = {}) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.setGitToken(owner.id, "tkn"); // satisfies the commit token guard; ignored for file remotes
    const group = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(group.id, owner.id, opts.role ?? "admin");
    const remote = makeBareRemote(path.join(tempDir, dir, "remote.git"));
    const seed = path.join(tempDir, dir, "seed");
    gitInit(seed);
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    store.setGroupKnowledgeRepo(group.id, remote, "main");
    return {
      store,
      config,
      ownerId: owner.id,
      owner: { id: owner.id, username: "owner", displayName: "Owner" },
      group,
      remote,
    };
  }

  function tools(s: ReturnType<typeof setup>, opts: { viewerIsOwner?: boolean } = {}) {
    return buildGroupRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: opts.viewerIsOwner ?? true,
      config: s.config,
    });
  }

  it("exposes the documented server + tool names", () => {
    expect(GROUP_REPO_SERVER_NAME).toBe("group_repo");
    expect(GROUP_REPO_TOOL_NAMES).toContain("mcp__group_repo__write_file");
    expect(tools(setup("gp-names")).map((t) => t.name)).toEqual([
      "list_groups",
      "list_files",
      "read_file",
      "write_file",
      "delete_file",
      "move_file",
      "scaffold_skill",
      "commit",
      "create_repo",
    ]);
  });

  it("is owner-only (a non-owner viewer is refused)", async () => {
    const s = setup("gp-owner");
    const res = await callTool(tools(s, { viewerIsOwner: false }), "list_groups", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("can only be used by the avatar owner");
  });

  it("lets a group admin write + commit; a member can read but not write", async () => {
    const s = setup("gp-admin");
    const w = await callTool(tools(s), "write_file", { group: "Team", path: "docs/note.md", content: "hi" });
    expect(w.isError).toBeFalsy();
    const c = await callTool(tools(s), "commit", { group: "Team", message: "add note" });
    expect(c.isError).toBeFalsy();
    expect(c.content[0].text).toContain("Committed and pushed the changes");
    const r = await callTool(tools(s), "read_file", { group: "Team", path: "docs/note.md" });
    expect(r.content[0].text).toBe("hi");

    // An admin can rename and delete.
    const mv = await callTool(tools(s), "move_file", { group: "Team", from: "docs/note.md", to: "docs/renamed.md" });
    expect(mv.isError).toBeFalsy();
    expect(mv.content[0].text).toContain("Moved docs/note.md → docs/renamed.md");
    const del = await callTool(tools(s), "delete_file", { group: "Team", path: "docs/renamed.md" });
    expect(del.isError).toBeFalsy();
    expect(del.content[0].text).toContain("Deleted docs/renamed.md");
    const lsAfter = await callTool(tools(s), "list_files", { group: "Team" });
    expect(lsAfter.content[0].text).not.toContain("docs/renamed.md");

    const sm = setup("gp-member", { role: "member" });
    const list = await callTool(tools(sm), "list_files", { group: "Team" });
    expect(list.isError).toBeFalsy();
    const denied = await callTool(tools(sm), "write_file", { group: "Team", path: "x.md", content: "no" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("Only a group admin can modify");
    const deniedDel = await callTool(tools(sm), "delete_file", { group: "Team", path: "docs/note.md" });
    expect(deniedDel.isError).toBe(true);
    expect(deniedDel.content[0].text).toContain("Only a group admin can modify");
    const deniedMv = await callTool(tools(sm), "move_file", { group: "Team", from: "docs/note.md", to: "docs/y.md" });
    expect(deniedMv.isError).toBe(true);
    expect(deniedMv.content[0].text).toContain("Only a group admin can modify");
  });

  it("rejects an unknown group", async () => {
    const s = setup("gp-unknown");
    const res = await callTool(tools(s), "list_files", { group: "Nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Could not find a group with that name/ID");
  });
});
