import http from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import {
  externalAvatarId,
  parseExternalAgents,
} from "../src/server/externalAgents.js";
import type {
  AdminExternalAgentInput,
  ExternalAgentConfig,
} from "../src/server/types.js";
import { signup, withTempDir } from "./helpers.js";

const tempDir = withTempDir("external-agent-admin");

function input(
  endpoint: string,
  overrides: Partial<AdminExternalAgentInput> = {},
): AdminExternalAgentInput {
  return {
    id: "research",
    displayName: "Research Agent",
    alias: "리서처",
    bio: "외부 조사 아바타",
    persona: "공개 페르소나",
    intro: "무엇을 조사할까요?",
    hashtags: ["research"],
    endpoint,
    agent: "claude",
    enabled: true,
    model: "sonnet",
    system: "private-system-marker",
    apiKeyMode: "set",
    apiKey: "private-api-key-marker",
    ...overrides,
  };
}

function envAgent(endpoint: string): ExternalAgentConfig {
  return {
    id: "environment-agent",
    displayName: "Environment Agent",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    endpoint,
    agent: "claude",
    enabled: true,
    apiKey: "environment-secret",
  };
}

describe("external agent endpoint normalization", () => {
  it("canonicalizes base paths without doubling the endpoint suffix", () => {
    const [fromRoot, fromPath, alreadyExact] = parseExternalAgents(
      JSON.stringify([
        { id: "root", displayName: "Root", baseUrl: "https://gateway.example/" },
        { id: "path", displayName: "Path", baseUrl: "https://gateway.example/internal/" },
        {
          id: "exact-base",
          displayName: "Exact base",
          baseUrl: "https://gateway.example/internal/v1/agents/messages/",
        },
      ]),
    );
    expect(fromRoot.endpoint).toBe("https://gateway.example/v1/agents/messages");
    expect(fromPath.endpoint).toBe(
      "https://gateway.example/internal/v1/agents/messages",
    );
    expect(alreadyExact.endpoint).toBe(
      "https://gateway.example/internal/v1/agents/messages",
    );
  });

  it("rejects ambiguous or unsafe URL forms", () => {
    const base = { id: "bad", displayName: "Bad" };
    expect(() =>
      parseExternalAgents(
        JSON.stringify([
          {
            ...base,
            endpoint: "https://gateway.example/v1/agents/messages",
            baseUrl: "https://gateway.example",
          },
        ]),
      ),
    ).toThrow("not both");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([{ ...base, baseUrl: "https://gateway.example?q=1" }]),
      ),
    ).toThrow("query string");
    expect(() =>
      parseExternalAgents(
        JSON.stringify([
          {
            ...base,
            endpoint: "https://gateway.example/v1/agents/messages#secret",
          },
        ]),
      ),
    ).toThrow("fragment");
  });
});

