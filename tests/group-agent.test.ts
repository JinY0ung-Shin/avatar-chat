import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { callTool, makeBareRemote, parseSse, signup, withTempDir } from "./helpers.js";

// Mocked agent layer (routes-chat.test.ts pattern): captures the AgentRequest
// each chat turn builds so the group-agent run wiring can be asserted without
// spawning the SDK.
const H = vi.hoisted(() => ({ requests: [] as AgentRequest[] }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      _pluginRoots: unknown,
      config: AppConfig,
      _store: unknown,
      events: AgentEvents,
    ) => {
      H.requests.push(agentRequest);
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.("[mock]");
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "[mock]" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";
import {
  findChattableGroupAgent,
  groupAgentAvatarId,
  groupAgentCaptureAllowed,
  parseGroupAgentGroupId,
} from "../src/server/groupAgents.js";
import {
  buildPrompt,
  deriveAgentToolAccess,
  planMcpToolFamilies,
} from "../src/server/agent/claudeAgent.js";
import { summarizeGroupAgentState } from "../src/server/agent/ownerState.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import { buildGroupAgentRepoTools, GROUP_AGENT_REPO_TOOL_NAMES } from "../src/server/agent/groupRepoTools.js";
import { buildGroupAgentBrainTools } from "../src/server/agent/groupBrainTools.js";
import { buildSystemTools } from "../src/server/agent/systemTools.js";
import { groupKnowledgeClonePath } from "../src/server/groupKnowledgeRepo.js";

const tempDir = withTempDir("group-agent");

function services(dir: string) {
  return createServices({
    dataDir: path.join(tempDir(), dir),
    agentRuntime: "local",
    sessionSecret: "t",
  });
}

describe("store group agents", () => {
  it("upserts one agent per group, normalizing capture scope and hashtags", () => {
    const { store } = services("crud");
    const group = store.createGroup({ name: "Platform" });
    expect(store.getGroupAgent(group.id)).toBeNull();
    // Ghost group fails closed.
    expect(store.upsertGroupAgent("ghost", { displayName: "X" })).toBeNull();

    const created = store.upsertGroupAgent(group.id, {
      displayName: "  플랫폼 도우미  ",
      hashtags: ["#Infra", "infra", "런북"],
      createdBy: "admin-1",
    })!;
    expect(created.displayName).toBe("플랫폼 도우미");
    expect(created.captureScope).toBe("members"); // default
    expect(created.enabled).toBe(true);
    // normalizeHashtags strips "#" and dedupes case-insensitively (first wins).
    expect(created.hashtags).toEqual(["Infra", "런북"]);
    expect(created.createdBy).toBe("admin-1");

    // Update keeps created_*, merges unspecified fields, validates scope on read.
    const updated = store.upsertGroupAgent(group.id, {
      displayName: "플랫폼 도우미",
      captureScope: "admins",
      persona: "친절하게",
      createdBy: "someone-else",
    })!;
    expect(updated.captureScope).toBe("admins");
    expect(updated.persona).toBe("친절하게");
    expect(updated.hashtags).toEqual(["Infra", "런북"]); // carried over
    expect(updated.createdBy).toBe("admin-1"); // insert-only

    expect(store.setGroupAgentEnabled(group.id, false)?.enabled).toBe(false);
    expect(store.setGroupAgentEnabled("ghost", false)).toBeNull();

    store.setGroupAgentImageExt(group.id, "png");
    expect(store.getGroupAgentImageExtByAvatarId(groupAgentAvatarId(group.id))).toBe("png");
    expect(store.getGroupAgentImageExtByAvatarId("group:")).toBeNull();
    expect(store.getGroupAgentImageExtByAvatarId("not-a-group-id")).toBeNull();
  });

  it("lists ENABLED agents of the viewer's groups only", () => {
    const { store } = services("list");
    const me = store.createUser({ username: "me", displayName: "나", password: "password123" });
    const g1 = store.createGroup({ name: "Mine" });
    const g2 = store.createGroup({ name: "Other" });
    const g3 = store.createGroup({ name: "MineDisabled" });
    store.addGroupMember(g1.id, me.id, "admin");
    store.addGroupMember(g3.id, me.id, "member");
    store.upsertGroupAgent(g1.id, { displayName: "A1" });
    store.upsertGroupAgent(g2.id, { displayName: "A2" }); // not my group
    store.upsertGroupAgent(g3.id, { displayName: "A3", enabled: false });

    const listed = store.listGroupAgentsForUser(me.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ groupName: "Mine", viewerRole: "admin" });
    expect(listed[0].agent.displayName).toBe("A1");
  });

  it("deleteGroup cascades the agent row + every member's agent conversations", () => {
    const { store } = services("cascade");
    const member = store.createUser({ username: "m", displayName: "M", password: "password123" });
    const group = store.createGroup({ name: "Doomed" });
    const other = store.createGroup({ name: "Survivor" });
    store.addGroupMember(group.id, member.id, "member");
    store.upsertGroupAgent(group.id, { displayName: "Doomed Agent" });
    store.upsertGroupAgent(other.id, { displayName: "Survivor Agent" });

    const agentId = groupAgentAvatarId(group.id);
    store.touchConversation(member.id, "ga-conv", agentId, "질문");
    store.addMessage("ga-conv", { role: "user", content: "안녕" });
    // A personal conversation must survive the group deletion.
    store.touchConversation(member.id, "self-conv", member.id, "메모");

    expect(store.deleteGroup(group.id)).toBe(true);
    expect(store.getGroupAgent(group.id)).toBeNull();
    expect(store.countConversationsForAvatar(agentId)).toBe(0);
    expect(store.listMessages(member.id, "ga-conv")).toEqual([]);
    expect(store.countConversationsForAvatar(member.id)).toBe(1);
    expect(store.getGroupAgent(other.id)?.displayName).toBe("Survivor Agent");
  });

  it("deleteUser removes their agent threads but not other members'", () => {
    const { store } = services("del-user");
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const b = store.createUser({ username: "b", displayName: "B", password: "password123" });
    const group = store.createGroup({ name: "Team" });
    store.addGroupMember(group.id, a.id, "member");
    store.addGroupMember(group.id, b.id, "member");
    store.upsertGroupAgent(group.id, { displayName: "팀 에이전트" });
    const agentId = groupAgentAvatarId(group.id);
    store.touchConversation(a.id, "a-conv", agentId, "a의 질문");
    store.touchConversation(b.id, "b-conv", agentId, "b의 질문");

    expect(store.deleteUser(a.id)).toBe(true);
    expect(store.countConversationsForAvatar(agentId)).toBe(1);
    expect(store.getGroupAgent(group.id)).not.toBeNull();
  });

  it("resolves the agent display name in conversation summaries (no '삭제된 아바타')", () => {
    const { store } = services("conv-name");
    const me = store.createUser({ username: "me", displayName: "나", password: "password123" });
    const group = store.createGroup({ name: "Team" });
    store.addGroupMember(group.id, me.id, "member");
    store.upsertGroupAgent(group.id, { displayName: "팀 비서" });
    store.touchConversation(me.id, "c1", groupAgentAvatarId(group.id), "안녕");

    const summaries = store.listConversations(me.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].avatarDisplayName).toBe("팀 비서");
  });
});

