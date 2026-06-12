import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { createServices } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { applyCustomGithubCa } from "../src/server/tlsCa.js";
import { loadDotEnv } from "../src/server/loadEnv.js";
import {
  buildKnowledgeTools,
  KNOWLEDGE_SERVER_NAME,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolsContext,
} from "../src/server/agent/knowledgeTools.js";
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
  APP_MANAGED_MCP_SERVERS,
  inspectRepoContents,
  listSkillsInRoots,
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
import { buildPreToolUseHook, buildPrompt, interpretResult, resultErrorMessage } from "../src/server/agent/claudeAgent.js";
import { executeRoutineJob } from "../src/server/scheduler.js";
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

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function rpcClient(proc: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : null;
      if (id !== null) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    }
  });
  return {
    request(method: string, params?: Record<string, unknown>) {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }, 1000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
  };
}

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

/**
 * Build a marketplace repo at `dir` listing `names` as relative `./plugins/<n>`
 * sources, each a valid single-plugin dir.
 */
function makeMarketplaceRepo(dir: string, names: string[]): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  const plugins = names.map((n) => ({ name: n, source: `./plugins/${n}` }));
  fs.writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins }));
  for (const n of names) {
    const pdir = path.join(dir, "plugins", n, ".claude-plugin");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "plugin.json"), JSON.stringify({ name: n }));
  }
}

/** Write a `skills/<name>/SKILL.md` with the given frontmatter under `root`. */
function makeSkill(root: string, name: string, frontmatter: string, body = ""): void {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n${body}`);
}

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

describe("sshTrust", () => {
  // A real ed25519 public key blob (base64), so the fingerprint is deterministic.
  const KEY =
    "AAAAC3NzaC1lZDI1NTE5AAAAIE3Q5Z7dQ2bqf3pVnE0Yk1m2sJ8t4hX9aBcDeFgHiJk";
  const line = (host: string, key = KEY) => `${host} ssh-ed25519 ${key}`;

  function makeStore() {
    const { store, config } = createServices({
      dataDir: path.join(tempDir, "ssht"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "o", displayName: "O", password: "password123" });
    return { config, ownerId: owner.id };
  }

  it("derives a per-user known_hosts path under the data volume", () => {
    const { config, ownerId } = makeStore();
    const p = knownHostsPath(ownerId, config);
    expect(p.startsWith(path.join(config.dataDir, "ssh"))).toBe(true);
    expect(p.endsWith("known_hosts")).toBe(true);
  });

  it("parses known_hosts into host/type/fingerprint and computes SHA256: form", () => {
    const entries = parseKnownHosts(`# comment\n${line("1.2.3.4")}\n\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].host).toBe("1.2.3.4");
    expect(entries[0].keyType).toBe("ssh-ed25519");
    expect(entries[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(entries[0].fingerprint).not.toMatch(/=$/); // unpadded
  });

  it("expands comma-separated host fields and skips @markers/short lines", () => {
    const entries = parseKnownHosts(
      `${line("a,b")}\n@revoked ${line("c").replace("c ", "")}\nbroken line\n`,
    );
    const hosts = entries.map((e) => e.host).sort();
    expect(hosts).toContain("a");
    expect(hosts).toContain("b");
  });

  it("upsertHostLine appends a new host and reports changed", () => {
    const r = upsertHostLine("", line("1.1.1.1"));
    expect(r.changed).toBe(true);
    expect(r.body.trim()).toBe(line("1.1.1.1"));
  });

  it("upsertHostLine is idempotent for an identical line", () => {
    const r = upsertHostLine(`${line("1.1.1.1")}\n`, line("1.1.1.1"));
    expect(r.changed).toBe(false);
    expect(r.body.trim()).toBe(line("1.1.1.1"));
  });

  it("upsertHostLine replaces a rotated key for the same host+type", () => {
    const r = upsertHostLine(`${line("1.1.1.1", "OLDKEY")}\n`, line("1.1.1.1", "NEWKEY"));
    expect(r.changed).toBe(true);
    expect(r.body).toContain("NEWKEY");
    expect(r.body).not.toContain("OLDKEY");
  });

  it("lists and removes hosts from the on-disk file", async () => {
    const { config, ownerId } = makeStore();
    const file = knownHostsPath(ownerId, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line("9.9.9.9")}\n${line("8.8.8.8")}\n`);

    const before = await listTrustedHosts(ownerId, config);
    expect(before.map((e) => e.host).sort()).toEqual(["8.8.8.8", "9.9.9.9"]);

    const removed = await removeTrustedHost(ownerId, config, "9.9.9.9");
    expect(removed).toBe(1);
    const after = await listTrustedHosts(ownerId, config);
    expect(after.map((e) => e.host)).toEqual(["8.8.8.8"]);
  });

  it("listTrustedHosts is empty when no file exists", async () => {
    const { config, ownerId } = makeStore();
    expect(await listTrustedHosts(ownerId, config)).toEqual([]);
  });

  it("trust tools: list reports empty, then reflects the file", async () => {
    const { config, ownerId } = makeStore();
    const tools = buildSshTrustTools({ avatarUserId: ownerId, config });
    const callTool = (name: string, args: unknown) => {
      const t = tools.find((x) => x.name === name)!;
      return (t.handler as (a: unknown, e: unknown) => Promise<ToolResult>)(args, {});
    };

    expect(SSH_TRUST_SERVER_NAME).toBe("ssh_trust");
    expect(SSH_TRUST_TOOL_NAMES).toContain("mcp__ssh_trust__add_host");

    const empty = await callTool("list_hosts", {});
    expect(empty.content[0].text).toContain("신뢰하는 호스트가 없습니다");

    const file = knownHostsPath(ownerId, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line("5.5.5.5")}\n`);
    const listed = await callTool("list_hosts", {});
    expect(listed.content[0].text).toContain("5.5.5.5");

    const gone = await callTool("remove_host", { host: "5.5.5.5" });
    expect(gone.content[0].text).toContain("제거했습니다");
  });
});

