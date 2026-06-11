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
  awaitResponse,
  CANCELLED,
  closeRun,
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
} from "../src/server/knowledgeRepo.js";
import { buildRepoTools, REPO_SERVER_NAME, REPO_TOOL_NAMES } from "../src/server/agent/repoTools.js";
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
import { workspaceDirFor } from "../src/server/workspace.js";
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
    expect(JSON.stringify(user)).not.toContain("topsecret");
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
    expect(res.content[0].text).toContain("지식 저장소가 설정되지 않았습니다");
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

  it("trust is directional: trusting A doesn't let A's avatar be reached by the owner", () => {
    const { store, ownerId, friendId } = makeStore("tu3");
    store.addTrustedUser(ownerId, "friend");
    // friend is trusted FOR owner's avatar, not the reverse.
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.isTrustedFor(ownerId, friendId)).toBe(false);
  });

  it("a trusted user can resolve/see an UNPUBLISHED avatar; a stranger cannot", () => {
    const { store, ownerId, friendId, strangerId } = makeStore("tu4");
    // owner's avatar is unpublished by default.
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
