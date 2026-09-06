import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { signup, withTempDir } from "./helpers.js";

const H = vi.hoisted(() => ({ requests: [] as AgentRequest[], script: [] as ((events: AgentEvents, abort?: AbortController) => Promise<void> | void)[] }));
vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(async (req: AgentRequest, _roots: unknown, config: AppConfig, _store: unknown, events: AgentEvents, abort?: AbortController) => {
    H.requests.push(req);
    await H.script.shift()?.(events, abort);
    if (abort?.signal.aborted) throw new Error("aborted");
    events.onDelta?.("작업 결과");
    return { kind: "text", runtime: config.agentRuntime, summary: "완료", text: "작업 결과" };
  }),
  isRetryableModelError: vi.fn(() => false),
}));
import { createApp, createServices } from "../src/server/app.js";
import { dispatchAvatarTasks, startAvatarTaskDispatcher } from "../src/server/avatarTaskRunner.js";
import { cancelAllRuns, openRun, closeRun, awaitResponse, emitRunEvent, getRunPrompts } from "../src/server/agent/runRegistry.js";
import { Store } from "../src/server/store.js";

const dir = withTempDir("avatar-tasks");
let current: ReturnType<typeof createServices> | undefined;
afterEach(async () => {
  cancelAllRuns();
  await new Promise(resolve => setTimeout(resolve, 20));
  current?.store.close();
  current = undefined;
});
async function boot() {
  H.requests = []; H.script = [];
  const services = createServices({ dataDir: path.join(dir(), "data"), agentRuntime: "local", sessionSecret: "test", botTaskRunTimeoutMs: 1000 });
  current = services;
  const app = createApp(services);
  const owner = request.agent(app);
  const user = (await signup(owner, "owner").expect(201)).body.user;
  const created = (await owner.post("/api/me/avatar-api-keys").send({ name: "monitor" }).expect(201)).body;
  const call = (method: "get" | "post", url: string) => request(app)[method](url).set("Authorization", `Bearer ${created.token}`);
  return { services, app, owner, user, created, call };
}
const endpoint = "/api/v1/avatar/tasks";

