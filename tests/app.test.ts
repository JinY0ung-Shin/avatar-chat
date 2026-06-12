import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { loadDefaultPluginRoots, resolvePluginRoots } from "../src/server/plugins.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-almighty-"));
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

describe("noah-almighty platform", () => {
  it("reports needsSetup until the first account exists", async () => {
    const app = testApp();
    const fresh = await request(app).get("/api/bootstrap").expect(200);
    expect(fresh.body.needsSetup).toBe(true);
    expect(fresh.body.githubHost).toBe("github.com");

    await signup(request.agent(app), "alice").expect(201);

    const after = await request(app).get("/api/bootstrap").expect(200);
    expect(after.body.needsSetup).toBe(false);
  });

  it("reports the configured default GitHub host", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      githubHost: "github.enterprise.local",
    });
    const app = createApp(services);
    const res = await request(app).get("/api/bootstrap").expect(200);
    expect(res.body.githubHost).toBe("github.enterprise.local");
  });

  it("restricts knowledge repos to the configured internal GitHub host", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      githubHost: "github.enterprise.local",
    });
    const app = createApp(services);
    const { agent } = await newUser(app, "internal-owner");

    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/knowledge", branch: "main" }).expect(200);
    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "https://github.enterprise.local/owner/knowledge.git", branch: "main" })
      .expect(200);
    const rejected = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "https://github.com/owner/knowledge.git", branch: "main" })
      .expect(400);
    expect(rejected.body.error).toContain("사내 GitHub host(github.enterprise.local)");
  });

  it("generates an SSH keypair through the owner settings API without returning the private key", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "ssh-owner");

    const created = await agent.post("/api/me/ssh-key").send({}).expect(200);
    expect(created.body.publicKey).toMatch(/^ssh-ed25519 /);
    expect(created.body.fingerprint).toMatch(/^SHA256:/);
    expect(created.body.user.secretNames).toContain("SSH_PRIVATE_KEY");
    expect(created.body.user.sshPublicKey).toBe(created.body.publicKey);
    expect(JSON.stringify(created.body)).not.toContain("BEGIN OPENSSH PRIVATE KEY");

    await agent.post("/api/me/ssh-key").send({}).expect(409);
  });

  it("makes the first signup an admin and subsequent users members only", async () => {
    const app = testApp();
    const first = request.agent(app);
    const firstRes = await signup(first, "alice").expect(201);
    expect(firstRes.body.user.username).toBe("alice");
    expect(firstRes.body.user.published).toBe(true);
    expect(firstRes.body.user.roles).toContain("admin");
    expect(firstRes.body.user.roles).toContain("member");

    const second = request.agent(app);
    const secondRes = await signup(second, "bob").expect(201);
    expect(secondRes.body.user.published).toBe(true);
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
      .send({ displayName: "Erin K", alias: "  Aria  ", published: true })
      .expect(200);
    expect(res.body.user.displayName).toBe("Erin K");
    // alias is trimmed and persisted.
    expect(res.body.user.alias).toBe("Aria");
    expect(res.body.user.published).toBe(true);
    // published persists: a fresh read reflects the stored value.
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.published).toBe(true);
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
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
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

    // The dedicated conversation exists immediately, but is listed under the
    // routine view instead of the normal chat rail.
    const regularConvs = await agent.get("/api/conversations").expect(200);
    expect(regularConvs.body.conversations.some((c: { id: string }) => c.id === routine.conversationId)).toBe(false);
    const convs = await agent.get("/api/conversations?kind=routine").expect(200);
    const conv = convs.body.conversations.find(
      (c: { id: string }) => c.id === routine.conversationId,
    );
    expect(conv).toBeTruthy();
    expect(conv.title.startsWith("[루틴]")).toBe(true);
    expect(conv.isRoutine).toBe(true);
    expect(conv.routineId).toBe(routine.id);

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

    // Avatar/system tools can leave user-facing in-app alerts.
    const notification = await services.store.addAvatarNotification(routine.avatarUserId, {
      avatarUserId: routine.avatarUserId,
      title: "루틴 알림",
      message: "확인할 결과가 있습니다.",
      conversationId: routine.conversationId,
    });
    const notifications = await agent.get("/api/me/notifications").expect(200);
    expect(notifications.body.notifications[0].id).toBe(notification.id);
    await agent.patch(`/api/me/notifications/${notification.id}/read`).expect(200);
    const unread = await agent.get("/api/me/notifications?unread=1").expect(200);
    expect(unread.body.notifications).toHaveLength(0);

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
    await hidden.patch("/api/me").send({ published: false }).expect(200);

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

  it("lets the owner manage trusted users, who can then reach an unpublished avatar", async () => {
    const app = testApp();
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "olga").expect(201);
    await owner.patch("/api/me").send({ published: false }).expect(200);

    const friend = request.agent(app);
    const friendRes = await signup(friend, "fred").expect(201);
    const friendId = friendRes.body.user.id;

    // Before trust: a non-owner can't see the unpublished avatar or chat with it.
    await friend.get(`/api/avatars/${ownerRes.body.user.id}`).expect(404);
    await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕" })
      .expect(403);

    // Owner grants trust by username.
    const added = await owner.post("/api/me/trusted").send({ username: "fred" }).expect(200);
    expect(added.body.trusted.map((t: { username: string }) => t.username)).toEqual(["fred"]);
    // Unknown user / self → error, no row added.
    await owner.post("/api/me/trusted").send({ username: "nobody" }).expect(404);
    await owner.post("/api/me/trusted").send({ username: "olga" }).expect(404);

    // After trust: the friend sees the (still unpublished) avatar as elevated and can chat.
    const detail = await friend.get(`/api/avatars/${ownerRes.body.user.id}`).expect(200);
    expect(detail.body.avatar.elevated).toBe(true);
    expect(detail.body.avatar.isOwn).toBe(false);
    const chat = await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕" })
      .expect(200);
    expect(parseSse(chat.text).find((f) => f.event === "done")).toBeTruthy();

    // Revoke: the friend loses access again.
    const after = await owner.delete(`/api/me/trusted/${friendId}`).expect(200);
    expect(after.body.trusted).toHaveLength(0);
    await friend.get(`/api/avatars/${ownerRes.body.user.id}`).expect(404);
  });

  it("searches users for the trusted-user picker (by name/@id, self excluded, trusted flagged)", async () => {
    const app = testApp();
    const owner = request.agent(app);
    await signup(owner, "olga").expect(201);
    const friend = request.agent(app);
    await signup(friend, "fred").expect(201);

    // Match by substring; the searcher (olga) is never in their own results.
    const hit = await owner.get("/api/me/trusted/search?q=fre").expect(200);
    expect(hit.body.users.map((u: { username: string }) => u.username)).toEqual(["fred"]);
    expect(hit.body.users[0].trusted).toBe(false);
    const self = await owner.get("/api/me/trusted/search?q=olga").expect(200);
    expect(self.body.users).toEqual([]);
    // Blank query → no results, no error.
    expect((await owner.get("/api/me/trusted/search?q=").expect(200)).body.users).toEqual([]);

    // After trusting, the same user comes back flagged.
    await owner.post("/api/me/trusted").send({ username: "fred" }).expect(200);
    const flagged = await owner.get("/api/me/trusted/search?q=fred").expect(200);
    expect(flagged.body.users[0].trusted).toBe(true);
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

  it("lists an avatar's skills from bundled default plugins", async () => {
    // A default-plugins dir with one skill; runtime must be "claude" (the local
    // runtime loads no skills). No avatar plugins, so nothing is cloned.
    const pluginsDir = path.join(tempDir, "default-skills");
    fs.mkdirSync(path.join(pluginsDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "defaults" }),
    );
    const skillDir = path.join(pluginsDir, "skills", "greet");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Greeter\ndescription: Greets colleagues warmly\n---\n# body",
    );

    const app = createApp(
      createServices({
        dataDir: tempDir,
        agentRuntime: "claude",
        sessionSecret: "test",
        defaultPluginsDir: pluginsDir,
      }),
    );
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "skilluser").expect(201);
    await owner.patch("/api/me").send({ published: true }).expect(200);

    const res = await owner.get(`/api/avatars/${ownerRes.body.user.id}/skills`).expect(200);
    expect(res.body.skills).toEqual([
      { name: "Greeter", description: "Greets colleagues warmly", source: "default" },
    ]);
  });

  it("returns an empty skill list under the local runtime", async () => {
    const app = testApp(); // agentRuntime: "local"
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "localskill").expect(201);
    const res = await owner.get(`/api/avatars/${ownerRes.body.user.id}/skills`).expect(200);
    expect(res.body.skills).toEqual([]);
  });

  it("hides skills of an unpublished, non-own avatar (404)", async () => {
    const app = testApp();
    const hidden = request.agent(app);
    const hiddenRes = await signup(hidden, "kevin").expect(201);
    await hidden.patch("/api/me").send({ published: false }).expect(200);

    const viewer = request.agent(app);
    await signup(viewer, "laura").expect(201);
    await viewer.get(`/api/avatars/${hiddenRes.body.user.id}/skills`).expect(404);
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

  it("stores/clears a subscription token and reflects it in system status", async () => {
    const app = testApp(); // no ANTHROPIC_API_KEY → subscription mode
    const { agent: admin } = await newUser(app, "boss"); // first → admin

    // Initially disconnected, subscription auth mode (no API key in test config).
    let sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.subscriptionConnected).toBe(false);
    expect(sys.apiKeyOverride).toBe(false);
    expect(sys.authMode).toBe("subscription");

    // Reject empty / malformed tokens.
    await admin.put("/api/admin/claude-token").send({ token: "  " }).expect(400);
    await admin.put("/api/admin/claude-token").send({ token: "nope" }).expect(400);

    // Store a valid-looking token; it must never be echoed back.
    const put = await admin.put("/api/admin/claude-token").send({ token: "sk-ant-oat01-secret" }).expect(200);
    expect(put.body).toEqual({ ok: true });
    expect(JSON.stringify(put.body)).not.toContain("secret");

    sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.subscriptionConnected).toBe(true);

    // Clearing it returns to disconnected.
    await admin.delete("/api/admin/claude-token").expect(200);
    sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.subscriptionConnected).toBe(false);
  });

  it("forbids the subscription-token endpoints for members (403)", async () => {
    const app = testApp();
    await newUser(app, "boss"); // first → admin
    const { agent: member } = await newUser(app, "peon");
    await member.put("/api/admin/claude-token").send({ token: "sk-ant-oat01-x" }).expect(403);
    await member.delete("/api/admin/claude-token").expect(403);
  });

  it("exposes system/runtime info to admins, gated from members", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      anthropicModel: "claude-opus-4-8",
    });
    const app = createApp(services);

    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/system").expect(200);
    expect(res.body.system.agentRuntime).toBe("local");
    expect(res.body.system.configuredModel).toBe("claude-opus-4-8");
    // No Claude run has reported a model yet (local runtime never does).
    expect(res.body.system.observedModel).toBeNull();
    expect(res.body.system.authMode).toBe("subscription");
    expect(Array.isArray(res.body.system.readOnlyTools)).toBe(true);
    expect(res.body.system.hexSshTools.map((t: { name: string }) => t.name)).toContain("remote-ssh");
    expect(res.body.system.hexSshToolPolicy.owner).toContain("remote-ssh");
    expect(res.body.system.hexSshToolPolicy.trusted).toContain("ssh-read-lines");
    expect(res.body.system.hexSshToolPolicy.trusted).not.toContain("remote-ssh");

    const member = request.agent(app);
    await signup(member, "peon").expect(201);
    await member.get("/api/admin/system").expect(403);
  });

  it("lets admins manage the hex-ssh tool policy and blocks members", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "boss");
    const { agent: member } = await newUser(app, "member1");

    const policy = {
      owner: ["ssh-read-lines", "remote-ssh"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    };
    const saved = await admin
      .put("/api/admin/hex-ssh-policy")
      .send({ policy })
      .expect(200);
    expect(saved.body.policy).toEqual(policy);

    const system = await admin.get("/api/admin/system").expect(200);
    expect(system.body.system.hexSshToolPolicy).toEqual(policy);

    await admin.put("/api/admin/hex-ssh-policy").send({ policy: { owner: [] } }).expect(400);
    await member.put("/api/admin/hex-ssh-policy").send({ policy }).expect(403);
  });

  it("reports configuredModel as null when ANTHROPIC_MODEL is unset", async () => {
    const app = testApp();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/system").expect(200);
    expect(res.body.system.configuredModel).toBeNull();
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
    await agent.patch("/api/me").send({ bio: "도우미", persona: "간결하게", alias: "미라봇", published: true }).expect(200);
    await agent.post("/api/me/plugins").send({ repo: "owner/tool", label: "Tool" }).expect(200);

    const detail = await agent.get(`/api/avatars/${user.id}`).expect(200);
    expect(detail.body.avatar.isOwn).toBe(true);
    expect(detail.body.avatar.persona).toBe("간결하게");
    expect(detail.body.avatar.alias).toBe("미라봇");
    expect(detail.body.avatar.plugins.length).toBe(1);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.pluginCount).toBe(1);
  });

  it("stores and exposes the avatar self-introduction, and generates one on demand", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "intro");
    await agent.patch("/api/me").send({ alias: "소개봇", intro: "안녕하세요, 저는 도와드립니다.", published: true }).expect(200);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.intro).toBe("안녕하세요, 저는 도와드립니다.");
    const detail = await agent.get(`/api/avatars/${user.id}`).expect(200);
    expect(detail.body.avatar.intro).toBe("안녕하세요, 저는 도와드립니다.");

    // The local runtime returns a deterministic placeholder naming the avatar.
    const gen = await agent.post("/api/me/intro/generate").expect(200);
    expect(typeof gen.body.intro).toBe("string");
    expect(gen.body.intro).toContain("소개봇");
    // Generating does NOT persist — the stored value is unchanged until saved.
    const after = await agent.get("/api/me").expect(200);
    expect(after.body.user.intro).toBe("안녕하세요, 저는 도와드립니다.");
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
    const { agent: ownerAgent, user: owner } = await newUser(app, "quinn");
    await ownerAgent.patch("/api/me").send({ published: false }).expect(200);
    const viewer = (await newUser(app, "rex")).agent;

    await viewer.post("/api/chat/stream").send({ avatarId: owner.id, message: "" }).expect(400);
    await viewer.post("/api/chat/stream").send({ message: "hi" }).expect(400);
    // owner avatar is not published and not the viewer's own → 403.
    await viewer.post("/api/chat/stream").send({ avatarId: owner.id, message: "hi" }).expect(403);
  });

  it("allows mixed-avatar split sessions and refuses cross-avatar conversation reuse", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "split-owner");
    await agent.patch("/api/me").send({ published: true }).expect(200);

    const other = request.agent(app);
    const otherRes = await signup(other, "split-other").expect(201);
    await other.patch("/api/me").send({ published: true }).expect(200);

    await agent
      .post("/api/chat/stream")
      .send({ avatarId: otherRes.body.user.id, message: "hi", multiSession: true })
      .expect(200);

    const first = await agent
      .post("/api/chat/stream")
      .send({ avatarId: user.id, conversationId: "split-conv-1", message: "내 작업" })
      .expect(200);
    expect(parseSse(first.text).find((f) => f.event === "done")).toBeTruthy();

    await agent
      .post("/api/chat/stream")
      .send({ avatarId: otherRes.body.user.id, conversationId: "split-conv-1", message: "섞기" })
      .expect(409);
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

  it("greets first (owner only) and reports pending requests without persisting", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "gwen").expect(201);
    const ownerId = ownerRes.body.user.id;

    // A colleague's gap is waiting for the owner.
    services.store.addKnowledgeRequest(ownerId, { question: "출시일?", askerName: "동료A" });

    // Owner greeting with their OWN avatar streams an assistant reply.
    const convId = "greet-conv-1";
    const greet = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: convId, greeting: true })
      .expect(200);
    const done = parseSse(greet.text).find((f) => f.event === "done")!.data as {
      message: { role: string; content: string };
    };
    expect(done.message.role).toBe("assistant");

    // Greeting is ephemeral: nothing was persisted to the conversation.
    const after = await owner.get(`/api/messages?conversationId=${convId}`).expect(200);
    expect(after.body.messages).toHaveLength(0);

    // The pending request is still open (greeting only reports it, never answers).
    const stillOpen = await owner.get("/api/me/knowledge/requests?status=open").expect(200);
    expect(stillOpen.body.requests).toHaveLength(1);

    // greeting=true with no message falls back to the empty-message 400 when the
    // viewer is NOT the avatar's owner (a colleague can't make the avatar greet).
    const stranger = request.agent(app);
    await signup(stranger, "hank").expect(201);
    await stranger
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, greeting: true })
      .expect(400);
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

  it("backfills knowledge: a colleague's gap is queued and resolved (closed)", async () => {
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

    // Resolving takes no body: there is no stored answer (the owner teaches the
    // avatar via plugins). Closing the request is the whole action.
    await owner.delete(`/api/me/knowledge/requests/${reqId}`).expect(200);

    const stillOpen = await owner.get("/api/me/knowledge/requests?status=open").expect(200);
    expect(stillOpen.body.requests).toHaveLength(0);
    const resolved = await owner.get("/api/me/knowledge/requests?status=resolved").expect(200);
    expect(resolved.body.requests).toHaveLength(1);
    expect(resolved.body.requests[0].status).toBe("resolved");
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

    // Bob cannot resolve Ann's request.
    await bob.delete(`/api/me/knowledge/requests/${req.id}`).expect(404);
    // Ann can resolve her own.
    await ann.delete(`/api/me/knowledge/requests/${req.id}`).expect(200);
    // Resolving again (no longer open) → 404.
    await ann.delete(`/api/me/knowledge/requests/${req.id}`).expect(404);
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

  it("round-trips capability hashtags through PATCH /api/me and into discovery", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "tagowner");
    const patched = await agent
      .patch("/api/me")
      .send({ hashtags: ["#코드리뷰", "코드리뷰", " 파이썬 ", "데이터 분석"] })
      .expect(200);
    // Normalized server-side: deduped, "#"/whitespace handled, spaces → hyphens.
    expect(patched.body.user.hashtags).toEqual(["코드리뷰", "파이썬", "데이터-분석"]);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.hashtags).toEqual(["코드리뷰", "파이썬", "데이터-분석"]);

    const list = await agent.get("/api/avatars").expect(200);
    const mine = list.body.avatars.find((a: { username: string }) => a.username === "tagowner");
    expect(mine.hashtags).toEqual(["코드리뷰", "파이썬", "데이터-분석"]);
  });

  it("auto-generates hashtags (local runtime placeholder) without persisting", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "taggen");
    const res = await agent.post("/api/me/hashtags/generate").expect(200);
    expect(Array.isArray(res.body.hashtags)).toBe(true);
    expect(res.body.hashtags.length).toBeGreaterThan(0);
    // Generation does NOT persist — the profile stays empty until the user saves.
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.hashtags).toEqual([]);
  });
});

