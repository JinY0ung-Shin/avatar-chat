import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createServices, expandChatSlashCommand } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { applyCustomGithubCa } from "../src/server/tlsCa.js";
import { loadDotEnv } from "../src/server/loadEnv.js";
import { createRateLimiter } from "../src/server/rateLimit.js";
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

import { callTool } from "./helpers.js";

let tempDir: string;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
  process.env.NODE_ENV = originalNodeEnv;
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});


describe("rate limiter", () => {
  function makeResponse() {
    const headers = new Map<string, string>();
    const res = {
      setHeader: vi.fn((name: string, value: string | number) => {
        headers.set(name, String(value));
      }),
      status: vi.fn(function status(this: Response, _code: number) {
        return this;
      }),
      json: vi.fn(function json(this: Response, _body: unknown) {
        return this;
      }),
    } as unknown as Response & {
      setHeader: ReturnType<typeof vi.fn>;
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    };
    return { res, headers };
  }

  function runLimiter(
    limiter: ReturnType<typeof createRateLimiter>,
    key: string,
  ): { headers: Map<string, string>; next: ReturnType<typeof vi.fn>; res: ReturnType<typeof makeResponse>["res"] } {
    const { res, headers } = makeResponse();
    const req = { testKey: key } as unknown as Request & { testKey: string };
    const next = vi.fn() as NextFunction & ReturnType<typeof vi.fn>;
    limiter(req, res, next);
    return { headers, next, res };
  }

  it("bypasses checks in test mode", () => {
    process.env.NODE_ENV = "test";
    const limiter = createRateLimiter({
      windowMs: 1_000,
      max: 0,
      keyFn: () => {
        throw new Error("keyFn should not run in test mode");
      },
    });

    const { next, res } = runLimiter(limiter, "ignored");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows requests up to the fixed-window limit and then returns 429", () => {
    process.env.NODE_ENV = "production";
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const limiter = createRateLimiter({
      windowMs: 5_000,
      max: 2,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
      message: "slow down",
    });

    expect(runLimiter(limiter, "same").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "same").next).toHaveBeenCalledTimes(1);
    const blocked = runLimiter(limiter, "same");

    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.res.json).toHaveBeenCalledWith({ error: "slow down" });
    expect(blocked.headers.get("Retry-After")).toBe("5");
  });

  it("starts a fresh bucket after expiry and keeps keys independent", () => {
    process.env.NODE_ENV = "production";
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const limiter = createRateLimiter({
      windowMs: 1_000,
      max: 1,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
    });

    expect(runLimiter(limiter, "a").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "b").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "a").res.status).toHaveBeenCalledWith(429);

    now.mockReturnValue(11_000);
    const reset = runLimiter(limiter, "a");

    expect(reset.next).toHaveBeenCalledTimes(1);
    expect(reset.res.status).not.toHaveBeenCalled();
  });

  it("prunes expired buckets once many keys have accumulated", () => {
    process.env.NODE_ENV = "production";
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const limiter = createRateLimiter({
      windowMs: 1,
      max: 1,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
    });

    for (let i = 0; i < 5_001; i += 1) {
      expect(runLimiter(limiter, `key-${i}`).next).toHaveBeenCalledTimes(1);
    }

    now.mockReturnValue(20_002);
    const afterPrune = runLimiter(limiter, "fresh");

    expect(afterPrune.next).toHaveBeenCalledTimes(1);
    expect(afterPrune.res.status).not.toHaveBeenCalled();
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

  it("TS fingerprint format agrees with the embedded-python (paramiko) form", () => {
    // The TS `fingerprintOf` (exercised via parseKnownHosts) and `fetchHostKey`'s
    // embedded paramiko script must compute the SAME SHA256: form, or trusting a
    // host via add_host would store a fingerprint hex-ssh can never match. Drive
    // BOTH off one valid key blob and assert they agree — guards a silent drift.
    const validKeyBase64 = "bm9haC1hbG1pZ2h0eS1zc2gtdHJ1c3QtZmluZ2VycHJpbnQtYWdyZWVtZW50LWZpeHR1cmU=";
    const tsFingerprint = parseKnownHosts(line("h.example", validKeyBase64))[0].fingerprint;
    // The exact expression fetchHostKey runs (sshTrust.ts), fed the same raw bytes.
    const pyFingerprint = execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys, base64, hashlib",
          "raw = base64.b64decode(sys.argv[1])",
          'print("SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("="))',
        ].join("\n"),
        validKeyBase64,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(tsFingerprint).toBe(pyFingerprint);
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

    expect(SSH_TRUST_SERVER_NAME).toBe("ssh_trust");
    expect(SSH_TRUST_TOOL_NAMES).toContain("mcp__ssh_trust__add_host");

    const empty = await callTool(tools, "list_hosts", {});
    expect(empty.content[0].text).toContain("No trusted hosts");

    const file = knownHostsPath(ownerId, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line("5.5.5.5")}\n`);
    const listed = await callTool(tools, "list_hosts", {});
    expect(listed.content[0].text).toContain("5.5.5.5");

    const gone = await callTool(tools, "remove_host", { host: "5.5.5.5" });
    expect(gone.content[0].text).toContain("Removed");
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

    const generated = await callTool(tools, "generate_key", { comment: "avatar-chat-owner" });
    expect(generated.isError).toBeFalsy();
    expect(generated.content[0].text).toContain("Public key:");
    expect(generated.content[0].text).not.toContain("BEGIN OPENSSH PRIVATE KEY");

    const user = store.getUserById(owner.id)!;
    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(store.getUserSecrets(owner.id).SSH_PRIVATE_KEY).toContain("BEGIN OPENSSH PRIVATE KEY");

    const shown = await callTool(tools, "show_public_key", {});
    expect(shown.content[0].text).toContain(user.sshPublicKey!);

    const second = await callTool(tools, "generate_key", { comment: "again" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("An SSH key is already configured");
  });

  it("refuses key management to non-owner viewers", async () => {
    const { store, owner } = makeStore();
    const tools = buildSshIdentityTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      viewerIsOwner: false,
    });

    const res = await callTool(tools, "generate_key", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("avatar owner is present");
    expect(store.listUserSecretNames(owner.id)).toEqual([]);
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


describe("git token secret storage", () => {
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
    expect(user.secretNames).toContain(INTERNAL_GIT_TOKEN_SECRET_NAME);
    expect(store.getUserSecrets(ownerId)[INTERNAL_GIT_TOKEN_SECRET_NAME]).toBe("ghp_secretvalue");
    // Server-side decryption recovers the plaintext for git auth.
    expect(store.getGitToken(ownerId)).toBe("ghp_secretvalue");
  });

  it("clears the token", () => {
    const { store, ownerId } = makeStore("gt2");
    store.setGitToken(ownerId, "ghp_x");
    const cleared = store.setGitToken(ownerId, null);
    expect(cleared.gitTokenSet).toBe(false);
    expect(cleared.secretNames).not.toContain(INTERNAL_GIT_TOKEN_SECRET_NAME);
    expect(store.getGitToken(ownerId)).toBeNull();
  });

  it("stores the external github.com token as a separate user secret", () => {
    const { store, ownerId } = makeStore("gt-external");
    store.setUserSecret(ownerId, EXTERNAL_GIT_TOKEN_SECRET_NAME, "ghp_external");
    expect(store.getExternalGitToken(ownerId)).toBe("ghp_external");
    expect(store.getGitTokens(ownerId)).toMatchObject({
      internal: null,
      external: "ghp_external",
    });
    expect(store.getUserById(ownerId)!.secretNames).toContain(EXTERNAL_GIT_TOKEN_SECRET_NAME);
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
