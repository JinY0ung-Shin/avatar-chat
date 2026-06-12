import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest, AgentResponse } from "../src/server/types.js";

const capturedRequests = vi.hoisted(() => [] as AgentRequest[]);

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(async (agentRequest: AgentRequest, _pluginRoots, config, _store, events) => {
    capturedRequests.push(agentRequest);
    events.onSessionId?.(`mock-session-${capturedRequests.length}`);
    events.onDelta?.(`[mock] ${agentRequest.message}`);
    return {
      kind: "text",
      runtime: config.agentRuntime,
      summary: "mock",
      text: `[mock] ${agentRequest.message}`,
    } satisfies AgentResponse;
  }),
}));

import { createApp, createServices } from "../src/server/app.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-history-"));
  capturedRequests.length = 0;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function signup(agent: ReturnType<typeof request.agent>, username: string, password = "password123") {
  return agent.post("/api/auth/signup").send({ username, displayName: username, password });
}

describe("chat history fallback", () => {
  it("passes stored messages when no SDK session exists after a stopped first turn", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "owner").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-stopped-first";

    services.store.touchConversation(ownerId, conversationId, ownerId, "첫 요청: 일정 정리");
    services.store.addMessage(conversationId, { role: "user", content: "첫 요청: 일정 정리" });
    services.store.addMessage(conversationId, {
      role: "assistant",
      content: "(중지됨)",
      response: { kind: "text", runtime: "claude", summary: "중지됨", text: "" },
    });

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId, message: "계속해" })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].resumeSessionId).toBeUndefined();
    expect(capturedRequests[0].conversationHistory).toEqual([
      { role: "user", content: "첫 요청: 일정 정리" },
    ]);
  });

  it("uses SDK resume instead of replaying stored messages when a session exists", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "claude",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "resumer").expect(201);
    const ownerId = ownerRes.body.user.id as string;
    const conversationId = "conv-has-session";

    services.store.touchConversation(ownerId, conversationId, ownerId, "첫 요청");
    services.store.addMessage(conversationId, { role: "user", content: "첫 요청" });
    services.store.setAgentSessionId(conversationId, "sess-existing");

    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId, message: "이어서" })
      .expect(200);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].resumeSessionId).toBe("sess-existing");
    expect(capturedRequests[0].conversationHistory).toEqual([]);
  });
});
