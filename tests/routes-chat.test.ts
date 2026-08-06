import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { Store } from "../src/server/store.js";
import { parseSse, signup, withTempDir } from "./helpers.js";
import { chatFilesDir } from "../src/server/chatFiles.js";

// Shared control surface for the mocked agent layer. `impl`, when set, fully
// drives a turn (fires the events callbacks the route wires); otherwise a default
// mock streams one delta and returns. `retryable` steers isRetryableModelError so
// the chat error branch can be exercised both ways.
type RunImpl = (
  request: AgentRequest,
  pluginRoots: unknown,
  config: AppConfig,
  store: unknown,
  events: AgentEvents,
  abortController: AbortController,
) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({
  requests: [] as AgentRequest[],
  impl: null as RunImpl | null,
  retryable: false,
}));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      agentRequest: AgentRequest,
      pluginRoots: unknown,
      config: AppConfig,
      store: unknown,
      events: AgentEvents,
      abortController: AbortController,
    ): Promise<AgentResponse> => {
      H.requests.push(agentRequest);
      if (H.impl) {
        return H.impl(agentRequest, pluginRoots, config, store, events, abortController);
      }
      events.onSessionId?.(`sess-${H.requests.length}`);
      events.onDelta?.(`[mock] ${agentRequest.message}`);
      return {
        kind: "text",
        runtime: config.agentRuntime,
        summary: "mock",
        text: `[mock] ${agentRequest.message}`,
      };
    },
  ),
  isRetryableModelError: vi.fn(() => H.retryable),
}));

import { createApp, createServices } from "../src/server/app.js";
import { acquireActiveRepo, releaseActiveRepo } from "../src/server/activeRepoLock.js";
import { gitRepoClonePath } from "../src/server/gitRepos.js";

let tempDir: string;
const getTempDir = withTempDir("routes-chat", () => {
  tempDir = getTempDir();
  H.requests.length = 0;
  H.impl = null;
  H.retryable = false;
});

function boot() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "claude", sessionSecret: "test" });
  return { services, app: createApp(services), store: services.store, config: services.config };
}

/** Extract the session cookie(s) from a signup response for raw-http reuse. */
function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((c) => c.split(";")[0]).join("; ");
}

/** The id of the newest assistant message in a conversation. */
function lastAssistantId(store: Store, ownerId: string, conversationId: string): string {
  const found = [...store.listMessages(ownerId, conversationId)].reverse().find((m) => m.role === "assistant");
  if (!found) throw new Error("expected an assistant message");
  return found.id;
}

async function waitUntil(pred: () => boolean | Promise<boolean>, label = "condition"): Promise<void> {
  for (let i = 0; i < 1600; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

// Parked-run + interactive tests hold an SSE stream open and poll; coverage
// instrumentation slows them well past the 5s default, so give them headroom.
const LIVE = 20_000;

/** The active-run snapshot for a conversation, or null. */
async function activeRun(
  agent: ReturnType<typeof request.agent>,
  conversationId: string,
): Promise<{ runId: string; pendingCount: number } | null> {
  const res = await agent.get(`/api/chat/runs?conversationId=${conversationId}`);
  return (res.body.run as { runId: string; pendingCount: number } | null) ?? null;
}

/** Dispatch a chat-stream POST in the background; resolves when the run closes. */
function fireStream(agent: ReturnType<typeof request.agent>, body: object): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    agent
      .post("/api/chat/stream")
      .send(body)
      .end((err, res) => (res ? resolve(res) : reject(err)));
  });
}

/** A plain JSON POST over a dedicated socket to the same listening server. */
function postJson(
  port: number,
  cookie: string,
  path: string,
  body: object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

interface SseFrame {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

function parseFrameBlock(block: string): SseFrame | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event) return null;
  return { event, data: data ? JSON.parse(data) : undefined };
}

/**
 * Open an SSE request over a REAL socket so frames can be read WHILE the run is
 * parked (supertest buffers the whole body, so it can't answer interactive
 * prompts mid-turn). `onFrame` fires per frame as it arrives.
 */