describe("ssh identity", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "ssh-identity"),
      agentRuntime: "local",
      sessionSecret: "shh",
    });
    const owner = store.createUser({ username: "sshowner", displayName: "Owner", password: "password123" });
    return { store, owner };
  }

  function call(tools: ReturnType<typeof buildSshIdentityTools>, name: string, args: unknown): Promise<ToolResult> {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
  }

  it("generates OpenSSH private key material and a reusable public key", async () => {
    const pair = await generateSshKeyPair("avatar-chat-test");
    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ avatar-chat-test$/);
    expect(pair.fingerprint).toMatch(/^SHA256:/);
  });

  it("tools generate a key, store only the public half on the user, and refuse overwrite", async () => {
    const { store, owner } = makeStore();
    const tools = buildSshIdentityTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      viewerIsOwner: true,
    });

    expect(SSH_IDENTITY_SERVER_NAME).toBe("ssh_identity");
    expect(SSH_IDENTITY_TOOL_NAMES).toContain("mcp__ssh_identity__generate_key");

    const generated = await call(tools, "generate_key", { comment: "avatar-chat-owner" });
    expect(generated.isError).toBeFalsy();
    expect(generated.content[0].text).toContain("공개키:");
    expect(generated.content[0].text).not.toContain("BEGIN OPENSSH PRIVATE KEY");

    const user = store.getUserById(owner.id)!;
    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(store.getUserSecrets(owner.id).SSH_PRIVATE_KEY).toContain("BEGIN OPENSSH PRIVATE KEY");

    const shown = await call(tools, "show_public_key", {});
    expect(shown.content[0].text).toContain(user.sshPublicKey!);

    const second = await call(tools, "generate_key", { comment: "again" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("이미 SSH 키가 설정");
  });

  it("refuses key management to non-owner viewers", async () => {
    const { store, owner } = makeStore();
    const tools = buildSshIdentityTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      viewerIsOwner: false,
    });

    const res = await call(tools, "generate_key", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("소유자");
    expect(store.listUserSecretNames(owner.id)).toEqual([]);
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

describe("store plugin persistence", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "plg"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("defaults selected to null and lastSyncedAt to null on add", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    expect(p.selected).toBeNull();
    expect(p.lastSyncedAt).toBeNull();
  });

  it("round-trips a selection and clears it with null", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    const sel = store.setPluginSelected(ownerId, p.id, ["alpha", "beta"]);
    expect(sel?.selected).toEqual(["alpha", "beta"]);
    expect(store.getPlugin(ownerId, p.id)?.selected).toEqual(["alpha", "beta"]);
    const cleared = store.setPluginSelected(ownerId, p.id, null);
    expect(cleared?.selected).toBeNull();
  });

  it("updates the tracked ref and stamps sync time", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    expect(store.setPluginRef(ownerId, p.id, "v2")?.ref).toBe("v2");
    const synced = store.markPluginSynced(ownerId, p.id);
    expect(synced?.lastSyncedAt).toBeTruthy();
  });
});

describe("store user secrets", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "secrets"),
      agentRuntime: "local",
      sessionSecret: "shh",
    });
    const owner = store.createUser({ username: "secowner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("round-trips an encrypted secret value", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    expect(store.getUserSecrets(ownerId)).toEqual({
      SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
    });
  });

  it("upserts (overwrites) an existing name and lists names sorted", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    store.setUserSecret(ownerId, "ALLOWED_HOSTS", "host1");
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v2");
    expect(store.listUserSecretNames(ownerId)).toEqual(["ALLOWED_HOSTS", "SSH_PRIVATE_KEY"]);
    expect(store.getUserSecrets(ownerId).SSH_PRIVATE_KEY).toBe("v2");
  });

  it("deletes a secret", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    store.deleteUserSecret(ownerId, "SSH_PRIVATE_KEY");
    expect(store.listUserSecretNames(ownerId)).toEqual([]);
    expect(store.getUserSecrets(ownerId)).toEqual({});
  });

  it("exposes only names via toUser (getUserById), never values", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "topsecret");
    const user = store.getUserById(ownerId)!;
    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toBeNull();
    expect(JSON.stringify(user)).not.toContain("topsecret");
  });

  it("stores generated SSH public key while keeping private key secret", () => {
    const { store, ownerId } = makeStore();
    const user = store.setSshKeyPair(
      ownerId,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n",
      "ssh-ed25519 AAAATEST avatar-chat-owner",
    );

    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toBe("ssh-ed25519 AAAATEST avatar-chat-owner");
    expect(store.getUserSecrets(ownerId).SSH_PRIVATE_KEY).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(JSON.stringify(user)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("clears generated SSH public key when SSH_PRIVATE_KEY is changed or deleted manually", () => {
    const { store, ownerId } = makeStore();
    store.setSshKeyPair(ownerId, "private-key", "ssh-ed25519 AAAATEST avatar-chat-owner");
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "manual-private-key");
    expect(store.getUserById(ownerId)!.sshPublicKey).toBeNull();

    store.setSshKeyPair(ownerId, "private-key", "ssh-ed25519 AAAATEST avatar-chat-owner");
    store.deleteUserSecret(ownerId, "SSH_PRIVATE_KEY");
    expect(store.getUserById(ownerId)!.sshPublicKey).toBeNull();
    expect(store.getUserSecrets(ownerId)).toEqual({});
  });

  it("scopes secrets per user", () => {
    const { store, ownerId } = makeStore();
    const other = store.createUser({ username: "secother", displayName: "Other", password: "password123" });
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "mine");
    expect(store.getUserSecrets(other.id)).toEqual({});
  });

  it("skips entries that fail to decrypt (e.g. SESSION_SECRET changed)", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    // Re-open the same DB with a different secret: the stored value can't decrypt.
    const { store: store2 } = createServices({
      dataDir: path.join(tempDir, "secrets"),
      agentRuntime: "local",
      sessionSecret: "different",
    });
    expect(store2.getUserSecrets(ownerId)).toEqual({});
    // The name is still listed (only decryption fails, the row exists).
    expect(store2.listUserSecretNames(ownerId)).toEqual(["SSH_PRIVATE_KEY"]);
  });
});