describe("group-agent helpers", () => {
  it("round-trips the avatar id namespace", () => {
    expect(groupAgentAvatarId("g-1")).toBe("group:g-1");
    expect(parseGroupAgentGroupId("group:g-1")).toBe("g-1");
    expect(parseGroupAgentGroupId("group:")).toBeNull();
    expect(parseGroupAgentGroupId("external:g-1")).toBeNull();
    expect(parseGroupAgentGroupId("plain-uuid")).toBeNull();
  });

  it("captureAllowed = members-scope OR admin role", () => {
    expect(groupAgentCaptureAllowed({ captureScope: "members" }, "member")).toBe(true);
    expect(groupAgentCaptureAllowed({ captureScope: "members" }, "admin")).toBe(true);
    expect(groupAgentCaptureAllowed({ captureScope: "admins" }, "member")).toBe(false);
    expect(groupAgentCaptureAllowed({ captureScope: "admins" }, "admin")).toBe(true);
  });

  it("findChattableGroupAgent gates on prefix, existence, enabled, membership", () => {
    const { store } = services("gate");
    const member = store.createUser({ username: "m", displayName: "M", password: "password123" });
    const outsider = store.createUser({ username: "o", displayName: "O", password: "password123" });
    const group = store.createGroup({ name: "Team" });
    store.addGroupMember(group.id, member.id, "admin");
    store.upsertGroupAgent(group.id, { displayName: "팀 에이전트" });
    const id = groupAgentAvatarId(group.id);

    expect(findChattableGroupAgent(store, member.id, id)).toMatchObject({
      groupId: group.id,
      groupName: "Team",
      viewerRole: "admin",
    });
    expect(findChattableGroupAgent(store, outsider.id, id)).toBeNull();
    expect(findChattableGroupAgent(store, member.id, "group:ghost")).toBeNull();
    expect(findChattableGroupAgent(store, member.id, member.id)).toBeNull();

    store.setGroupAgentEnabled(group.id, false);
    expect(findChattableGroupAgent(store, member.id, id)).toBeNull();
    expect(
      findChattableGroupAgent(store, member.id, id, { includeDisabled: true })?.agent.enabled,
    ).toBe(false);
  });
});