function streamRaw(
  port: number,
  cookie: string,
  path: string,
  method: "POST" | "GET",
  body: object | null,
  onFrame: (f: SseFrame) => void,
): Promise<{ status: number; frames: SseFrame[] }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        // A dedicated socket (no global keep-alive pool) so a finished SSE stream
        // is closed cleanly and can't leak a stale socket into the next test.
        agent: false,
        headers: {
          cookie,
          ...(payload != null
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const frames: SseFrame[] = [];
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const frame = parseFrameBlock(block);
            if (frame) {
              frames.push(frame);
              onFrame(frame);
            }
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, frames }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A fake turn that streams a partial then parks until the SDK is aborted. */
const parkUntilAborted: RunImpl = async (_req, _pr, config, _store, events, ac) => {
  events.onSessionId?.("sess-parked");
  events.onDelta?.("부분 답변");
  await new Promise<never>((_resolve, reject) => {
    if (ac.signal.aborted) return reject(new Error("aborted"));
    ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { kind: "text", runtime: config.agentRuntime, summary: "x", text: "x" };
};

// ---------------------------------------------------------------------------

describe("activity-snapshot persistence (PUT /api/messages/:id/activity)", () => {
  it("sanitizes + caps + normalizes a client activity snapshot before storing it", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "act").expect(201)).body.user.id as string;

    // A default turn leaves an assistant message with a response to attach onto.
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-act", message: "안녕" }).expect(200);
    const messageId = lastAssistantId(store, ownerId, "conv-act");

    const activity = {
      agents: [
        { id: "a1", parentId: "", label: "메인", status: "running", isMain: true }, // running → done
        { id: "a2", parentId: "a1", label: "sub", status: "failed", isMain: false },
        { id: "a3", parentId: "a1", label: "sub2", status: "weird" }, // unknown → done
        ...Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, parentId: "a1", label: "x", status: "done" })),
      ],
      tools: [
        { id: "t1", agentId: "a1", kind: "tool", label: "Read", detail: "file.ts", status: "done" },
        { id: "t2", agentId: "", kind: "blocked", label: "Bash", status: "blocked" }, // agentId → main
        { id: "t3", agentId: "a1", kind: "task", label: "legacy task row", status: "running" }, // legacy → tasks
        { id: "t4", kind: "weird", label: "w", status: "weird" }, // kind → tool, status → done, agentId → main
        { id: "t5", agentId: "main", kind: "memory", label: "기억 추가됨", detail: "wiki/people/kim.md", status: "done" }, // 기억 chip source — kind survives
      ],
      tasks: [
        { id: "k1", agentId: "a1", label: "task1", detail: "d", status: "running" },
        { id: "k2", label: "task2", status: "failed" },
        { id: "k3", label: "task3", status: "done" },
      ],
    };

    await owner.put(`/api/messages/${messageId}/activity`).send({ activity }).expect(200).expect({ ok: true });

    const stored = store.listMessages(ownerId, "conv-act").find((m) => m.id === messageId)!.response!.activity!;
    expect(stored.agents).toHaveLength(60); // capped from 73
    expect(stored.agents[0].status).toBe("done"); // running normalized on persist
    expect(stored.agents[1].status).toBe("failed");
    expect(stored.agents[2].status).toBe("done"); // unknown normalized
    // The legacy `kind:"task"` tool row is filtered out of tools and merged into tasks.
    expect(stored.tools.map((t) => t.id).sort()).toEqual(["t1", "t2", "t4", "t5"]);
    expect(stored.tools.find((t) => t.id === "t2")).toMatchObject({ kind: "blocked", agentId: "main" });
    expect(stored.tools.find((t) => t.id === "t4")).toMatchObject({ kind: "tool", agentId: "main", status: "done" });
    // kind:"memory" must survive the round-trip — the reload-time 기억 summary
    // chip is rebuilt from these persisted rows.
    expect(stored.tools.find((t) => t.id === "t5")).toMatchObject({
      kind: "memory",
      label: "기억 추가됨",
      detail: "wiki/people/kim.md",
    });
    expect(stored.tasks!.map((t) => t.id).sort()).toEqual(["k1", "k2", "k3", "t3"]);
    expect(stored.tasks!.find((t) => t.id === "k1")).toMatchObject({ status: "running", agentId: "a1" });
    expect(stored.tasks!.find((t) => t.id === "k2")).toMatchObject({ status: "failed", agentId: "main" });
  });

  it("clears the activity when the snapshot has no tools or tasks (agents only)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "act2").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-act2", message: "hi" }).expect(200);
    const messageId = lastAssistantId(store, ownerId, "conv-act2");

    await owner
      .put(`/api/messages/${messageId}/activity`)
      .send({ activity: { agents: [{ id: "a1", label: "only", status: "done" }], tools: [], tasks: [] } })
      .expect(200)
      .expect({ ok: true });

    expect(store.listMessages(ownerId, "conv-act2").find((m) => m.id === messageId)!.response!.activity).toBeUndefined();

    // A non-object activity payload is rejected by the sanitizer and also clears.
    await owner.put(`/api/messages/${messageId}/activity`).send({ activity: 42 }).expect(200).expect({ ok: true });
    expect(store.listMessages(ownerId, "conv-act2").find((m) => m.id === messageId)!.response!.activity).toBeUndefined();
  });

  it("404s activity for an unknown message id", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "act3").expect(201);
    await owner.put("/api/messages/does-not-exist/activity").send({ activity: { tools: [{ id: "t", label: "x" }] } }).expect(404);
  });
});

