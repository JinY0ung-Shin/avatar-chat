import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";

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
    ownerSetupCode: "owner-code",
    sessionSecret: "test-secret",
    marketplaceSource: path.join(process.cwd(), "sample-marketplace"),
    agentRuntime: "local",
  });
  return createApp(services);
}

describe("avatar-chat app", () => {
  it("bootstraps owner, creates colleague invite, and serves read-only skill tables", async () => {
    const app = testApp();
    const owner = request.agent(app);

    const ownerLogin = await owner
      .post("/api/session")
      .send({ name: "Owner", code: "owner-code" })
      .expect(200);
    expect(ownerLogin.body.user.role).toBe("owner");

    const inviteResult = await owner
      .post("/api/invites")
      .send({ label: "Team", role: "colleague", projectScope: "alpha", maxUses: 2 })
      .expect(200);
    expect(inviteResult.body.invite.code).toBeTruthy();

    const teammate = request.agent(app);
    const teammateLogin = await teammate
      .post("/api/session")
      .send({ name: "Teammate", code: inviteResult.body.invite.code })
      .expect(200);
    expect(teammateLogin.body.user.role).toBe("colleague");
    expect(teammateLogin.body.user.projectScope).toBe("alpha");

    const colleagueSkills = await teammate.get("/api/skills").expect(200);
    const visibleCommands = colleagueSkills.body.plugins.flatMap(
      (plugin: { commands: { name: string }[] }) =>
        plugin.commands.map((command) => command.name),
    );
    expect(visibleCommands).toContain("service-status");
    expect(visibleCommands).toContain("vm-inventory");
    expect(visibleCommands).not.toContain("owner-work-summary");

    const chat = await teammate
      .post("/api/chat")
      .send({ mode: "colleague", message: "지금 서비스들 정상 작동하고 있는지 확인해줘" })
      .expect(200);
    expect(chat.body.response.kind).toBe("table");
    expect(chat.body.response.runtime).toBe("local");
    expect(chat.body.response.skillName).toBe("service-status");
    expect(chat.body.response.table.rows[0].project).toBe("alpha");
  });

  it("blocks mutating colleague requests and prevents colleague owner mode", async () => {
    const app = testApp();
    const owner = request.agent(app);
    await owner.post("/api/session").send({ name: "Owner", code: "owner-code" }).expect(200);
    const inviteResult = await owner
      .post("/api/invites")
      .send({ label: "Team", role: "colleague", projectScope: "alpha", maxUses: 1 })
      .expect(200);

    const teammate = request.agent(app);
    await teammate
      .post("/api/session")
      .send({ name: "Teammate", code: inviteResult.body.invite.code })
      .expect(200);

    const blocked = await teammate
      .post("/api/chat")
      .send({ mode: "colleague", message: "api 서버 재배포 해줘" })
      .expect(200);
    expect(blocked.body.response.runtime).toBe("blocked");

    await teammate
      .post("/api/chat")
      .send({ mode: "owner", message: "업무 정리해줘" })
      .expect(403);
  });

  it("lets owner mode invoke owner-only marketplace commands", async () => {
    const app = testApp();
    const owner = request.agent(app);
    await owner.post("/api/session").send({ name: "Owner", code: "owner-code" }).expect(200);

    const response = await owner
      .post("/api/chat")
      .send({ mode: "owner", message: "오늘 업무 지시를 요약해서 보고해줘" })
      .expect(200);

    expect(response.body.response.runtime).toBe("local");
    expect(response.body.response.skillName).toBe("owner-work-summary");
    expect(response.body.response.text).toContain("오늘 업무 지시");
  });
});