describe("deriveAgentToolAccess (group-agent class)", () => {
  const base = {
    message: "m",
    avatar: { id: "group:g", displayName: "팀", alias: "", persona: "" },
    groupAgent: { groupId: "g", groupName: "팀", viewerRole: "member" as const, captureAllowed: true },
  };

  it("pins the interactive class: elevated built-ins, never owner tools", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: false, autoApprove: true });
    expect(a).toMatchObject({
      viewerIsOwner: false,
      ownerToolAccess: false,
      elevatedToolAccess: true,
      elevated: true,
      autoApprove: true,
      hexSshViewerClass: "colleague",
    });
  });

  it("never grants owner access even if a caller lies about viewerIsOwner", () => {
    const a = deriveAgentToolAccess({ ...base, viewerIsOwner: true });
    expect(a.viewerIsOwner).toBe(false);
    expect(a.ownerToolAccess).toBe(false);
  });

  it("keeps the headless algebra (restricted unless allowHeadlessTools)", () => {
    const restricted = deriveAgentToolAccess({ ...base, headless: true });
    expect(restricted.elevatedToolAccess).toBe(false);
    expect(restricted.elevated).toBe(true);
    const optedIn = deriveAgentToolAccess({ ...base, headless: true, allowHeadlessTools: true });
    expect(optedIn.elevatedToolAccess).toBe(true);
  });
});

describe("planMcpToolFamilies (run-kind tool containment)", () => {
  const ALL = MCP_TOOL_GROUPS.map((g) => g.id);

  it("personal run: registered mirrors the selection, nothing run-kind-blocked", () => {
    const plan = planMcpToolFamilies(ALL, false);
    expect(plan.registered).toEqual(ALL);
    expect(plan.runKindBlocked).toEqual([]);
    expect(plan.confluence).toBe(true);
    const partial = planMcpToolFamilies(["web", "system"], false);
    expect(partial.registered).toEqual(["web", "system"]);
    expect(partial.personalKnowledge).toBe(false);
  });

  it("group-agent run: personal families are stripped and reported as run-kind-blocked", () => {
    const plan = planMcpToolFamilies(ALL, true);
    expect(plan.registered).toEqual(["group_knowledge", "web", "system"]);
    expect(plan.runKindBlocked).toEqual([
      "personal_knowledge",
      "git_repo",
      "confluence",
      "ssh",
      "avatars",
      "canvas",
    ]);
    expect(plan.groupKnowledge).toBe(true);
    expect(plan.confluence).toBe(false);
    expect(plan.avatars).toBe(false);
    // Deselecting group_knowledge in the composer still applies on a group run.
    const noBrain = planMcpToolFamilies(["web", "system"], true);
    expect(noBrain.groupKnowledge).toBe(false);
    expect(noBrain.registered).toEqual(["web", "system"]);
  });
});