describe("slash-command expansion at the route boundary", () => {
  it("rejects /new with a Korean error before streaming", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "slash").expect(201)).body.user.id as string;
    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/new" }).expect(400);
    expect(res.body.error).toContain("/new");
    expect(H.requests).toHaveLength(0); // never reached the agent
  });

  it("rejects an argument-less owner-only command (/remember) with its error", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "slash2").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/remember" }).expect(400);
    expect(H.requests).toHaveLength(0);
  });

  it("blocks an owner-only command (/learn) sent to someone else's avatar", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "owner-learn").expect(201)).body.user.id as string;

    const teammate = request.agent(app);
    const teammateId = (await signup(teammate, "teammate-learn").expect(201)).body.user.id as string;
    // Group co-membership is the only reach to someone else's avatar now (it
    // also elevates the viewer — irrelevant here: the ownerOnly slash guard
    // keys on IDENTITY, not elevation).
    const group = store.createGroup({ name: "learn-group" });
    store.addGroupMember(group.id, ownerId);
    store.addGroupMember(group.id, teammateId);

    const res = await teammate.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "c", message: "/learn" }).expect(403);
    expect(res.body.error).toContain("내 아바타");
    expect(H.requests).toHaveLength(0);
  });
});

describe("discovery + listing edge cases", () => {
  it("lists the owner's registered git repos (name/repo/branch only)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gitrepos").expect(201)).body.user.id as string;
    store.upsertGitRepo(ownerId, "beta", "acme/beta", "dev");
    store.upsertGitRepo(ownerId, "alpha", "acme/alpha", null);

    const res = await owner.get("/api/me/git-repos").expect(200);
    expect(res.body.repos).toEqual([
      { name: "alpha", repo: "acme/alpha", branch: null },
      { name: "beta", repo: "acme/beta", branch: "dev" },
    ]);
  });

  it("returns an empty message list when no conversationId is supplied", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "nomsg").expect(201);
    const res = await owner.get("/api/messages").expect(200);
    expect(res.body).toEqual({ messages: [] });
  });
});

describe("canvas version history endpoints", () => {
  async function seedCanvas(store: Store, ownerId: string) {
    store.touchConversation(ownerId, "conv-cv", ownerId, "seed");
    store.upsertCanvasArtifact(ownerId, "conv-cv", { artifactId: "cv1", title: "v1", content: "one", contentType: "markdown" });
    // A changed body appends a second version.
    store.upsertCanvasArtifact(ownerId, "conv-cv", { artifactId: "cv1", title: "v2", content: "two", contentType: "markdown" });
  }

  it("lists versions, rolls back, and validates the version input", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvowner").expect(201)).body.user.id as string;
    await seedCanvas(store, ownerId);

    const versions = await owner.get("/api/chat/canvases/cv1/versions").expect(200);
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    await owner.post("/api/chat/canvases/cv1/rollback").send({ version: 0 }).expect(400);
    await owner.post("/api/chat/canvases/cv1/rollback").send({ version: "x" }).expect(400);
    await owner.post("/api/chat/canvases/unknown/rollback").send({ version: 1 }).expect(404);

    const rolled = await owner.post("/api/chat/canvases/cv1/rollback").send({ version: 1 }).expect(200);
    expect(rolled.body.canvas.content).toBe("one"); // rollback re-appends v1's body as the new current
    expect(rolled.body.canvas.currentVersion).toBe(3);
  });

  it("deletes a canvas and 404s an unknown one", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvdel").expect(201)).body.user.id as string;
    await seedCanvas(store, ownerId);

    await owner.delete("/api/chat/canvases/unknown").expect(404);
    await owner.delete("/api/chat/canvases/cv1").expect(200).expect({ ok: true });
    expect(store.getCanvasArtifact(ownerId, "cv1")).toBeNull();
  });
});

