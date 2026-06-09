import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import {
  buildKnowledgeTools,
  KNOWLEDGE_SERVER_NAME,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolsContext,
} from "../src/server/agent/knowledgeTools.js";
import {
  marketplaceCloneUrl,
  pathExists,
  sanitizeName,
  syncGitRepo,
} from "../src/server/marketplace.js";
import { loadAvatarPluginRoots, loadDefaultPluginRoots } from "../src/server/plugins.js";
import {
  awaitResponse,
  CANCELLED,
  closeRun,
  openRun,
  submitResponse,
} from "../src/server/agent/runRegistry.js";
import type { Plugin } from "../src/server/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Initialise a local git repo at `dir` with a single committed file and return its HEAD sha. */
function gitInit(dir: string, seedFile = "README.md"): string {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, seedFile), "hello");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return git("rev-parse", "HEAD");
}

/** Turn `dir` into a valid single-plugin repo (`.claude-plugin/plugin.json`). */
function makePluginRepo(dir: string, name = "p"): string {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return gitInit(dir, ".claude-plugin/plugin.json");
}

// ---------------------------------------------------------------------------
// runRegistry — in-memory parking of interactive-tool responses
// ---------------------------------------------------------------------------

describe("runRegistry", () => {
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

  it("resolves clone URLs for shorthand, tokens, and full URLs", () => {
    expect(marketplaceCloneUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
    expect(marketplaceCloneUrl("owner/repo", "tok en")).toBe(
      "https://x-access-token:tok%20en@github.com/owner/repo.git",
    );
    expect(marketplaceCloneUrl("https://github.com/owner/repo.git", "tk")).toBe(
      "https://x-access-token:tk@github.com/owner/repo.git",
    );
    // ssh / arbitrary sources pass through untouched.
    const ssh = "git@github.com:owner/repo.git";
    expect(marketplaceCloneUrl(ssh)).toBe(ssh);
    expect(marketplaceCloneUrl("https://example.com/x.git")).toBe("https://example.com/x.git");
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
});

// ---------------------------------------------------------------------------
// plugins — cloning enabled avatar plugins, default plugin loading
// ---------------------------------------------------------------------------

describe("loadAvatarPluginRoots", () => {
  const plugin = (repo: string): Plugin => ({
    id: "p1",
    repo,
    ref: null,
    label: null,
    enabled: true,
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

// ---------------------------------------------------------------------------
// knowledgeTools — MCP handlers exercised directly
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

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

  function call(tools: ReturnType<typeof buildKnowledgeTools>, name: string, args: unknown): Promise<ToolResult> {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
  }

  it("exposes the documented server + tool names", () => {
    expect(KNOWLEDGE_SERVER_NAME).toBe("knowledge");
    const { store, ownerId } = makeStore();
    const names = buildKnowledgeTools(store, ownerCtx(ownerId)).map((t) => t.name);
    expect(names).toEqual(["recall_knowledge", "request_info", "pending_requests", "save_knowledge"]);
    expect(KNOWLEDGE_TOOL_NAMES).toContain("mcp__knowledge__recall_knowledge");
  });

  it("recall_knowledge returns a miss then a hit", async () => {
    const { store, ownerId } = makeStore();
    const tools = buildKnowledgeTools(store, visitorCtx(ownerId));

    const miss = await call(tools, "recall_knowledge", { query: "출시" });
    expect(miss.content[0].text).toContain("관련된 저장 지식이 없습니다");

    store.addKnowledgeEntry(ownerId, { topic: "출시", content: "6월 20일에 출시합니다." });
    const hit = await call(tools, "recall_knowledge", { query: "출시" });
    expect(hit.content[0].text).toContain("저장된 지식 1건");
    expect(hit.content[0].text).toContain("[출시]");
    expect(hit.content[0].text).toContain("6월 20일");
  });

  it("request_info records a request attributed to the asker", async () => {
    const { store, ownerId } = makeStore();
    const tools = buildKnowledgeTools(store, visitorCtx(ownerId));

    const res = await call(tools, "request_info", { question: "다음 출시일은?" });
    expect(res.content[0].text).toContain("요청 id");

    const open = store.listKnowledgeRequests(ownerId, "open");
    expect(open).toHaveLength(1);
    expect(open[0].askerName).toBe("동료B");
  });

  it("pending_requests is owner-only and lists open requests", async () => {
    const { store, ownerId } = makeStore();

    const denied = await call(buildKnowledgeTools(store, visitorCtx(ownerId)), "pending_requests", {});
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("아바타 소유자만");

    const ownerTools = buildKnowledgeTools(store, ownerCtx(ownerId));
    const empty = await call(ownerTools, "pending_requests", {});
    expect(empty.content[0].text).toContain("대기 중인 정보 요청이 없습니다");

    store.addKnowledgeRequest(ownerId, { question: "비밀 질문", askerName: "동료C" });
    const listed = await call(ownerTools, "pending_requests", {});
    expect(listed.content[0].text).toContain("대기 중인 정보 요청 1건");
    expect(listed.content[0].text).toContain("비밀 질문");
    expect(listed.content[0].text).toContain("동료C");
  });

  it("save_knowledge enforces ownership and handles each save path", async () => {
    const { store, ownerId } = makeStore();

    // Non-owner is refused.
    const denied = await call(buildKnowledgeTools(store, visitorCtx(ownerId)), "save_knowledge", {
      answer: "x",
    });
    expect(denied.isError).toBe(true);

    const tools = buildKnowledgeTools(store, ownerCtx(ownerId));

    // Unknown request id → error.
    const bad = await call(tools, "save_knowledge", { answer: "a", request_id: "ghost" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("찾을 수 없습니다");

    // Answering a real request resolves it and stores knowledge.
    const req = store.addKnowledgeRequest(ownerId, { question: "출시일?" });
    const resolved = await call(tools, "save_knowledge", { answer: "6월 20일", request_id: req.id });
    expect(resolved.isError).toBeFalsy();
    expect(resolved.content[0].text).toContain("출시일?");
    expect(store.listKnowledgeRequests(ownerId, "open")).toHaveLength(0);

    // Free-form save with a topic.
    const withTopic = await call(tools, "save_knowledge", { answer: "오전 선호", question: "회의" });
    expect(withTopic.content[0].text).toContain("주제: 회의");

    // Free-form save without a topic.
    const noTopic = await call(tools, "save_knowledge", { answer: "그냥 메모" });
    expect(noTopic.content[0].text).toContain("저장했습니다");
    expect(noTopic.content[0].text).not.toContain("주제:");

    // All three saves are searchable.
    expect(store.searchKnowledge(ownerId, "20일").length).toBeGreaterThan(0);
  });
});