describe("group-agent prompt branch", () => {
  const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "안녕",
    avatar: { id: "group:g", displayName: "팀 에이전트", alias: "", persona: "" },
    viewerName: "지영",
    groupAgent: { groupId: "g", groupName: "플랫폼팀", viewerRole: "member", captureAllowed: true },
    groupAgentState: {
      groupId: "g",
      groupName: "플랫폼팀",
      enabled: true,
      captureScope: "members",
      viewerRole: "member",
      captureAllowed: true,
      knowledgeRepoConfigured: true,
      knowledgeRepo: { repo: "acme/team-brain", branch: null },
      viewerGitTokenSet: true,
      modelOverride: null,
    },
    ...over,
  });

  it("states identity, privacy, recall + capture triggers, and the capability boundary", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain("SHARED agent of the group '플랫폼팀'");
    expect(p).toContain('group member "지영" (role: member)');
    expect(p).toContain("PRIVATE to that member");
    expect(p).toContain("never assume another member can read this conversation");
    expect(p).toContain("mcp__group_brain__search");
    expect(p).toContain("CAPTURE it");
    expect(p).toContain("mcp__group_repo__commit");
    expect(p).toContain("NO personal-avatar capabilities");
    // Personal-avatar sections stay out.
    expect(p).not.toContain("Personal knowledge repository: connected");
    expect(p).not.toContain("mcp__avatars__ask_avatar");
  });

  it("warns pre-emptively when the member has no git token", () => {
    const p = buildPrompt(
      req({
        groupAgentState: {
          ...req().groupAgentState!,
          viewerGitTokenSet: false,
        },
      }),
      0,
    );
    expect(p).toContain("no internal Git token (GIT_TOKEN) registered");
  });

  it("switches to the capture-denied guidance under the admins-only policy", () => {
    const p = buildPrompt(
      req({
        groupAgent: { groupId: "g", groupName: "플랫폼팀", viewerRole: "member", captureAllowed: false },
        groupAgentState: {
          ...req().groupAgentState!,
          captureScope: "admins",
          captureAllowed: false,
        },
      }),
      0,
    );
    expect(p).toContain("only group ADMINS may write");
    expect(p).not.toContain("CAPTURE it:");
  });

  it("explains a missing shared repository instead of advertising dead tools", () => {
    const p = buildPrompt(
      req({
        groupAgentState: {
          ...req().groupAgentState!,
          knowledgeRepoConfigured: false,
          knowledgeRepo: { repo: null, branch: null },
        },
      }),
      0,
    );
    expect(p).toContain("NO shared knowledge repository connected");
    expect(p).not.toContain("CAPTURE it:");
  });

  it("with the run-kind plan, stripped families leave no ghost guidance or misattribution", () => {
    // The run assembly passes planMcpToolFamilies' registered/runKindBlocked —
    // rebuild the same inputs here and pin the consumer behavior.
    const plan = planMcpToolFamilies(MCP_TOOL_GROUPS.map((g) => g.id), true);
    const p = buildPrompt(
      req({
        mcpToolGroups: plan.registered,
        adminBlockedMcpToolGroups: plan.runKindBlocked,
      }),
      0,
    );
    // No ACTIONABLE guidance for servers that never register on a group-agent
    // run (the generic MCP-only-git POLICY paragraph may still name the
    // mcp__git_repo__ family as taxonomy — that's a rule, not an offer).
    expect(p).not.toContain("mcp__confluence__");
    expect(p).not.toContain("mcp__avatars__search_avatars");
    expect(p).not.toContain("General **git repo work");
    // …and the forcing is not misattributed to the member's composer choice.
    expect(p).not.toContain("the user disabled these MCP tool groups");
  });
});

