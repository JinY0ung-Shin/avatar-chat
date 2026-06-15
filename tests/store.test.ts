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
  buildImageQueryPrompt,
  buildPreToolUseHook,
  buildPrompt,
  deriveAgentToolAccess,
  interpretResult,
  resultErrorMessage,
  rewriteBashCommandWithRtk,
  sshMcpSecretEnv,
} from "../src/server/agent/claudeAgent.js";
import { executeRoutineJob, startRoutineScheduler } from "../src/server/scheduler.js";
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
import type { AgentImageInput, AppConfig, Plugin } from "../src/server/types.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../src/server/hexSshPolicy.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
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
    store.setAgentSessionId(ownerId, "conv-2", "sess-aaa");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-aaa");
    store.setAgentSessionId(ownerId, "conv-2", "sess-bbb");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-bbb");
  });

  it("does not leak a session id across owners", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-3", ownerId, "hi");
    store.setAgentSessionId(ownerId, "conv-3", "sess-ccc");
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    expect(store.getAgentSessionId(other.id, "conv-3")).toBeNull();
    // A different owner can't overwrite it either — the UPDATE is owner-scoped.
    store.setAgentSessionId(other.id, "conv-3", "sess-evil");
    expect(store.getAgentSessionId(ownerId, "conv-3")).toBe("sess-ccc");
  });

  it("returns a conversation avatar only to its owner", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "avatar", displayName: "Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-4", avatar.id, "hi");
    const other = store.createUser({ username: "viewer", displayName: "Viewer", password: "password123" });

    expect(store.getConversationAvatarId(ownerId, "conv-4")).toBe(avatar.id);
    expect(store.getConversationAvatarId(other.id, "conv-4")).toBeNull();
  });

  it("tracks the per-conversation group-knowledge OFF set (default all-on), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-gk", ownerId, "hi");
    // Default: nothing disabled → every group on.
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual([]);
    // Replace the OFF set (dedupes, drops falsy); empty clears it.
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g1", "g2", "g1", ""]);
    expect(new Set(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk"))).toEqual(new Set(["g1", "g2"]));
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g2"]);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual(["g2"]);
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", []);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual([]);
    // Another owner can't read or mutate this conversation's setting.
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g2"]);
    const other = store.createUser({ username: "gkother", displayName: "Other", password: "password123" });
    expect(store.getConversationGroupKnowledgeOff(other.id, "conv-gk")).toEqual([]);
    store.setConversationGroupKnowledgeOff(other.id, "conv-gk", ["g3"]);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual(["g2"]);
  });

  it("round-trips the per-conversation model tier (null default), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-model", ownerId, "hi");
    // Default: no tier chosen → null (server default resolution).
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    store.setConversationModel(ownerId, "conv-model", "opus");
    expect(store.getConversationModel(ownerId, "conv-model")).toBe("opus");
    // Empty / null clears back to the default.
    store.setConversationModel(ownerId, "conv-model", "");
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    store.setConversationModel(ownerId, "conv-model", "sonnet");
    store.setConversationModel(ownerId, "conv-model", null);
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    // Another owner can't read or mutate this conversation's tier.
    store.setConversationModel(ownerId, "conv-model", "haiku");
    const other = store.createUser({ username: "modelother", displayName: "Other", password: "password123" });
    expect(store.getConversationModel(other.id, "conv-model")).toBeNull();
    store.setConversationModel(other.id, "conv-model", "opus");
    expect(store.getConversationModel(ownerId, "conv-model")).toBe("haiku");
  });

  it("round-trips the per-conversation effort level (null default), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-effort", ownerId, "hi");
    // Default: no effort chosen → null (SDK default resolution).
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    store.setConversationEffort(ownerId, "conv-effort", "max");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBe("max");
    // Empty / null clears back to the default.
    store.setConversationEffort(ownerId, "conv-effort", "");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    store.setConversationEffort(ownerId, "conv-effort", "low");
    store.setConversationEffort(ownerId, "conv-effort", null);
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    // Another owner can't read or mutate this conversation's effort.
    store.setConversationEffort(ownerId, "conv-effort", "xhigh");
    const other = store.createUser({ username: "effortother", displayName: "Other", password: "password123" });
    expect(store.getConversationEffort(other.id, "conv-effort")).toBeNull();
    store.setConversationEffort(other.id, "conv-effort", "high");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBe("xhigh");
  });

  it("attaches an activity snapshot to a stored message, owner-scoped, clearing when empty", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-act", ownerId, "hi");
    const msg = store.addMessage("conv-act", { role: "assistant", content: "done", response: { kind: "text", runtime: "claude", summary: "", text: "done" } });
    const activity = {
      agents: [{ id: "main", parentId: "", label: "", status: "done" as const, isMain: true }],
      tools: [{ id: "t1", agentId: "main", kind: "tool" as const, label: "파일 읽기", detail: "a.ts", status: "done" as const }],
    };
    expect(store.setMessageActivity(ownerId, msg.id, activity)).toBe(true);
    expect(store.listMessages(ownerId, "conv-act")[0].response?.activity).toEqual(activity);
    // Empty tools clears it back off the response.
    expect(store.setMessageActivity(ownerId, msg.id, { agents: [], tools: [] })).toBe(true);
    expect(store.listMessages(ownerId, "conv-act")[0].response?.activity).toBeUndefined();
    // A different owner can't attach to someone else's message.
    const other = store.createUser({ username: "actother", displayName: "Other", password: "password123" });
    expect(store.setMessageActivity(other.id, msg.id, activity)).toBe(false);
    // A message with no stored response can't carry activity.
    const bare = store.addMessage("conv-act", { role: "user", content: "hi" });
    expect(store.setMessageActivity(ownerId, bare.id, activity)).toBe(false);
  });

  it("persists task-only activity snapshots and deletes only regular chats in bulk", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "taskavatar", displayName: "Task Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-task-only", avatar.id, "hi");
    const msg = store.addMessage("conv-task-only", {
      role: "assistant",
      content: "done",
      response: { kind: "text", runtime: "claude", summary: "", text: "done" },
    });
    const activity = {
      agents: [{ id: "main", parentId: "", label: "", status: "done" as const, isMain: true }],
      tools: [],
      tasks: [{ id: "task-1", agentId: "main", label: "리서치", detail: "자료 확인", status: "done" as const }],
    };
    expect(store.setMessageActivity(ownerId, msg.id, activity)).toBe(true);
    expect(store.listMessages(ownerId, "conv-task-only")[0].response?.activity).toEqual(activity);

    store.touchConversation(ownerId, "conv-routine", avatar.id, "routine", { isRoutine: true });
    const other = store.createUser({ username: "bulkother", displayName: "Other", password: "password123" });
    store.touchConversation(other.id, "conv-other", other.id, "other");

    expect(new Set(store.deleteChatConversations(ownerId))).toEqual(new Set(["conv-task-only"]));
    expect(store.listConversations(ownerId)).toHaveLength(0);
    expect(store.listConversations(ownerId, undefined, "routine").map((c) => c.id)).toEqual(["conv-routine"]);
    expect(store.listConversations(other.id).map((c) => c.id)).toEqual(["conv-other"]);
  });

  it("round-trips the per-user default group-knowledge OFF set (seeds new conversations)", () => {
    const { store, ownerId } = makeStore();
    // Default on a fresh user: every group on.
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual([]);
    // Saving the default surfaces on the User; [] clears it back to "all on".
    expect(store.setGroupKnowledgeOffDefault(ownerId, ["g1", "g2"]).groupKnowledgeOffDefault).toEqual(["g1", "g2"]);
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual(["g1", "g2"]);
    expect(store.setGroupKnowledgeOffDefault(ownerId, []).groupKnowledgeOffDefault).toEqual([]);
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual([]);
  });
});

