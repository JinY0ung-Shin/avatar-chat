import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { makeBareRemote, parseSse, signup, withTempDir } from "./helpers.js";

// Mocked agent layer (routes-chat/group-agent pattern): captures the
// AgentRequest each chat turn builds so the personal-agent run wiring can be
// asserted without spawning the SDK.
const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  // The plugin roots the route resolved for each turn — how the bot's granted
  // skill allowlist is observed from outside `loadAgentPluginRoots`.
  pluginRoots: [] as { path: string }[][],
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      pluginRoots: { path: string }[],
      config: AppConfig,
      _store: unknown,
      events: AgentEvents,
    ) => {
      H.requests.push(agentRequest);
      H.pluginRoots.push(pluginRoots);
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.("[mock]");
      return { kind: "text", runtime: config.agentRuntime, summary: "mock", text: "[mock]" };
    },
  ),
  isRetryableModelError: vi.fn(() => false),
}));

import { createApp, createServices } from "../src/server/app.js";
import {
  personalAgentAvatarId,
  personalAgentWorkspaceParent,
} from "../src/server/personalAgents.js";
import { MAX_PERSONAL_AGENTS } from "../src/server/store.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { workspaceDirFor } from "../src/server/workspace.js";

const tempDir = withTempDir("personal-agent-routes");

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function services(dir: string, over: { agentRuntime?: "local" | "claude" } = {}) {
  const dataDir = path.join(tempDir(), dir);
  return createServices({
    dataDir,
    agentRuntime: "local",
    sessionSecret: "t",
    // Skill/plugin assertions read the knowledge repo only — keep the bundled
    // default plugins out of the picture. Harmless for the `local` runtime,
    // which loads nothing at all.
    defaultPluginsDir: path.join(dataDir, "no-default-plugins"),
    ...over,
  });
}

function boot(dir: string, over: { agentRuntime?: "local" | "claude" } = {}) {
  H.requests.length = 0;
  H.pluginRoots.length = 0;
  const svc = services(dir, over);
  const app = createApp(svc);
  return { ...svc, app };
}

/**
 * A local bare remote seeded with `files` on `main` (the offline knowledge-repo
 * fixture pattern from skill-share.test.ts) — the skill catalog runs a real
 * `ensureClone`, so it needs a real repo, not a mock.
 */