describe("group-agent tool factories", () => {
  function setup(dir: string, opts: { captureScope?: "members" | "admins"; repo?: boolean } = {}) {
    const { store, config } = services(dir);
    const member = store.createUser({ username: "member", displayName: "멤버", password: "password123" });
    const group = store.createGroup({ name: "팀" });
    store.addGroupMember(group.id, member.id, "member");
    store.upsertGroupAgent(group.id, {
      displayName: "팀 에이전트",
      captureScope: opts.captureScope ?? "members",
    });
    if (opts.repo !== false) {
      const remote = makeBareRemote(path.join(tempDir(), dir, "team.git"));
      store.setGroupKnowledgeRepo(group.id, remote, null);
    }
    const ctx = {
      groupId: group.id,
      groupName: "팀",
      actingUser: { id: member.id, username: "member", displayName: "멤버" },
      config,
    };
    return { store, config, group, member, ctx };
  }

  it("exposes the pinned subset (no list_groups / create_repo)", () => {
    const { store, ctx } = setup("names");
    const names = buildGroupAgentRepoTools(store, ctx).map((t) => t.name);
    expect(names).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "move_file",
      "scaffold_skill",
      "commit",
    ]);
    expect([...GROUP_AGENT_REPO_TOOL_NAMES]).not.toContain("mcp__group_repo__list_groups");
    expect([...GROUP_AGENT_REPO_TOOL_NAMES]).not.toContain("mcp__group_repo__create_repo");
  });

  it("members write under the members scope; commit without a token refuses", async () => {
    const { store, ctx } = setup("write-ok");
    const tools = buildGroupAgentRepoTools(store, ctx);
    const write = await callTool(tools, "write_file", {
      path: "raw/note.md",
      content: "# 팀 노트",
    });
    expect(write.isError).toBeFalsy();
    expect(write.content[0].text).toContain("Not committed yet");
    // The acting member has no GIT_TOKEN → commit refuses with the standing message.
    const commit = await callTool(tools, "commit", { message: "add note" });
    expect(commit.isError).toBe(true);
    expect(commit.content[0].text).toContain("GIT_TOKEN");
  });

  it("denies member writes (reads still work) under the admins-only policy", async () => {
    const { store, ctx } = setup("write-denied", { captureScope: "admins" });
    const tools = buildGroupAgentRepoTools(store, ctx);
    const write = await callTool(tools, "write_file", { path: "raw/x.md", content: "x" });
    expect(write.isError).toBe(true);
    expect(write.content[0].text).toContain("capture policy allows only group ADMINS");
    expect(write.content[0].text).toContain("suggest a group admin capture it");
    const list = await callTool(tools, "list_files", {});
    expect(list.isError).toBeFalsy();
  });

  it("refuses mid-run when the agent is disabled or the member was removed", async () => {
    const { store, ctx, group, member } = setup("live-gates");
    const tools = buildGroupAgentRepoTools(store, ctx);
    store.setGroupAgentEnabled(group.id, false);
    const disabled = await callTool(tools, "list_files", {});
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0].text).toContain("disabled by a group admin");

    store.setGroupAgentEnabled(group.id, true);
    store.removeGroupMember(group.id, member.id);
    const removed = await callTool(tools, "list_files", {});
    expect(removed.isError).toBe(true);
    expect(removed.content[0].text).toContain("no longer a member");
  });

  it("brain tools: pinned-group recall messages for no-repo and no-vault", async () => {
    const noRepo = setup("brain-norepo", { repo: false });
    const brainNoRepo = buildGroupAgentBrainTools(noRepo.store, {
      groupId: noRepo.group.id,
      groupName: "팀",
      actingUserId: noRepo.member.id,
      config: noRepo.config,
    });
    const denied = await callTool(brainNoRepo, "search", { query: "규칙" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("no team brain to search");

    const withRepo = setup("brain-novault");
    const brain = buildGroupAgentBrainTools(withRepo.store, {
      groupId: withRepo.group.id,
      groupName: "팀",
      actingUserId: withRepo.member.id,
      config: withRepo.config,
    });
    const noVault = await callTool(brain, "search", { query: "규칙" });
    expect(noVault.isError).toBe(true);
    expect(noVault.content[0].text).toContain("no `wiki/` vault yet");
    const badPath = await callTool(brain, "get_note", { path: "raw/x.md" });
    expect(badPath.isError).toBe(true);
    expect(badPath.content[0].text).toContain("only reads notes under `wiki/`");
  });

  it("describe_system reports the group self-state for group-agent runs", async () => {
    const { store, config, group, member } = setup("describe");
    const tools = buildSystemTools(store, {
      avatarUserId: groupAgentAvatarId(group.id),
      owner: { id: groupAgentAvatarId(group.id), username: "", displayName: "팀 에이전트", alias: "" },
      viewerIsOwner: false,
      config,
      groupAgent: { groupId: group.id, actingUserId: member.id },
    });
    const res = await callTool(tools, "describe_system", {});
    expect(res.isError).toBeFalsy();
    const body = res.content[0].text;
    expect(body).toContain("Current GROUP SHARED-AGENT state:");
    expect(body).toContain("shared agent of the group '팀'");
    expect(body).toContain("all group members may capture");
    expect(body).toContain("(role: member) MAY capture");
    expect(body).toContain("not set — capture's commit/push will fail");
    expect(body).toContain("Capability boundary: NO personal knowledge repository");
  });

  it("describe_system lists only the REGISTERED tool groups and fails closed on a removed member", async () => {
    const { store, config, group, member } = setup("describe-registered");
    const plan = planMcpToolFamilies(MCP_TOOL_GROUPS.map((g) => g.id), true);
    const tools = buildSystemTools(store, {
      avatarUserId: groupAgentAvatarId(group.id),
      owner: { id: groupAgentAvatarId(group.id), username: "", displayName: "팀 에이전트", alias: "" },
      viewerIsOwner: false,
      config,
      groupAgent: { groupId: group.id, actingUserId: member.id },
      enabledMcpToolGroups: plan.registered,
    });
    const res = await callTool(tools, "describe_system", {});
    const body = res.content[0].text;
    const registeredLabels = MCP_TOOL_GROUPS.filter((g) => plan.registered.includes(g.id))
      .map((g) => g.labelEn)
      .join(", ");
    expect(body).toContain(
      `MCP tool groups enabled for this conversation: ${registeredLabels}`,
    );
    const confluenceLabel = MCP_TOOL_GROUPS.find((g) => g.id === "confluence")!.labelEn;
    expect(body).not.toContain(confluenceLabel);

    // Removed mid-turn: the state report must fail closed, matching the tools.
    store.removeGroupMember(group.id, member.id);
    const gone = summarizeGroupAgentState(store, config, group.id, member.id);
    expect(gone).toMatchObject({ viewerRole: null, captureAllowed: false });
    const res2 = await callTool(tools, "describe_system", {});
    expect(res2.content[0].text).toContain(
      "(role: removed — no longer a group member) may NOT capture",
    );
  });
});