describe("agent image prompt", () => {
  it("builds a single SDK user message with text and image content blocks", async () => {
    const image: AgentImageInput = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    const messages: Record<string, any>[] = [];
    for await (const message of buildImageQueryPrompt("이 이미지 봐줘", [image])) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("user");
    expect(messages[0].parent_tool_use_id).toBeNull();
    expect(messages[0].shouldQuery).toBe(true);
    expect(messages[0].uuid).toEqual(expect.any(String));
    expect(messages[0].message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "이 이미지 봐줘" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    });
  });
});


describe("routineSchedule", () => {
  // Fixed UTC+9 KST math, no DST.
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The KST wall-clock minute-of-day of a UTC instant.
  function kstMinuteOfDay(iso: string): number {
    const kstMs = new Date(iso).getTime() + KST_OFFSET_MS;
    return Math.floor((kstMs % DAY_MS) / 60_000);
  }
  // The KST weekday (0=Sun..6=Sat) of a UTC instant.
  function kstWeekday(iso: string): number {
    const kstMs = new Date(iso).getTime() + KST_OFFSET_MS;
    return (((Math.floor(kstMs / DAY_MS) + 4) % 7) + 7) % 7;
  }

  it("formatMinuteOfDay renders zero-padded HH:MM", () => {
    expect(formatMinuteOfDay(0)).toBe("00:00");
    expect(formatMinuteOfDay(9 * 60 + 5)).toBe("09:05");
    expect(formatMinuteOfDay(1439)).toBe("23:59");
  });

  it("parseTimeToMinute parses valid times and rejects junk", () => {
    expect(parseTimeToMinute("00:00")).toBe(0);
    expect(parseTimeToMinute("09:30")).toBe(9 * 60 + 30);
    expect(parseTimeToMinute("23:59")).toBe(1439);
    expect(parseTimeToMinute("  09:30  ")).toBe(9 * 60 + 30);
    expect(parseTimeToMinute("24:00")).toBeNull();
    expect(parseTimeToMinute("09:60")).toBeNull();
    expect(parseTimeToMinute("9:5")).toBeNull();
    expect(parseTimeToMinute("nope")).toBeNull();
    expect(parseTimeToMinute(930)).toBeNull();
    expect(parseTimeToMinute(undefined)).toBeNull();
    expect(parseTimeToMinute(null)).toBeNull();
  });

  describe("parseRoutineSchedule", () => {
    it("defaults to a daily schedule when scheduleKind is absent", () => {
      const res = parseRoutineSchedule({ time: "09:30" });
      expect(res).toEqual({
        ok: true,
        value: { kind: "daily", minuteOfDay: 9 * 60 + 30, daysOfWeek: null, intervalMinutes: null },
      });
    });

    it("parses an explicit daily schedule", () => {
      const res = parseRoutineSchedule({ scheduleKind: "daily", time: "07:00" });
      expect(res).toEqual({
        ok: true,
        value: { kind: "daily", minuteOfDay: 7 * 60, daysOfWeek: null, intervalMinutes: null },
      });
    });

    it("parses a weekly schedule and normalizes days to sorted-unique", () => {
      const res = parseRoutineSchedule({
        scheduleKind: "weekly",
        time: "08:15",
        daysOfWeek: [5, 1, 1, 3],
      });
      expect(res).toEqual({
        ok: true,
        value: { kind: "weekly", minuteOfDay: 8 * 60 + 15, daysOfWeek: [1, 3, 5], intervalMinutes: null },
      });
    });

    it("parses an interval schedule", () => {
      const res = parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 90 });
      expect(res).toEqual({
        ok: true,
        value: { kind: "interval", minuteOfDay: 0, daysOfWeek: null, intervalMinutes: 90 },
      });
    });

    it("returns each ScheduleError code for the matching invalid input", () => {
      expect(parseRoutineSchedule({ scheduleKind: "monthly" })).toEqual({
        ok: false,
        error: "INVALID_KIND",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily" })).toEqual({
        ok: false,
        error: "TIME_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily", time: "" })).toEqual({
        ok: false,
        error: "TIME_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily", time: "25:00" })).toEqual({
        ok: false,
        error: "INVALID_TIME",
      });
      expect(parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00" })).toEqual({
        ok: false,
        error: "DAYS_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [] })).toEqual({
        ok: false,
        error: "DAYS_REQUIRED",
      });
      expect(
        parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [7] }),
      ).toEqual({ ok: false, error: "INVALID_DAYS" });
      expect(
        parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [1.5] }),
      ).toEqual({ ok: false, error: "INVALID_DAYS" });
      expect(parseRoutineSchedule({ scheduleKind: "interval" })).toEqual({
        ok: false,
        error: "INTERVAL_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 10 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 10081 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 30.5 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
    });
  });

  describe("nextRunIso", () => {
    it("daily: lands on the requested KST minute, strictly after `from`", () => {
      const from = new Date("2026-06-13T00:00:00.000Z"); // 09:00 KST
      const iso = nextRunIso(
        { kind: "daily", minuteOfDay: 9 * 60 + 30, daysOfWeek: null, intervalMinutes: null },
        from,
      );
      expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime());
      expect(kstMinuteOfDay(iso)).toBe(9 * 60 + 30);
    });

    it("daily: rolls to tomorrow when today's slot already passed", () => {
      const from = new Date("2026-06-13T01:00:00.000Z"); // 10:00 KST
      const iso = nextRunIso(
        { kind: "daily", minuteOfDay: 9 * 60, daysOfWeek: null, intervalMinutes: null },
        from,
      );
      expect(kstMinuteOfDay(iso)).toBe(9 * 60);
      // 9:00 KST already passed at 10:00 KST → next slot is the following day.
      expect(new Date(iso).getTime() - from.getTime()).toBeGreaterThan(20 * 60 * 60 * 1000);
    });

    it("weekly: returns the soonest matching weekday slot in KST, strictly after `from`", () => {
      // 2026-06-13 is a Saturday; 2026-06-13T00:00Z is 09:00 KST Saturday.
      const from = new Date("2026-06-13T00:00:00.000Z");
      expect(kstWeekday(from.toISOString())).toBe(6);
      // Schedule for Monday(1)/Wednesday(3) at 08:00 KST → next is Monday.
      const iso = nextRunIso(
        { kind: "weekly", minuteOfDay: 8 * 60, daysOfWeek: [1, 3], intervalMinutes: null },
        from,
      );
      expect(kstWeekday(iso)).toBe(1);
      expect(kstMinuteOfDay(iso)).toBe(8 * 60);
      expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime());
    });

    it("weekly: same weekday but earlier slot today rolls a full week forward", () => {
      // Saturday 09:00 KST `from`; schedule Saturday(6) at 08:00 KST (already past today).
      const from = new Date("2026-06-13T00:00:00.000Z");
      const iso = nextRunIso(
        { kind: "weekly", minuteOfDay: 8 * 60, daysOfWeek: [6], intervalMinutes: null },
        from,
      );
      expect(kstWeekday(iso)).toBe(6);
      const days = (new Date(iso).getTime() - from.getTime()) / DAY_MS;
      expect(days).toBeGreaterThan(6);
      expect(days).toBeLessThan(8);
    });

    it("interval: exactly from + intervalMinutes", () => {
      const from = new Date("2026-06-13T12:00:00.000Z");
      const iso = nextRunIso(
        { kind: "interval", minuteOfDay: 0, daysOfWeek: null, intervalMinutes: 45 },
        from,
      );
      expect(new Date(iso).getTime()).toBe(from.getTime() + 45 * 60_000);
    });
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

  it("legacy { prompt, minuteOfDay } calls still behave as a daily schedule", () => {
    const { store, ownerId } = makeStore("rj-legacy");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 9 * 60 });
    expect(job.scheduleKind).toBe("daily");
    expect(job.daysOfWeek).toBeNull();
    expect(job.intervalMinutes).toBeNull();
    expect(job.time).toBe("09:00");
    expect(job.nextRunAt).toBeTruthy();
  });

  it("persists a weekly schedule (daysOfWeek + future next run)", () => {
    const { store, ownerId } = makeStore("rj-weekly");
    const job = store.createRoutineJob(ownerId, {
      name: "주간",
      prompt: "p",
      scheduleKind: "weekly",
      minuteOfDay: 8 * 60,
      daysOfWeek: [1, 3, 5],
    });
    expect(job.scheduleKind).toBe("weekly");
    expect(job.daysOfWeek).toEqual([1, 3, 5]);
    expect(job.intervalMinutes).toBeNull();
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    // Round-trips through toRoutineJob after reload.
    const reloaded = store.listRoutineJobs(ownerId)[0];
    expect(reloaded.name).toBe("주간");
    expect(reloaded.daysOfWeek).toEqual([1, 3, 5]);
    expect(reloaded.scheduleKind).toBe("weekly");
  });

  it("persists an interval schedule (intervalMinutes)", () => {
    const { store, ownerId } = makeStore("rj-interval");
    const job = store.createRoutineJob(ownerId, {
      prompt: "p",
      scheduleKind: "interval",
      intervalMinutes: 45,
    });
    expect(job.scheduleKind).toBe("interval");
    expect(job.intervalMinutes).toBe(45);
    expect(job.daysOfWeek).toBeNull();
    expect(job.name).toBeNull();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const reloaded = store.listRoutineJobs(ownerId)[0];
    expect(reloaded.intervalMinutes).toBe(45);
    expect(reloaded.scheduleKind).toBe("interval");
  });

  it("a name-only edit does not reschedule, but a schedule change does", () => {
    const { store, ownerId } = makeStore("rj-name-vs-sched");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 300 });
    // Name-only: nextRunAt preserved.
    const renamed = store.updateRoutineJob(ownerId, job.id, { name: "라벨" });
    expect(renamed?.name).toBe("라벨");
    expect(renamed?.nextRunAt).toBe(job.nextRunAt);
    // name=null clears the label, still no reschedule.
    const cleared = store.updateRoutineJob(ownerId, job.id, { name: null });
    expect(cleared?.name).toBeNull();
    expect(cleared?.nextRunAt).toBe(job.nextRunAt);
    // Switching to a weekly schedule recomputes nextRunAt.
    const rescheduled = store.updateRoutineJob(ownerId, job.id, {
      scheduleKind: "weekly",
      minuteOfDay: 8 * 60,
      daysOfWeek: [2],
    });
    expect(rescheduled?.scheduleKind).toBe("weekly");
    expect(rescheduled?.daysOfWeek).toEqual([2]);
    expect(rescheduled?.nextRunAt).not.toBe(job.nextRunAt);
    expect(new Date(rescheduled!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("markRoutineRun rolls an interval job forward by its interval", () => {
    const { store, ownerId } = makeStore("rj-mark-interval");
    const job = store.createRoutineJob(ownerId, {
      prompt: "p",
      scheduleKind: "interval",
      intervalMinutes: 30,
    });
    store.markRoutineRun(job.id, { status: "success" });
    const after = store.listRoutineJobs(ownerId)[0];
    expect(after.scheduleKind).toBe("interval");
    expect(after.lastStatus).toBe("success");
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("creates the dedicated conversation eagerly, titled from the prompt", () => {
    const { store, ownerId } = makeStore("rj-conv");
    const job = store.createRoutineJob(ownerId, { prompt: "매일 상태 요약", minuteOfDay: 540 });
    expect(store.listConversations(ownerId).some((c) => c.id === job.conversationId)).toBe(false);
    const conv = store.listConversations(ownerId, undefined, "routine").find((c) => c.id === job.conversationId);
    expect(conv).toBeTruthy();
    expect(conv!.title.startsWith("[루틴]")).toBe(true);
    expect(conv!.isRoutine).toBe(true);
    expect(conv!.routineId).toBe(job.id);
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

  it("executeRoutineJob records an error when the avatar no longer exists", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-missing-avatar"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const job = {
      id: "missing-job",
      avatarUserId: "missing-avatar",
      conversationId: "missing-conversation",
      name: null,
      prompt: "안녕",
      scheduleKind: "daily",
      minuteOfDay: 0,
      time: "00:00",
      daysOfWeek: null,
      intervalMinutes: null,
      enabled: true,
      nextRunAt: new Date().toISOString(),
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      createdAt: new Date().toISOString(),
    } as const;

    const result = await executeRoutineJob(services, job);

    expect(result).toEqual({ ok: false, error: "아바타를 찾을 수 없습니다." });
  });

  it("executeRoutineJob releases the overlap guard when outcome recording fails", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-record-fail"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });
    const markRoutineRun = services.store.markRoutineRun.bind(services.store);
    vi.spyOn(services.store, "markRoutineRun")
      .mockImplementationOnce(() => {
        throw new Error("db write failed");
      })
      .mockImplementation(markRoutineRun);

    const failed = await executeRoutineJob(services, job);
    const retried = await executeRoutineJob(services, job);

    expect(failed).toEqual({ ok: false, error: "db write failed" });
    expect(retried.ok).toBe(true);
  });

  it("startRoutineScheduler runs due jobs and survives list failures", async () => {
    vi.useFakeTimers();
    try {
      const services = createServices({
        dataDir: path.join(tempDir, "rj-scheduler"),
        agentRuntime: "local",
        sessionSecret: "t",
      });
      const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });
      vi.spyOn(services.store, "listDueRoutineJobs")
        .mockImplementationOnce(() => {
          throw new Error("temporary db failure");
        })
        .mockReturnValueOnce([job])
        .mockReturnValue([]);

      const stop = startRoutineScheduler(services, { tickMs: 10 });
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(services.store.listMessages(owner.id, job.conversationId)).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(10);
        expect(services.store.listMessages(owner.id, job.conversationId)).toHaveLength(2);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
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
    const nextRunMs = new Date(job.nextRunAt!).getTime();
    // Just before the scheduled instant, nothing is due.
    expect(store.listDueRoutineJobs(new Date(nextRunMs - 1000).toISOString())).toHaveLength(0);
    // Just after the scheduled instant, the job is due.
    const due = store.listDueRoutineJobs(new Date(nextRunMs + 1000).toISOString());
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


describe("group trust & visibility", () => {
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

  it("derives trust from group co-membership, symmetrically", () => {
    const { store, ownerId, friendId } = makeStore("gt1");
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    // Co-membership trusts both directions (unlike the old directional grant).
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.isTrustedFor(ownerId, friendId)).toBe(true);
    // Leaving the group revokes it.
    store.removeGroupMember(group.id, friendId);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
  });

  it("new avatars default to group visibility; updateProfile changes it", () => {
    const { store, ownerId } = makeStore("gt2");
    expect(store.getUserById(ownerId)?.visibility).toBe("group");
    expect(store.updateProfile(ownerId, { visibility: "public" }).visibility).toBe("public");
    expect(store.updateProfile(ownerId, { visibility: "private" }).visibility).toBe("private");
  });

  it("searchUsers matches name or @id (case-insensitive), excludes self", () => {
    const { store, ownerId } = makeStore("gt-search");
    // Substring match on display name AND username, case-insensitive.
    expect(store.searchUsers("frie", ownerId).map((u) => u.username)).toEqual(["friend"]);
    expect(store.searchUsers("STRANGER", ownerId).map((u) => u.username)).toEqual(["stranger"]);
    expect(store.searchUsers("r", ownerId).map((u) => u.username).sort()).toEqual(["friend", "stranger"]);
    // The searcher is never a candidate for their own results.
    expect(store.searchUsers("owner", ownerId)).toEqual([]);
    // Blank query short-circuits.
    expect(store.searchUsers("   ", ownerId)).toEqual([]);
    // A literal % isn't treated as a wildcard (escaped).
    expect(store.searchUsers("%", ownerId)).toEqual([]);
  });

  it("a group co-member resolves/sees a group-visible avatar; a stranger cannot", () => {
    const { store, ownerId, friendId, strangerId } = makeStore("gt3");
    // Owner keeps the default `group` visibility.
    expect(store.resolveChatAvatar(strangerId, ownerId)).toBeNull();
    expect(store.getAvatar(strangerId, ownerId)).toBeNull();
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    const detail = store.getAvatar(friendId, ownerId);
    expect(detail?.elevated).toBe(true);
    expect(detail?.isOwn).toBe(false);
  });

  it("a private avatar is reachable only by its owner, even by a group co-member", () => {
    const { store, ownerId, friendId } = makeStore("gt4");
    store.updateProfile(ownerId, { visibility: "private" });
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    // Group co-membership still grants elevation, but `private` blocks reach.
    expect(store.resolveChatAvatar(friendId, ownerId)).toBeNull();
    expect(store.getAvatar(friendId, ownerId)).toBeNull();
    // The owner always reaches their own avatar.
    expect(store.resolveChatAvatar(ownerId, ownerId)?.id).toBe(ownerId);
  });

  it("deleting a user clears their group memberships (and thus trust)", () => {
    const { store, ownerId, friendId } = makeStore("gt5");
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.deleteUser(friendId)).toBe(true);
    expect(store.listGroupMembers(group.id).map((m) => m.userId)).toEqual([ownerId]);
  });

  // ---- experimental features (#50) ----
  it("stores experimental features as a normalized key list (drops unknown)", () => {
    const { store, ownerId } = makeStore("ef1");
    expect(store.getUserById(ownerId)?.experimentalFeatures).toEqual([]);
    expect(store.getExperimentalFeatures(ownerId)).toEqual([]);
    // Unknown keys are dropped, known ones kept + deduped.
    const updated = store.updateProfile(ownerId, { experimentalFeatures: ["canvas", "canvas", "bogus"] });
    expect(updated.experimentalFeatures).toEqual(["canvas"]);
    expect(store.getExperimentalFeatures(ownerId)).toEqual(["canvas"]);
    // Clearing works.
    expect(store.updateProfile(ownerId, { experimentalFeatures: [] }).experimentalFeatures).toEqual([]);
  });
});


describe("normalizeHashtags", () => {
  it("strips leading #/markers, trims, hyphenates spaces, dedupes case-insensitively", () => {
    expect(normalizeHashtags(["#코드리뷰", "코드리뷰", "  - 파이썬 ", "데이터 분석"])).toEqual([
      "코드리뷰",
      "파이썬",
      "데이터-분석",
    ]);
  });
  it("keeps C#/C++ intact (only the LEADING # is removed)", () => {
    expect(normalizeHashtags(["C#", "C++"])).toEqual(["C#", "C++"]);
  });
  it("parses a raw string by splitting on whitespace/commas", () => {
    expect(normalizeHashtags("#a #b, c")).toEqual(["a", "b", "c"]);
  });
  it("caps the count at 12 and each tag at 30 chars", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(normalizeHashtags(many)).toHaveLength(12);
    expect(normalizeHashtags(["x".repeat(50)])[0]).toHaveLength(30);
  });
  it("ignores non-strings, empties, and bare punctuation", () => {
    expect(normalizeHashtags([123, "", "  ", "#", "ok"])).toEqual(["ok"]);
  });
});


describe("searchAvatars (cross-avatar discovery)", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "search"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    return store;
  }

  it("ranks a hashtag match above a body match and excludes the querying avatar", () => {
    const store = makeStore();
    const reviewer = store.createUser({ username: "reviewer", displayName: "리뷰어", password: "password123" });
    const analyst = store.createUser({ username: "analyst", displayName: "분석가", password: "password123" });
    const me = store.createUser({ username: "me", displayName: "나", password: "password123" });
    // Public so `me` (sharing no group) can discover them cross-avatar.
    store.updateProfile(reviewer.id, { hashtags: ["코드리뷰", "파이썬"], visibility: "public" });
    store.updateProfile(analyst.id, { hashtags: ["데이터분석"], bio: "코드리뷰도 가끔 합니다", visibility: "public" });

    const hits = store.searchAvatars(me.id, "코드리뷰", { excludeId: me.id });
    expect(hits.map((a) => a.username)).toEqual(["reviewer", "analyst"]);
    expect(hits.some((a) => a.username === "me")).toBe(false);
    expect(hits[0].hashtags).toContain("코드리뷰");
  });

  it("only surfaces avatars visible to the viewer (plus the viewer's own)", () => {
    const store = makeStore();
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const hidden = store.createUser({ username: "hidden", displayName: "H", password: "password123" });
    store.updateProfile(hidden.id, { hashtags: ["쿠버네티스"], visibility: "private" });

    expect(store.searchAvatars(a.id, "쿠버네티스")).toHaveLength(0);
    // The owner still finds their OWN non-visible avatar.
    expect(store.searchAvatars(hidden.id, "쿠버네티스").map((x) => x.username)).toContain("hidden");
  });

  it("lists candidates for an empty query, excluding self", () => {
    const store = makeStore();
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const b = store.createUser({ username: "b", displayName: "B", password: "password123" });
    // b must be public to be discoverable by a (who shares no group with b).
    store.updateProfile(b.id, { visibility: "public" });
    expect(store.searchAvatars(a.id, "", { excludeId: a.id }).map((x) => x.username)).toEqual(["b"]);
  });
});