describe("chat-stream request validation", () => {
  it("rejects a non-array mcpToolGroups payload", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "mcpbad").expect(201)).body.user.id as string;
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "c", message: "hi", mcpToolGroups: "confluence" })
      .expect(400);
    expect(H.requests).toHaveLength(0);
  });

  it("409s a supplied conversation id owned by another user", async () => {
    const { app } = boot();
    const alice = request.agent(app);
    const aliceId = (await signup(alice, "alice").expect(201)).body.user.id as string;
    await alice.post("/api/chat/stream").send({ avatarId: aliceId, conversationId: "shared-conv", message: "내 대화" }).expect(200);

    const bob = request.agent(app);
    const bobId = (await signup(bob, "bob").expect(201)).body.user.id as string;
    H.requests.length = 0;
    await bob.post("/api/chat/stream").send({ avatarId: bobId, conversationId: "shared-conv", message: "끼어들기" }).expect(409);
    expect(H.requests).toHaveLength(0);
  });

  it("rejects image uploads when the deployment model has no vision", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
      visionEnabled: false,
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "novision").expect(201)).body.user.id as string;
    H.requests.length = 0;
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-nv", message: "이거 봐줘", images: [png] })
      .expect(400);
    expect(res.body.error).toContain("이미지 입력을 지원하지 않아");
    expect(H.requests).toHaveLength(0);
  });

  it("gates image uploads by the per-tier vision policy of this turn's model", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
    });
    services.store.setModelVisionPolicy({ sonnet: false });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "tiervision").expect(201)).body.user.id as string;
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    H.requests.length = 0;
    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-tv", message: "이미지", model: "sonnet", images: [png] })
      .expect(400);
    expect(res.body.error).toContain("이미지 입력을 지원하지 않아");
    expect(H.requests).toHaveLength(0);

    // A vision tier (no explicit entry → inherits the on default) still accepts images.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-tv2", message: "이미지", model: "opus", images: [png] })
      .expect(200);
    expect(H.requests).toHaveLength(1);
  });

  it("serves 404 for a missing image on the owner's own conversation", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "imgmiss").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-img", message: "hi" }).expect(200);
    // Owner matches, but the image id doesn't resolve to a stored file.
    await owner.get("/api/conversations/conv-img/images/ghost").expect(404);
  });

  it("serves a stored generated file as an owner-only attachment download", async () => {
    const { app, config } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "filedl").expect(201)).body.user.id as string;
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-file", message: "hi" }).expect(200);

    // Seed the on-disk store the way onShareFile would (metadata rides the message row).
    const dir = chatFilesDir(config, "conv-file");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deck-1.pdf"), "%PDF-1.4 test");

    await owner.get("/api/conversations/conv-file/files/ghost").expect(404);
    const res = await owner
      .get("/api/conversations/conv-file/files/deck-1")
      .query({ name: "주간 보고.pdf" })
      .expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment;");
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("주간 보고.pdf"));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    // Another user never reaches the bytes — same 404 shape as the image route.
    const bob = request.agent(app);
    await signup(bob, "filedl2").expect(201);
    await bob.get("/api/conversations/conv-file/files/deck-1").expect(404);
  });
});

describe("working-repo resolution failures (before SSE)", () => {
  it("400s when the opened working repo is no longer registered", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "reponf").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-repo", ownerId, "seed");
    store.setConversationWorkingRepo("conv-repo", "ghost-repo"); // not in git_repositories

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-repo", message: "작업" }).expect(400);
    expect(res.body.error).toContain("등록된 저장소");
    expect(H.requests).toHaveLength(0);
  });

  it("409s when another conversation holds the working-repo clone lock", async () => {
    const { store, config, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "repolock").expect(201)).body.user.id as string;
    store.upsertGitRepo(ownerId, "myrepo", "acme/myrepo", null);
    store.touchConversation(ownerId, "conv-lock", ownerId, "seed");
    store.setConversationWorkingRepo("conv-lock", "myrepo");

    const clonePath = gitRepoClonePath(ownerId, "myrepo", config);
    expect(acquireActiveRepo(clonePath, "another-conversation")).toBe(true);
    try {
      const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-lock", message: "작업" }).expect(409);
      expect(res.body.error).toContain("다른 대화");
      expect(H.requests).toHaveLength(0);
    } finally {
      releaseActiveRepo(clonePath, "another-conversation");
    }
  });
});

describe("per-conversation preferences persist + feed the agent", () => {
  it("stores the owner's model/effort/group-knowledge choices and passes them this turn", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "prefs").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({
        avatarId: ownerId,
        conversationId: "conv-prefs",
        message: "hi",
        model: "sonnet",
        effort: "medium",
        groupKnowledgeOff: ["g1", "g2", 5], // the non-string is filtered out
      })
      .expect(200);

    expect(H.requests[0].modelTier).toBe("sonnet");
    expect(H.requests[0].effort).toBe("medium");

    const msgs = await owner.get("/api/messages?conversationId=conv-prefs").expect(200);
    expect(msgs.body.selectedModel).toBe("sonnet");
    expect(msgs.body.selectedEffort).toBe("medium");
    expect(msgs.body.groupKnowledgeOff).toEqual(["g1", "g2"]);
  });

  it("drops system messages from the reconstructed conversation history", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "syshist").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-sys", ownerId, "이전 요청");
    store.addMessage("conv-sys", { role: "user", content: "이전 요청" });
    store.addMessage("conv-sys", { role: "system", content: "시스템 노트" });
    store.addMessage("conv-sys", {
      role: "assistant",
      content: "이전 답변",
      response: { kind: "text", runtime: "claude", summary: "", text: "이전 답변" },
    });

    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-sys", message: "이어서" }).expect(200);
    expect(H.requests[0].conversationHistory).toEqual([
      { role: "user", content: "이전 요청" },
      { role: "assistant", content: "이전 답변" },
    ]);
  });
});