describe("group-agent routes", () => {
  function boot(dir: string) {
    H.requests.length = 0;
    const svc = services(dir);
    const app = createApp(svc);
    return { ...svc, app };
  }

  it("manages the agent via canManageGroup and echoes it on GET /api/me/groups", async () => {
    const { app } = boot("routes-manage");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const lead = request.agent(app);
    await signup(lead, "lead").expect(201);
    const plain = request.agent(app);
    await signup(plain, "plain").expect(201);

    const created = await admin.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id as string;
    await admin.post(`/api/admin/groups/${groupId}/members`).send({ username: "lead", role: "admin" }).expect(200);
    await admin.post(`/api/admin/groups/${groupId}/members`).send({ username: "plain" }).expect(200);

    await lead.put("/api/me/groups/ghost/agent").send({ displayName: "X" }).expect(404);
    await plain.put(`/api/me/groups/${groupId}/agent`).send({ displayName: "X" }).expect(403);
    await lead.put(`/api/me/groups/${groupId}/agent`).send({}).expect(400);
    await lead
      .put(`/api/me/groups/${groupId}/agent`)
      .send({ displayName: "팀 비서", captureScope: "sideways" })
      .expect(400);

    const saved = await lead
      .put(`/api/me/groups/${groupId}/agent`)
      .send({ displayName: "팀 비서", persona: "간결하게", captureScope: "admins" })
      .expect(200);
    expect(saved.body.agent).toMatchObject({
      displayName: "팀 비서",
      captureScope: "admins",
      enabled: true,
    });

    const mine = await plain.get("/api/me/groups").expect(200);
    expect(mine.body.groups[0].agent).toMatchObject({ displayName: "팀 비서" });

    // A NON-member system admin may manage too (canManageGroup).
    await admin
      .put(`/api/me/groups/${groupId}/agent`)
      .send({ displayName: "팀 비서", enabled: false })
      .expect(200);
  });

  it("shows the agent to members only, across list/detail/skills/models", async () => {
    const { app, store } = boot("routes-visibility");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const member = request.agent(app);
    await signup(member, "member").expect(201);
    const outsider = request.agent(app);
    await signup(outsider, "outsider").expect(201);

    const created = await admin.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id as string;
    await admin.post(`/api/admin/groups/${groupId}/members`).send({ username: "member" }).expect(200);
    const agentId = `group:${groupId}`;
    store.upsertGroupAgent(groupId, { displayName: "팀 비서", bio: "팀 공용" });

    const list = await member.get("/api/avatars").expect(200);
    const card = list.body.avatars.find((a: { id: string }) => a.id === agentId);
    expect(card).toMatchObject({
      displayName: "팀 비서",
      runtime: "native",
      visibility: "group",
      groupAgent: { groupId, groupName: "Team" },
    });
    const outsiderList = await outsider.get("/api/avatars").expect(200);
    expect(outsiderList.body.avatars.some((a: { id: string }) => a.id === agentId)).toBe(false);

    const detail = await member.get(`/api/avatars/${encodeURIComponent(agentId)}`).expect(200);
    expect(detail.body.avatar).toMatchObject({ isOwn: false, elevated: true });
    await outsider.get(`/api/avatars/${encodeURIComponent(agentId)}`).expect(404);

    const skills = await member.get(`/api/avatars/${encodeURIComponent(agentId)}/skills`).expect(200);
    expect(skills.body.skills).toEqual([]); // local runtime
    await outsider.get(`/api/avatars/${encodeURIComponent(agentId)}/skills`).expect(404);

    const models = await member.get(`/api/avatars/${encodeURIComponent(agentId)}/models`).expect(200);
    expect(models.body).toEqual({ models: [], defaultModel: null });
    await outsider.get(`/api/avatars/${encodeURIComponent(agentId)}/models`).expect(404);

    // Disabling hides it from discovery entirely.
    store.setGroupAgentEnabled(groupId, false);
    const hidden = await member.get("/api/avatars").expect(200);
    expect(hidden.body.avatars.some((a: { id: string }) => a.id === agentId)).toBe(false);
    await member.get(`/api/avatars/${encodeURIComponent(agentId)}`).expect(404);
  });

  it("gates the chat turn and pins the run wiring (groupAgent + no trust leakage)", async () => {
    const { app, store } = boot("routes-chat");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const member = request.agent(app);
    await signup(member, "member").expect(201);
    const outsider = request.agent(app);
    await signup(outsider, "outsider").expect(201);

    const created = await admin.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id as string;
    await admin.post(`/api/admin/groups/${groupId}/members`).send({ username: "member" }).expect(200);
    store.upsertGroupAgent(groupId, { displayName: "팀 비서", captureScope: "members" });
    const agentId = `group:${groupId}`;

    // Reach is MEMBERSHIP-only: even with avatar sharing OFF the agent works.
    await admin
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: false })
      .expect(200);

    const ok = await member
      .post("/api/chat/stream")
      .send({ avatarId: agentId, conversationId: "ga-c1", message: "안녕" })
      .expect(200);
    expect(parseSse(ok.text).some((f) => f.event === "done")).toBe(true);
    expect(H.requests).toHaveLength(1);
    expect(H.requests[0]).toMatchObject({
      viewerIsOwner: false,
      elevated: false,
      trustedViaGroups: [],
      groupAgent: {
        groupId,
        groupName: "Team",
        viewerRole: "member",
        captureAllowed: true,
      },
    });
    expect(H.requests[0].avatar.id).toBe(agentId);

    // Non-member: the generic fail-closed 403 (no existence leak).
    const blocked = await outsider
      .post("/api/chat/stream")
      .send({ avatarId: agentId, conversationId: "ga-c2", message: "안녕" })
      .expect(403);
    expect(blocked.body.error).toContain("이 아바타와 대화할 수 없습니다");

    // Owner-only slash commands never match a group agent.
    await member
      .post("/api/chat/stream")
      .send({ avatarId: agentId, conversationId: "ga-c1", message: "/learn" })
      .expect(403);

    // Member-visible DISABLED agent gets the dedicated message on the next turn.
    store.setGroupAgentEnabled(groupId, false);
    const disabled = await member
      .post("/api/chat/stream")
      .send({ avatarId: agentId, conversationId: "ga-c1", message: "계속" })
      .expect(403);
    expect(disabled.body.error).toContain("그룹 에이전트가 비활성화되어 있습니다");
    // History survives the disable.
    expect(store.listMessages((await member.get("/api/me").expect(200)).body.user.id, "ga-c1").length).toBeGreaterThan(0);
  });

  it("stores/serves/removes the agent profile image and cleans up on group delete", async () => {
    const { app, store, config } = boot("routes-image");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const created = await admin.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id as string;
    store.upsertGroupAgent(groupId, { displayName: "팀 비서" });
    const agentId = `group:${groupId}`;
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    await admin.put(`/api/me/groups/${groupId}/agent/image`).send({ image: png }).expect(200);
    const image = await admin.get(`/api/users/${encodeURIComponent(agentId)}/avatar-image`).expect(200);
    expect(image.headers["content-type"]).toContain("image/png");

    await admin.delete(`/api/me/groups/${groupId}/agent/image`).expect(200);
    await admin.get(`/api/users/${encodeURIComponent(agentId)}/avatar-image`).expect(404);

    // Group deletion sweeps the on-disk leftovers: clone dir + image file +
    // every member's chat-image/file dirs for the agent's conversations (the
    // ids are snapshotted BEFORE the row cascade erases them).
    await admin.put(`/api/me/groups/${groupId}/agent/image`).send({ image: png }).expect(200);
    const cloneDir = groupKnowledgeClonePath(groupId, config);
    fs.mkdirSync(cloneDir, { recursive: true });
    const sysAdminId = store.getUserByUsername("sys-admin")!.id;
    store.addGroupMember(groupId, sysAdminId, "member");
    store.touchConversation(sysAdminId, "ga-del-conv", agentId, "질문");
    const imgDir = chatImagesDir(config, "ga-del-conv");
    const fileDir = chatFilesDir(config, "ga-del-conv");
    fs.mkdirSync(imgDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, "img.png"), "x");
    fs.writeFileSync(path.join(fileDir, "doc.pdf"), "x");
    await admin.delete(`/api/admin/groups/${groupId}`).expect(200);
    expect(fs.existsSync(cloneDir)).toBe(false);
    expect(fs.existsSync(imgDir)).toBe(false);
    expect(fs.existsSync(fileDir)).toBe(false);
    await admin.get(`/api/users/${encodeURIComponent(agentId)}/avatar-image`).expect(404);
    expect(store.getGroupAgent(groupId)).toBeNull();
  });
});
