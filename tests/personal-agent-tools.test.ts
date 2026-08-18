import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, PersonalAgentState } from "../src/server/types.js";
import { callTool, withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Partial SDK mock (agent-run.test.ts pattern): tool()/createSdkMcpServer() stay
// REAL so the in-process servers build, and only `query` is replaced by a fake
// that snapshots each call's `options` — the run loop mutates that object in
// place, so a live reference would read post-mutation state. The registration
// assertions below (allowedTools / mcpServers) are the only way to prove the two
// hand-synced lists agree for a personal-agent run.
// ---------------------------------------------------------------------------
type QueryArgs = { prompt: unknown; options: Record<string, unknown> };
type QueryHandle = AsyncIterable<unknown>;

const sdkMock = vi.hoisted(() => ({
  calls: [] as { options: Record<string, unknown> }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: QueryArgs) => {
      sdkMock.calls.push({ options: { ...args.options } });
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "opus" };
        yield { type: "result", subtype: "success", result: "ok" };
      }
      return gen() as QueryHandle;
    },
  };
});

import { createServices } from "../src/server/app.js";
import { MAX_PERSONAL_AGENTS } from "../src/server/store.js";
import { runAgentStream } from "../src/server/agent/index.js";
import {
  buildPrompt,
  deriveAgentToolAccess,
  planMcpToolFamilies,
} from "../src/server/agent/claudeAgent.js";
import { summarizePersonalAgentState } from "../src/server/agent/ownerState.js";
import {
  buildPersonalAgentOwnerTools,
  buildPersonalAgentSelfTools,
  PERSONAL_AGENT_FIELD_CAPS,
  PERSONAL_AGENT_OWNER_TOOL_NAMES,
  PERSONAL_AGENT_SELF_TOOL_NAMES,
} from "../src/server/agent/personalAgentProfileTools.js";
import { buildSystemTools } from "../src/server/agent/systemTools.js";
import { MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";

let tempDir: string;
const getTempDir = withTempDir("personal-agent-tools", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
});

/**
 * Fresh services + an ADMIN owner (the first user of a store is auto-granted the
 * system-admin role, which is the phase-1 feature gate) + one of their bots.
 */