describe("canvas submission turns (#50)", () => {
  it("formats a values submission for the agent and shows a Korean bubble", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvsub").expect(201)).body.user.id as string;
    store.touchConversation(ownerId, "conv-sub", ownerId, "seed");
    store.upsertCanvasArtifact(ownerId, "conv-sub", { artifactId: "cv-title", title: "내 차트", content: "x", contentType: "markdown" });

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-sub", canvasSubmission: { canvasId: "cv-title", values: { color: "red" } } })
      .expect(200);

    expect(H.requests[0].message).toContain('the canvas "내 차트" (id: cv-title)');
    expect(H.requests[0].message).toContain("- color: red");
    const userMsg = store.listMessages(ownerId, "conv-sub").find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("캔버스 응답을 보냈습니다.");
  });

  it("formats an edited-content submission (untitled canvas)", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvedit").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-edit", canvasSubmission: { canvasId: "cv-none", editedContent: "수정된 내용" } })
      .expect(200);

    expect(H.requests[0].message).toContain("The user edited the canvas (id: cv-none) content to:");
    expect(H.requests[0].message).toContain("수정된 내용");
    const userMsg = store.listMessages(ownerId, "conv-edit").find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("캔버스를 수정해 보냈습니다.");
  });

  it("ignores a canvasSubmission that carries neither values nor edited content", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cvnoop").expect(201)).body.user.id as string;

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop", message: "실제 메시지", canvasSubmission: { canvasId: "x" } })
      .expect(200);
    expect(H.requests[0].message).toBe("실제 메시지"); // treated as a normal turn

    // A non-object canvasSubmission is likewise ignored.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop2", message: "또 다른 메시지", canvasSubmission: 5 })
      .expect(200);
    expect(H.requests[1].message).toBe("또 다른 메시지");

    // An object canvasSubmission missing a canvasId is ignored too.
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-noop3", message: "세번째 메시지", canvasSubmission: { values: { x: 1 } } })
      .expect(200);
    expect(H.requests[2].message).toBe("세번째 메시지");
  });
});

describe("SSE event fan-out", () => {
  it("forwards every non-blocking event as an SSE frame and persists plan + thinking", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "fanout").expect(201)).body.user.id as string;

    H.impl = async (agentRequest, _pr, config, _store, events) => {
      events.onSessionId?.("sess-nb");
      events.onModel?.("claude-test-model");
      events.onStatus?.("작업 중");
      events.onDelta?.("답변 ");
      events.onThinking?.("throwaway");
      events.onThinkingReset?.();
      events.onThinking?.("final thinking");
      events.onPlugin?.({ status: "installed", name: "p1" });
      events.onToolStart?.({ toolUseId: "t1", name: "Read", agentId: "main", inputSummary: "file.ts" });
      events.onToolEnd?.({ toolUseId: "t1", ok: true });
      events.onTaskStart?.({ taskId: "k1", description: "task" });
      events.onTaskUpdate?.({ taskId: "k1", status: "running" });
      events.onTaskEnd?.({ taskId: "k1", ok: true, status: "done" });
      events.onAgentStart?.({ agentId: "a1", parentId: "main", subagentType: "explore", description: "sub" });
      events.onAgentEnd?.({ agentId: "a1", ok: true });
      events.onBlocked?.({ toolName: "Bash", agentId: "main", reason: "read-only" });
      events.onPlan?.({ plan: "", planning: true });
      events.onPlan?.({ plan: "THE PLAN" });
      await events.onCanvas?.({ artifactId: "c1", title: "T", content: "# hi", contentType: "markdown", awaitInput: false });
      const generatedPath = path.join(agentRequest.cwd!, "generated.png");
      fs.writeFileSync(generatedPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
      const shown = await events.onFile?.({ path: generatedPath, caption: "생성 결과" });
      expect(shown?.behavior).toBe("shown");
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "final answer" };
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-fan", message: "가라" }).expect(200);
    const frames = parseSse(res.text);
    const events = frames.map((f) => f.event);
    for (const name of [
      "open", "delta", "thinking", "thinking_reset", "status", "plugin", "tool", "tool_end",
      "task", "task_update", "task_end", "agent", "agent_end", "blocked", "plan", "canvas", "file", "done",
    ]) {
      expect(events).toContain(name);
    }
    const planFrames = frames.filter((f) => f.event === "plan");
    expect(planFrames).toHaveLength(2);
    expect(planFrames.some((f) => (f.data as { planning?: boolean }).planning === true)).toBe(true);
    expect(planFrames.some((f) => (f.data as { plan?: string }).plan === "THE PLAN")).toBe(true);

    const doneData = frames.find((f) => f.event === "done")!.data as { response: AgentResponse };
    expect(doneData.response.plan).toBe("THE PLAN");
    expect(doneData.response.thinking).toBe("final thinking"); // reset dropped the throwaway
    expect(doneData.response.text).toBe("final answer");
    const stored = store.listMessages(ownerId, "conv-fan").find((message) => message.role === "assistant");
    expect(stored?.attachments?.[0]).toMatchObject({ mediaType: "image/png", caption: "생성 결과" });

    // The non-blocking canvas was recorded to the dedicated tables.
    expect(store.getCanvasArtifact(ownerId, "c1")?.title).toBe("T");
    // Session id persisted for the next turn's resume.
    expect(store.getAgentSessionId(ownerId, "conv-fan")).toBe("sess-nb");
  });
});