describe("groups", () => {
  it("admin creates a group + adds members; co-members auto-trust; non-admin is blocked", async () => {
    const app = testApp();
    const { agent: adminA } = await newUser(app, "admin"); // first signup → admin
    const { agent: agentB, user: bob } = await newUser(app, "bob");
    const { agent: agentC } = await newUser(app, "carol");

    // A non-admin cannot create a group.
    await agentB.post("/api/admin/groups").send({ name: "X" }).expect(403);

    const created = await adminA.post("/api/admin/groups").send({ name: "Team", description: "d" }).expect(200);
    const groupId = created.body.group.id;
    await adminA.post(`/api/admin/groups/${groupId}/members`).send({ username: "bob", role: "admin" }).expect(200);
    await adminA.post(`/api/admin/groups/${groupId}/members`).send({ username: "carol" }).expect(200);

    const list = await adminA.get("/api/admin/groups").expect(200);
    expect(list.body.groups[0].memberCount).toBe(2);
    expect(list.body.groups[0].adminCount).toBe(1);

    // bob unpublishes; carol (same group) still reaches his avatar at elevated level.
    await agentB.patch("/api/me").send({ published: false }).expect(200);
    const seen = await agentC.get(`/api/avatars/${bob.id}`).expect(200);
    expect(seen.body.avatar.elevated).toBe(true);

    // A stranger outside the group gets 404 on the unpublished avatar.
    const { agent: agentD } = await newUser(app, "dave");
    await agentD.get(`/api/avatars/${bob.id}`).expect(404);

    // Roster: carol sees all teammates and her own role.
    const mine = await agentC.get("/api/me/groups").expect(200);
    // Creating a group doesn't auto-add the system admin; only explicit members appear.
    expect(mine.body.groups[0].members.map((m: { username: string }) => m.username).sort()).toEqual(["bob", "carol"]);
    expect(mine.body.groups[0].role).toBe("member");

    // bob (group admin) can self-serve member adds; carol (plain member) cannot.
    await agentB.post(`/api/me/groups/${groupId}/members`).send({ username: "dave" }).expect(200);
    await agentC.post(`/api/me/groups/${groupId}/members`).send({ username: "dave" }).expect(403);
  });

  it("group repo connect is group-admin-only and validated to the internal host", async () => {
    const app = testApp();
    const { agent: adminA } = await newUser(app, "admin");
    const { agent: agentB } = await newUser(app, "bob");
    const { agent: agentC } = await newUser(app, "carol");
    const created = await adminA.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id;
    await adminA.post(`/api/admin/groups/${groupId}/members`).send({ username: "bob", role: "admin" }).expect(200);
    await adminA.post(`/api/admin/groups/${groupId}/members`).send({ username: "carol" }).expect(200);

    // bob (group admin) connects an internal repo (owner/repo shorthand).
    await agentB.put(`/api/me/groups/${groupId}/knowledge-repo`).send({ repo: "org/team-knowledge", branch: "main" }).expect(200);
    const mine = await agentB.get("/api/me/groups").expect(200);
    expect(mine.body.groups[0].knowledgeRepo).toBe("org/team-knowledge");

    // An external host is rejected.
    await agentB.put(`/api/me/groups/${groupId}/knowledge-repo`).send({ repo: "https://gitlab.example.com/x/y.git" }).expect(400);

    // A plain member cannot set the group repo.
    await agentC.put(`/api/me/groups/${groupId}/knowledge-repo`).send({ repo: "org/x" }).expect(403);
  });
});