describe("external agent admin API", () => {
  it("stores managed settings encrypted, applies them live, and persists them", async () => {
    const dataDir = tempDir();
    const services = createServices({
      dataDir,
      agentRuntime: "local",
      sessionSecret: "external-admin-secret",
      externalAgents: [],
    });
    const app = createApp(services);
    const admin = request.agent(app);
    const outsider = request.agent(app);
    const adminId = (await signup(admin, "external-config-admin").expect(201))
      .body.user.id as string;
    await signup(outsider, "external-config-outsider").expect(201);
    const group = services.store.createGroup({
      name: "Research Team",
      createdBy: adminId,
    });
    services.store.addGroupMember(group.id, adminId, "admin");

    const created = await admin
      .post("/api/admin/external-agents")
      .send({
        agent: input("https://gateway.example/v1/agents/messages", {
          visibleToGroupIds: [group.id],
        }),
      })
      .expect(201);
    expect(created.body.agent).toMatchObject({
      id: "research",
      source: "managed",
      apiKeySet: true,
      visibleToGroupIds: [group.id],
    });
    expect(JSON.stringify(created.body)).not.toContain("private-api-key-marker");

    const listed = await admin.get("/api/admin/external-agents").expect(200);
    expect(listed.body.agents[0]).toMatchObject({
      id: "research",
      system: "private-system-marker",
      apiKeySet: true,
      source: "managed",
    });
    expect(JSON.stringify(listed.body)).not.toContain("private-api-key-marker");

    const appConfigRow = (
      services.store as unknown as {
        db: { prepare: (sql: string) => { get: (key: string) => { value_enc: string } } };
      }
    ).db
      .prepare("SELECT value_enc FROM app_config WHERE key = ?")
      .get("external_agents_registry_v1");
    expect(appConfigRow.value_enc).not.toContain("private-api-key-marker");
    expect(appConfigRow.value_enc).not.toContain("private-system-marker");

    const adminAvatars = await admin.get("/api/avatars").expect(200);
    expect(
      adminAvatars.body.avatars.some(
        (avatar: { id: string }) => avatar.id === "external:research",
      ),
    ).toBe(true);
    const outsiderAvatars = await outsider.get("/api/avatars").expect(200);
    expect(
      outsiderAvatars.body.avatars.some(
        (avatar: { id: string }) => avatar.id === "external:research",
      ),
    ).toBe(false);

    const stored = services.store.getManagedExternalAgents()[0];
    expect(stored.apiKey).toBe("private-api-key-marker");
    services.store.close();

    const restarted = createServices({
      dataDir,
      agentRuntime: "local",
      sessionSecret: "external-admin-secret",
      externalAgents: [],
    });
    expect(restarted.store.getManagedExternalAgents()[0]).toMatchObject({
      id: "research",
      endpoint: "https://gateway.example/v1/agents/messages",
      apiKey: "private-api-key-marker",
      visibleToGroupIds: [group.id],
    });
    restarted.store.close();
  });

  it("enforces admin auth, env read-only precedence, group validation, and secret modes", async () => {
    const services = createServices({
      dataDir: tempDir(),
      agentRuntime: "local",
      sessionSecret: "test",
      externalAgents: [
        envAgent("https://env-gateway.example/v1/agents/messages"),
      ],
    });
    const app = createApp(services);
    const admin = request.agent(app);
    const member = request.agent(app);
    await signup(admin, "external-policy-admin").expect(201);
    await signup(member, "external-policy-member").expect(201);

    await member.get("/api/admin/external-agents").expect(403);
    const envList = await admin.get("/api/admin/external-agents").expect(200);
    expect(envList.body.agents[0]).toMatchObject({
      id: "environment-agent",
      source: "environment",
      apiKeySet: true,
    });
    expect(JSON.stringify(envList.body)).not.toContain("environment-secret");
    await admin
      .put("/api/admin/external-agents/environment-agent")
      .send({ agent: input("https://new.example/v1/agents/messages") })
      .expect(409);
    await admin
      .delete("/api/admin/external-agents/environment-agent")
      .expect(409);
    await admin
      .post("/api/admin/external-agents")
      .send({
        agent: input("https://new.example/v1/agents/messages", {
          id: "environment-agent",
        }),
      })
      .expect(409);
    await admin
      .post("/api/admin/external-agents")
      .send({
        agent: input("https://new.example/v1/agents/messages", {
          visibleToGroupIds: ["missing-group"],
        }),
      })
      .expect(400);

    await admin
      .post("/api/admin/external-agents")
      .send({ agent: input("https://new.example/v1/agents/messages") })
      .expect(201);
    await admin
      .put("/api/admin/external-agents/research")
      .send({
        agent: input("https://new.example/v1/agents/messages", {
          apiKeyMode: "keep",
          apiKey: undefined,
          system: "updated system",
        }),
      })
      .expect(200);
    expect(services.store.getManagedExternalAgents()[0].apiKey).toBe(
      "private-api-key-marker",
    );
    await admin
      .put("/api/admin/external-agents/research")
      .send({
        agent: input("https://new.example/v1/agents/messages", {
          apiKeyMode: "clear",
          apiKey: undefined,
        }),
      })
      .expect(200);
    expect(services.store.getManagedExternalAgents()[0].apiKey).toBeUndefined();
  });

  it("requires disabling instead of deleting an id that owns conversation history", async () => {
    const services = createServices({
      dataDir: tempDir(),
      agentRuntime: "local",
      sessionSecret: "test",
      externalAgents: [],
    });
    const app = createApp(services);
    const admin = request.agent(app);
    const adminId = (await signup(admin, "external-history-admin").expect(201))
      .body.user.id as string;
    await admin
      .post("/api/admin/external-agents")
      .send({ agent: input("https://gateway.example/v1/agents/messages") })
      .expect(201);
    services.store.touchConversation(
      adminId,
      "external-history",
      externalAvatarId({ id: "research" }),
      "기존 질문",
    );
    await admin.delete("/api/admin/external-agents/research").expect(409);
    await admin
      .put("/api/admin/external-agents/research")
      .send({
        agent: input("https://gateway.example/v1/agents/messages", {
          enabled: false,
          apiKeyMode: "keep",
          apiKey: undefined,
        }),
      })
      .expect(200);
    const list = await admin.get("/api/avatars").expect(200);
    expect(
      list.body.avatars.some(
        (avatar: { id: string }) => avatar.id === "external:research",
      ),
    ).toBe(false);
  });

  it("checks gateway auth and models without executing an agent turn", async () => {
    const captured: { method?: string; url?: string; authorization?: string } = {};
    const gateway = http.createServer((req, res) => {
      captured.method = req.method;
      captured.url = req.url;
      captured.authorization = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "sonnet", backend: "claude" },
            { id: "codex/gpt-5", backend: "codex" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const services = createServices({
        dataDir: tempDir(),
        agentRuntime: "local",
        sessionSecret: "test",
        externalAgents: [],
      });
      const app = createApp(services);
      const admin = request.agent(app);
      await signup(admin, "external-probe-admin").expect(201);
      const result = await admin
        .post("/api/admin/external-agents/test")
        .send({
          agent: input(
            `http://127.0.0.1:${port}/v1/agents/messages`,
            { apiKey: "Bearer probe-secret" },
          ),
        })
        .expect(200);
      expect(result.body).toMatchObject({
        ok: true,
        modelsCount: 1,
        modelAvailable: true,
      });
      expect(captured).toEqual({
        method: "GET",
        url: "/v1/models",
        authorization: "Bearer probe-secret",
      });
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});