describe("interactive prompts answered over /api/chat/respond", () => {
  it("delivers approve/allow/answer/submit decisions back to the run", async () => {
    const { services, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "interact").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    H.impl = async (_req, _pr, config, _store, events) => {
      const perm = await events.onPermission!({ toolUseId: "tu1", toolName: "Bash", input: { command: "ls" }, agentId: "main" });
      const q = await events.onQuestion!({ dialogKind: "ask", payload: { question: "고를래?" } });
      const plan = await events.onPlanReview!({ plan: "PLAN TEXT" });
      const canvas = await events.onCanvas!({
        artifactId: "cvpos",
        title: "T",
        content: "body",
        contentType: "markdown",
        controls: [{ type: "text", id: "a" }],
        awaitInput: true,
        interaction: "blocking",
      });
      events.onDelta?.(JSON.stringify({ perm, q, plan, canvas }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "ANSWERED" };
    };

    await withServer(app, async (port) => {
      const responses: Promise<{ status: number }>[] = [];
      const answer = (d: { runId: string; requestId: string }, value: object) =>
        responses.push(postJson(port, cookie, "/api/chat/respond", { runId: d.runId, requestId: d.requestId, value }));

      const { frames } = await streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-int", message: "가라" }, (frame) => {
        if (frame.event === "permission") answer(frame.data, { behavior: "allow" });
        else if (frame.event === "question") answer(frame.data, { result: { choice: "A" } });
        else if (frame.event === "plan_review") answer(frame.data, { behavior: "approved" });
        else if (frame.event === "canvas") answer(frame.data, { values: { a: "typed" } });
      });

      for (const r of await Promise.all(responses)) expect(r.status).toBe(200);
      const delta = frames.find((f) => f.event === "delta")!;
      expect(JSON.parse(delta.data.text)).toEqual({
        perm: { behavior: "allow" },
        q: { behavior: "completed", result: { choice: "A" } },
        plan: { behavior: "approved" },
        canvas: { behavior: "submitted", values: { a: "typed" } },
      });
      expect(frames.some((f) => f.event === "done")).toBe(true);
      // The submitted canvas persisted with the user's values.
      expect(services.store.getCanvasArtifact(ownerId, "cvpos")?.submittedValues).toEqual({ a: "typed" });
    });
  }, LIVE);

  it("delivers deny/cancel/reject/delete decisions back to the run", async () => {
    const { services, app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "interact2").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);

    H.impl = async (_req, _pr, config, _store, events) => {
      const perm = await events.onPermission!({ toolUseId: "tu1", toolName: "Bash", input: {}, agentId: "main" });
      const q = await events.onQuestion!({ dialogKind: "ask", payload: {} });
      const plan = await events.onPlanReview!({ plan: "P" });
      const canvasControls = [{ type: "text" as const, id: "a" }];
      // Two canvases: one the user DELETES, one they DISMISS (cancel) — distinct branches.
      const canvasDel = await events.onCanvas!({ artifactId: "cvdel", title: "T", content: "c", contentType: "markdown", controls: canvasControls, awaitInput: true, interaction: "blocking" });
      const canvasCancel = await events.onCanvas!({ artifactId: "cvcancel", title: "T", content: "c", contentType: "markdown", controls: canvasControls, awaitInput: true, interaction: "blocking" });
      events.onDelta?.(JSON.stringify({ perm, q, plan, canvasDel, canvasCancel }));
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "done" };
    };

    await withServer(app, async (port) => {
      const responses: Promise<{ status: number }>[] = [];
      const answer = (d: { runId: string; requestId: string }, value: object) =>
        responses.push(postJson(port, cookie, "/api/chat/respond", { runId: d.runId, requestId: d.requestId, value }));
      let canvasSeen = 0;

      const { frames } = await streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-int2", message: "가라" }, (frame) => {
        if (frame.event === "permission") answer(frame.data, { behavior: "deny" });
        else if (frame.event === "question") answer(frame.data, { cancelled: true });
        else if (frame.event === "plan_review") answer(frame.data, { behavior: "rejected", feedback: "다시" });
        else if (frame.event === "canvas") answer(frame.data, ++canvasSeen === 1 ? { deleteCanvas: true } : { cancelled: true });
      });

      await Promise.all(responses);
      const delta = frames.find((f) => f.event === "delta")!;
      expect(JSON.parse(delta.data.text)).toEqual({
        perm: { behavior: "deny" },
        q: { behavior: "cancelled" },
        plan: { behavior: "rejected", feedback: "다시" },
        canvasDel: { behavior: "cancelled" },
        canvasCancel: { behavior: "cancelled" },
      });
      // deleteCanvas removed the artifact; a plain cancel still records it (no values).
      expect(services.store.getCanvasArtifact(ownerId, "cvdel")).toBeNull();
      const cancelled = services.store.getCanvasArtifact(ownerId, "cvcancel");
      expect(cancelled?.submittedValues).toBeUndefined();
    });
  }, LIVE);
});