function seedRemote(name: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(tempDir(), `${name}.git`));
  const seed = path.join(tempDir(), `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "seed@example.com");
  g("config", "user.name", "Seed");
  g("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

/** SKILL.md text with the frontmatter `listRepoSkills` reads. */
function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describe("personal-agent routes", () => {
  // Kept separate from the lifecycle test below: both are request-heavy, and one
  // combined test sat right on vitest's 5s default timeout.
  it("admin-gates every /api/me/agents route", async () => {
    const { app } = boot("admin-gate");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201); // first signup = system admin
    const plain = request.agent(app);
    await signup(plain, "plain").expect(201);

    // Non-admin: every route is 403, including the read.
    await plain.get("/api/me/agents").expect(403);
    await plain.get("/api/me/agents/skill-catalog").expect(403);
    await plain.post("/api/me/agents").send({ displayName: "봇" }).expect(403);
    await plain.patch("/api/me/agents/whatever").send({ enabled: false }).expect(403);
    await plain.delete("/api/me/agents/whatever").expect(403);
    await plain.put("/api/me/agents/whatever/image").send({ image: PNG }).expect(403);
    await plain.delete("/api/me/agents/whatever/image").expect(403);
    // The admin reaches the same routes.
    await admin.get("/api/me/agents").expect(200);
  });

  it("validates the write body and runs the CRUD lifecycle", async () => {
    const { app } = boot("crud");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);

    // Validation: name required, per-field caps (one field proves the shared
    // cap loop), tier list.
    const noName = await admin.post("/api/me/agents").send({}).expect(400);
    expect(noName.body.error).toContain("봇 이름을 입력해 주세요");
    await admin.post("/api/me/agents").send({ displayName: "x".repeat(65) }).expect(400);
    const overCap = await admin
      .post("/api/me/agents")
      .send({ displayName: "봇", persona: "x".repeat(8_001) })
      .expect(400);
    expect(overCap.body.error).toContain("persona");
    const badModel = await admin
      .post("/api/me/agents")
      .send({ displayName: "봇", defaultModel: "gpt-9" })
      .expect(400);
    expect(badModel.body.error).toContain("지원하지 않는 모델입니다");

    const created = await admin
      .post("/api/me/agents")
      .send({
        displayName: "  리서치 봇  ",
        alias: "리서치",
        bio: "조사 담당",
        hashtags: ["#Infra", "infra", "리서치"],
        defaultModel: "sonnet",
      })
      .expect(200);
    const agentId = created.body.agent.id as string;
    expect(created.body.agent).toMatchObject({
      displayName: "리서치 봇",
      alias: "리서치",
      enabled: true,
      defaultModel: "sonnet",
      hasImage: false,
      hashtags: ["Infra", "리서치"],
    });

    const roster = await admin.get("/api/me/agents").expect(200);
    expect(roster.body.agents).toHaveLength(1);

    // PATCH gates: unknown id 404, blank rename 400, bad tier 400.
    await admin.patch("/api/me/agents/ghost").send({ enabled: false }).expect(404);
    await admin.patch(`/api/me/agents/${agentId}`).send({ displayName: "  " }).expect(400);
    await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ defaultModel: "gpt-9" })
      .expect(400);

    // Omitted defaultModel keeps the stored tier; "" clears it.
    const renamed = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ displayName: "리서치 도우미", enabled: false })
      .expect(200);
    expect(renamed.body.agent).toMatchObject({
      displayName: "리서치 도우미",
      enabled: false,
      defaultModel: "sonnet",
    });
    const cleared = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ defaultModel: "" })
      .expect(200);
    expect(cleared.body.agent.defaultModel).toBeNull();

    // A disabled bot stays in the owner's roster (that's where it's re-enabled).
    const withDisabled = await admin.get("/api/me/agents").expect(200);
    expect(withDisabled.body.agents.map((a: { enabled: boolean }) => a.enabled)).toEqual([false]);

    await admin.delete("/api/me/agents/ghost").expect(404);
    await admin.delete(`/api/me/agents/${agentId}`).expect(200);
    expect((await admin.get("/api/me/agents").expect(200)).body.agents).toEqual([]);
  });

  it("serves memoryDir + selectedSkills and full-replaces a validated grant list", async () => {
    const { app, store } = boot("skills-patch");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);

    const created = await admin
      .post("/api/me/agents")
      .send({ displayName: "코딩 봇", selectedSkills: ["code-review", "code-review", ""] })
      .expect(200);
    const agentId = created.body.agent.id as string;
    // Create accepts the grant list (deduped) and stamps the memory folder.
    expect(created.body.agent.selectedSkills).toEqual(["code-review"]);
    // A Korean name leaves nothing after the ASCII filter → the "bot" fallback.
    expect(created.body.agent.memoryDir).toBe(`bot-${agentId.slice(0, 8)}`);

    // Validation matrix — every rejection is a 400 with the file's error shape.
    const notArray = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: "code-review" })
      .expect(400);
    expect(notArray.body.error).toContain("스킬 목록 형식이 올바르지 않습니다");
    await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: [42] })
      .expect(400);
    const traversal = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: ["../../etc"] })
      .expect(400);
    expect(traversal.body.error).toContain("사용할 수 없는 스킬 이름입니다");
    const tooLong = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: ["x".repeat(101)] })
      .expect(400);
    expect(tooLong.body.error).toContain("최대 100자");
    const tooMany = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: Array.from({ length: 65 }, (_, i) => `s-${i}`) })
      .expect(400);
    expect(tooMany.body.error).toContain("최대 64개");
    // A rejected patch changes nothing.
    expect(store.getPersonalAgentById(agentId)!.selectedSkills).toEqual(["code-review"]);

    // Omitted = unchanged; an array = FULL replace; [] = revoke all.
    const renamed = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ displayName: "코딩 도우미" })
      .expect(200);
    expect(renamed.body.agent.selectedSkills).toEqual(["code-review"]);
    // The memory folder is insert-only — a rename must not move it.
    expect(renamed.body.agent.memoryDir).toBe(created.body.agent.memoryDir);
    const replaced = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: ["pptx-report", "deploy", "deploy"] })
      .expect(200);
    expect(replaced.body.agent.selectedSkills).toEqual(["pptx-report", "deploy"]);
    const revoked = await admin
      .patch(`/api/me/agents/${agentId}`)
      .send({ selectedSkills: [] })
      .expect(200);
    expect(revoked.body.agent.selectedSkills).toEqual([]);

    // The roster read carries both new fields.
    const roster = await admin.get("/api/me/agents").expect(200);
    expect(roster.body.agents[0]).toMatchObject({
      memoryDir: created.body.agent.memoryDir,
      selectedSkills: [],
    });
  });

  it("answers the skill catalog from the owner's repo, and keeps its literal path", async () => {
    const { app, store } = boot("skill-catalog");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    const bot = store.createPersonalAgent(ownerId, { displayName: "봇" });

    // No repo connected is a NORMAL state, not an error.
    const none = await admin.get("/api/me/agents/skill-catalog").expect(200);
    expect(none.body).toEqual({ repoConfigured: false, skills: [] });

    // A repo with no skills/ dir answers connected-but-empty.
    store.setKnowledgeRepo(
      ownerId,
      seedRemote("empty-repo", { "README.md": "hi" }),
      "main",
    );
    const empty = await admin.get("/api/me/agents/skill-catalog").expect(200);
    expect(empty.body).toEqual({ repoConfigured: true, skills: [] });

    // With skills: slug + the SKILL.md frontmatter description, slug-sorted.
    store.setKnowledgeRepo(
      ownerId,
      seedRemote("skills-repo", {
        "skills/pptx-report/SKILL.md": skillMd("pptx-report", "Weekly deck"),
        "skills/code-review/SKILL.md": skillMd("code-review", "Reads a PR first"),
        // No SKILL.md → not a skill.
        "skills/not-a-skill/notes.md": "nope",
      }),
      "main",
    );
    const listed = await admin.get("/api/me/agents/skill-catalog").expect(200);
    expect(listed.body).toEqual({
      repoConfigured: true,
      skills: [
        { slug: "code-review", intro: "Reads a PR first" },
        { slug: "pptx-report", intro: "Weekly deck" },
      ],
    });

    // Route order: the literal path must not be captured as an :agentId, and the
    // real bot id still resolves on the sibling routes.
    expect(store.getPersonalAgentById("skill-catalog")).toBeNull();
    await admin.patch(`/api/me/agents/${bot.id}`).send({ enabled: false }).expect(200);
    await admin.patch("/api/me/agents/skill-catalog").send({ enabled: false }).expect(404);
  });

  it("caps the roster at MAX_PERSONAL_AGENTS", async () => {
    const { app, store } = boot("cap");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    for (let i = 0; i < MAX_PERSONAL_AGENTS; i += 1) {
      store.createPersonalAgent(ownerId, { displayName: `봇 ${i}` });
    }
    const full = await admin.post("/api/me/agents").send({ displayName: "하나 더" }).expect(400);
    expect(full.body.error).toContain(`최대 ${MAX_PERSONAL_AGENTS}개`);
  });

  it("404s another admin's bot and hides it from their discovery", async () => {
    const { app, store } = boot("ownership");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const other = request.agent(app);
    await signup(other, "other-admin").expect(201);
    const plain = request.agent(app);
    await signup(plain, "plain").expect(201);
    const otherId = store.getUserByUsername("other-admin")!.id;
    await admin
      .post(`/api/admin/users/${otherId}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);

    const created = await admin
      .post("/api/me/agents")
      .send({ displayName: "내 봇" })
      .expect(200);
    const agentId = created.body.agent.id as string;
    const avatarId = personalAgentAvatarId(
      store.getUserByUsername("sys-admin")!.id,
      agentId,
    );

    // Another ADMIN sees an empty roster and gets the not-found shape (never
    // 403 — that would confirm the row exists).
    expect((await other.get("/api/me/agents").expect(200)).body.agents).toEqual([]);
    await other.patch(`/api/me/agents/${agentId}`).send({ enabled: false }).expect(404);
    await other.delete(`/api/me/agents/${agentId}`).expect(404);
    await other.put(`/api/me/agents/${agentId}/image`).send({ image: PNG }).expect(404);
    await other.delete(`/api/me/agents/${agentId}/image`).expect(404);
    await other.get(`/api/avatars/${encodeURIComponent(avatarId)}`).expect(404);
    const otherList = await other.get("/api/avatars").expect(200);
    expect(otherList.body.avatars.some((a: { id: string }) => a.id === avatarId)).toBe(false);
    const plainList = await plain.get("/api/avatars").expect(200);
    expect(plainList.body.avatars.some((a: { id: string }) => a.id === avatarId)).toBe(false);
  });

  it("shows the bot to its owner only, across list/detail/skills/models", async () => {
    const { app, store } = boot("visibility");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    const agent = store.createPersonalAgent(ownerId, {
      displayName: "리서치 봇",
      bio: "조사 담당",
      defaultModel: "haiku",
    });
    const avatarId = personalAgentAvatarId(ownerId, agent.id);
    const encoded = encodeURIComponent(avatarId);

    const list = await admin.get("/api/avatars").expect(200);
    const card = list.body.avatars.find((a: { id: string }) => a.id === avatarId);
    expect(card).toMatchObject({
      displayName: "리서치 봇",
      runtime: "native",
      visibility: "group",
      sharesGroup: false,
      personalAgent: { agentId: agent.id, defaultModel: "haiku" },
    });

    const detail = await admin.get(`/api/avatars/${encoded}`).expect(200);
    expect(detail.body.avatar).toMatchObject({
      isOwn: false,
      elevated: true,
      personalAgent: { agentId: agent.id },
    });
    const skills = await admin.get(`/api/avatars/${encoded}/skills`).expect(200);
    expect(skills.body.skills).toEqual([]); // local runtime
    const models = await admin.get(`/api/avatars/${encoded}/models`).expect(200);
    expect(models.body).toEqual({ models: [], defaultModel: null });

    // Disabling hides it from discovery entirely (the settings roster keeps it).
    store.updatePersonalAgent(agent.id, { enabled: false });
    const hidden = await admin.get("/api/avatars").expect(200);
    expect(hidden.body.avatars.some((a: { id: string }) => a.id === avatarId)).toBe(false);
    await admin.get(`/api/avatars/${encoded}`).expect(404);
    await admin.get(`/api/avatars/${encoded}/skills`).expect(404);
    await admin.get(`/api/avatars/${encoded}/models`).expect(404);
  });

  it("reports and loads only the knowledge-repo skills granted to the bot", async () => {
    // A NON-local runtime: `local` loads no plugins and lists no skills at all.
    const { app, store, config } = boot("skill-grants", { agentRuntime: "claude" });
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    // A marketplace knowledge repo with two skills, plus a standing-memory file
    // in the owner's root AND one in the bot's own folder.
    const agent = store.createPersonalAgent(ownerId, { displayName: "리서치 봇" });
    const memoryRoot = `agents/${agent.memoryDir}`;
    const slugs = ["code-review", "pptx-report"];
    const files: Record<string, string> = {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: slugs.map((slug) => ({ name: slug, source: `./skills/${slug}` })),
      }),
      "CLAUDE.md": "OWNER standing memory",
      [`${memoryRoot}/CLAUDE.md`]: "BOT standing memory",
    };
    for (const slug of slugs) {
      files[`skills/${slug}/SKILL.md`] = `---\nname: ${slug}\ndescription: ${slug} does things\n---\n`;
      files[`skills/${slug}/.claude-plugin/plugin.json`] = JSON.stringify({ name: slug });
    }
    store.setKnowledgeRepo(ownerId, seedRemote("skill-grants", files), "main");
    const avatarId = personalAgentAvatarId(ownerId, agent.id);
    const encoded = encodeURIComponent(avatarId);

    // No grants yet: the panel must not advertise the owner's skills as the
    // bot's, while the owner's OWN avatar still lists both.
    const none = await admin.get(`/api/avatars/${encoded}/skills`).expect(200);
    expect(none.body.skills).toEqual([]);
    const ownerSkills = await admin.get(`/api/avatars/${ownerId}/skills`).expect(200);
    expect(ownerSkills.body.skills.map((s: { name: string }) => s.name)).toEqual(slugs.slice().sort());

    store.updatePersonalAgent(agent.id, { selectedSkills: ["code-review"] });
    const granted = await admin.get(`/api/avatars/${encoded}/skills`).expect(200);
    expect(granted.body.skills.map((s: { name: string }) => s.name)).toEqual(["code-review"]);

    // …and the chat turn loads the same set, with the bot's OWN standing memory.
    const ok = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-skills", message: "안녕" })
      .expect(200);
    expect(parseSse(ok.text).some((f) => f.event === "done")).toBe(true);
    const clone = path.join(config.dataDir, "knowledge", ownerId);
    expect(H.pluginRoots[0].map((r) => r.path)).toEqual([
      path.join(clone, "skills", "code-review"),
    ]);
    expect(H.requests[0].knowledgeMemory?.personal).toBe("BOT standing memory");

    // Control: the owner's own turn keeps both skills and the ROOT memory.
    await admin
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "owner-skills", message: "안녕" })
      .expect(200);
    expect(H.pluginRoots[1].map((r) => r.path).sort()).toEqual(
      [
        path.join(clone, "skills", "code-review"),
        path.join(clone, "skills", "pptx-report"),
      ].sort(),
    );
    expect(H.requests[1].knowledgeMemory?.personal).toBe("OWNER standing memory");
  });

  it("pins the bot turn to an OWNER run while the thread keeps the composite id", async () => {
    const { app, store, config } = boot("chat");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const outsider = request.agent(app);
    await signup(outsider, "outsider").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    // The owner's OWN avatar carries a persona too, so the overlay assertions
    // below prove the bot's identity wins rather than merely being present.
    store.updateProfile(ownerId, {
      alias: "오너별칭",
      persona: "오너 페르소나",
    });
    const agent = store.createPersonalAgent(ownerId, {
      displayName: "리서치 봇",
      alias: "리서치",
      persona: "간결하게",
    });
    const avatarId = personalAgentAvatarId(ownerId, agent.id);

    const ok = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-c1", message: "안녕" })
      .expect(200);
    expect(parseSse(ok.text).some((f) => f.event === "done")).toBe(true);
    expect(H.requests).toHaveLength(1);
    // A bot turn is a FULL OWNER run: owner capability, no groupAgent kill
    // switch, and `avatar` is the owner's OWN row (never the composite id).
    expect(H.requests[0]).toMatchObject({
      viewerIsOwner: true,
      elevated: true,
      trustedViaGroups: [],
      personalAgent: { agentId: agent.id, ownerUserId: ownerId },
    });
    expect(H.requests[0].groupAgent).toBeUndefined();
    // The id is the CAPABILITY key and stays the owner's; the conversational
    // identity is overlaid with the bot's, so the prompt never speaks the
    // owner's persona as the bot's standing instructions.
    expect(H.requests[0].avatar.id).toBe(ownerId);
    expect(H.requests[0].avatar).toMatchObject({
      displayName: "리서치 봇",
      alias: "리서치",
      persona: "간결하게",
    });

    // Thread-scoped state stays on the COMPOSITE id: the conversation binding,
    // the client-facing run event, and the scratch workspace.
    const conversations = await admin.get("/api/conversations").expect(200);
    const thread = conversations.body.conversations.find(
      (c: { id: string }) => c.id === "pa-c1",
    );
    expect(thread.avatarUserId).toBe(avatarId);
    expect(thread.avatarDisplayName).toBe("리서치 봇");
    const openFrame = parseSse(ok.text).find((f) => f.event === "open");
    expect((openFrame!.data as { avatarId: string }).avatarId).toBe(avatarId);
    expect(fs.existsSync(workspaceDirFor(config, avatarId, "pa-c1"))).toBe(true);

    // Owner-only slash commands DO work in a bot thread (it is an owner run).
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-c1", message: "/learn" })
      .expect(200);

    // Nobody else reaches it — the generic fail-closed 403, no existence leak.
    const blocked = await outsider
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-c2", message: "안녕" })
      .expect(403);
    expect(blocked.body.error).toContain("이 아바타와 대화할 수 없습니다");

    // Disabled: the owner's own dedicated 403, with history preserved.
    store.updatePersonalAgent(agent.id, { enabled: false });
    const disabled = await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-c1", message: "계속" })
      .expect(403);
    expect(disabled.body.error).toContain("이 봇은 비활성화되어 있습니다");
    expect(disabled.body.error).toContain("설정 → 내 봇");
    expect(store.listMessages(ownerId, "pa-c1").length).toBeGreaterThan(0);
  });

  it("never lets a persona-less bot inherit the owner's alias or persona", async () => {
    const { app, store } = boot("blank-persona");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    store.updateProfile(ownerId, {
      alias: "오너별칭",
      persona: "오너 페르소나",
    });
    const agent = store.createPersonalAgent(ownerId, { displayName: "빈 봇" });

    await admin
      .post("/api/chat/stream")
      .send({
        avatarId: personalAgentAvatarId(ownerId, agent.id),
        conversationId: "pa-blank",
        message: "안녕",
      })
      .expect(200);
    // Empty stays empty (`??`, not `||`): the prompt suppresses the persona line
    // instead of falling back to the owner's, and the name falls back to the
    // BOT's displayName.
    expect(H.requests[0].avatar).toMatchObject({
      id: ownerId,
      displayName: "빈 봇",
      alias: "",
      persona: "",
    });
  });

  it("fails the next turn closed once the owner loses the admin role", async () => {
    const { app, store } = boot("role-revoked");
    const root = request.agent(app);
    await signup(root, "sys-admin").expect(201);
    const owner = request.agent(app);
    await signup(owner, "bot-owner").expect(201);
    const ownerId = store.getUserByUsername("bot-owner")!.id;
    await root
      .post(`/api/admin/users/${ownerId}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);

    const created = await owner
      .post("/api/me/agents")
      .send({ displayName: "내 봇" })
      .expect(200);
    const avatarId = personalAgentAvatarId(ownerId, created.body.agent.id);
    await owner
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-role", message: "안녕" })
      .expect(200);

    await root
      .post(`/api/admin/users/${ownerId}/roles`)
      .send({ role: "admin", grant: false })
      .expect(200);

    // Management and reach both fail closed; the thread's history survives.
    await owner.get("/api/me/agents").expect(403);
    await owner.get(`/api/avatars/${encodeURIComponent(avatarId)}`).expect(404);
    const after = await owner
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-role", message: "계속" })
      .expect(403);
    expect(after.body.error).toContain("이 아바타와 대화할 수 없습니다");
    expect(store.listMessages(ownerId, "pa-role").length).toBeGreaterThan(0);
  });

  it("stores/serves/removes the bot image and sweeps disk on bot delete", async () => {
    const { app, store, config } = boot("image");
    const admin = request.agent(app);
    await signup(admin, "sys-admin").expect(201);
    const ownerId = store.getUserByUsername("sys-admin")!.id;
    const created = await admin
      .post("/api/me/agents")
      .send({ displayName: "리서치 봇" })
      .expect(200);
    const agentId = created.body.agent.id as string;
    const avatarId = personalAgentAvatarId(ownerId, agentId);
    const imagePath = `/api/me/agents/${agentId}/image`;

    await admin.put(imagePath).send({ image: "data:text/plain;base64,eA==" }).expect(400);
    await admin.put(imagePath).send({ image: PNG }).expect(200);
    expect(store.getPersonalAgentById(agentId)!.hasImage).toBe(true);
    const image = await admin
      .get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`)
      .expect(200);
    expect(image.headers["content-type"]).toContain("image/png");

    await admin.delete(imagePath).expect(200);
    await admin.get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`).expect(404);

    // Delete sweeps the on-disk leftovers: image file, workspace tree, and every
    // thread's chat image/file dirs (ids snapshotted BEFORE the row cascade).
    await admin.put(imagePath).send({ image: PNG }).expect(200);
    await admin
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-del", message: "안녕" })
      .expect(200);
    const imgDir = chatImagesDir(config, "pa-del");
    const fileDir = chatFilesDir(config, "pa-del");
    fs.mkdirSync(imgDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, "img.png"), "x");
    fs.writeFileSync(path.join(fileDir, "doc.pdf"), "x");
    const workspaceParent = personalAgentWorkspaceParent(config, {
      id: agentId,
      ownerUserId: ownerId,
    });
    expect(fs.existsSync(workspaceParent)).toBe(true);

    await admin.delete(`/api/me/agents/${agentId}`).expect(200);
    expect(store.getPersonalAgentById(agentId)).toBeNull();
    expect(store.listMessages(ownerId, "pa-del")).toEqual([]);
    expect(fs.existsSync(workspaceParent)).toBe(false);
    expect(fs.existsSync(imgDir)).toBe(false);
    expect(fs.existsSync(fileDir)).toBe(false);
    await admin.get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`).expect(404);
  });

  it("sweeps a deleted user's bot images and workspaces", async () => {
    const { app, store, config } = boot("delete-user");
    const root = request.agent(app);
    await signup(root, "sys-admin").expect(201);
    const owner = request.agent(app);
    await signup(owner, "bot-owner").expect(201);
    const ownerId = store.getUserByUsername("bot-owner")!.id;
    await root
      .post(`/api/admin/users/${ownerId}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);

    const created = await owner
      .post("/api/me/agents")
      .send({ displayName: "내 봇" })
      .expect(200);
    const agentId = created.body.agent.id as string;
    const avatarId = personalAgentAvatarId(ownerId, agentId);
    await owner.put(`/api/me/agents/${agentId}/image`).send({ image: PNG }).expect(200);
    await owner
      .post("/api/chat/stream")
      .send({ avatarId, conversationId: "pa-user-del", message: "안녕" })
      .expect(200);
    const imgDir = chatImagesDir(config, "pa-user-del");
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, "img.png"), "x");
    const workspaceParent = personalAgentWorkspaceParent(config, {
      id: agentId,
      ownerUserId: ownerId,
    });
    expect(fs.existsSync(workspaceParent)).toBe(true);

    await root.delete(`/api/admin/users/${ownerId}`).expect(200);
    expect(store.listPersonalAgents(ownerId, { includeDisabled: true })).toEqual([]);
    expect(fs.existsSync(workspaceParent)).toBe(false);
    expect(fs.existsSync(imgDir)).toBe(false);
    await root.get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`).expect(404);
  });
});