describe("store groups", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const admin = store.createUser({ username: "admin", displayName: "Admin", password: "password123" });
    const alice = store.createUser({ username: "alice", displayName: "Alice", password: "password123" });
    const bob = store.createUser({ username: "bob", displayName: "Bob", password: "password123" });
    const carol = store.createUser({ username: "carol", displayName: "Carol", password: "password123" });
    return { store, adminId: admin.id, aliceId: alice.id, bobId: bob.id, carolId: carol.id };
  }

  it("creates, lists, updates, and deletes groups", () => {
    const { store } = makeStore("g-crud");
    const g = store.createGroup({ name: "Team A", description: "desc", createdBy: null });
    expect(g.name).toBe("Team A");
    expect(store.getGroup(g.id)?.description).toBe("desc");
    expect(store.listGroups().map((x) => x.name)).toContain("Team A");
    expect(store.listGroups()[0].memberCount).toBe(0);
    store.updateGroup(g.id, { name: "Team B" });
    expect(store.getGroup(g.id)?.name).toBe("Team B");
    expect(store.deleteGroup(g.id)).toBe(true);
    expect(store.getGroup(g.id)).toBeNull();
  });

  it("manages members + roles", () => {
    const { store, aliceId, bobId } = makeStore("g-mem");
    const g = store.createGroup({ name: "T", createdBy: null });
    expect(store.addGroupMember(g.id, aliceId, "admin")?.role).toBe("admin");
    expect(store.addGroupMemberByUsername(g.id, "bob")?.role).toBe("member");
    expect(store.groupRoleFor(aliceId, g.id)).toBe("admin");
    expect(store.isGroupAdmin(aliceId, g.id)).toBe(true);
    expect(store.isGroupAdmin(bobId, g.id)).toBe(false);
    expect(store.listGroupMembers(g.id).map((m) => m.userId).sort()).toEqual([aliceId, bobId].sort());
    expect(store.setGroupMemberRole(g.id, bobId, "admin")?.role).toBe("admin");
    expect(store.listGroups()[0].adminCount).toBe(2);
    expect(store.removeGroupMember(g.id, bobId)).toBe(true);
    expect(store.groupRoleFor(bobId, g.id)).toBeNull();
    expect(store.addGroupMemberByUsername(g.id, "nobody")).toBeNull();
  });

  it("group co-membership grants mutual, symmetric trust + group-visible-avatar access", () => {
    const { store, aliceId, bobId, carolId } = makeStore("g-trust");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId, "member");
    store.addGroupMember(g.id, bobId, "member");
    // Group trust is symmetric.
    expect(store.isTrustedFor(aliceId, bobId)).toBe(true);
    expect(store.isTrustedFor(bobId, aliceId)).toBe(true);
    expect(store.isTrustedFor(carolId, aliceId)).toBe(false);
    // alice keeps the default `group` visibility — bob (co-member) reaches her
    // avatar at elevated level; carol (not a teammate) cannot.
    expect(store.getAvatar(bobId, aliceId)?.elevated).toBe(true);
    expect(store.getAvatar(carolId, aliceId)).toBeNull();
    expect(store.resolveChatAvatar(bobId, aliceId)?.id).toBe(aliceId);
  });

  it("removing the shared group drops the auto-trust", () => {
    const { store, aliceId, bobId } = makeStore("g-trust-drop");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(true);
    store.deleteGroup(g.id);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(false);
  });

  it("deleting a user removes their group memberships (and the trust they conferred)", () => {
    const { store, aliceId, bobId } = makeStore("g-cascade");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    expect(store.deleteUser(bobId)).toBe(true);
    expect(store.listGroupMembers(g.id).map((m) => m.userId)).toEqual([aliceId]);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(false);
  });

  it("toUser exposes group memberships with role", () => {
    const { store, aliceId } = makeStore("g-user");
    const g = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(g.id, aliceId, "admin");
    const u = store.getUserById(aliceId);
    expect(u?.groups.map((x) => x.name)).toEqual(["Team"]);
    expect(u?.groups[0].role).toBe("admin");
  });

  it("group knowledge repo: setting it clears selection; lists per-user repos", () => {
    const { store, aliceId, bobId } = makeStore("g-repo");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    expect(store.getGroupKnowledgeRepo(g.id).repo).toBeNull();
    store.setGroupKnowledgeRepo(g.id, "org/team-knowledge", "main");
    store.setGroupKnowledgeSelected(g.id, ["a"]);
    expect(store.getGroupKnowledgeRepo(g.id).selected).toEqual(["a"]);
    store.setGroupKnowledgeRepo(g.id, "org/other", null);
    expect(store.getGroupKnowledgeRepo(g.id).selected).toBeNull();
    const repos = store.listGroupKnowledgeReposForUser(aliceId);
    expect(repos.map((r) => r.repo)).toEqual(["org/other"]);
    // bob isn't in the group → sees no group repos.
    expect(store.listGroupKnowledgeReposForUser(bobId)).toEqual([]);
  });

  it("listPublishedAvatars surfaces group-visible teammates with sharesGroup", () => {
    const { store, aliceId, bobId, carolId } = makeStore("g-explore");
    // bob keeps default `group` visibility; carol is public, in no shared group.
    store.updateProfile(carolId, { visibility: "public" });
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    const forAlice = store.listPublishedAvatars(aliceId);
    const bobCard = forAlice.find((a) => a.id === bobId);
    // bob is group-visible AND a teammate → visible + flagged.
    expect(bobCard?.sharesGroup).toBe(true);
    // carol (public, no shared group) is visible but not flagged.
    expect(forAlice.find((a) => a.id === carolId)?.sharesGroup).toBe(false);
  });
});