describe("cancellation + run registry", () => {
  it("stops a parked run, persists the streamed partial, and rejects a concurrent turn", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cancel").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-cancel", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-cancel")) !== null, "run active");
    const run = (await activeRun(owner, "conv-cancel"))!;

    // A second POST to the same conversation is refused while one is streaming.
    await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-cancel", message: "동시 요청" }).expect(409);
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200).expect({ ok: true });

    expect(parseSse((await streamDone).text).some((f) => f.event === "cancelled")).toBe(true);
    // The partial the user watched is persisted (not an empty stub).
    const assistant = store.listMessages(ownerId, "conv-cancel").find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("부분 답변");
    expect(assistant.response?.summary).toBe("중지됨");
  }, LIVE);

  it("replays the buffered events to a late watcher on the run-events endpoint", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const signupRes = await signup(owner, "watch").expect(201);
    const ownerId = signupRes.body.user.id as string;
    const cookie = cookieOf(signupRes);
    H.impl = parkUntilAborted;

    await withServer(app, async (port) => {
      let runId = "";
      // The main stream parks after emitting an open + delta.
      const mainDone = streamRaw(port, cookie, "/api/chat/stream", "POST", { avatarId: ownerId, conversationId: "conv-watch", message: "느린 요청" }, (f) => {
        if (f.event === "open") runId = f.data.runId as string;
      });
      await waitUntil(() => runId !== "", "main run open");

      // A watcher that connects LATE must be replayed the frames it missed.
      const watcher: string[] = [];
      const watcherDone = streamRaw(port, cookie, `/api/chat/runs/${runId}/events`, "GET", null, (f) => watcher.push(f.event));
      await waitUntil(() => watcher.includes("delta"), "watcher replayed the missed delta");

      await owner.post(`/api/chat/runs/${runId}/cancel`).send({}).expect(200);
      await Promise.all([mainDone, watcherDone]);
      expect(watcher).toContain("open"); // replayed
      expect(watcher).toContain("cancelled"); // live
    });
  }, LIVE);

  it("cancels the four blocking prompts at once when the run is stopped", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "cancelprompts").expect(201)).body.user.id as string;

    H.impl = async (_req, _pr, config, _store, events, ac) => {
      const [plan, perm, q, canvas] = await Promise.all([
        events.onPlanReview!({ plan: "p" }),
        events.onPermission!({ toolUseId: "tu", toolName: "Bash", input: {}, agentId: "main" }),
        events.onQuestion!({ dialogKind: "ask", payload: {} }),
        events.onCanvas!({ artifactId: "cvc", title: "T", content: "c", contentType: "markdown", controls: [{ type: "text", id: "a" }], awaitInput: true, interaction: "blocking" }),
      ]);
      events.onDelta?.(JSON.stringify({ plan, perm, q, canvas }));
      if (ac.signal.aborted) throw new Error("aborted");
      return { kind: "text", runtime: config.agentRuntime, summary: "s", text: "x" };
    };

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-cp", message: "질문들" });
    await waitUntil(async () => ((await activeRun(owner, "conv-cp"))?.pendingCount ?? 0) === 4, "four prompts parked");
    const run = (await activeRun(owner, "conv-cp"))!;
    await owner.post(`/api/chat/runs/${run.runId}/cancel`).send({}).expect(200);

    const frames = parseSse((await streamDone).text);
    for (const name of ["plan_review", "permission", "question", "canvas", "cancelled"]) {
      expect(frames.map((f) => f.event)).toContain(name);
    }
    // The stop resolved the permission prompt WITHOUT an answer — the decision
    // must say so (unanswered), not read as an explicit user refusal.
    const delta = frames.find((f) => f.event === "delta")!.data as { text: string };
    expect(JSON.parse(delta.text).perm).toEqual({ behavior: "deny", unanswered: true });
  }, LIVE);

  it("cancels the in-flight run when its conversation is deleted", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "delone").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-del1", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-del1")) !== null, "run active");

    await owner.delete("/api/conversations/conv-del1").expect(200).expect({ ok: true });
    // Persistence is skipped once the conversation row is gone (FK would reject).
    expect(parseSse((await streamDone).text).some((f) => f.event === "cancelled")).toBe(true);
    expect(store.listMessages(ownerId, "conv-del1")).toEqual([]);
  }, LIVE);

  it("cancels in-flight runs when all chat conversations are bulk-deleted", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "delall").expect(201)).body.user.id as string;
    H.impl = parkUntilAborted;

    const streamDone = fireStream(owner, { avatarId: ownerId, conversationId: "conv-del-all", message: "느린 요청" });
    await waitUntil(async () => (await activeRun(owner, "conv-del-all")) !== null, "run active");

    const res = await owner.delete("/api/conversations").expect(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.conversationIds).toContain("conv-del-all");
    await streamDone; // the aborted run unwinds and closes
  }, LIVE);
});

