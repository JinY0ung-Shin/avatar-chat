import http from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SDK_MESSAGE_SCHEMA,
  probeExternalAgentGateway,
  runExternalAgent,
} from "../src/server/agent/externalAgent.js";
import {
  MAX_EXTERNAL_AGENTS,
  externalAgentVisibleTo,
  externalAvatarDetail,
  listExternalAvatarSummaries,
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

/** Model catalog served by the fake gateway's GET /v1/models. */
const GATEWAY_CATALOG = [
  { id: "gateway-model", backend: "claude" },
  { id: "claude-frontier-9", backend: "claude" },
  { id: "gpt-99", backend: "openai" },
];

async function withGateway(
  framesFor: (request: CapturedRequest, index: number) => GatewayFrame[],
  run: (
    endpoint: string,
    captured: CapturedRequest[],
    gateway: { modelsHits: number },
  ) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const gateway = { modelsHits: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      gateway.modelsHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: GATEWAY_CATALOG }));
      return;
    }
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
    await run(`http://127.0.0.1:${port}/v1/agents/messages`, captured, gateway);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Gateway that writes RAW HTTP/SSE bytes, so a test can shape frame
 * boundaries, headers, and truncation that the structured `withGateway`
 * fixture always gets right.
 */
async function withRawGateway(
  respond: (
    res: http.ServerResponse,
    req: http.IncomingMessage,
  ) => void | Promise<void>,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => void respond(res, req));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}/v1/agents/messages`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Open an SSE response and write pre-built raw blocks (no framing help). */
function writeSse(res: http.ServerResponse, ...blocks: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const block of blocks) res.write(block);
}

function rawFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const RAW_START = rawFrame("message_start", {
  schema: EXTERNAL_SDK_MESSAGE_SCHEMA,
});

/** Run and return the rejection, so a test can assert what a message omits. */
async function failedRun(
  ...args: Parameters<typeof runExternalAgent>
): Promise<Error> {
  try {
    await runExternalAgent(...args);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the external agent run to fail");
}

/** Minimal valid registry entry; a case overrides only the field under test. */
const REGISTRY_ENTRY = {
  id: "research",
  displayName: "Research Agent",
  endpoint: "https://gateway.example/v1/agents/messages",
};

function parseEntry(overrides: Record<string, unknown>): ExternalAgentConfig {
  return parseExternalAgents(
    JSON.stringify([{ ...REGISTRY_ENTRY, ...overrides }]),
  )[0];
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
    // No visibleToGroupIds: the entry parses (legacy env JSON must not break
    // boot) but is visible to NO ONE until groups are assigned (fail closed).
    expect(externalAgentVisibleTo(agent, new Set())).toBe(false);
    expect(externalAgentVisibleTo(agent, new Set(["any-group"]))).toBe(false);
    const publicAvatar = externalAvatarDetail(agent);
    expect(publicAvatar.visibility).toBe("group");
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
    ).toThrow("visibleToGroupIds는 비워 둘 수 없습니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: "group-a" }]),
      ),
    ).toThrow("visibleToGroupIds는 배열이어야 합니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: [123] }]),
      ),
    ).toThrow("visibleToGroupIds[0]은(는) 문자열이어야 합니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupIds: null }]),
      ),
    ).toThrow("visibleToGroupIds는 배열이어야 합니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, visibleToGroupId: ["group-a"] }]),
      ),
    ).toThrow("지원하지 않는 설정 필드입니다: visibleToGroupId");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, VisibleToGroupIds: ["group-a"] }]),
      ),
    ).toThrow("지원하지 않는 설정 필드입니다: VisibleToGroupIds");
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
    ).toThrow("connectTimeoutSeconds은(는) 300초 이하의 양수여야 합니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, idleTimeoutSeconds: "30" }]),
      ),
    ).toThrow("idleTimeoutSeconds은(는) 3600초 이하의 양수여야 합니다.");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...entry, totalTimeoutSeconds: 100_000 }]),
      ),
    ).toThrow("totalTimeoutSeconds은(는) 86400초 이하의 양수여야 합니다.");
  });

  it("rejects a registry that is not a JSON array of objects", () => {
    expect(parseExternalAgents(undefined)).toEqual([]);
    expect(parseExternalAgents("   ")).toEqual([]);
    expect(() => parseExternalAgents("{not json}")).toThrow(
      "EXTERNAL_AGENTS_JSON은 올바른 JSON이어야 합니다.",
    );
    expect(() => parseExternalAgents(JSON.stringify(REGISTRY_ENTRY))).toThrow(
      "EXTERNAL_AGENTS_JSON은 JSON 배열이어야 합니다.",
    );
    expect(() =>
      parseExternalAgents(
        JSON.stringify(
          Array.from({ length: MAX_EXTERNAL_AGENTS + 1 }, (_, index) => ({
            ...REGISTRY_ENTRY,
            id: `research-${index}`,
          })),
        ),
      ),
    ).toThrow("최대 50개의 외부 아바타만 등록할 수 있습니다.");
    for (const item of ["research", 42, null, ["research"]]) {
      expect(() => parseExternalAgents(JSON.stringify([item]))).toThrow(
        "EXTERNAL_AGENTS_JSON[0] 항목은 객체여야 합니다.",
      );
    }
  });

  it("rejects malformed identity, text, and flag fields", () => {
    expect(() => parseEntry({ id: undefined })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].id은(는) 필수입니다.",
    );
    expect(() => parseEntry({ id: "리서치 에이전트" })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].id는 영문/숫자/_/- 만 사용할 수 있습니다.",
    );
    expect(() =>
      parseExternalAgents(
        JSON.stringify([
          REGISTRY_ENTRY,
          { ...REGISTRY_ENTRY, displayName: "Twin" },
        ]),
      ),
    ).toThrow("EXTERNAL_AGENTS_JSON에 중복된 id가 있습니다: research");
    expect(() => parseEntry({ displayName: 42 })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].displayName은(는) 문자열이어야 합니다.",
    );
    expect(() => parseEntry({ displayName: "   " })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].displayName은(는) 필수입니다.",
    );
    expect(() => parseEntry({ bio: "가".repeat(501) })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].bio은(는) 500자를 초과할 수 없습니다.",
    );
    expect(() => parseEntry({ enabled: "yes" })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].enabled은(는) true 또는 false여야 합니다.",
    );
    // Blank/absent optional values mean "unset", not an error.
    expect(parseEntry({ alias: "", model: "", enabled: null })).toMatchObject({
      alias: "",
      enabled: true,
    });
    expect(parseEntry({ model: "" }).model).toBeUndefined();
  });

  it("rejects unusable endpoint URLs", () => {
    expect(() => parseEntry({ endpoint: undefined })).toThrow(
      "EXTERNAL_AGENTS_JSON[0] endpoint 또는 baseUrl이 필요합니다.",
    );
    expect(() =>
      parseEntry({ endpoint: "gateway.example/v1/agents/messages" }),
    ).toThrow("EXTERNAL_AGENTS_JSON[0].endpoint URL 형식이 올바르지 않습니다.");
    expect(() =>
      parseEntry({ endpoint: "ftp://gateway.example/v1/agents/messages" }),
    ).toThrow("EXTERNAL_AGENTS_JSON[0].endpoint는 http 또는 https여야 합니다.");
    expect(() =>
      parseEntry({
        endpoint: "https://user:pass@gateway.example/v1/agents/messages",
      }),
    ).toThrow(
      "EXTERNAL_AGENTS_JSON[0].endpoint에는 인증 정보를 포함할 수 없습니다.",
    );
  });

  it("rejects malformed hashtag and group-ACL shapes", () => {
    expect(() => parseEntry({ hashtags: "research" })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].hashtags는 배열이어야 합니다.",
    );
    expect(() => parseEntry({ hashtags: ["ok", 7] })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].hashtags[1]은(는) 문자열이어야 합니다.",
    );
    expect(
      parseEntry({
        hashtags: Array.from({ length: 25 }, (_, index) => `tag-${index}`),
      }).hashtags,
    ).toHaveLength(20);
    expect(() =>
      parseEntry({
        visibleToGroupIds: Array.from(
          { length: 51 },
          (_, index) => `group-${index}`,
        ),
      }),
    ).toThrow("visibleToGroupIds는 최대 50개 그룹까지 지정할 수 있습니다.");
    for (const groupId of ["   ", "g".repeat(129)]) {
      expect(() => parseEntry({ visibleToGroupIds: [groupId] })).toThrow(
        "visibleToGroupIds[0]에는 128자 이하의 그룹 ID를 입력해야 합니다.",
      );
    }
  });

  it("reads apiKeyEnv through process.env when no lookup is injected", () => {
    const variable = "NOAH_TEST_EXTERNAL_GATEWAY_TOKEN";
    delete process.env[variable];
    expect(() => parseEntry({ apiKeyEnv: "not a variable" })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].apiKeyEnv는 올바른 환경 변수 이름이 아닙니다.",
    );
    expect(() => parseEntry({ apiKeyEnv: variable })).toThrow(
      "EXTERNAL_AGENTS_JSON[0].apiKeyEnv가 가리키는 환경 변수가 설정되지 않았습니다.",
    );
    process.env[variable] = "  env-token  ";
    try {
      // The env value is trimmed and wins over an inline apiKey.
      expect(
        parseEntry({ apiKeyEnv: variable, apiKey: "inline-token" }).apiKey,
      ).toBe("env-token");
    } finally {
      delete process.env[variable];
    }
  });

  it("lists only enabled, group-visible avatars sorted by display name", () => {
    const agents = parseExternalAgents(
      JSON.stringify([
        {
          ...REGISTRY_ENTRY,
          id: "zulu",
          displayName: "Zulu Agent",
          visibleToGroupIds: ["team"],
        },
        {
          ...REGISTRY_ENTRY,
          id: "alpha",
          displayName: "Alpha Agent",
          visibleToGroupIds: ["team", "other"],
        },
        {
          ...REGISTRY_ENTRY,
          id: "off",
          displayName: "Disabled Agent",
          enabled: false,
          visibleToGroupIds: ["team"],
        },
        {
          ...REGISTRY_ENTRY,
          id: "elsewhere",
          displayName: "Elsewhere Agent",
          visibleToGroupIds: ["other"],
        },
        { ...REGISTRY_ENTRY, id: "unbound", displayName: "Unbound Agent" },
      ]),
    );

    const visible = listExternalAvatarSummaries(agents, new Set(["team"]));
    expect(visible.map((avatar) => avatar.id)).toEqual([
      "external:alpha",
      "external:zulu",
    ]);
    expect(visible[0]).toMatchObject({
      username: "external-alpha",
      runtime: "external",
      visibility: "group",
      sharesGroup: false,
      pluginCount: 0,
      hasImage: false,
    });
    // A group-less viewer and an unconfigured registry both see nothing.
    expect(listExternalAvatarSummaries(agents, new Set())).toEqual([]);
    expect(listExternalAvatarSummaries(undefined, new Set(["team"]))).toEqual(
      [],
    );
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

  it("folds the superseded text block into the host's reasoning sink", async () => {
    const textDelta = (text: string): GatewayFrame => ({
      event: "sdk_message",
      data: {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      },
    });
    const assistantText = (text: string, blocks: unknown[] = []): GatewayFrame => ({
      event: "sdk_message",
      data: { type: "assistant", message: { content: [{ type: "text", text }, ...blocks] } },
    });
    await withGateway(
      () => [
        { event: "message_start", data: { schema: EXTERNAL_SDK_MESSAGE_SCHEMA } },
        textDelta("중간 설명"),
        assistantText("중간 설명", [
          { type: "tool_use", id: "tool-1", name: "WebSearch", input: { query: "x" } },
        ]),
        {
          event: "sdk_message",
          data: {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
          },
        },
        textDelta("최종 답"),
        assistantText("최종 답"),
        { event: "sdk_message", data: { type: "result", subtype: "success", result: "최종 답" } },
        { event: "message_stop", data: {} },
      ],
      async (endpoint) => {
        const folded: string[] = [];
        const result = await runExternalAgent(
          { message: "설명하고 답해" },
          externalConfig(endpoint),
          { onTextFold: (text) => folded.push(text) },
        );
        // The gateway stream is consumed as-is; the fold is Noah-side only.
        expect(folded).toEqual(["중간 설명"]);
        expect(result.text).toBe("최종 답");
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

  it("flushes a final frame the gateway never newline-terminated", async () => {
    await withRawGateway(
      (res) => {
        writeSse(
          res,
          RAW_START,
          rawFrame("sdk_message", {
            type: "result",
            subtype: "success",
            result: "마지막 프레임",
          }),
          // No trailing blank line: this frame exists only in the leftover
          // buffer once the stream closes.
          "event: message_stop\ndata: {}",
        );
        res.end();
      },
      async (endpoint) => {
        const result = await runExternalAgent(
          { message: "끝맺음" },
          externalConfig(endpoint),
          {},
        );
        expect(result).toMatchObject({
          runtime: "external",
          text: "마지막 프레임",
        });
      },
    );
  });

  it("rejects a stream that stops before the completion event", async () => {
    await withRawGateway(
      (res) => {
        writeSse(
          res,
          RAW_START,
          rawFrame("sdk_message", {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "중간까지" },
            },
          }),
        );
        res.end();
      },
      async (endpoint) => {
        const deltas: string[] = [];
        await expect(
          runExternalAgent({ message: "중단" }, externalConfig(endpoint), {
            onDelta: (text) => deltas.push(text),
          }),
        ).rejects.toThrow(
          "외부 에이전트 스트림이 완료 이벤트 없이 종료되었습니다.",
        );
        // The partial text did reach the client, but the turn still fails.
        expect(deltas).toEqual(["중간까지"]);
      },
    );

    await withRawGateway(
      (res) => {
        writeSse(res);
        res.end();
      },
      async (endpoint) => {
        await expect(
          runExternalAgent({ message: "빈 응답" }, externalConfig(endpoint), {}),
        ).rejects.toThrow(
          "외부 에이전트 스트림에 message_start 이벤트가 없습니다.",
        );
      },
    );

    // A dangling comment is not a frame, so it cannot stand in for the
    // completion event either.
    await withRawGateway(
      (res) => {
        writeSse(res, RAW_START, ": still working");
        res.end();
      },
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "주석으로 끝남" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow(
          "외부 에이전트 스트림이 완료 이벤트 없이 종료되었습니다.",
        );
      },
    );
  });

  it("answers with the empty-response text when a turn carries no content", async () => {
    await withRawGateway(
      (res) => {
        writeSse(res, RAW_START, rawFrame("message_stop", {}));
        res.end();
      },
      async (endpoint) => {
        const result = await runExternalAgent(
          { message: "빈 턴" },
          externalConfig(endpoint),
          {},
        );
        expect(result).toMatchObject({
          runtime: "external",
          text: "외부 에이전트 응답이 비어 있습니다.",
        });
        expect(result.usage).toBeUndefined();
      },
    );
  });

  it("rejects frames that break the SDK event contract", async () => {
    const cases = [
      {
        blocks: [rawFrame("message_stop", {})],
        message: "외부 에이전트 스트림에 message_start 이벤트가 없습니다.",
      },
      {
        blocks: [rawFrame("sdk_message", { type: "result" })],
        message: "외부 에이전트가 message_start 전에 SDK 이벤트를 보냈습니다.",
      },
      {
        blocks: [RAW_START, rawFrame("sdk_message", 42)],
        message: "외부 에이전트의 sdk_message 이벤트가 객체가 아닙니다.",
      },
      {
        blocks: [RAW_START, 'event: sdk_message\ndata: {"type":\n\n'],
        message: "외부 에이전트의 sdk_message 이벤트가 올바른 JSON이 아닙니다.",
      },
      {
        blocks: ["event: message_start\ndata: nope\n\n"],
        message: "외부 에이전트의 message_start 이벤트가 올바른 JSON이 아닙니다.",
      },
      {
        blocks: [rawFrame("message_start", 42)],
        message: "외부 에이전트 스트림에 이벤트 스키마가 없습니다.",
      },
    ];
    for (const { blocks, message } of cases) {
      await withRawGateway(
        (res) => {
          writeSse(res, ...blocks);
          res.end();
        },
        async (endpoint) => {
          await expect(
            runExternalAgent(
              { message: "계약 위반" },
              externalConfig(endpoint),
              {},
            ),
          ).rejects.toThrow(message);
        },
      );
    }
  });

  it("ignores SSE comments and unknown event names", async () => {
    await withRawGateway(
      (res) => {
        writeSse(
          res,
          ": stream primed\n\n",
          `: about to start\n${RAW_START}`,
          // A field-less line is neither `event` nor `data`: skip, don't fail.
          `retry\n${rawFrame("heartbeat", { note: "ignored" })}`,
          rawFrame("sdk_message", {
            type: "result",
            subtype: "success",
            result: "주석은 무시됩니다",
          }),
          rawFrame("message_stop", {}),
        );
        res.end();
      },
      async (endpoint) => {
        const statuses: string[] = [];
        const result = await runExternalAgent(
          { message: "주석" },
          externalConfig(endpoint),
          { onStatus: (label) => statuses.push(label) },
        );
        expect(result.text).toBe("주석은 무시됩니다");
        expect(statuses).toEqual([
          "외부 에이전트에 연결 중…",
          "응답 생성 중…",
        ]);
      },
    );
  });

  it("rejects an SSE frame larger than the stream limit", async () => {
    const limit = 2 * 1024 * 1024;
    // Terminated frame: the pending buffer stays legal until the closing chunk
    // arrives, so the guard has to reject the assembled block.
    await withRawGateway(
      async (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: sdk_message\ndata: "${"x".repeat(limit - 1_000)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        res.write(`${"x".repeat(2_000)}"\n\n`);
      },
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "거대 프레임" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow(
          "외부 에이전트 스트림 이벤트가 허용 크기를 초과했습니다.",
        );
      },
    );

    // Never-terminated frame: the same cap applies to the pending buffer, so a
    // gateway cannot stream unbounded bytes by withholding the boundary.
    await withRawGateway(
      (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: sdk_message\ndata: "${"x".repeat(limit + 4_096)}`);
      },
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "미완 프레임" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow(
          "외부 에이전트 스트림 이벤트가 허용 크기를 초과했습니다.",
        );
      },
    );
  });

  it("rejects a gateway response that is not a live SSE stream", async () => {
    await withRawGateway(
      (res) => {
        res.writeHead(500, { "content-type": "text/event-stream" });
        res.end("upstream stack trace");
      },
      async (endpoint) => {
        const error = await failedRun(
          { message: "실패 응답" },
          externalConfig(endpoint),
          {},
        );
        expect(error.message).toBe(
          "외부 에이전트 요청에 실패했습니다 (HTTP 500).",
        );
        // The upstream body may carry implementation detail: never relay it.
        expect(error.message).not.toContain("upstream stack trace");
      },
    );

    await withRawGateway(
      (res) => {
        res.writeHead(204, { "content-type": "text/event-stream" });
        res.end();
      },
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "빈 본문" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow("외부 에이전트가 빈 스트림을 반환했습니다.");
      },
    );

    await withRawGateway(
      (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      async (endpoint) => {
        await expect(
          runExternalAgent(
            { message: "JSON 응답" },
            externalConfig(endpoint),
            {},
          ),
        ).rejects.toThrow(
          "외부 에이전트가 SSE 스트림이 아닌 응답을 반환했습니다.",
        );
      },
    );
  });

  it("normalizes upstream error events into one Korean failure line", async () => {
    const cases = [
      {
        data: "gateway exploded",
        expected: "외부 에이전트 실행에 실패했습니다: gateway exploded",
      },
      {
        data: JSON.stringify("quota exceeded"),
        expected: "외부 에이전트 실행에 실패했습니다: quota exceeded",
      },
      {
        data: JSON.stringify({ error: "bad gateway key" }),
        expected: "외부 에이전트 실행에 실패했습니다: bad gateway key",
      },
      {
        data: JSON.stringify({ message: "upstream busy" }),
        expected: "외부 에이전트 실행에 실패했습니다: upstream busy",
      },
      {
        data: JSON.stringify({ error: { message: "nested detail" } }),
        expected: "외부 에이전트 실행에 실패했습니다: nested detail",
      },
      {
        data: JSON.stringify({ code: 500 }),
        expected: "외부 에이전트 실행에 실패했습니다.",
      },
      {
        data: JSON.stringify([1, 2]),
        expected: "외부 에이전트 실행에 실패했습니다.",
      },
      { data: "   ", expected: "외부 에이전트 실행에 실패했습니다." },
    ];
    for (const { data, expected } of cases) {
      await withRawGateway(
        (res) => {
          writeSse(res, RAW_START, `event: error\ndata: ${data}\n\n`);
          res.end();
        },
        async (endpoint) => {
          const error = await failedRun(
            { message: "오류 이벤트" },
            externalConfig(endpoint),
            {},
          );
          expect(error.message).toBe(expected);
        },
      );
    }
  });

  it("fails when a non-result SDK message carries is_error", async () => {
    const cases = [
      {
        payload: {
          type: "stream_event",
          is_error: true,
          message: "gateway refused the tool call",
        },
        expected:
          "외부 에이전트 실행에 실패했습니다: gateway refused the tool call",
      },
      {
        payload: { type: "assistant", is_error: true },
        expected: "외부 에이전트 실행에 실패했습니다.",
      },
    ];
    for (const { payload, expected } of cases) {
      await withGateway(
        () => [
          {
            event: "message_start",
            data: { schema: EXTERNAL_SDK_MESSAGE_SCHEMA },
          },
          { event: "sdk_message", data: payload },
          { event: "message_stop", data: {} },
        ],
        async (endpoint) => {
          const error = await failedRun(
            { message: "도구 거부" },
            externalConfig(endpoint),
            {},
          );
          expect(error.message).toBe(expected);
        },
      );
    }
  });

  it("never contacts the gateway when the run is already cancelled", async () => {
    await withGateway(
      () => successfulFrames("실행되지 않아야 함"),
      async (endpoint, captured) => {
        const controller = new AbortController();
        controller.abort();
        const statuses: string[] = [];
        await expect(
          runExternalAgent(
            { message: "이미 취소됨" },
            externalConfig(endpoint),
            { onStatus: (label) => statuses.push(label) },
            controller,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(captured).toHaveLength(0);
        expect(statuses).toEqual(["외부 에이전트에 연결 중…"]);
      },
    );
  });
});

