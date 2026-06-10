import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { loadDefaultPluginRoots, resolvePluginRoots } from "../src/server/plugins.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-chat-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function testApp() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return createApp(services);
}

function signup(agent: ReturnType<typeof request.agent>, username: string, password = "password123") {
  return agent.post("/api/auth/signup").send({ username, displayName: username, password });
}

// 1x1 transparent PNG as a data URL, for avatar-image upload tests.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC";

/** Sign up a user and return their agent + user record. */
async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, user: res.body.user as { id: string; username: string; roles: string[] } };
}

/** Parse SSE text into a list of {event, data} frames. */
function parseSse(raw: string): { event: string; data: unknown }[] {
  const frames: { event: string; data: unknown }[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) {
      frames.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  return frames;
}

describe("avatar-chat platform", () => {
  it("reports needsSetup until the first account exists", async () => {
    const app = testApp();
    const fresh = await request(app).get("/api/bootstrap").expect(200);
    expect(fresh.body.needsSetup).toBe(true);

    await signup(request.agent(app), "alice").expect(201);

    const after = await request(app).get("/api/bootstrap").expect(200);
    expect(after.body.needsSetup).toBe(false);
  });

  it("makes the first signup an admin and subsequent users members only", async () => {
    const app = testApp();
    const first = request.agent(app);
    const firstRes = await signup(first, "alice").expect(201);
    expect(firstRes.body.user.username).toBe("alice");
    expect(firstRes.body.user.roles).toContain("admin");
    expect(firstRes.body.user.roles).toContain("member");

    const second = request.agent(app);
    const secondRes = await signup(second, "bob").expect(201);
    expect(secondRes.body.user.roles).toContain("member");
    expect(secondRes.body.user.roles).not.toContain("admin");
  });

  it("rejects duplicate usernames with 409", async () => {
    const app = testApp();
    await signup(request.agent(app), "carol").expect(201);
    await signup(request.agent(app), "carol").expect(409);
  });

  it("rejects login with wrong password (401)", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "dave", "password123").expect(201);
    await agent.post("/api/auth/login").send({ username: "dave", password: "wrong-pass" }).expect(401);
    const ok = await agent
      .post("/api/auth/login")
      .send({ username: "dave", password: "password123" })
      .expect(200);
    expect(ok.body.user.username).toBe("dave");
  });

  it("updates profile via PATCH /api/me", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "erin").expect(201);
    const res = await agent
      .patch("/api/me")
      .send({ displayName: "Erin K", published: true })
      .expect(200);
    expect(res.body.user.displayName).toBe("Erin K");
    expect(res.body.user.published).toBe(true);
  });

  it("supports plugin add / list / delete", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "frank").expect(201);

    const added = await agent
      .post("/api/me/plugins")
      .send({ repo: "owner/repo", label: "My Plugin" })
      .expect(200);
    expect(added.body.plugin.repo).toBe("owner/repo");
    expect(added.body.plugin.enabled).toBe(true);

    await agent.post("/api/me/plugins").send({ repo: "not a repo!!" }).expect(400);

    const list = await agent.get("/api/me/plugins").expect(200);
    expect(list.body.plugins).toHaveLength(1);

    await agent.delete(`/api/me/plugins/${added.body.plugin.id}`).expect(200);
    const after = await agent.get("/api/me/plugins").expect(200);
    expect(after.body.plugins).toHaveLength(0);
  });

  it("lets an owner create, edit, run, and delete routine jobs", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "rita").expect(201);

    // Bad input is rejected before anything is stored.
    await agent.post("/api/me/routines").send({ prompt: "p", time: "25:00" }).expect(400);
    await agent.post("/api/me/routines").send({ prompt: "", time: "09:00" }).expect(400);
    await agent.post("/api/me/routines").send({ prompt: "p", time: "09:00", enabled: "true" }).expect(400);

    const created = await agent
      .post("/api/me/routines")
      .send({ prompt: "오늘 요약해줘", time: "09:30" })
      .expect(200);
    const routine = created.body.routine;
    expect(routine.time).toBe("09:30");
    expect(routine.enabled).toBe(true);
    expect(routine.nextRunAt).toBeTruthy();

    // The dedicated conversation exists immediately, titled from the prompt.
    const convs = await agent.get("/api/conversations").expect(200);
    const conv = convs.body.conversations.find(
      (c: { id: string }) => c.id === routine.conversationId,
    );
    expect(conv).toBeTruthy();
    expect(conv.title.startsWith("[루틴]")).toBe(true);

    // Edit: disable + change time.
    const edited = await agent
      .patch(`/api/me/routines/${routine.id}`)
      .send({ enabled: false, time: "07:00" })
      .expect(200);
    expect(edited.body.routine.enabled).toBe(false);
    expect(edited.body.routine.time).toBe("07:00");
    expect(edited.body.routine.nextRunAt).toBeNull();

    // Run now (local runtime → deterministic) appends to the routine's conversation.
    const ran = await agent.post(`/api/me/routines/${routine.id}/run`).expect(200);
    expect(ran.body.ok).toBe(true);
    expect(ran.body.routine.lastStatus).toBe("success");
    const msgs = await agent
      .get(`/api/messages?conversationId=${routine.conversationId}`)
      .expect(200);
    expect(msgs.body.messages.length).toBeGreaterThanOrEqual(2);

    // Another user cannot touch it.
    const { agent: stranger } = await newUser(app, "sam");
    await stranger.patch(`/api/me/routines/${routine.id}`).send({ prompt: "x" }).expect(404);
    await stranger.delete(`/api/me/routines/${routine.id}`).expect(404);

    await agent.delete(`/api/me/routines/${routine.id}`).expect(200);
    const list = await agent.get("/api/me/routines").expect(200);
    expect(list.body.routines).toHaveLength(0);
  });

  it("shows published avatars and hides unpublished ones from other users", async () => {
    const app = testApp();
    const publisher = request.agent(app);
    const pubRes = await signup(publisher, "gina").expect(201);
    await publisher.patch("/api/me").send({ published: true }).expect(200);

    const hidden = request.agent(app);
    const hiddenRes = await signup(hidden, "henry").expect(201);

    const viewer = request.agent(app);
    await signup(viewer, "ivy").expect(201);

    const avatars = await viewer.get("/api/avatars").expect(200);
    const ids = avatars.body.avatars.map((a: { id: string }) => a.id);
    expect(ids).toContain(pubRes.body.user.id);
    expect(ids).not.toContain(hiddenRes.body.user.id);

    // Direct fetch of an unpublished, non-own avatar → 404.
    await viewer.get(`/api/avatars/${hiddenRes.body.user.id}`).expect(404);
    // Published avatar is visible.
    await viewer.get(`/api/avatars/${pubRes.body.user.id}`).expect(200);
  });

  it("streams a local-runtime chat and persists conversation + messages", async () => {
    const app = testApp();
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "judy").expect(201);
    await owner.patch("/api/me").send({ published: true }).expect(200);

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕하세요" })
      .expect(200);

    const frames = parseSse(res.text);
    const open = frames.find((f) => f.event === "open");
    expect(open).toBeTruthy();
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeTruthy();
    const donePayload = done!.data as { message: { content: string }; response: { text: string; runtime: string } };
    expect(donePayload.response.runtime).toBe("local");
    expect(donePayload.response.text).toBe("[local] 안녕하세요");
    expect(donePayload.message.content).toBe("[local] 안녕하세요");

    const convId = (open!.data as { conversationId: string }).conversationId;
    const convs = await owner.get("/api/conversations").expect(200);
    expect(convs.body.conversations.some((c: { id: string }) => c.id === convId)).toBe(true);

    const messages = await owner.get(`/api/messages?conversationId=${convId}`).expect(200);
    expect(messages.body.messages).toHaveLength(2);
    expect(messages.body.messages[0].role).toBe("user");
    expect(messages.body.messages[1].role).toBe("assistant");
    expect(messages.body.messages[1].content).toBe("[local] 안녕하세요");
  });

  it("returns 401 for unauthenticated requests", async () => {
    const app = testApp();
    await request(app).get("/api/me/plugins").expect(401);
    const me = await request(app).get("/api/me").expect(200);
    expect(me.body.user).toBeNull();
  });

  it("forbids admin-only endpoints for members (403)", async () => {
    const app = testApp();
    await signup(request.agent(app), "admin-user").expect(201); // first → admin

    const member = request.agent(app);
    await signup(member, "member-user").expect(201);
    await member.get("/api/admin/users").expect(403);
  });

  it("allows admin to list users", async () => {
    const app = testApp();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/users").expect(200);
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].username).toBe("boss");
  });

  // ---- Input validation -------------------------------------------------

  it("rejects invalid signup input (short/invalid username, short password)", async () => {
    const app = testApp();
    await request(app).post("/api/auth/signup").send({ username: "ab", displayName: "x", password: "password123" }).expect(400);
    await request(app).post("/api/auth/signup").send({ username: "has space", displayName: "x", password: "password123" }).expect(400);
    await request(app).post("/api/auth/signup").send({ username: "validname", displayName: "x", password: "short" }).expect(400);
  });

  it("never returns the password hash to the client", async () => {
    const app = testApp();
    const { user } = await newUser(app, "secure");
    expect(user).not.toHaveProperty("password_hash");
    expect(user).not.toHaveProperty("passwordHash");
  });

  // ---- Session lifecycle ------------------------------------------------

  it("clears the session on logout", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "lori");
    await agent.get("/api/me/plugins").expect(200);
    await agent.post("/api/auth/logout").expect(200);
    await agent.get("/api/me/plugins").expect(401);
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user).toBeNull();
  });

  // ---- Profile + persona ------------------------------------------------

  it("stores bio/persona and exposes persona + plugins on the owner's avatar detail", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "mira");
    await agent.patch("/api/me").send({ bio: "도우미", persona: "간결하게", published: true }).expect(200);
    await agent.post("/api/me/plugins").send({ repo: "owner/tool", label: "Tool" }).expect(200);

    const detail = await agent.get(`/api/avatars/${user.id}`).expect(200);
    expect(detail.body.avatar.isOwn).toBe(true);
    expect(detail.body.avatar.persona).toBe("간결하게");
    expect(detail.body.avatar.plugins.length).toBe(1);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.pluginCount).toBe(1);
  });

  // ---- Avatar image -----------------------------------------------------

  it("uploads, serves, and deletes an avatar image", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "nina");

    await request(app).get(`/api/users/${user.id}/avatar-image`).expect(404);

    const up = await agent.put("/api/me/avatar-image").send({ image: PNG_DATA_URL }).expect(200);
    expect(up.body.hasImage).toBe(true);

    const img = await request(app).get(`/api/users/${user.id}/avatar-image`).expect(200);
    expect(img.headers["content-type"]).toContain("image/png");

    await agent.delete("/api/me/avatar-image").expect(200);
    await request(app).get(`/api/users/${user.id}/avatar-image`).expect(404);
  });

  it("rejects a non-image avatar upload and oversized images", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "olga");
    await agent.put("/api/me/avatar-image").send({ image: "data:text/plain;base64,aGVsbG8=" }).expect(400);
    // > 2MB once base64-decoded, but kept under the 3MB body limit.
    const oversized = `data:image/png;base64,${"A".repeat(2_800_000)}`;
    await agent.put("/api/me/avatar-image").send({ image: oversized }).expect(400);
  });

  // ---- Plugins ----------------------------------------------------------

  it("toggles a plugin's enabled flag and 404s on unknown plugin", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "pat");
    const added = await agent.post("/api/me/plugins").send({ repo: "owner/repo" }).expect(200);
    const id = added.body.plugin.id;

    const off = await agent.patch(`/api/me/plugins/${id}`).send({ enabled: false }).expect(200);
    expect(off.body.plugin.enabled).toBe(false);

    await agent.patch(`/api/me/plugins/${id}`).send({}).expect(400);
    await agent.delete("/api/me/plugins/does-not-exist").expect(404);
  });

  // ---- Chat validation + authorization ----------------------------------

  it("validates chat input and forbids chatting with an unpublished avatar", async () => {
    const app = testApp();
    const { user: owner } = await newUser(app, "quinn"); // unpublished
    const viewer = (await newUser(app, "rex")).agent;

    await viewer.post("/api/chat/stream").send({ avatarId: owner.id, message: "" }).expect(400);
    await viewer.post("/api/chat/stream").send({ message: "hi" }).expect(400);
    // owner avatar is not published and not the viewer's own → 403.
    await viewer.post("/api/chat/stream").send({ avatarId: owner.id, message: "hi" }).expect(403);
  });

  it("regenerate replaces the last reply instead of duplicating the turn", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "sam");
    await agent.patch("/api/me").send({ published: true }).expect(200);

    const first = await agent.post("/api/chat/stream").send({ avatarId: user.id, message: "처음" }).expect(200);
    const convId = (parseSse(first.text).find((f) => f.event === "open")!.data as { conversationId: string }).conversationId;

    await agent
      .post("/api/chat/stream")
      .send({ avatarId: user.id, message: "처음", conversationId: convId, regenerate: true })
      .expect(200);

    const messages = await agent.get(`/api/messages?conversationId=${convId}`).expect(200);
    expect(messages.body.messages).toHaveLength(2); // not 3 or 4
  });

  it("exposes a runId on the chat stream and guards the respond endpoint", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "ivy");
    await agent.patch("/api/me").send({ published: true }).expect(200);

    const chat = await agent.post("/api/chat/stream").send({ avatarId: user.id, message: "hi" }).expect(200);
    const open = parseSse(chat.text).find((f) => f.event === "open")!.data as { runId?: string };
    expect(typeof open.runId).toBe("string");

    // Auth required.
    await request(app).post("/api/chat/respond").send({ runId: open.runId, requestId: "x" }).expect(401);
    // Missing fields → 400.
    await agent.post("/api/chat/respond").send({ runId: open.runId }).expect(400);
    // Run already finished (local runtime resolves synchronously) → 404.
    await agent.post("/api/chat/respond").send({ runId: open.runId, requestId: "nope", value: { behavior: "allow" } }).expect(404);
    // Unknown run → 404.
    await agent.post("/api/chat/respond").send({ runId: "ghost", requestId: "x", value: {} }).expect(404);
  });

  // ---- Conversation ownership ------------------------------------------

  it("renames and deletes conversations, and isolates them between users", async () => {
    const app = testApp();
    const { agent: a, user: ua } = await newUser(app, "tina");
    await a.patch("/api/me").send({ published: true }).expect(200);
    const chat = await a.post("/api/chat/stream").send({ avatarId: ua.id, message: "hi" }).expect(200);
    const convId = (parseSse(chat.text).find((f) => f.event === "open")!.data as { conversationId: string }).conversationId;

    const renamed = await a.patch(`/api/conversations/${convId}`).send({ title: "내 첫 대화" }).expect(200);
    expect(renamed.body.conversation.title).toBe("내 첫 대화");

    // Another user cannot read or mutate someone else's conversation.
    const b = (await newUser(app, "uma")).agent;
    const peek = await b.get(`/api/messages?conversationId=${convId}`).expect(200);
    expect(peek.body.messages).toHaveLength(0);
    await b.patch(`/api/conversations/${convId}`).send({ title: "hijack" }).expect(404);
    await b.delete(`/api/conversations/${convId}`).expect(404);

    await a.delete(`/api/conversations/${convId}`).expect(200);
    const convs = await a.get("/api/conversations").expect(200);
    expect(convs.body.conversations.some((c: { id: string }) => c.id === convId)).toBe(false);
  });

  // ---- Admin role management -------------------------------------------

  it("lets an admin grant/revoke the admin role and blocks self-deletion", async () => {
    const app = testApp();
    const { agent: admin, user: adminUser } = await newUser(app, "vera"); // first → admin
    const { user: member } = await newUser(app, "walt");

    const granted = await admin
      .post(`/api/admin/users/${member.id}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);
    expect(granted.body.user.roles).toContain("admin");

    const revoked = await admin
      .post(`/api/admin/users/${member.id}/roles`)
      .send({ role: "admin", grant: false })
      .expect(200);
    expect(revoked.body.user.roles).not.toContain("admin");

    await admin.delete(`/api/admin/users/${adminUser.id}`).expect(400); // can't delete self
    await admin.delete(`/api/admin/users/${member.id}`).expect(200);
    const users = await admin.get("/api/admin/users").expect(200);
    expect(users.body.users.some((u: { id: string }) => u.id === member.id)).toBe(false);
  });

  it("forbids members from admin user-management endpoints", async () => {
    const app = testApp();
    await newUser(app, "admin2"); // first → admin
    const { agent: member, user } = await newUser(app, "mem2");
    await member.delete(`/api/admin/users/${user.id}`).expect(403);
    await member.post(`/api/admin/users/${user.id}/roles`).send({ role: "admin", grant: true }).expect(403);
  });

  // ---- Audit ------------------------------------------------------------

  it("resolves single-plugin, marketplace, and non-plugin repos correctly", async () => {
    const mkPlugin = (root: string) => {
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p" }));
    };

    // Single-plugin repo → [root]
    const single = path.join(tempDir, "single");
    mkPlugin(single);
    expect(await resolvePluginRoots(single, "single")).toEqual([single]);

    // Marketplace repo → each listed sub-plugin dir
    const market = path.join(tempDir, "market");
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "confluence", source: "./plugins/confluence" }] }),
    );
    mkPlugin(path.join(market, "plugins", "confluence"));
    expect(await resolvePluginRoots(market, "market")).toEqual([path.join(market, "plugins", "confluence")]);

    // Neither → empty + a warning
    const bare = path.join(tempDir, "bare");
    fs.mkdirSync(bare, { recursive: true });
    const warns: string[] = [];
    expect(await resolvePluginRoots(bare, "bare", (m) => warns.push(m))).toEqual([]);
    expect(warns.length).toBe(1);
  });

  it("backfills knowledge: a colleague's gap becomes an answered entry", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "olga").expect(201);
    const ownerId = ownerRes.body.user.id;

    // The agent's request_info tool records gaps via the store; simulate one.
    services.store.addKnowledgeRequest(ownerId, { question: "다음 출시일은 언제인가요?", askerName: "동료A" });

    const open = await owner.get("/api/me/knowledge/requests?status=open").expect(200);
    expect(open.body.requests).toHaveLength(1);
    const reqId = open.body.requests[0].id;
    expect(open.body.requests[0].askerName).toBe("동료A");

    const answered = await owner
      .post(`/api/me/knowledge/requests/${reqId}/answer`)
      .send({ answer: "6월 20일에 출시합니다." })
      .expect(200);
    expect(answered.body.request.status).toBe("answered");

    // The answer is now a searchable knowledge entry.
    const entries = await owner.get("/api/me/knowledge/entries").expect(200);
    expect(entries.body.entries).toHaveLength(1);
    expect(entries.body.entries[0].content).toContain("6월 20일");
    expect(services.store.searchKnowledge(ownerId, "출시").length).toBe(1);

    // The request is no longer open.
    const stillOpen = await owner.get("/api/me/knowledge/requests?status=open").expect(200);
    expect(stillOpen.body.requests).toHaveLength(0);

    // Manual entry add + delete.
    const manual = await owner
      .post("/api/me/knowledge/entries")
      .send({ topic: "선호", content: "회의는 오전을 선호합니다." })
      .expect(200);
    await owner.delete(`/api/me/knowledge/entries/${manual.body.entry.id}`).expect(200);
    const afterDelete = await owner.get("/api/me/knowledge/entries").expect(200);
    expect(afterDelete.body.entries).toHaveLength(1);
  });

  it("isolates knowledge between avatars and 404s on cross-owner access", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const ann = request.agent(app);
    const annRes = await signup(ann, "ann").expect(201);
    const bob = request.agent(app);
    await signup(bob, "bob").expect(201);

    const req = services.store.addKnowledgeRequest(annRes.body.user.id, { question: "ann만의 질문" });

    expect((await ann.get("/api/me/knowledge/requests").expect(200)).body.requests).toHaveLength(1);
    expect((await bob.get("/api/me/knowledge/requests").expect(200)).body.requests).toHaveLength(0);

    // Bob cannot answer or dismiss Ann's request.
    await bob.post(`/api/me/knowledge/requests/${req.id}/answer`).send({ answer: "x" }).expect(404);
    await bob.delete(`/api/me/knowledge/requests/${req.id}`).expect(404);
    // Empty answer is rejected.
    await ann.post(`/api/me/knowledge/requests/${req.id}/answer`).send({ answer: "" }).expect(400);
    // Ann can dismiss her own.
    await ann.delete(`/api/me/knowledge/requests/${req.id}`).expect(200);
  });

  it("loads the repo-bundled default plugin for every avatar", async () => {
    const { config } = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const roots = await loadDefaultPluginRoots(config);
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toContain("default-skills");
  });

  it("scopes the audit log: admin sees all, members see their own", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "xena"); // admin
    const { agent: member } = await newUser(app, "yuki");

    const adminAudit = await admin.get("/api/audit").expect(200);
    const actors = new Set(adminAudit.body.audit.map((e: { actorName: string }) => e.actorName));
    expect(actors.has("xena")).toBe(true);
    expect(actors.has("yuki")).toBe(true); // admin sees others

    const memberAudit = await member.get("/api/audit").expect(200);
    const memberActors = new Set(memberAudit.body.audit.map((e: { actorName: string }) => e.actorName));
    expect(memberActors.has("xena")).toBe(false); // member sees only own
    expect([...memberActors].every((a) => a === "yuki")).toBe(true);
  });
});