describe("chat error handling", () => {
  it("surfaces a non-retryable agent failure as an error frame + persisted message", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "err1").expect(201)).body.user.id as string;
    H.retryable = false;
    H.impl = async () => {
      throw new Error("boom failure");
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-err1", message: "가라" }).expect(200);
    const errData = parseSse(res.text).find((f) => f.event === "error")!.data as { error: string };
    expect(errData.error).toContain("boom failure");

    const assistant = store.listMessages(ownerId, "conv-err1").find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("boom failure");
    expect(assistant.response).toBeNull(); // plain error keeps the null-response shape
  });

  it("nudges the user to switch models on a retryable failure, keeping the streamed partial + plan + thinking", async () => {
    const { store, app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "err2").expect(201)).body.user.id as string;
    H.retryable = true;
    H.impl = async (_req, _pr, _config, _store, events) => {
      events.onDelta?.("부분 결과");
      events.onPlan?.({ plan: "PLAN" });
      events.onThinking?.("생각");
      throw new Error("overloaded");
    };

    const res = await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-err2", message: "가라" }).expect(200);
    const errData = parseSse(res.text).find((f) => f.event === "error")!.data as { error: string };
    expect(errData.error).toContain("일시적으로"); // Korean model-switch nudge, not the raw SDK error

    const assistant = store.listMessages(ownerId, "conv-err2").find((m) => m.role === "assistant")!;
    expect(assistant.content.startsWith("부분 결과")).toBe(true);
    expect(assistant.response?.plan).toBe("PLAN");
    expect(assistant.response?.thinking).toBe("생각");
  });
});

describe("run-registry endpoint validation", () => {
  it("validates /api/chat/runs and the runId endpoints", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "regval").expect(201);

    await owner.get("/api/chat/runs").expect(400); // no conversationId
    const noRun = await owner.get("/api/chat/runs?conversationId=nothing").expect(200);
    expect(noRun.body.run).toBeNull();
    await owner.get("/api/chat/runs/unknown/events").expect(404);
    await owner.post("/api/chat/runs/unknown/cancel").send({}).expect(404);
  });

  it("validates /api/chat/respond inputs and rejects unknown runs", async () => {
    const { app } = boot();
    const owner = request.agent(app);
    await signup(owner, "respval").expect(201);

    await owner.post("/api/chat/respond").send({}).expect(400); // missing runId/requestId
    await owner.post("/api/chat/respond").send({ runId: "a", requestId: "b", value: "not-an-object" }).expect(400);
    await owner.post("/api/chat/respond").send({ runId: "a", requestId: "b", value: { behavior: "allow" } }).expect(404);
  });
});