describe("avatar task API", () => {
  it("shows a token only at creation, scopes it to task APIs, and revokes it", async () => {
    const { owner, call, created, app, services, user } = await boot();
    const listed = await owner.get("/api/me/avatar-api-keys").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
    expect(JSON.stringify(listed.body)).not.toContain("token_hash");
    await request(app).post(endpoint).send({ message: "hello" }).expect(401);
    await owner.post(endpoint).send({ message: "hello" }).expect(401);
    await call("post", "/api/me/avatar-api-keys").send({ name: "forbidden" }).expect(401);
    await call("get", endpoint).expect(200);
    services.store.setSuspended(user.id, true);
    await call("get", endpoint).expect(401);
    services.store.setSuspended(user.id, false);
    services.store.revokeAvatarApiKey(user.id, created.key.id);
    await call("get", endpoint).expect(401);
  });

  it("accepts arbitrary instructions asynchronously and persists the real owner chat result", async () => {
    const { call, services, user } = await boot();
    const accepted = await call("post", endpoint).send({ message: "내 문서를 정리해 줘" }).expect(202);
    const task = accepted.body.task;
    expect(task.status).toBe("queued");
    expect(H.requests).toHaveLength(0);
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    const done = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
    expect(done.result.text).toBe("작업 결과");
    expect(H.requests[0]).toMatchObject({ message: "내 문서를 정리해 줘", viewerUserId: user.id, viewerIsOwner: true });
    expect(services.store.listRoutineJobs(user.id)).toHaveLength(0);
    expect(services.store.listMessages(user.id, task.conversationId).map(m => m.role)).toEqual(["user", "assistant"]);
    const next = (await call("post", endpoint).send({ message: "이어서 요약해 줘", conversationId: task.conversationId }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, next.id)?.status).toBe("succeeded"));
    expect(services.store.listMessages(user.id, task.conversationId)).toHaveLength(4);
  });

  it("prevents duplicate execution and rejects changed payloads for an idempotency key", async () => {
    const { call, services, user } = await boot();
    const first = await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "do this" }).expect(202);
    const replay = await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "do this" }).expect(200);
    expect(replay.body.task.id).toBe(first.body.task.id);
    await call("post", endpoint).set("Idempotency-Key", "event-1").send({ message: "different" }).expect(409);
    expect(services.store.listAvatarTasks(user.id)).toHaveLength(1);
  });

  it("blocks cross-owner tasks, thread reuse, and arbitrary target/permission input", async () => {
    const { call, app, services, user } = await boot();
    const other = services.store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const otherKey = services.store.createAvatarApiKey(other.id, "other");
    const task = (await call("post", endpoint).send({ message: "private" }).expect(202)).body.task;
    for (const suffix of ["", "/cancel", "/respond"]) {
      const method = suffix ? "post" : "get";
      await request(app)[method](`${endpoint}/${task.id}${suffix}`).set("Authorization", `Bearer ${otherKey.token}`).send({}).expect(404);
    }
    services.store.touchConversation(other.id, "other-thread", other.id, "Other");
    services.store.touchConversation(user.id, "peer-thread", other.id, "Peer");
    for (const conversationId of ["other-thread", "peer-thread", "nonexistent"]) {
      await call("post", endpoint).send({ message: "do it", conversationId }).expect(404);
    }
    await call("post", endpoint).send({ message: "do it", avatarId: other.id }).expect(400);
    await call("post", endpoint).send({ message: "do it", autoApprove: true }).expect(400);
    await call("post", endpoint).send({ message: "한".repeat(22000) }).expect(400);
  });

  it("queues behind an active conversation and supports queued cancellation", async () => {
    const { call, services, user } = await boot();
    services.store.touchConversation(user.id, "busy-thread", user.id, "Busy");
    openRun("busy-run", user.id, { conversationId: "busy-thread" });
    try {
      const task = (await call("post", endpoint).send({ message: "queued", conversationId: "busy-thread" }).expect(202)).body.task;
      dispatchAvatarTasks(services);
      expect(H.requests).toHaveLength(0);
      await call("post", `${endpoint}/${task.id}/cancel`).expect(200);
      expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled");
    } finally { closeRun("busy-run"); }
  });

  it("surfaces questions and lets the external caller answer the same run", async () => {
    const { call, services, user } = await boot();
    let answer: unknown;
    H.script.push(async events => {
      answer = await events.onQuestion?.({ dialogKind: "question", payload: { question: "어느 서비스인가요?" } });
    });
    const task = (await call("post", endpoint).send({ message: "분석해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    let pending: any;
    await vi.waitFor(async () => {
      pending = (await call("get", `${endpoint}/${task.id}`).expect(200)).body.task;
      expect(pending.status).toBe("waiting_input");
    });
    await call("post", `${endpoint}/${task.id}/respond`).send({ requestId: pending.pendingRequests[0].data.requestId, value: { result: { service: "A" } } }).expect(200);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("succeeded"));
    expect(answer).toEqual({ behavior: "completed", result: { service: "A" } });
    await call("post", `${endpoint}/${task.id}/respond`).send({ requestId: pending.pendingRequests[0].data.requestId, value: {} }).expect(409);
  });

  it("records SDK failures and deadline expiry as failures, not successful acceptance", async () => {
    const { call, services, user } = await boot();
    H.script.push(() => { throw new Error("test failure"); });
    const task = (await call("post", endpoint).send({ message: "fail" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, task.id)?.error).toContain("test failure");
    services.config.botTaskRunTimeoutMs = 30;
    H.script.push(async (_events, abort) => new Promise<void>(resolve => abort!.signal.addEventListener("abort", () => resolve(), { once: true })));
    const timed = (await call("post", endpoint).send({ message: "hang" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, timed.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, timed.id)?.error).toContain("제한 시간");
  });

  it("rechecks revoked keys before dispatch and limits outstanding requests", async () => {
    const { call, services, user, created } = await boot();
    for (let i = 0; i < 20; i++) await call("post", endpoint).send({ message: `task ${i}` }).expect(202);
    await call("post", endpoint).send({ message: "overflow" }).expect(429);
    services.store.revokeAvatarApiKey(user.id, created.key.id);
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.listAvatarTasks(user.id).some(t => t.status === "failed")).toBe(true));
    expect(H.requests).toHaveLength(0);
  });

  it("keeps permission checks interactive and can cancel a waiting run", async () => {
    const { call, services, user } = await boot();
    let answer: unknown;
    H.script.push(async events => {
      answer = await events.onPermission?.({ agentId: "owner", toolUseId: "tool-1", toolName: "Bash", input: { command: "echo test" } });
    });
    const task = (await call("post", endpoint).send({ message: "도구를 사용해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(async () => {
      const pending = (await call("get", `${endpoint}/${task.id}`)).body.task;
      expect(pending.pendingRequests[0]?.event).toBe("permission");
    });
    await call("post", `${endpoint}/${task.id}/cancel`).expect(200);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("cancelled"));
    expect(answer).toEqual({ behavior: "deny", unanswered: true });
  });

  it("releases unanswered questions when the execution deadline expires", async () => {
    const { call, services, user } = await boot();
    services.config.botTaskRunTimeoutMs = 30;
    H.script.push(async events => { await events.onQuestion?.({ dialogKind: "question", payload: {} }); });
    const task = (await call("post", endpoint).send({ message: "질문해 줘" }).expect(202)).body.task;
    dispatchAvatarTasks(services);
    await vi.waitFor(() => expect(services.store.getAvatarTask(user.id, task.id)?.status).toBe("failed"));
    expect(services.store.getAvatarTask(user.id, task.id)?.error).toContain("제한 시간");
  });

  it("persists queued tasks across reopening and fails interrupted runs on startup", async () => {
    const { call, services, user } = await boot();
    const queued = (await call("post", endpoint).send({ message: "queued" }).expect(202)).body.task;
    const interrupted = (await call("post", endpoint).send({ message: "interrupted" }).expect(202)).body.task;
    services.store.claimAvatarTask(user.id, interrupted.id);
    services.store.close();
    const reopened = { ...services, store: new Store(services.config) };
    current = reopened;
    const stop = startAvatarTaskDispatcher(reopened);
    try {
      expect(reopened.store.getAvatarTask(user.id, interrupted.id)?.status).toBe("failed");
      await vi.waitFor(() => expect(reopened.store.getAvatarTask(user.id, queued.id)?.status).toBe("succeeded"));
    } finally { stop(); }
    reopened.store.deleteUser(user.id);
    expect(reopened.store.listAvatarTasks(user.id)).toEqual([]);
    expect(reopened.store.listAvatarApiKeys(user.id)).toEqual([]);
  });

  it("exposes only outstanding prompts, never secret browser events", async () => {
    openRun("prompts", "owner");
    emitRunEvent("prompts", "browser", { secretText: "secret", requestId: "b" }, { replay: false });
    emitRunEvent("prompts", "question", { requestId: "q", payload: {} });
    const response = awaitResponse("prompts", "q");
    expect(getRunPrompts("prompts", "owner")).toHaveLength(1);
    expect(getRunPrompts("prompts", "other")).toEqual([]);
    closeRun("prompts"); await response;
  });
});