describe("external gateway connection probe", () => {
  it("refuses to probe an endpoint that is not the agent route", async () => {
    await expect(
      probeExternalAgentGateway({
        ...externalConfig("https://gateway.example/v1/agents/messages"),
        endpoint: "https://gateway.example/v2/chat",
      }),
    ).rejects.toThrow(
      "외부 에이전트 endpoint가 /v1/agents/messages 형식이 아닙니다.",
    );
  });

  it("rejects unusable model-catalog responses", async () => {
    const cases: {
      respond: (res: http.ServerResponse) => void;
      message: string;
    }[] = [
      {
        respond: (res) => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end("{}");
        },
        message: "Gateway 연결 확인에 실패했습니다 (HTTP 503).",
      },
      {
        respond: (res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        },
        message: "Gateway가 JSON 모델 목록을 반환하지 않았습니다.",
      },
      {
        respond: (res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not json");
        },
        message: "Gateway 모델 목록이 올바른 JSON이 아닙니다.",
      },
      {
        respond: (res) => {
          // A bodyless success is still not a catalog.
          res.writeHead(204, { "content-type": "application/json" });
          res.end();
        },
        message: "Gateway 모델 목록이 올바른 JSON이 아닙니다.",
      },
      {
        respond: (res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { id: "sonnet" } }));
        },
        message: "Gateway 모델 목록 형식이 올바르지 않습니다.",
      },
      {
        respond: (res) => {
          // Declares a huge body: the cap must apply before a byte is read.
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": "99999999",
          });
          res.write("{");
        },
        message: "Gateway 모델 응답이 허용 크기를 초과했습니다.",
      },
      {
        respond: (res) => {
          // Chunked, so only the streamed byte count can stop it.
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"data":[{"id":"');
          res.write("m".repeat(1024 * 1024 + 4_096));
          res.end('"}]}');
        },
        message: "Gateway 모델 응답이 허용 크기를 초과했습니다.",
      },
    ];
    for (const { respond, message } of cases) {
      await withRawGateway(respond, async (endpoint) => {
        await expect(
          probeExternalAgentGateway(externalConfig(endpoint)),
        ).rejects.toThrow(message);
      });
    }
  });

  it("reports the Claude catalog when no model preference is configured", async () => {
    let authorization: string | undefined = "unset";
    await withRawGateway(
      (res, req) => {
        authorization = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "claude-a", backend: "claude" },
              { id: "claude-a", backend: "claude" },
              { id: "gpt-9", backend: "openai" },
              { id: "claude-b", backend: "claude" },
              { backend: "claude" },
            ],
          }),
        );
      },
      async (endpoint) => {
        const result = await probeExternalAgentGateway({
          ...externalConfig(endpoint),
          model: undefined,
          apiKey: undefined,
        });
        expect(result).toMatchObject({
          ok: true,
          modelsCount: 3,
          // No configured model means "nothing to check", not "unavailable".
          modelAvailable: null,
          models: ["claude-a", "claude-b"],
        });
      },
    );
    // An entry without a stored key must not send a bearer header at all.
    expect(authorization).toBeUndefined();
  });

  it("aborts a probe the gateway never answers", async () => {
    await withRawGateway(
      () => {
        // Accept the request and intentionally never respond.
      },
      async (endpoint) => {
        await expect(
          probeExternalAgentGateway(externalConfig(endpoint), 40),
        ).rejects.toThrow("Gateway 연결 확인 시간이 초과되었습니다.");
      },
    );
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
        // Group binding is mandatory now: bind the agent to a group the viewer
        // is in (config objects are read live, so mutating the entry works).
        const group = services.store.createGroup({ name: "ext-viewers" });
        services.store.addGroupMember(group.id, viewerId);
        external.visibleToGroupIds = [group.id];
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

  it("lists gateway models to viewers and applies a per-conversation model override", async () => {
    await withGateway(
      () => successfulFrames("모델 응답"),
      async (endpoint, captured, gateway) => {
        const external = externalConfig(endpoint);
        const services = createServices({
          dataDir: tempDir(),
          agentRuntime: "local",
          sessionSecret: "test",
          externalAgents: [external],
        });
        const app = createApp(services);
        const viewer = request.agent(app);
        const viewerId = (
          await signup(viewer, "external-model-viewer").expect(201)
        ).body.user.id as string;
        const group = services.store.createGroup({ name: "ext-model-viewers" });
        services.store.addGroupMember(group.id, viewerId);
        external.visibleToGroupIds = [group.id];
        const avatarId = "external:research";
        const conversationId = "external-model-conversation";

        // Catalog: gateway-advertised Claude ids only, plus the admin default.
        const models = await viewer
          .get(`/api/avatars/${encodeURIComponent(avatarId)}/models`)
          .expect(200);
        expect(models.body).toEqual({
          models: ["gateway-model", "claude-frontier-9"],
          defaultModel: "gateway-model",
        });
        // A second hit is served from the per-agent cache, not another probe.
        await viewer
          .get(`/api/avatars/${encodeURIComponent(avatarId)}/models`)
          .expect(200);
        expect(gateway.modelsHits).toBe(1);

        // Native avatars answer with an empty catalog (their picker uses the
        // bootstrap model tiers); unknown avatars stay 404.
        const nativeModels = await viewer
          .get(`/api/avatars/${encodeURIComponent(viewerId)}/models`)
          .expect(200);
        expect(nativeModels.body).toEqual({ models: [], defaultModel: null });
        await viewer.get("/api/avatars/missing-avatar/models").expect(404);

        // Turn 1: an explicit pick rides the gateway request and persists.
        await viewer
          .post("/api/chat/stream")
          .send({
            avatarId,
            conversationId,
            message: "질문 1",
            model: "claude-frontier-9",
          })
          .expect(200);
        expect(captured[0].body.model).toBe("claude-frontier-9");
        expect(
          services.store.getConversationModel(viewerId, conversationId),
        ).toBe("claude-frontier-9");
        const detail = await viewer
          .get(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`)
          .expect(200);
        expect(detail.body.selectedModel).toBe("claude-frontier-9");

        // Turn 2: nothing sent → the stored override still applies.
        await viewer
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "질문 2" })
          .expect(200);
        expect(captured[1].body.model).toBe("claude-frontier-9");

        // Turn 3: "" clears back to the admin-configured default model.
        await viewer
          .post("/api/chat/stream")
          .send({ avatarId, conversationId, message: "질문 3", model: "" })
          .expect(200);
        expect(captured[2].body.model).toBe("gateway-model");
        expect(
          services.store.getConversationModel(viewerId, conversationId),
        ).toBeNull();

        // Turn 4: an unusable id clears too (mirrors the native unknown-tier rule).
        await viewer
          .post("/api/chat/stream")
          .send({
            avatarId,
            conversationId,
            message: "질문 4",
            model: "제멋대로 모델 !!",
          })
          .expect(200);
        expect(captured[3].body.model).toBe("gateway-model");
      },
    );
  });

  it("stores an admin-set profile image and serves it on the public avatar route", async () => {
    await withGateway(
      () => successfulFrames("무관"),
      async (endpoint) => {
        const external = externalConfig(endpoint);
        const services = createServices({
          dataDir: tempDir(),
          agentRuntime: "local",
          sessionSecret: "test",
          externalAgents: [external],
        });
        const app = createApp(services);
        const admin = request.agent(app);
        const viewer = request.agent(app);
        await signup(admin, "image-admin").expect(201); // first user = admin
        const viewerId = (await signup(viewer, "image-viewer").expect(201))
          .body.user.id as string;
        const group = services.store.createGroup({ name: "ext-image-viewers" });
        services.store.addGroupMember(group.id, viewerId);
        external.visibleToGroupIds = [group.id];
        const avatarId = "external:research";
        const png =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

        // Only admins may set it; the payload is validated like profile photos.
        await viewer
          .put("/api/admin/external-agents/research/image")
          .send({ image: png })
          .expect(403);
        await admin
          .put("/api/admin/external-agents/missing/image")
          .send({ image: png })
          .expect(404);
        await admin
          .put("/api/admin/external-agents/research/image")
          .send({ image: "data:text/plain;base64,aGk=" })
          .expect(400);
        const put = await admin
          .put("/api/admin/external-agents/research/image")
          .send({ image: png })
          .expect(200);
        expect(put.body).toEqual({ ok: true, hasImage: true });

        // The stored image surfaces on the admin DTO, viewer list/detail, and
        // the public avatar-image route (env-defined agents included).
        const adminList = await admin
          .get("/api/admin/external-agents")
          .expect(200);
        expect(
          adminList.body.agents.find(
            (agent: { id: string }) => agent.id === "research",
          ),
        ).toMatchObject({ source: "environment", hasImage: true });
        const list = await viewer.get("/api/avatars").expect(200);
        expect(
          list.body.avatars.find(
            (avatar: { id: string }) => avatar.id === avatarId,
          ),
        ).toMatchObject({ hasImage: true });
        await viewer
          .get(`/api/avatars/${encodeURIComponent(avatarId)}`)
          .expect(200)
          .expect((res) => {
            expect(res.body.avatar.hasImage).toBe(true);
          });
        const image = await viewer
          .get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`)
          .expect(200);
        expect(image.headers["content-type"]).toContain("image/png");

        // Removal clears the flag and the served file.
        const removed = await admin
          .delete("/api/admin/external-agents/research/image")
          .expect(200);
        expect(removed.body).toEqual({ ok: true, hasImage: false });
        await viewer
          .get(`/api/users/${encodeURIComponent(avatarId)}/avatar-image`)
          .expect(404);
        const cleared = await viewer.get("/api/avatars").expect(200);
        expect(
          cleared.body.avatars.find(
            (avatar: { id: string }) => avatar.id === avatarId,
          ),
        ).toMatchObject({ hasImage: false });

        // Deleting a managed agent cascades its image row + file away.
        // (Managed writes require a group binding now.)
        await admin
          .post("/api/admin/external-agents")
          .send({
            agent: {
              id: "managed-image",
              displayName: "Managed Image Agent",
              endpoint,
              agent: "claude",
              enabled: true,
              apiKeyMode: "clear",
              visibleToGroupIds: [group.id],
            },
          })
          .expect(201);
        await admin
          .put("/api/admin/external-agents/managed-image/image")
          .send({ image: png })
          .expect(200);
        await admin
          .get(`/api/users/${encodeURIComponent("external:managed-image")}/avatar-image`)
          .expect(200);
        await admin
          .delete("/api/admin/external-agents/managed-image")
          .expect(200);
        await admin
          .get(`/api/users/${encodeURIComponent("external:managed-image")}/avatar-image`)
          .expect(404);
        expect(
          services.store.getExternalAvatarImageExt("external:managed-image"),
        ).toBeNull();
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
          .get(`/api/avatars/${encodeURIComponent(avatarId)}/models`)
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