describe("store app config (app-wide secrets)", () => {
  function makeStore(secret = "appshh") {
    const { store } = createServices({
      dataDir: path.join(tempDir, "appconfig"),
      agentRuntime: "local",
      sessionSecret: secret,
    });
    return store;
  }

  it("round-trips and upserts an encrypted app-wide value", () => {
    const store = makeStore();
    expect(store.getAppSecret("claude_oauth_token")).toBeNull();
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    expect(store.getAppSecret("claude_oauth_token")).toBe("sk-ant-oat01-abc");
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-def");
    expect(store.getAppSecret("claude_oauth_token")).toBe("sk-ant-oat01-def");
  });

  it("deletes an app-wide value", () => {
    const store = makeStore();
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    store.deleteAppSecret("claude_oauth_token");
    expect(store.getAppSecret("claude_oauth_token")).toBeNull();
  });

  it("returns null when the value can't decrypt (e.g. SESSION_SECRET changed)", () => {
    makeStore("secretA").setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    // Re-open the same DB with a different secret: the stored value can't decrypt.
    expect(makeStore("secretB").getAppSecret("claude_oauth_token")).toBeNull();
  });

  it("stores the hex-ssh tool policy as app config", () => {
    const store = makeStore();
    expect(store.getHexSshToolPolicy()).toEqual(DEFAULT_HEX_SSH_TOOL_POLICY);
    const policy: HexSshToolPolicy = {
      owner: ["ssh-read-lines", "remote-ssh"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    };
    expect(store.setHexSshToolPolicy(policy)).toEqual(policy);
    expect(store.getHexSshToolPolicy()).toEqual(policy);
  });
});

describe("store agent session resume", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "sess"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "sowner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("returns null before any session is recorded", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-1", ownerId, "hi");
    expect(store.getAgentSessionId(ownerId, "conv-1")).toBeNull();
  });

  it("round-trips the session id and overwrites on the next turn", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-2", ownerId, "hi");
    store.setAgentSessionId("conv-2", "sess-aaa");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-aaa");
    store.setAgentSessionId("conv-2", "sess-bbb");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-bbb");
  });

  it("does not leak a session id across owners", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-3", ownerId, "hi");
    store.setAgentSessionId("conv-3", "sess-ccc");
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    expect(store.getAgentSessionId(other.id, "conv-3")).toBeNull();
  });

  it("returns a conversation avatar only to its owner", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "avatar", displayName: "Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-4", avatar.id, "hi");
    const other = store.createUser({ username: "viewer", displayName: "Viewer", password: "password123" });

    expect(store.getConversationAvatarId(ownerId, "conv-4")).toBe(avatar.id);
    expect(store.getConversationAvatarId(other.id, "conv-4")).toBeNull();
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
    expect(p).toContain('"도우미" 아바타로서');
    expect(p).not.toContain("당신의 이름은");
  });

  it("gives the avatar its alias as a self-name when set", () => {
    const p = buildPrompt(req({ avatar: avatar({ alias: "세바스찬" }) }), 0);
    expect(p).toContain('당신의 이름은 "세바스찬"입니다');
    // displayName no longer seeds the opening line.
    expect(p).not.toContain('"도우미" 아바타로서');
  });

  it("treats a whitespace-only alias as unset", () => {
    const p = buildPrompt(req({ avatar: avatar({ alias: "   " }) }), 0);
    expect(p).toContain('"도우미" 아바타로서');
    expect(p).not.toContain("당신의 이름은");
  });

  it("names the owner in the prompt when the viewer is the owner", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("소유자");
    expect(p).toContain('"신진영"님');
  });

  it("injects system awareness and owner system-management tool guidance", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("Noah Almighty avatar-chat");
    expect(p).toContain("mcp__system__describe_system");
    expect(p).toContain("mcp__system__create_routine");
    expect(p).toContain("mcp__system__add_plugin");
    expect(p).toContain("다음 대화부터 로드");
  });

  it("offers to create the knowledge repo via the repo tool on a greeting when a git token is set", () => {
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
    expect(p).toContain("아직 지식 저장소가 연결되어 있지 않습니다");
    expect(p).toContain("mcp__repo__create_repo");
    // The pending-requests nudge composes into the same greeting line.
    expect(p).toContain("그런 다음 무엇을 도와줄지 물어보세요");
  });

  it("guides the owner to set a git token first on a greeting when none is set", () => {
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
    expect(p).toContain("git 토큰도 설정돼 있지 않습니다");
    expect(p).toContain("git 자격증명");
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
    expect(mid).toContain("수동 절차를 안내하지 말고");
    // The greeting-only proactive suggestion is NOT injected mid-conversation.
    expect(mid).not.toContain("아직 지식 저장소가 연결되어 있지 않습니다");
    // The manage-capability blurb is withheld until a repo is connected.
    expect(mid).not.toContain("자신의 **지식 저장소**(소유자 전용 개인 repo)를 직접 관리");
  });

  it("guides the owner to set a git token mid-conversation when none is set and no repo exists", () => {
    const mid = buildPrompt(
      req({ viewerIsOwner: true, knowledgeRepoConfigured: false, gitTokenSet: false }),
      0,
    );
    expect(mid).toContain("git 토큰도 설정돼 있지 않습니다");
    expect(mid).toContain("git 자격증명");
  });

  it("shows the repo-management capability to the owner once a repo is connected", () => {
    const p = buildPrompt(
      req({ viewerIsOwner: true, viewerName: "신진영", knowledgeRepoConfigured: true }),
      0,
    );
    expect(p).toContain("자신의 **지식 저장소**(소유자 전용 개인 repo)를 직접 관리");
    expect(p).not.toContain("아직 지식 저장소가 연결되어 있지 않습니다");
  });

  it("tells the owner how to enable SSH tools when no SSH key is configured", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, viewerName: "신진영" }), 0);
    expect(p).toContain("SSH 도구는 아직 비활성화");
    expect(p).toContain("SSH_PRIVATE_KEY");
    expect(p).toContain("mcp__ssh_identity__generate_key");
    expect(p).toContain("mcp__ssh_trust__add_host");
  });

  it("omits the SSH enablement guidance once an SSH key is configured", () => {
    const p = buildPrompt(req({ viewerIsOwner: true, secretNames: ["SSH_PRIVATE_KEY"] }), 0);
    expect(p).not.toContain("SSH 도구는 아직 비활성화");
    // The key name still appears in the secret-names listing, not the nudge.
    expect(p).toContain("SSH_PRIVATE_KEY");
  });

  it("does not show SSH enablement guidance to colleagues", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, viewerName: "김철수" }), 0);
    expect(p).not.toContain("SSH 도구는 아직 비활성화");
  });

  it("does not show the missing knowledge repo guidance to colleagues or headless runs", () => {
    const colleague = buildPrompt(
      req({ viewerIsOwner: false, viewerName: "김철수", knowledgeRepoConfigured: false }),
      0,
    );
    expect(colleague).not.toContain("아직 지식 저장소가 연결되어 있지 않습니다");

    const headless = buildPrompt(
      req({ viewerIsOwner: true, headless: true, knowledgeRepoConfigured: false }),
      0,
    );
    expect(headless).not.toContain("아직 지식 저장소가 연결되어 있지 않습니다");
  });

  it("names the colleague in the prompt for a non-owner viewer", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, viewerName: "김철수" }), 0);
    expect(p).toContain("동료");
    expect(p).toContain('"김철수"님');
    expect(p).toContain("읽기 전용");
  });

  it("does not mark the chat read-only for a trusted (elevated) non-owner viewer", () => {
    const p = buildPrompt(req({ viewerIsOwner: false, elevated: true, viewerName: "김철수" }), 0);
    expect(p).toContain("동료");
    expect(p).not.toContain("읽기 전용");
    expect(p).toContain("신뢰하는 사용자");
    expect(p).toContain("아바타 시스템 설정 변경은 소유자 전용");
  });

  it("falls back to the unnamed wording when viewerName is absent", () => {
    const owner = buildPrompt(req({ viewerIsOwner: true }), 0);
    expect(owner).toContain("**소유자**입니다.");
    const colleague = buildPrompt(req({ viewerIsOwner: false }), 0);
    expect(colleague).toContain("**동료**입니다.");
  });

  it("shows configured secret names only to the owner, never values", () => {
    const owner = buildPrompt(
      req({ viewerIsOwner: true, secretNames: ["SSH_PRIVATE_KEY", "API_TOKEN"] }),
      0,
    );
    expect(owner).toContain("시크릿");
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
    expect(p).not.toContain("사용자 메시지:");
    // The pending-request count is surfaced in the greeting.
    expect(p).toContain("2");
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
    expect(names).toEqual(["request_info", "pending_requests", "resolve_request"]);
    expect(KNOWLEDGE_TOOL_NAMES).toContain("mcp__knowledge__request_info");
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

  it("resolve_request is owner-only and closes an open request", async () => {
    const { store, ownerId } = makeStore();

    // Non-owner is refused.
    const denied = await call(buildKnowledgeTools(store, visitorCtx(ownerId)), "resolve_request", {
      request_id: "x",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("아바타 소유자만");

    const ownerTools = buildKnowledgeTools(store, ownerCtx(ownerId));

    // Unknown / already-handled id → error.
    const bad = await call(ownerTools, "resolve_request", { request_id: "ghost" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("찾을 수 없습니다");

    // A real open request is resolved and no longer listed as open.
    const req = store.addKnowledgeRequest(ownerId, { question: "넘길 질문", askerName: "동료D" });
    const ok = await call(ownerTools, "resolve_request", { request_id: req.id });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("처리 완료");
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

  function call(tools: ReturnType<typeof buildConfluenceTools>, name: string, args: unknown): Promise<ToolResult> {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
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
    const missingUrl = await call(
      buildConfluenceTools({ config: makeConfig(), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: false }),
      "search",
      { text: "auth" },
    );
    expect(missingUrl.isError).toBe(true);
    expect(missingUrl.content[0].text).toContain("CONFLUENCE_URL");

    const missingPat = await call(
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

    const result = await call(
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
    const result = await call(
      buildConfluenceTools({
        config: makeConfig("https://confluence.internal"),
        ownerSecrets: { CONFLUENCE_PAT: "pat" },
        elevated: false,
      }),
      "create_page",
      { space_key: "DEV", title: "Draft", body_storage: "<p>Hello</p>" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("소유자 또는 신뢰 사용자");
  });
});

describe("repo tools (knowledge-repo management)", () => {
  function call(tools: ReturnType<typeof buildRepoTools>, name: string, args: unknown): Promise<ToolResult> {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
  }

  // A store + owner pointed at a local bare git remote, so commit/push works
  // offline. Returns the config so tools can resolve the clone path.
  function setup(dir: string) {
    const dataDir = path.join(tempDir, dir);
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    // A bare remote + an initial commit so `ensureClone` has a branch to track.
    const remote = path.join(tempDir, dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
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
    expect(names).toEqual(["list_files", "read_file", "write_file", "scaffold_skill", "commit"]);
  });

  it("refuses every tool for a non-owner viewer", async () => {
    const s = setup("rt1");
    const tools = buildRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: s.owner,
      viewerIsOwner: false,
      config: s.config,
    });
    for (const name of ["list_files", "read_file", "write_file", "scaffold_skill", "commit"]) {
      const res = await call(tools, name, { path: "x", content: "y", name: "x", message: "m" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("아바타 소유자만");
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
    const res = await call(tools, "list_files", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("지식 저장소가 아직 연결되어 있지 않습니다");
    // The error redirects to create_repo, not manual setup.
    expect(res.content[0].text).toContain("create_repo");
  });

  it("writes, scaffolds, lists, reads, then commits & pushes", async () => {
    const s = setup("rt3");
    const tools = ownerTools(s);

    const w = await call(tools, "write_file", { path: "notes/onboarding.md", content: "# 온보딩\n절차" });
    expect(w.isError).toBeFalsy();
    expect(w.content[0].text).toContain("아직 커밋되지 않았습니다");

    const sk = await call(tools, "scaffold_skill", { name: "Deploy Runbook", description: "배포" });
    expect(sk.content[0].text).toContain("skills/deploy-runbook/SKILL.md");

    const ls = await call(tools, "list_files", {});
    expect(ls.content[0].text).toContain("notes/onboarding.md");
    expect(ls.content[0].text).toContain("skills/deploy-runbook/SKILL.md");

    const rd = await call(tools, "read_file", { path: "notes/onboarding.md" });
    expect(rd.content[0].text).toContain("# 온보딩");

    const commit = await call(tools, "commit", { message: "지식 추가" });
    expect(commit.isError).toBeFalsy();
    expect(commit.content[0].text).toContain("커밋하고 푸시");

    // A second commit with no changes reports nothing to commit.
    const noop = await call(tools, "commit", { message: "재시도" });
    expect(noop.content[0].text).toContain("변경사항이 없습니다");

    // The push reached the remote — clone it fresh and verify the file landed.
    const verify = path.join(tempDir, "rt3", "verify");
    const { repo } = s.store.getKnowledgeRepo(s.ownerId) as { repo: string };
    execFileSync("git", ["clone", "-q", repo, verify], { stdio: "pipe" });
    expect(fs.existsSync(path.join(verify, "notes/onboarding.md"))).toBe(true);
  });

  it("commits knowledge-repo changes with the avatar alias by default", async () => {
    const s = setup("rt-alias");
    s.store.updateProfile(s.ownerId, { alias: "Knowledge Bot" });
    const tools = ownerTools(s);

    await call(tools, "write_file", { path: "notes/identity.md", content: "uses alias" });
    const commit = await call(tools, "commit", { message: "identity check" });
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

  // ---- create_repo: a store with a git token but NO repo configured yet. The
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
    const res = await call(createTools(s, false), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("아바타 소유자만");
  });

  it("create_repo requires a git token", async () => {
    const s = setupNoRepo("rt-create-notoken");
    const res = await call(createTools(s), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("git 자격증명에 토큰");
  });

  it("create_repo rejects an invalid repo name", async () => {
    const s = setupNoRepo("rt-create-badname");
    s.store.setGitToken(s.ownerId, "tok");
    const res = await call(createTools(s), "create_repo", { name: "bad name!" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("영문/숫자");
  });

  it("create_repo refuses when a repo is already connected", async () => {
    const s = setupNoRepo("rt-create-exists");
    s.store.setGitToken(s.ownerId, "tok");
    s.store.setKnowledgeRepo(s.ownerId, "owner/existing", "main");
    const res = await call(createTools(s), "create_repo", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("이미 지식 저장소가 연결");
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

    const res = await call(createTools(s, true, { createRemoteRepo: create }), "create_repo", {
      name: "my-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("owner/my-knowledge");
    expect(create).toHaveBeenCalledWith("github.com", "tok", "my-knowledge", true, "", undefined);
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
      ["repo", "create", "my-knowledge", "--private", "--add-readme", "--description", "desc"],
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

    const res = await createRemoteRepo("github.enterprise.local", "tok", "my-knowledge", true, "", undefined, runner);

    expect(res).toMatchObject({
      ok: true,
      fullName: "owner/my-knowledge",
      defaultBranch: "main",
      isPrivate: true,
    });
    expect(calls).toEqual([
      ["api", "user", "--jq", ".login"],
      ["repo", "create", "my-knowledge", "--private", "--add-readme"],
      ["repo", "view", "owner/my-knowledge", "--json", "nameWithOwner,defaultBranchRef,isPrivate"],
    ]);
  });

  it("createRemoteRepo redacts tokens from gh errors", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("failed with tok-secret"), {
        code: 1,
        stderr: "bad credentials tok-secret",
      });
    });

    const res = await createRemoteRepo("github.com", "tok-secret", "dup", true, "", undefined, runner);

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

    const res = await call(createTools(s, true, { createRemoteRepo: create }), "create_repo", { name: "dup" });

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
    const remote = path.join(tempDir, "rt-create-seed", "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
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

    const res = await call(createTools(s, true, { createRemoteRepo: create }), "create_repo", {
      name: "my-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("초기화");
    // The template landed on the remote as a real commit.
    const verify = path.join(tempDir, "rt-create-seed", "verify");
    execFileSync("git", ["clone", "-q", remote, verify], { stdio: "pipe" });
    const mp = JSON.parse(fs.readFileSync(path.join(verify, ".claude-plugin/marketplace.json"), "utf8"));
    expect(mp.plugins).toEqual([]);
  });
});

describe("system tools (avatar system management)", () => {
  function call(tools: ReturnType<typeof buildSystemTools>, name: string, args: unknown): Promise<ToolResult> {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
  }

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
    expect(toolsFor(s).map((t) => t.name)).toEqual([
      "describe_system",
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
    const res = await call(toolsFor(s, false), "describe_system", {});

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Noah Almighty avatar-chat 시스템 요약");
    expect(res.content[0].text).toContain("소유자가 아니므로");
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

    const res = await call(toolsFor(s), "describe_system", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("runtime: local");
    expect(res.content[0].text).toContain("owner/knowledge @ main");
    expect(res.content[0].text).toContain("GitHub 토큰: 설정됨");
    expect(res.content[0].text).toContain("SSH_PRIVATE_KEY");
    expect(res.content[0].text).toContain("플러그인: 1개");
    expect(res.content[0].text).toContain("루틴: 1개");
    expect(res.content[0].text).not.toContain("ghp_secretvalue");
    expect(res.content[0].text).not.toContain("private-key");
  });

  it("refuses routine and plugin mutations for non-owner viewers", async () => {
    const s = setup("st-deny");
    const nonOwner = toolsFor(s, false);
    const routine = await call(nonOwner, "create_routine", { prompt: "p", time: "09:00" });
    const plugin = await call(nonOwner, "add_plugin", { repo: "owner/repo" });

    expect(routine.isError).toBe(true);
    expect(routine.content[0].text).toContain("아바타 소유자");
    expect(plugin.isError).toBe(true);
    expect(plugin.content[0].text).toContain("아바타 소유자");
    expect(s.store.listRoutineJobs(s.owner.id)).toHaveLength(0);
    expect(s.store.listPlugins(s.owner.id)).toHaveLength(0);
  });

  it("creates, updates, lists, and deletes owner routines", async () => {
    const s = setup("st-routine");
    const tools = toolsFor(s);

    const bad = await call(tools, "create_routine", { prompt: "p", time: "25:00" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("HH:MM");

    const created = await call(tools, "create_routine", {
      prompt: "오늘 해야 할 일을 정리해줘",
      time: "09:30",
    });
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toContain("time=09:30 KST");

    const job = s.store.listRoutineJobs(s.owner.id)[0];
    expect(job.prompt).toBe("오늘 해야 할 일을 정리해줘");

    const updated = await call(tools, "update_routine", {
      id: job.id,
      prompt: "오늘 일정과 미해결 작업을 정리해줘",
      time: "10:15",
      enabled: false,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.content[0].text).toContain("time=10:15 KST");
    expect(updated.content[0].text).toContain("enabled=false");

    const listed = await call(tools, "list_routines", {});
    expect(listed.content[0].text).toContain(job.id);
    expect(listed.content[0].text).toContain("오늘 일정");

    const deleted = await call(tools, "delete_routine", { id: job.id });
    expect(deleted.isError).toBeFalsy();
    expect(s.store.listRoutineJobs(s.owner.id)).toHaveLength(0);
  });

  it("adds and toggles owner plugins", async () => {
    const s = setup("st-plugin");
    const tools = toolsFor(s);

    const bad = await call(tools, "add_plugin", { repo: "not a repo!!" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("owner/repo");

    const added = await call(tools, "add_plugin", {
      repo: "owner/plugin",
      ref: "main",
      label: "Ops Plugin",
    });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain("다음 대화부터");

    const plugin = s.store.listPlugins(s.owner.id)[0];
    expect(plugin.repo).toBe("owner/plugin");
    expect(plugin.enabled).toBe(true);

    const listed = await call(tools, "list_plugins", {});
    expect(listed.content[0].text).toContain("owner/plugin");
    expect(listed.content[0].text).toContain("Ops Plugin");

    const disabled = await call(tools, "set_plugin_enabled", { id: plugin.id, enabled: false });
    expect(disabled.isError).toBeFalsy();
    expect(disabled.content[0].text).toContain("enabled=false");
    expect(s.store.getPlugin(s.owner.id, plugin.id)?.enabled).toBe(false);
  });
});

describe("routine jobs", () => {
  function makeStore(label: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, label),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("creates a job with a dedicated conversation and a future next run", () => {
    const { store, ownerId } = makeStore("rj1");
    const job = store.createRoutineJob(ownerId, { prompt: "  요약해줘  ", minuteOfDay: 540 });
    expect(job.prompt).toBe("요약해줘");
    expect(job.minuteOfDay).toBe(540);
    expect(job.time).toBe("09:00");
    expect(job.enabled).toBe(true);
    expect(job.conversationId).toBeTruthy();
    expect(job.lastRunAt).toBeNull();
    // next run is scheduled and lies in the future.
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(store.listRoutineJobs(ownerId)).toHaveLength(1);
  });

  it("disabling parks the schedule; re-enabling reschedules", () => {
    const { store, ownerId } = makeStore("rj2");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 60 });
    const off = store.updateRoutineJob(ownerId, job.id, { enabled: false });
    expect(off?.enabled).toBe(false);
    expect(off?.nextRunAt).toBeNull();
    const on = store.updateRoutineJob(ownerId, job.id, { enabled: true });
    expect(on?.enabled).toBe(true);
    expect(on?.nextRunAt).toBeTruthy();
  });

  it("editing prompt/time keeps the conversation and recomputes the run", () => {
    const { store, ownerId } = makeStore("rj3");
    const job = store.createRoutineJob(ownerId, { prompt: "old", minuteOfDay: 0 });
    const edited = store.updateRoutineJob(ownerId, job.id, { prompt: "new", minuteOfDay: 1439 });
    expect(edited?.prompt).toBe("new");
    expect(edited?.time).toBe("23:59");
    expect(edited?.conversationId).toBe(job.conversationId);
  });

  it("a prompt-only edit preserves next_run_at (does not cancel a pending run)", () => {
    const { store, ownerId } = makeStore("rj-prompt");
    const job = store.createRoutineJob(ownerId, { prompt: "old", minuteOfDay: 300 });
    const edited = store.updateRoutineJob(ownerId, job.id, { prompt: "new" });
    expect(edited?.prompt).toBe("new");
    expect(edited?.nextRunAt).toBe(job.nextRunAt);
    // Re-sending enabled:true on an already-enabled job is also timing-neutral.
    const same = store.updateRoutineJob(ownerId, job.id, { enabled: true });
    expect(same?.nextRunAt).toBe(job.nextRunAt);
  });

  it("creates the dedicated conversation eagerly, titled from the prompt", () => {
    const { store, ownerId } = makeStore("rj-conv");
    const job = store.createRoutineJob(ownerId, { prompt: "매일 상태 요약", minuteOfDay: 540 });
    const conv = store.listConversations(ownerId).find((c) => c.id === job.conversationId);
    expect(conv).toBeTruthy();
    expect(conv!.title.startsWith("[루틴]")).toBe(true);
  });

  it("executeRoutineJob runs the job, records the outcome, and blocks overlap", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-exec"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });

    // Two simultaneous firings: the shared guard lets exactly one through.
    const [first, second] = await Promise.all([
      executeRoutineJob(services, job),
      executeRoutineJob(services, job),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.skipped)).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

    const after = services.store.listRoutineJobs(owner.id)[0];
    expect(after.lastStatus).toBe("success");
    expect(after.lastRunAt).toBeTruthy();
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("scopes updates and deletes to the owning avatar", () => {
    const { store, ownerId } = makeStore("rj4");
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 30 });
    expect(store.updateRoutineJob(other.id, job.id, { prompt: "x" })).toBeNull();
    expect(store.deleteRoutineJob(other.id, job.id)).toBe(false);
    expect(store.deleteRoutineJob(ownerId, job.id)).toBe(true);
    expect(store.listRoutineJobs(ownerId)).toHaveLength(0);
  });

  it("lists only enabled, due jobs and rolls them forward after a run", () => {
    const { store, ownerId } = makeStore("rj5");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 0 });
    // Nothing is due yet (next run is in the future).
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(store.listDueRoutineJobs(future)).toHaveLength(0);
    // A timestamp well past the scheduled run makes it due.
    const past = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    const due = store.listDueRoutineJobs(past);
    expect(due.map((j) => j.id)).toContain(job.id);
    // Recording a run advances next_run_at into the future again.
    store.markRoutineRun(job.id, { status: "success" });
    const after = store.listRoutineJobs(ownerId)[0];
    expect(after.lastStatus).toBe("success");
    expect(after.lastRunAt).toBeTruthy();
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("schedules the next run at the requested Seoul (KST) time", () => {
    const { store, ownerId } = makeStore("rj-kst");
    const minuteOfDay = 9 * 60 + 30; // 09:30 KST
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay });
    // Convert the stored UTC instant back to KST wall-clock minutes; it must
    // land exactly on the requested time regardless of the server's timezone.
    const kstMs = new Date(job.nextRunAt!).getTime() + 9 * 60 * 60 * 1000;
    const minutesInKstDay = Math.floor((kstMs % (24 * 60 * 60 * 1000)) / 60_000);
    expect(minutesInKstDay).toBe(minuteOfDay);
  });

  it("deleting the owner removes their routine jobs", () => {
    const { store, ownerId } = makeStore("rj6");
    store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 10 });
    expect(store.deleteUser(ownerId)).toBe(true);
    expect(store.listRoutineJobs(ownerId)).toHaveLength(0);
  });
});

describe("trusted users", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const friend = store.createUser({ username: "friend", displayName: "Friend", password: "password123" });
    const stranger = store.createUser({ username: "stranger", displayName: "Stranger", password: "password123" });
    return { store, ownerId: owner.id, friendId: friend.id, strangerId: stranger.id };
  }

  it("grants and revokes trust by username; isTrustedFor reflects it", () => {
    const { store, ownerId, friendId } = makeStore("tu1");
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
    const added = store.addTrustedUser(ownerId, "friend");
    expect(added?.id).toBe(friendId);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.listTrustedUsers(ownerId).map((t) => t.id)).toEqual([friendId]);
    // Idempotent: adding again doesn't duplicate.
    store.addTrustedUser(ownerId, "friend");
    expect(store.listTrustedUsers(ownerId)).toHaveLength(1);
    expect(store.removeTrustedUser(ownerId, friendId)).toBe(true);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
  });

  it("rejects trusting a nonexistent user or oneself", () => {
    const { store, ownerId } = makeStore("tu2");
    expect(store.addTrustedUser(ownerId, "nobody")).toBeNull();
    expect(store.addTrustedUser(ownerId, "owner")).toBeNull();
    expect(store.listTrustedUsers(ownerId)).toHaveLength(0);
  });

  it("searchUsers matches name or @id (case-insensitive), excludes self, flags trusted", () => {
    const { store, ownerId } = makeStore("tu-search");
    // Substring match on display name AND username, case-insensitive.
    expect(store.searchUsers("frie", ownerId).map((u) => u.username)).toEqual(["friend"]);
    expect(store.searchUsers("STRANGER", ownerId).map((u) => u.username)).toEqual(["stranger"]);
    expect(store.searchUsers("r", ownerId).map((u) => u.username).sort()).toEqual(["friend", "stranger"]);
    // The searcher is never a candidate for their own trust list.
    expect(store.searchUsers("owner", ownerId)).toEqual([]);
    // Blank query short-circuits.
    expect(store.searchUsers("   ", ownerId)).toEqual([]);
    // `trusted` reflects current state.
    expect(store.searchUsers("friend", ownerId)[0].trusted).toBe(false);
    store.addTrustedUser(ownerId, "friend");
    expect(store.searchUsers("friend", ownerId)[0].trusted).toBe(true);
    // A literal % isn't treated as a wildcard (escaped).
    expect(store.searchUsers("%", ownerId)).toEqual([]);
  });

  it("trust is directional: trusting A doesn't let A's avatar be reached by the owner", () => {
    const { store, ownerId, friendId } = makeStore("tu3");
    store.addTrustedUser(ownerId, "friend");
    // friend is trusted FOR owner's avatar, not the reverse.
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.isTrustedFor(ownerId, friendId)).toBe(false);
  });

  it("a trusted user can resolve/see an UNPUBLISHED avatar; a stranger cannot", () => {
    const { store, ownerId, friendId, strangerId } = makeStore("tu4");
    store.updateProfile(ownerId, { published: false });
    expect(store.resolveChatAvatar(strangerId, ownerId)).toBeNull();
    expect(store.getAvatar(strangerId, ownerId)).toBeNull();
    store.addTrustedUser(ownerId, "friend");
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    const detail = store.getAvatar(friendId, ownerId);
    expect(detail?.elevated).toBe(true);
    expect(detail?.isOwn).toBe(false);
  });

  it("deleting a user clears trust rows in both directions", () => {
    const { store, ownerId, friendId } = makeStore("tu5");
    store.addTrustedUser(ownerId, "friend");
    expect(store.deleteUser(friendId)).toBe(true);
    expect(store.listTrustedUsers(ownerId)).toHaveLength(0);
  });
});

describe("buildPreToolUseHook auto-approve safety contract", () => {
  const READONLY = ["Read", "Glob", "Grep"];
  // Invoke the hook for a non-read-only tool and return the permission decision.
  // `elevated` = owner OR trusted user (the tool-permission level).
  const decide = (
    opts: { elevated: boolean; headless: boolean; autoApprove: boolean },
    events: AgentEvents = {},
  ) => {
    const hook = buildPreToolUseHook(events, opts.elevated, READONLY, opts.headless, opts.autoApprove);
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

  it("NEVER auto-approves a non-elevated colleague, even with autoApprove=true", async () => {
    const out = await decide({ elevated: false, headless: false, autoApprove: true });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("auto-allows a read-only tool regardless of autoApprove", async () => {
    const hook = buildPreToolUseHook({}, false, READONLY, false, false);
    const out = await hook({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "t2" }, "t2");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("filters hex-ssh MCP tools before the blanket MCP auto-allow", async () => {
    const policy = normalizeHexSshToolPolicy({
      owner: ["remote-ssh", "ssh-read-lines"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    });
    const trustedHook = buildPreToolUseHook({}, true, READONLY, false, true, "trusted", policy);
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

    const ownerHook = buildPreToolUseHook({}, true, READONLY, false, true, "owner", policy);
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

describe("secret encryption", () => {
  const SECRET = "session-secret-key";

  it("round-trips a secret and authenticates it", () => {
    const enc = encryptSecret("ghp_token123", SECRET);
    expect(enc).not.toContain("ghp_token123");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc, SECRET)).toBe("ghp_token123");
  });

  it("produces a different ciphertext each time (random salt/iv)", () => {
    const a = encryptSecret("same", SECRET);
    const b = encryptSecret("same", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe("same");
    expect(decryptSecret(b, SECRET)).toBe("same");
  });

  it("fails closed on the wrong key, tampering, or garbage", () => {
    const enc = encryptSecret("secret", SECRET);
    expect(decryptSecret(enc, "wrong-key")).toBeNull();
    // Tamper with the ciphertext segment — the GCM tag must reject it.
    const parts = enc.split(":");
    const data = Buffer.from(parts[4], "base64url");
    data[0] ^= 0xff;
    parts[4] = data.toString("base64url");
    expect(decryptSecret(parts.join(":"), SECRET)).toBeNull();
    expect(decryptSecret("not-a-token", SECRET)).toBeNull();
    expect(decryptSecret("", SECRET)).toBeNull();
  });
});

describe("git token storage", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "a-secret",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("stores the token encrypted and never leaks it through the User shape", () => {
    const { store, ownerId } = makeStore("gt1");
    const user = store.setGitToken(ownerId, "ghp_secretvalue");
    // The public User shape exposes only a boolean flag, never the token.
    expect(user.gitTokenSet).toBe(true);
    expect(JSON.stringify(user)).not.toContain("ghp_secretvalue");
    expect(JSON.stringify(store.getUserById(ownerId))).not.toContain("ghp_secretvalue");
    // Server-side decryption recovers the plaintext for git auth.
    expect(store.getGitToken(ownerId)).toBe("ghp_secretvalue");
  });

  it("clears the token", () => {
    const { store, ownerId } = makeStore("gt2");
    store.setGitToken(ownerId, "ghp_x");
    const cleared = store.setGitToken(ownerId, null);
    expect(cleared.gitTokenSet).toBe(false);
    expect(store.getGitToken(ownerId)).toBeNull();
  });

  it("persists identity and knowledge repo settings", () => {
    const { store, ownerId } = makeStore("gt3");
    const u1 = store.setGitIdentity(ownerId, "Avatar Bot", "bot@example.com");
    expect(u1.gitIdentityName).toBe("Avatar Bot");
    expect(u1.gitIdentityEmail).toBe("bot@example.com");
    const u2 = store.setKnowledgeRepo(ownerId, "me/knowledge", "main");
    expect(u2.knowledgeRepo).toBe("me/knowledge");
    expect(u2.knowledgeBranch).toBe("main");
    expect(u2.knowledgeSelected).toBeNull();
    expect(store.getKnowledgeRepo(ownerId)).toEqual({ repo: "me/knowledge", branch: "main", selected: null });
  });

  it("uses the avatar alias as the default knowledge-repo commit author name", () => {
    const { store, ownerId } = makeStore("gt-alias");
    store.updateProfile(ownerId, { alias: "Knowledge Bot" });
    expect(commitIdentityFor(store, { id: ownerId, username: "owner", displayName: "Owner" })).toEqual({
      name: "Knowledge Bot",
      email: "owner@noah-almighty.local",
    });

    store.setGitIdentity(ownerId, "Explicit Committer", null);
    expect(commitIdentityFor(store, { id: ownerId, username: "owner", displayName: "Owner" }).name).toBe("Explicit Committer");
  });

  it("persists and clears the knowledge-repo plugin selection", () => {
    const { store, ownerId } = makeStore("gt4");
    store.setKnowledgeRepo(ownerId, "me/knowledge", "main");
    const u1 = store.setKnowledgeSelected(ownerId, ["alpha", "beta"]);
    expect(u1.knowledgeSelected).toEqual(["alpha", "beta"]);
    expect(store.getKnowledgeRepo(ownerId).selected).toEqual(["alpha", "beta"]);
    // null = "load all".
    const u2 = store.setKnowledgeSelected(ownerId, null);
    expect(u2.knowledgeSelected).toBeNull();
    // Re-pointing at a repo resets the selection to "load all".
    store.setKnowledgeSelected(ownerId, ["alpha"]);
    const u3 = store.setKnowledgeRepo(ownerId, "me/other", null);
    expect(u3.knowledgeSelected).toBeNull();
  });
});

describe("knowledge repo file ops", () => {
  it("rejects path traversal and absolute paths", () => {
    const root = path.join(tempDir, "repo");
    expect(resolveInRepo(root, "../etc/passwd")).toBeNull();
    expect(resolveInRepo(root, "a/../../b")).toBeNull();
    expect(resolveInRepo(root, "/etc/passwd")).toBeNull();
    expect(resolveInRepo(root, ".git/config")).toBeNull();
    // In-repo paths resolve under the root.
    expect(resolveInRepo(root, "skills/foo/SKILL.md")).toBe(
      path.join(root, "skills/foo/SKILL.md"),
    );
  });

  it("refuses to read/write outside the repo", async () => {
    const root = path.join(tempDir, "repo2");
    fs.mkdirSync(root, { recursive: true });
    await expect(readKnowledgeFile(root, "../escape.txt")).rejects.toThrow("INVALID_PATH");
    await expect(writeKnowledgeFile(root, "../escape.txt", "x")).rejects.toThrow("INVALID_PATH");
  });

  it("rejects reads/writes that escape via a symlink in the clone", async () => {
    const root = path.join(tempDir, "symrepo");
    fs.mkdirSync(root, { recursive: true });
    // A committed-style symlink pointing outside the repo.
    const secret = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(secret, "TOPSECRET");
    fs.symlinkSync(secret, path.join(root, "evil"));
    await expect(readKnowledgeFile(root, "evil")).rejects.toThrow("INVALID_PATH");
    // A symlinked directory ancestor must not let a write escape either.
    fs.symlinkSync(tempDir, path.join(root, "outdir"));
    await expect(writeKnowledgeFile(root, "outdir/pwned.txt", "x")).rejects.toThrow("INVALID_PATH");
    expect(fs.existsSync(path.join(tempDir, "pwned.txt"))).toBe(false);
    // A not-yet-existing path UNDER a symlinked ancestor is rejected before any
    // dirs are created at the link target.
    await expect(writeKnowledgeFile(root, "outdir/sub/deep.txt", "x")).rejects.toThrow("INVALID_PATH");
    expect(fs.existsSync(path.join(tempDir, "sub"))).toBe(false);
  });

  it("scaffolds a skill with a SKILL.md and marketplace manifest entry", async () => {
    const root = path.join(tempDir, "repo3");
    fs.mkdirSync(root, { recursive: true });
    const rel = await scaffoldSkill(root, "Deploy Runbook", "How to deploy");
    expect(rel).toBe("skills/deploy-runbook/SKILL.md");
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills/deploy-runbook/.claude-plugin/plugin.json"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
    );
    expect(manifest.plugins).toContainEqual({ name: "deploy-runbook", source: "./skills/deploy-runbook" });
    // A second skill is appended, not duplicated.
    await scaffoldSkill(root, "Other", "");
    const manifest2 = JSON.parse(
      fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
    );
    expect(manifest2.plugins).toHaveLength(2);
    // Re-scaffolding an existing skill fails.
    await expect(scaffoldSkill(root, "Deploy Runbook", "")).rejects.toThrow("SKILL_EXISTS");
  });
});

describe("applyCustomGithubCa (one GITHUB_CA_CERT for fetch + git)", () => {
  // A throwaway self-signed CA (10y) — only used to prove the cert is registered.
  const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUcqTjIIRo8c5W5rPd4IUUQ2k80ggwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMTm9haCBUZXN0IENBMB4XDTI2MDYxMjA1MDUwOFoXDTM2
MDYwOTA1MDUwOFowFzEVMBMGA1UEAwwMTm9haCBUZXN0IENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxiMQNWVb4iqF9mKflqgp5p+n+3LSyHeT5Har
apRgGPVhtYpz68GjMOMn7/VKGw2D5YWVup7jKAcYCvwjT+Ukj6/3wm7nxPWgvyoz
0XJpUG0LTYCnHRCkXzKcjlS6H51A+MkM2aJET5TB2ShKot/zbRBw8vVjipNnOozK
3z+io0KO9IaejvKxDg7wMxbsbt/cV8+hXlv05LcbEFr/tvW8fvDvqeFzwT4GWNOT
DdoFNCu8ZEa0XIrPCpTPr3+al5Miozbfdwq7bdpgDu4jsbcWUJrCTlbqlzExaAlP
SGApBv1IWwnR1Ke8trvaCfoHoRyLtglxHaNroErsJE4wnf5NCQIDAQABo1MwUTAd
BgNVHQ4EFgQUBGaTeJgpnW2L/2rPIJLI8HQL6okwHwYDVR0jBBgwFoAUBGaTeJgp
nW2L/2rPIJLI8HQL6okwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAKnENhipsapusqB11Hw7gbE1goF+7Gwyi0yvosEjdFk/mcxSqYlDNRksS3z6X
bFYa6nNa650egp8b0zvkGTNypIFFu7Ch+DI16ksHoMqepCoaj5BvRm0gwo/b/6of
hqc7FkZtQS0HkGmtGcxLhJQ458MVol9Jnwt8E2Exx/D3PHGtajIb5AZXkA9c9sBw
ERc1OguGascDEMRZK6bhvTbsAV61YoK+xQ7lBWhPOPxrEACx21kqpKrPYQXCtCHs
1QQXhW5lzK/QgKN3xYfu9Yd2XcK/KJpr2PUhlbn5YXj5x4RNRcMNhrs8sg7u2CTo
6UIgE2hSD+xkPUz7lTgYUjA4oQ==
-----END CERTIFICATE-----
`;
  const silent = { info: () => {}, warn: () => {} };

  it("is a no-op when GITHUB_CA_CERT is unset", () => {
    const prevGit = process.env.GIT_SSL_CAINFO;
    const applied = applyCustomGithubCa({ ...loadConfig(), githubCaCert: undefined }, silent);
    expect(applied).toBe(false);
    expect(process.env.GIT_SSL_CAINFO).toBe(prevGit);
  });

  it("warns and returns false when the cert file is unreadable", () => {
    const warn = vi.fn();
    const applied = applyCustomGithubCa(
      { ...loadConfig(), githubCaCert: "/no/such/internal-ca.pem" },
      { info: () => {}, warn },
    );
    expect(applied).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("trusts the CA for fetch (tls default set) and git (GIT_SSL_CAINFO)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ca-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, TEST_CA_PEM);
    const prevGit = process.env.GIT_SSL_CAINFO;
    delete process.env.GIT_SSL_CAINFO;
    const before = tls.getCACertificates("default").length;

    const applied = applyCustomGithubCa({ ...loadConfig(), githubCaCert: caPath }, silent);

    expect(applied).toBe(true);
    // git: every `git` execFile child inherits this.
    expect(process.env.GIT_SSL_CAINFO).toBe(path.resolve(caPath));
    // fetch (undici): appended to the default set, not replacing system roots.
    expect(tls.getCACertificates("default").length).toBe(before + 1);

    if (prevGit === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = prevGit;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an operator-set GIT_SSL_CAINFO instead of clobbering it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ca-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, TEST_CA_PEM);
    const prevGit = process.env.GIT_SSL_CAINFO;
    process.env.GIT_SSL_CAINFO = "/operator/explicit/bundle.pem";

    applyCustomGithubCa({ ...loadConfig(), githubCaCert: caPath }, silent);
    expect(process.env.GIT_SSL_CAINFO).toBe("/operator/explicit/bundle.pem");

    if (prevGit === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = prevGit;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadDotEnv (.env auto-load)", () => {
  it("is a no-op for a missing file", () => {
    expect(loadDotEnv("/no/such/dir/.env")).toBe(false);
  });

  it("fills unset keys from the file but never overwrites the real environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "NOAH_TEST_FROM_FILE=fromfile\nNOAH_TEST_REAL=fromfile\n");
    const prevReal = process.env.NOAH_TEST_REAL;
    const prevFile = process.env.NOAH_TEST_FROM_FILE;
    process.env.NOAH_TEST_REAL = "realenv";
    delete process.env.NOAH_TEST_FROM_FILE;

    expect(loadDotEnv(file)).toBe(true);
    expect(process.env.NOAH_TEST_FROM_FILE).toBe("fromfile"); // unset key gets filled
    expect(process.env.NOAH_TEST_REAL).toBe("realenv"); // real env wins over the file

    if (prevReal === undefined) delete process.env.NOAH_TEST_REAL;
    else process.env.NOAH_TEST_REAL = prevReal;
    if (prevFile === undefined) delete process.env.NOAH_TEST_FROM_FILE;
    else process.env.NOAH_TEST_FROM_FILE = prevFile;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
