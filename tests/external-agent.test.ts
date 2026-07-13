import http from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { runExternalAgent } from "../src/server/agent/externalAgent.js";
import {
  externalAvatarDetail,
  parseExternalAgents,
} from "../src/server/externalAgents.js";
import { createApp, createServices } from "../src/server/app.js";
import type { ExternalAgentConfig } from "../src/server/types.js";
import { parseSse, signup, withTempDir } from "./helpers.js";

const tempDir = withTempDir("external-agent");

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface GatewayFrame {
  event: string;
  data: unknown;
}

async function withGateway(
  framesFor: (request: CapturedRequest, index: number) => GatewayFrame[],
  run: (endpoint: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const entry = {
        headers: req.headers,
        body: JSON.parse(body) as Record<string, unknown>,
      };
      captured.push(entry);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of framesFor(entry, captured.length - 1)) {
        res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}/v1/agents/messages`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function externalConfig(endpoint: string): ExternalAgentConfig {
  return {
    id: "research",
    displayName: "Research Agent",
    alias: "리서처",
    bio: "외부 조사 에이전트",
    persona: "공개 소개",
    intro: "외부 Gateway에서 실행됩니다.",
    hashtags: ["research"],
    endpoint,
    agent: "claude",
    model: "gateway-model",
    system: "private system instruction",
    apiKey: "gateway-secret",
  };
}

function successfulFrames(text: string): GatewayFrame[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        schema: "claude-agent-sdk-message-v1",
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "system",
        subtype: "init",
        session_id: "gateway-session-must-not-persist",
        model: "gateway-model",
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "검토 중" },
        },
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "WebSearch",
              input: { query: "fixture" },
            },
          ],
        },
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        task_type: "workflow",
        description: "fixture task",
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        summary: "halfway",
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        summary: "done",
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
          usage: { input_tokens: 12 },
        },
      },
    },
    {
      event: "sdk_message",
      data: {
        type: "result",
        subtype: "success",
        result: text,
        usage: { input_tokens: 12, output_tokens: 4 },
        modelUsage: { gateway: { contextWindow: 200_000 } },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

describe("external agent registry", () => {
  it("resolves a base URL and keeps connection secrets out of public avatar JSON", () => {
    const [agent] = parseExternalAgents(
      JSON.stringify([
        {
          id: "research",
          displayName: "Research Agent",
          baseUrl: "https://gateway.example/internal/",
          apiKeyEnv: "RESEARCH_AGENT_TOKEN",
          model: "private-model",
          system: "private system",
          hashtags: ["#research", "research"],
          connectTimeoutSeconds: 12.5,
          idleTimeoutSeconds: 90,
          totalTimeoutSeconds: 900,
        },
      ]),
      (name) => (name === "RESEARCH_AGENT_TOKEN" ? "secret-token" : undefined),
    );

    expect(agent.endpoint).toBe(
      "https://gateway.example/internal/v1/agents/messages",
    );
    expect(agent.apiKey).toBe("secret-token");
    expect(agent.hashtags).toEqual(["research"]);
    expect(agent.connectTimeoutMs).toBe(12_500);
    expect(agent.idleTimeoutMs).toBe(90_000);
    expect(agent.totalTimeoutMs).toBe(900_000);
    const publicAvatar = externalAvatarDetail(agent);
    expect(publicAvatar.visibility).toBe("public");
    const publicJson = JSON.stringify(publicAvatar);
    expect(publicJson).toContain('"runtime":"external"');
    expect(publicJson).not.toContain("gateway.example");
    expect(publicJson).not.toContain("secret-token");
    expect(publicJson).not.toContain("private-model");
    expect(publicJson).not.toContain("private system");
    expect(publicJson).not.toContain("TimeoutMs");
  });

  it("normalizes a private group ACL without exposing group ids publicly", () => {
    const [agent] = parseExternalAgents(
      JSON.stringify([
        {
          id: "group-research",
          displayName: "Group Research Agent",
          endpoint: "https://gateway.example/v1/agents/messages",
          visibleToGroupIds: [" group-a ", "group-b", "group-a"],
        },
      ]),
    );

    expect(agent.visibleToGroupIds).toEqual(["group-a", "group-b"]);
    const publicAvatar = externalAvatarDetail(agent);
    expect(publicAvatar.visibility).toBe("group");
    expect(publicAvatar.elevated).toBe(false);
    expect(publicAvatar.sharesGroup).toBe(false);
    expect(JSON.stringify(publicAvatar)).not.toContain("group-a");
  });

  it("rejects an empty or malformed external group ACL", () => {
    const entry = {
      id: "group-research",
      displayName: "Group Research Agent",
      endpoint: "https://gateway.example/v1/agents/messages",
    };

    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: [] }]),
      ),
    ).toThrow("must not be empty");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: "group-a" }]),
      ),
    ).toThrow("must be an array");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: [123] }]),
      ),
    ).toThrow("must be a string");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: null }]),
      ),
    ).toThrow("must be an array");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupId: ["group-a"] }]),
      ),
    ).toThrow("unsupported field 'visibleToGroupId'");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, VisibleToGroupIds: ["group-a"] }]),
      ),
    ).toThrow("unsupported field 'VisibleToGroupIds'");
  });

  it("rejects unsafe external timeout values", () => {
    const entry = {
      id: "research",
      displayName: "Research Agent",
      endpoint: "https://gateway.example/v1/agents/messages",
    };

    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, connectTimeoutSeconds: 0 }]),
      ),
    ).toThrow("connectTimeoutSeconds must be a positive number");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, idleTimeoutSeconds: "30" }]),
      ),
    ).toThrow("idleTimeoutSeconds must be a positive number");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, totalTimeoutSeconds: 100_000 }]),
      ),
    ).toThrow("totalTimeoutSeconds must be a positive number");
  });
});

describe("external agent SDK event bridge", () => {
  it("sends full history and reuses SDK handlers without forwarding session ids", async () => {
    await withGateway(
      () => successfulFrames("최종 답변"),
      async (endpoint, captured) => {
        const deltas: string[] = [];
        const thinking: string[] = [];
        const models: string[] = [];
        const sessions: string[] = [];
        const tools: string[] = [];
        const toolEnds: string[] = [];
        const tasks: string[] = [];
        const taskUpdates: string[] = [];
        const taskEnds: string[] = [];
        const result = await runExternalAgent(
          {
            message: "현재 질문",
            conversationHistory: [
              { role: "user", content: "이전 질문" },
              { role: "assistant", content: "이전 답변" },
            ],
          },
          externalConfig(endpoint),
          {
            onDelta: (text) => deltas.push(text),
            onThinking: (text) => thinking.push(text),
            onModel: (model) => models.push(model),
            onSessionId: (sessionId) => sessions.push(sessionId),
            onToolStart: (event) => tools.push(`${event.toolUseId}:${event.name}`),
            onToolEnd: (event) => toolEnds.push(`${event.toolUseId}:${event.ok}`),
            onTaskStart: (event) => tasks.push(event.taskId),
            onTaskUpdate: (event) => taskUpdates.push(`${event.taskId}:${event.summary}`),
            onTaskEnd: (event) => taskEnds.push(`${event.taskId}:${event.ok}`),
          },
        );

        expect(result).toMatchObject({ runtime: "external", text: "최종 답변" });
        expect(deltas).toEqual(["최종 답변"]);
        expect(thinking).toEqual(["검토 중"]);
        expect(models).toEqual(["gateway-model"]);
        expect(sessions).toEqual([]);
        expect(tools).toEqual(["tool-1:WebSearch"]);
        expect(toolEnds).toEqual(["tool-1:true"]);
        expect(tasks).toEqual(["task-1"]);
        expect(taskUpdates).toEqual(["task-1:halfway"]);
        expect(taskEnds).toEqual(["task-1:true"]);
        expect(captured[0].headers.authorization).toBe(
          "Bearer gateway-secret",
        );
        expect(captured[0].body).toMatchObject({
          agent: "claude",
          model: "gateway-model",
          system: "private system instruction",
          stream: true,
          messages: [
            { role: "user", content: "이전 질문" },
            { role: "assistant", content: "이전 답변" },
            { role: "user", content: "현재 질문" },
          ],
        });
      },
    );
  });

  it("turns an SDK error envelope into a failed run", async () => {
    await withGateway(
      () => [
        {
          event: "message_start",
          data: { schema: "claude-agent-sdk-message-v1" },
        },
        {
          event: "sdk_message",
          data: {
            type: "error",
            is_error: true,
            error_message: "gateway agent failed",
          },
        },
        { event: "message_stop", data: {} },
      ],
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "실패해" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow("gateway agent failed");
      },
    );
  });

  it("interprets an SDK result error in-band like the local runner", async () => {
    await withGateway(
      () => [
        {
          event: "message_start",
          data: { schema: "claude-agent-sdk-message-v1" },
        },
        {
          event: "sdk_message",
          data: {
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            errors: ["Reached maximum number of turns"],
          },
        },
        { event: "message_stop", data: {} },
      ],
      async (endpoint) => {
        const result = await runExternalAgent(
          { message: "오래 실행해" },
          externalConfig(endpoint),
          {},
        );
        expect(result.text).toContain("최대 처리 단계");
        expect(result.text).not.toContain("Reached maximum number of turns");
      },
    );
  });

  it("rejects an unsupported SDK event schema before consuming messages", async () => {
    await withGateway(
      () => [
        { event: "message_start", data: { schema: "future-sdk-schema-v2" } },
        { event: "message_stop", data: {} },
      ],
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "스키마 확인" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow("지원하지 않는 외부 에이전트 이벤트 스키마");
      },
    );
  });

  it("rejects a message_start event that omits the SDK schema", async () => {
    await withGateway(
      () => [
        { event: "message_start", data: { type: "message_start" } },
        { event: "message_stop", data: {} },
      ],
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "스키마 확인" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow("이벤트 스키마가 없습니다");
      },
    );
  });

  it("aborts the upstream stream when the Noah run is cancelled", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ schema: "claude-agent-sdk-message-v1" })}\n\n`,
      );
      markStarted?.();
      // Intentionally leave the stream open until fetch aborts.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controller = new AbortController();
    try {
      const running = runExternalAgent(
        { message: "중지해" },
        externalConfig(`http://127.0.0.1:${port}/v1/agents/messages`),
        {},
        controller,
      );
      await started;
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out when the gateway never sends response headers", async () => {
    const server = http.createServer(() => {
      // Accept the request but intentionally never send response headers.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const external = externalConfig(
      `http://127.0.0.1:${port}/v1/agents/messages`,
    );
    external.connectTimeoutMs = 40;
    external.idleTimeoutMs = 1_000;
    external.totalTimeoutMs = 2_000;
    try {
      await expect(
        runExternalAgent({ message: "연결 제한" }, external, {}),
      ).rejects.toThrow("외부 에이전트 연결 시간이 초과되었습니다");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out when an open SSE stream goes idle", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ schema: "claude-agent-sdk-message-v1" })}\n\n`,
      );
      // Keep the connection open without sending another byte.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const external = externalConfig(
      `http://127.0.0.1:${port}/v1/agents/messages`,
    );
    external.connectTimeoutMs = 1_000;
    external.idleTimeoutMs = 40;
    external.totalTimeoutMs = 2_000;
    try {
      await expect(
        runExternalAgent({ message: "유휴 제한" }, external, {}),
      ).rejects.toThrow("외부 에이전트 응답 대기 시간이 초과되었습니다");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces a total timeout even while the gateway sends heartbeats", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ schema: "claude-agent-sdk-message-v1" })}\n\n`,
      );
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 10);
      res.on("close", () => clearInterval(heartbeat));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const external = externalConfig(
      `http://127.0.0.1:${port}/v1/agents/messages`,
    );
    external.connectTimeoutMs = 1_000;
    external.idleTimeoutMs = 200;
    external.totalTimeoutMs = 70;
    try {
      await expect(
        runExternalAgent({ message: "총 실행 제한" }, external, {}),
      ).rejects.toThrow("외부 에이전트 최대 실행 시간을 초과했습니다");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("external avatar chat routes", () => {
  it("discovers the avatar, sends stateless full history, and never stores a gateway SDK session", async () => {
    await withGateway(
      (_request, index) => successfulFrames(index === 0 ? "첫 외부 답변" : "두 번째 외부 답변"),
      async (endpoint, captured) => {
        const external = externalConfig(endpoint);
        const services = createServices({
          dataDir: tempDir(),
          agentRuntime: "local",
          sessionSecret: "test",
          externalAgents: [external],
        });
        const app = createApp(services);
        const viewer = request.agent(app);
        const viewerId = (await signup(viewer, "external-viewer").expect(201))
          .body.user.id as string;
        const avatarId = "external:research";
        const conversationId = "external-conversation";

        const list = await viewer.get("/api/avatars").expect(200);
        const card = list.body.avatars.find(
          (avatar: { id: string }) => avatar.id === avatarId,
        );
        expect(card).toMatchObject({
          displayName: "Research Agent",
          runtime: "external",
        });
        expect(JSON.stringify(card)).not.toContain("gateway-secret");
        await viewer
          .get(`/api/avatars/${encodeURIComponent(avatarId)}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.avatar).toMatchObject({
              id: avatarId,
              isOwn: false,
              elevated: false,
              runtime: "external",
            });
          });

        const first = await viewer
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "첫 질문" })
          .expect(200);
        expect(parseSse(first.text).some((frame) => frame.event === "done")).toBe(
          true,
        );
        expect(
          services.store.getAgentSessionId(viewerId, conversationId),
        ).toBeNull();
        expect(
          services.store.getConversationExternalEndpoint(
            viewerId,
            conversationId,
          ),
        ).toBe(endpoint);

        await viewer
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "두 번째 질문" })
          .expect(200);
        expect(captured[1].body.messages).toEqual([
          { role: "user", content: "첫 질문" },
          { role: "assistant", content: "첫 외부 답변" },
          { role: "user", content: "두 번째 질문" },
        ]);
        expect(
          services.store.getAgentSessionId(viewerId, conversationId),
        ).toBeNull();
        const system = await viewer.get("/api/admin/system").expect(200);
        expect(system.body.system.observedModel).toBeNull();

        const conversations = await viewer
          .get("/api/conversations")
          .expect(200);
        expect(conversations.body.conversations[0]).toMatchObject({
          avatarUserId: avatarId,
          avatarDisplayName: "Research Agent",
        });

        const png =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        await viewer
          .post("/api/chat/stream")
          .send({
            avatarId,
            conversationId,
            message: "이미지",
            images: [{ id: "external-image", data: png }],
          })
          .expect(400);
        expect(captured).toHaveLength(2);
      },
    );
  });

  it("exposes a group-scoped avatar only to current members", async () => {
    await withGateway(
      () => successfulFrames("그룹 전용 답변"),
      async (endpoint, captured) => {
        const external = externalConfig(endpoint);
        const services = createServices({
          dataDir: tempDir(),
          agentRuntime: "local",
          sessionSecret: "test",
          externalAgents: [external],
        });
        const app = createApp(services);
        const admin = request.agent(app);
        const member = request.agent(app);
        const outsider = request.agent(app);
        const adminId = (await signup(admin, "external-admin").expect(201)).body
          .user.id as string;
        const memberId = (await signup(member, "external-member").expect(201))
          .body.user.id as string;
        await signup(outsider, "external-outsider").expect(201);
        const group = services.store.createGroup({
          name: "External Agent Team",
          createdBy: adminId,
        });
        services.store.addGroupMember(group.id, memberId, "member");
        external.visibleToGroupIds = ["missing-group", group.id];

        const avatarId = "external:research";
        const conversationId = "external-group-conversation";
        const memberList = await member.get("/api/avatars").expect(200);
        expect(
          memberList.body.avatars.find(
            (avatar: { id: string }) => avatar.id === avatarId,
          ),
        ).toMatchObject({
          runtime: "external",
          visibility: "group",
          sharesGroup: false,
        });
        const outsiderList = await outsider.get("/api/avatars").expect(200);
        expect(
          outsiderList.body.avatars.some(
            (avatar: { id: string }) => avatar.id === avatarId,
          ),
        ).toBe(false);

        await member
          .get(`/api/avatars/${encodeURIComponent(avatarId)}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.avatar).toMatchObject({
              visibility: "group",
              elevated: false,
              sharesGroup: false,
            });
          });
        await member
          .get(`/api/avatars/${encodeURIComponent(avatarId)}/skills`)
          .expect(200);
        await outsider
          .get(`/api/avatars/${encodeURIComponent(avatarId)}`)
          .expect(404);
        await outsider
          .get(`/api/avatars/${encodeURIComponent(avatarId)}/skills`)
          .expect(404);
        await outsider
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "접근 시도" })
          .expect(403);
        expect(captured).toHaveLength(0);
        const outsiderConversations = await outsider
          .get("/api/conversations")
          .expect(200);
        expect(
          outsiderConversations.body.conversations.some(
            (conversation: { avatarUserId: string }) =>
              conversation.avatarUserId === avatarId,
          ),
        ).toBe(false);

        await member
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "그룹 질문" })
          .expect(200);
        expect(captured).toHaveLength(1);

        services.store.removeGroupMember(group.id, memberId);
        await member
          .get(`/api/avatars/${encodeURIComponent(avatarId)}`)
          .expect(404);
        await member
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "권한 철회 후 질문" })
          .expect(403);
        expect(captured).toHaveLength(1);
        const conversations = await member
          .get("/api/conversations")
          .expect(200);
        expect(conversations.body.conversations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              avatarUserId: avatarId,
              avatarDisplayName: "Research Agent",
            }),
          ]),
        );
      },
    );
  });
});