function setup(dir: string, opts: { plain?: boolean } = {}) {
  const { config, store } = createServices({
    dataDir: path.join(tempDir, dir),
    agentRuntime: "claude",
    sessionSecret: "test",
    anthropicModel: undefined,
    anthropicApiKey: undefined,
  });
  const admin = store.createUser({
    username: "owner",
    displayName: "오너",
    password: "password123",
  });
  // A SECOND user is a plain (non-admin) one — used for the feature-gate cases.
  const plain = store.createUser({
    username: "plain",
    displayName: "일반",
    password: "password123",
  });
  const owner = opts.plain ? plain : admin;
  const agent = store.createPersonalAgent(owner.id, {
    displayName: "릴리즈 봇",
    alias: "릴봇",
  });
  const cwd = path.join(tempDir, dir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  // A bot turn is a FULL OWNER run: avatar is the OWNER's own avatar (its id is
  // every capability key) and only `personalAgent` marks the run kind.
  const baseRequest: AgentRequest = {
    message: "안녕",
    avatar: { id: owner.id, displayName: "오너", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "오너",
    viewerIsOwner: true,
    autoApprove: true,
  };
  const botRequest: AgentRequest = {
    ...baseRequest,
    personalAgent: { agentId: agent.id, ownerUserId: owner.id },
  };
  return { config, store, owner, plain, agent, baseRequest, botRequest };
}

function makeEvents(): AgentEvents {
  return {
    onDelta: vi.fn(),
    onThinking: vi.fn(),
    onThinkingReset: vi.fn(),
    onStatus: vi.fn(),
    onModel: vi.fn(),
    onSessionId: vi.fn(),
    onPlugin: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskUpdate: vi.fn(),
    onTaskEnd: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentEnd: vi.fn(),
    onBlocked: vi.fn(),
    onPlan: vi.fn(),
  };
}

const lastOptions = () => sdkMock.calls[sdkMock.calls.length - 1].options;
const allowed = () => lastOptions().allowedTools as string[];
const servers = () => Object.keys(lastOptions().mcpServers as Record<string, unknown>);

// ===========================================================================
// Access algebra: a personal-agent run must stay a FULL OWNER run
// ===========================================================================
describe("personal-agent runs keep the owner algebra untouched", () => {
  const ALL = MCP_TOOL_GROUPS.map((g) => g.id);
  const base = {
    message: "m",
    avatar: { id: "u1", displayName: "U", alias: "", persona: "" },
    personalAgent: { agentId: "a1", ownerUserId: "u1" },
  };

  it("deriveAgentToolAccess is identical with and without the personalAgent tag", () => {
    const withTag = deriveAgentToolAccess({
      ...base,
      viewerIsOwner: true,
      autoApprove: true,
    });
    const without = deriveAgentToolAccess({
      message: "m",
      avatar: base.avatar,
      viewerIsOwner: true,
      autoApprove: true,
    });
    expect(withTag).toEqual(without);
    // Spelled out, because this is the whole point of the A-1 capability rule:
    // unlike `groupAgent`, the personal tag is NOT a kill-switch.
    expect(withTag).toMatchObject({
      viewerIsOwner: true,
      ownerToolAccess: true,
      elevatedToolAccess: true,
      elevated: true,
      hexSshViewerClass: "owner",
    });
  });

  it("planMcpToolFamilies keeps every personal family (the bot IS the owner)", () => {
    // planMcpToolFamilies never receives the personal flag; a bot run passes the
    // same `false` a normal owner chat does. Pinned so a future refactor cannot
    // quietly route the personal run through the group-agent containment.
    const plan = planMcpToolFamilies(ALL, false);
    expect(plan.registered).toEqual(ALL);
    expect(plan.runKindBlocked).toEqual([]);
    expect(plan.personalKnowledge).toBe(true);
    expect(plan.browser).toBe(true);
  });
});

// ===========================================================================
// Run-plan registration (the two hand-synced lists)
// ===========================================================================
describe("personal-agent run plan (SDK mocked)", () => {
  it("registers update_profile and drops the routine tools on a bot run", async () => {
    const { config, store, botRequest } = setup("plan-bot");
    await runAgentStream(botRequest, [], config, store, makeEvents());

    expect(servers()).toContain("personal_agent");
    expect(allowed()).toContain("mcp__personal_agent__update_profile");
    // create_agent belongs to the owner's OWN avatar, never to a bot.
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");
    // Routines cannot resolve a composite bot id (phase 1): the four names are
    // filtered out, while the rest of the system server stays.
    expect(allowed()).toContain("mcp__system__describe_system");
    expect(allowed()).not.toContain("mcp__system__list_routines");
    expect(allowed()).not.toContain("mcp__system__create_routine");
    expect(allowed()).not.toContain("mcp__system__update_routine");
    expect(allowed()).not.toContain("mcp__system__delete_routine");
    // Owner capability is untouched: the personal families still register.
    expect(servers()).toContain("repo");
    expect(servers()).toContain("system");
  });

  it("registers create_agent on the owner's own admin run, with routines intact", async () => {
    const { config, store, baseRequest } = setup("plan-owner");
    await runAgentStream(baseRequest, [], config, store, makeEvents());

    expect(servers()).toContain("personal_agent");
    expect(allowed()).toContain("mcp__personal_agent__create_agent");
    expect(allowed()).not.toContain("mcp__personal_agent__update_profile");
    expect(allowed()).toContain("mcp__system__create_routine");
  });

  it("withholds create_agent from non-admins, headless runs, and consultations", async () => {
    const nonAdmin = setup("plan-nonadmin", { plain: true });
    await runAgentStream(nonAdmin.baseRequest, [], nonAdmin.config, nonAdmin.store, makeEvents());
    expect(servers()).not.toContain("personal_agent");
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    const { config, store, baseRequest } = setup("plan-gates");
    // A scheduled routine holds owner tool access but must not create contacts.
    await runAgentStream(
      { ...baseRequest, headless: true, allowHeadlessTools: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    await runAgentStream(
      { ...baseRequest, avatarConsultation: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    // A teammate driving the owner's avatar is not the owner.
    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");
  });
});

// ===========================================================================
// update_profile (bot self-configuration)
// ===========================================================================
describe("mcp__personal_agent__update_profile", () => {
  it("pins the tool-name lists", () => {
    expect([...PERSONAL_AGENT_SELF_TOOL_NAMES]).toEqual([
      "mcp__personal_agent__update_profile",
    ]);
    expect([...PERSONAL_AGENT_OWNER_TOOL_NAMES]).toEqual([
      "mcp__personal_agent__create_agent",
    ]);
  });

  it("patches the bot, audits it, and says the change lands NEXT turn", async () => {
    const { store, owner, agent } = setup("self-ok");
    const tools = buildPersonalAgentSelfTools(store, {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const ok = await callTool(tools, "update_profile", {
      persona: "릴리즈 노트만 쓴다",
      alias: "릴봇2",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("NEXT turn");
    const updated = store.getPersonalAgentById(agent.id)!;
    expect(updated.persona).toBe("릴리즈 노트만 쓴다");
    expect(updated.alias).toBe("릴봇2");
    // displayName is never patched here.
    expect(updated.displayName).toBe("릴리즈 봇");
    const audit = store
      .listAudit(owner.id, true)
      .find((e) => e.action === "personal_agent_update");
    expect(audit?.detail).toContain(
      `agent=${agent.id} self-config via update_profile (persona, alias)`,
    );
  });

  it("refuses empty patches, over-cap fields, a disabled bot, a foreign actor, and a demoted owner", async () => {
    const { store, owner, plain, agent } = setup("self-gates");
    const ctx = {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    };
    const tools = buildPersonalAgentSelfTools(store, ctx);

    const empty = await callTool(tools, "update_profile", {});
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("at least one field");

    const overCap = await callTool(tools, "update_profile", {
      alias: "가".repeat(PERSONAL_AGENT_FIELD_CAPS.alias + 1),
    });
    expect(overCap.isError).toBe(true);
    expect(overCap.content[0].text).toContain("limited to 64 characters");

    // Someone else's bot: refused without confirming anything about it.
    const foreign = buildPersonalAgentSelfTools(store, {
      ...ctx,
      owner: { id: plain.id, username: "plain", displayName: "일반" },
    });
    const notMine = await callTool(foreign, "update_profile", { persona: "x" });
    expect(notMine.isError).toBe(true);
    expect(notMine.content[0].text).toContain("belongs to a different user");

    store.updatePersonalAgent(agent.id, { enabled: false });
    const disabled = await callTool(tools, "update_profile", { persona: "x" });
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0].text).toContain("DISABLED");

    // Admin role revoked mid-conversation → the feature gate fails closed, the
    // same way the reach gate will refuse the next turn.
    store.updatePersonalAgent(agent.id, { enabled: true });
    store.setRole(owner.id, "admin", false);
    const demoted = await callTool(tools, "update_profile", { persona: "x" });
    expect(demoted.isError).toBe(true);
    expect(demoted.content[0].text).toContain("administrator-only feature");

    expect(store.getPersonalAgentById(agent.id)!.persona).toBe("");
  });

  it("refuses once the bot row is gone", async () => {
    const { store, owner, agent } = setup("self-deleted");
    const tools = buildPersonalAgentSelfTools(store, {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    store.deletePersonalAgent(agent.id);
    const gone = await callTool(tools, "update_profile", { bio: "x" });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain("no longer exists");
  });
});

// ===========================================================================
// create_agent (owner's own avatar)
// ===========================================================================
describe("mcp__personal_agent__create_agent", () => {
  it("creates a chattable bot, audits it, and names the routes to it", async () => {
    const { store, owner } = setup("create-ok");
    const tools = buildPersonalAgentOwnerTools(store, {
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const before = store.countPersonalAgents(owner.id);
    const ok = await callTool(tools, "create_agent", {
      display_name: "  회의록 봇  ",
      persona: "회의록만 정리한다",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("회의록 봇");
    expect(ok.content[0].text).toContain("내 봇");
    expect(store.countPersonalAgents(owner.id)).toBe(before + 1);
    const created = store
      .listPersonalAgents(owner.id, { includeDisabled: true })
      .find((a) => a.displayName === "회의록 봇")!;
    expect(created.persona).toBe("회의록만 정리한다");
    expect(created.enabled).toBe(true);
    const audit = store
      .listAudit(owner.id, true)
      .find((e) => e.action === "personal_agent_create");
    expect(audit?.detail).toContain(`agent=${created.id} (회의록 봇) via create_agent`);
  });

  it("refuses a non-admin owner, an empty name, an over-cap name, and the roster cap", async () => {
    const { store, plain, owner } = setup("create-gates");
    const nonAdmin = buildPersonalAgentOwnerTools(store, {
      owner: { id: plain.id, username: "plain", displayName: "일반" },
    });
    const denied = await callTool(nonAdmin, "create_agent", { display_name: "봇" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("administrator-only feature");

    const tools = buildPersonalAgentOwnerTools(store, {
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const empty = await callTool(tools, "create_agent", { display_name: "   " });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("needs a name");

    const longName = await callTool(tools, "create_agent", { display_name: "가".repeat(65) });
    expect(longName.isError).toBe(true);
    expect(longName.content[0].text).toContain("limited to 64 characters");

    // Fill the roster (setup already created one) and hit the store's cap throw.
    while (store.countPersonalAgents(owner.id) < MAX_PERSONAL_AGENTS) {
      store.createPersonalAgent(owner.id, {
        displayName: `봇-${store.countPersonalAgents(owner.id)}`,
      });
    }
    const capped = await callTool(tools, "create_agent", { display_name: "하나 더" });
    expect(capped.isError).toBe(true);
    expect(capped.content[0].text).toContain(`maximum of ${MAX_PERSONAL_AGENTS}`);
    expect(store.countPersonalAgents(owner.id)).toBe(MAX_PERSONAL_AGENTS);
  });
});

// ===========================================================================
// describe_system (the metacognition mirror of the prompt branch)
// ===========================================================================
describe("describe_system for personal agents", () => {
  function systemTools(
    dir: string,
    opts: { plain?: boolean } = {},
    ctxOverrides: Record<string, unknown> = {},
  ) {
    const s = setup(dir, opts);
    const tools = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      ...ctxOverrides,
    });
    return { ...s, tools };
  }

  it("prints the bot block, then FALLS THROUGH to the owner state it runs with", async () => {
    const s = setup("desc-bot");
    const withBot = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    const res = await callTool(withBot, "describe_system", {});
    expect(res.isError).toBeFalsy();
    const body = res.content[0].text;
    expect(body).toContain("Current PERSONAL BOT (내 봇) state:");
    expect(body).toContain("릴리즈 봇");
    expect(body).toContain("Persona/instructions: NOT set");
    expect(body).toContain(`of ${MAX_PERSONAL_AGENTS} personal bots`);
    expect(body).toContain("mcp__personal_agent__update_profile");
    expect(body).toContain("Scheduled routines: UNAVAILABLE in this conversation");
    // …and the owner block still follows: a bot run HAS owner capability.
    expect(body).toContain("Current avatar state:");
    expect(body).toContain("Knowledge repository:");
    // The owner-avatar create trigger is NOT offered inside a bot thread.
    expect(body).not.toContain("mcp__personal_agent__create_agent");
    expect(body).toContain("NOT listable or manageable from this personal-bot conversation");
  });

  it("fails closed on a disabled bot, a demoted owner, and a foreign actor", async () => {
    const s = setup("desc-closed");
    const tools = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    s.store.updatePersonalAgent(s.agent.id, { enabled: false });
    const disabled = await callTool(tools, "describe_system", {});
    expect(disabled.content[0].text).toContain(
      "Current PERSONAL BOT (내 봇) state: UNAVAILABLE.",
    );
    expect(disabled.content[0].text).toContain("was disabled by its owner");
    // The leaky owner half is gone.
    expect(disabled.content[0].text).not.toContain("Current avatar state:");

    s.store.updatePersonalAgent(s.agent.id, { enabled: true });
    s.store.setRole(s.owner.id, "admin", false);
    const demoted = await callTool(tools, "describe_system", {});
    expect(demoted.content[0].text).toContain("UNAVAILABLE.");
    expect(demoted.content[0].text).toContain("no longer holds the admin role");

    // A foreign acting user can learn nothing about the bot.
    const foreign = buildSystemTools(s.store, {
      avatarUserId: s.plain.id,
      owner: { id: s.plain.id, username: "plain", displayName: "일반" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.plain.id },
    });
    const notMine = await callTool(foreign, "describe_system", {});
    expect(notMine.content[0].text).toContain("UNAVAILABLE.");
    expect(notMine.content[0].text).toContain("does not belong to the person");
    expect(notMine.content[0].text).not.toContain("릴리즈 봇");
  });

  it("adds the roster line to the OWNER's own avatar only when the feature is on", async () => {
    const admin = systemTools("desc-roster");
    const res = await callTool(admin.tools, "describe_system", {});
    const body = res.content[0].text;
    expect(body).toContain("Personal bots (내 봇):");
    expect(body).toContain(`1 of ${MAX_PERSONAL_AGENTS} created`);
    expect(body).toContain("릴리즈 봇");
    expect(body).toContain("mcp__personal_agent__create_agent");

    const plain = systemTools("desc-roster-plain", { plain: true });
    const plainBody = (await callTool(plain.tools, "describe_system", {})).content[0].text;
    expect(plainBody).not.toContain("Personal bots (내 봇):");
    expect(plainBody).not.toContain("mcp__personal_agent__create_agent");
  });

  it("summarizePersonalAgentState fails closed for a foreign actor and a missing bot", () => {
    const { store, agent, owner, plain } = setup("summarize");
    expect(summarizePersonalAgentState(store, agent.id, owner.id)).toMatchObject({
      agentId: agent.id,
      displayName: "릴리즈 봇",
      alias: "릴봇",
      personaSet: false,
      enabled: true,
      ownerIsAdmin: true,
      agentCount: 1,
      maxAgents: MAX_PERSONAL_AGENTS,
    });
    expect(summarizePersonalAgentState(store, agent.id, plain.id)).toBeNull();
    expect(summarizePersonalAgentState(store, "ghost", owner.id)).toBeNull();
    store.setRole(owner.id, "admin", false);
    expect(summarizePersonalAgentState(store, agent.id, owner.id)?.ownerIsAdmin).toBe(
      false,
    );
  });
});

// ===========================================================================
// Prompt branch
// ===========================================================================
describe("personal-agent prompt branch", () => {
  const state = (over: Partial<PersonalAgentState> = {}): PersonalAgentState => ({
    agentId: "a1",
    ownerUserId: "u1",
    displayName: "릴리즈 봇",
    alias: "릴봇",
    personaSet: false,
    enabled: true,
    ownerIsAdmin: true,
    agentCount: 3,
    maxAgents: MAX_PERSONAL_AGENTS,
    ...over,
  });
  const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "안녕",
    // The OWNER's avatar, as the A-1 rule requires — the identity below must
    // still come out as the BOT's.
    avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "" },
    viewerIsOwner: true,
    viewerName: "오너",
    knowledgeRepoConfigured: true,
    gitTokenSet: true,
    personalAgentState: state(),
    ...over,
  });

  it("speaks as the BOT, not as the owner's own avatar", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain('Your name is "릴봇"');
    expect(p).not.toContain('Your name is "노아"');
    expect(p).toContain('You are **"릴봇"**');
    expect(p).toContain("personal bots");
    expect(p).toContain(`3 of ${MAX_PERSONAL_AGENTS} bots`);
    // Still an owner turn: the owner line and owner capability guidance follow.
    expect(p).toContain('this avatar\'s **owner**, "오너"');
  });

  it("falls back to the bot's display name when it has no alias", () => {
    const p = buildPrompt(req({ personalAgentState: state({ alias: "" }) }), 0);
    expect(p).toContain('You are **"릴리즈 봇"**');
    expect(p).not.toContain('Your name is "노아"');
  });

  it("carries the memory-namespace convention, the no-routines redirect, and the self-config trigger", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain("agents/<your-slug>/");
    expect(p).toContain("`wiki/`");
    expect(p).toContain("Scheduled routines do NOT work in this conversation");
    expect(p).toContain("mcp__system__create_routine");
    expect(p).toContain("MAIN avatar");
    expect(p).toContain("mcp__personal_agent__update_profile");
    expect(p).toContain("CONFIRM the exact wording");
    expect(p).toContain("Your persona is currently NOT set");
  });

  it("drops the namespace convention when there is no repository to write it in", () => {
    const p = buildPrompt(req({ knowledgeRepoConfigured: false }), 0);
    expect(p).toContain('You are **"릴봇"**');
    expect(p).not.toContain("agents/<your-slug>/");
  });

  it("never speaks a persona the bot does not have", () => {
    // What the chat route actually delivers for a persona-less bot: it overlays
    // the identity fields with `??`, so an EMPTY bot persona arrives as "" and
    // never inherits the owner's (routes/chat.ts, pinned on that side too).
    const emptyOverlay = buildPrompt(
      req({ avatar: { id: "u1", displayName: "빈 봇", alias: "", persona: "" } }),
      0,
    );
    expect(emptyOverlay).not.toContain("Persona/instructions:");
    expect(emptyOverlay).toContain('You are **"릴봇"**');

    // Belt and braces on the same outcome: even if a non-empty persona reached
    // this field, a bot whose own personaSet is false must not recite it.
    const withoutPersona = buildPrompt(
      req({
        avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "나는 오너의 아바타다" },
      }),
      0,
    );
    expect(withoutPersona).not.toContain("Persona/instructions:");
    expect(withoutPersona).not.toContain("나는 오너의 아바타다");

    const withPersona = buildPrompt(
      req({
        avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "릴리즈 노트만 쓴다" },
        personalAgentState: state({ personaSet: true }),
      }),
      0,
    );
    expect(withPersona).toContain("Persona/instructions:\n릴리즈 노트만 쓴다");
    expect(withPersona).toContain("Your persona is currently SET");
  });

  it("keeps getting-started and the create trigger OUT of a bot thread", () => {
    const p = buildPrompt(
      req({ knowledgeRepoConfigured: false, gitTokenSet: false }),
      0,
    );
    expect(p).not.toContain("this owner's setup is still incomplete");
    // create_agent belongs to the owner's own avatar; a bot never offers it.
    expect(p).not.toContain("mcp__personal_agent__create_agent");
  });

  it("gives the OWNER's own avatar the create trigger, gated on the registration flag", () => {
    const owner = buildPrompt(
      req({
        personalAgentState: null,
        personalAgentsEnabled: true,
        personalAgentNames: ["릴리즈 봇", "회의록 봇"],
      }),
      0,
    );
    expect(owner).toContain("**Personal bots (내 봇)**");
    expect(owner).toContain("2 enabled: 릴리즈 봇, 회의록 봇");
    expect(owner).toContain("mcp__personal_agent__create_agent");
    expect(owner).toContain("설정 → 내 봇");
    // The bot identity block stays out of a non-bot run.
    expect(owner).not.toContain('You are **"릴봇"**');

    // Feature off for this owner → no mention of a tool the run lacks.
    const plain = buildPrompt(req({ personalAgentState: null }), 0);
    expect(plain).not.toContain("**Personal bots (내 봇)**");
    expect(plain).not.toContain("mcp__personal_agent__create_agent");
  });
});
