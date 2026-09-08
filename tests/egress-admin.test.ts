import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { normalizeEgressDomains } from "../src/shared/egressDomains.js";
import { signup, withTempDir } from "./helpers.js";

const tempDir = withTempDir("egress-admin");
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function boot(url?: string) {
  const services = createServices({ dataDir: tempDir(), agentRuntime: "local", sessionSecret: "test", egressControlUrl: url });
  cleanup.push(() => services.store.close());
  const app = createApp(services);
  const admin = request.agent(app);
  const user = (await signup(admin, "admin").expect(201)).body.user;
  return { services, app, admin, user };
}

describe("egress policy administration", () => {
  it("normalizes domains and removes Squid-incompatible overlapping suffixes", () => {
    expect(normalizeEgressDomains(["*.Example.COM.", "api.example.com", "example.com", ".sub.example.com", "other.test"]))
      .toEqual([".example.com", "other.test"]);
    expect(normalizeEgressDomains([])).toEqual([]);
  });

  it.each(["https://example.com", "example.com/path", "a\nb.test", "127.0.0.1", "2130706433", "[::1]", "0x7f000001", "-bad.com", ".", "*.bad*.com"])("rejects unsafe ACL input %s", (domain) => {
    expect(() => normalizeEgressDomains([domain])).toThrow();
  });

  it("requires live admin authorization on read, write and controller callback", async () => {
    const { app, admin, user } = await boot();
    const member = request.agent(app);
    await signup(member, "member").expect(201);
    for (const path of ["/api/admin/egress", "/api/admin/egress/authorize"]) {
      await request(app).get(path).expect(401);
      await member.get(path).expect(403);
    }
    await member.put("/api/admin/egress").send({ domains: [] }).expect(403);
    await request(app).put("/api/admin/egress").send({ domains: [] }).expect(401);
    const callback = await admin.get("/api/admin/egress/authorize").expect(200);
    expect(callback.body).toEqual({ actorId: user.id });
    expect(callback.headers["cache-control"]).toBe("no-store");
    const absent = await admin.get("/api/admin/egress").expect(200);
    expect(absent.body.configured).toBe(false);
    await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1").send({ domains: [] }).expect(503);
    await admin.post("/api/auth/logout").expect(200);
    await admin.get("/api/admin/egress/authorize").expect(401);
  });

  it("forwards only the admin session, validates inputs, handles conflicts and audits success", async () => {
    const calls: { cookie: string | undefined; body: any; method: string | undefined }[] = [];
    let revision = "a".repeat(32);
    const controller = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ cookie: req.headers.cookie, body, method: req.method });
      res.setHeader("Content-Type", "application/json");
      if (body && body.revision !== revision) {
        res.writeHead(409).end(JSON.stringify({ error: "최신 목록을 불러오세요." }));
      } else {
        if (body) revision = "b".repeat(32);
        res.end(JSON.stringify({ domains: body?.domains ?? [], revision, proxyReady: true, appliedAt: null, appliedBy: null }));
      }
    });
    await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => controller.close(() => resolve())));
    const { admin, services, user } = await boot(`http://127.0.0.1:${(controller.address() as import("node:net").AddressInfo).port}`);
    await admin.get("/api/admin/egress").expect(200);
    expect(calls[0].cookie).toMatch(/^ac_session=[^;]+$/);
    const before = calls.length;
    await admin.put("/api/admin/egress").send({ domains: [] }).expect(400);
    await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1")
      .send({ domains: ["foo\nhttp_access allow all"], revision }).expect(400);
    expect(calls).toHaveLength(before);
    const applied = await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1")
      .send({ domains: ["*.EXAMPLE.com", "a.example.com"], revision, actorId: "forged" }).expect(200);
    expect(applied.body.domains).toEqual([".example.com"]);
    expect(calls.at(-1)?.body).toEqual({ domains: [".example.com"], revision: "a".repeat(32) });
    expect(services.store.listAudit(user.id, true).some((row) => row.action === "set_egress_policy")).toBe(true);
    await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1")
      .send({ domains: [], revision: "a".repeat(32) }).expect(409);
  });

  it("does not report a successful apply when the controller is unreachable", async () => {
    const broken = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => broken.close(() => resolve())));
    const { admin, services, user } = await boot(`http://127.0.0.1:${(broken.address() as import("node:net").AddressInfo).port}`);
    await admin.get("/api/admin/egress").expect(503);
    const result = await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1")
      .send({ domains: [], revision: "a".repeat(32) }).expect(503);
    expect(result.body.error).toContain("적용 결과를 확인하지 못했습니다");
    expect(services.store.listAudit(user.id, true).some((row) => row.action === "set_egress_policy")).toBe(false);
    expect(services.store.listAudit(user.id, true).find((row) => row.action === "egress_policy_failed")?.status).toBe("error");
  });

  it("turns a controller-side session check failure into 502 instead of a logout-triggering 401", async () => {
    const rejecting = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "유효한 관리자 세션이 필요합니다." })));
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => rejecting.close(() => resolve())));
    const { admin, services, user } = await boot(`http://127.0.0.1:${(rejecting.address() as import("node:net").AddressInfo).port}`);
    const read = await admin.get("/api/admin/egress").expect(502);
    expect(read.body.error).toContain("NOAH_EGRESS_AUTH_URL");
    const write = await admin.put("/api/admin/egress").set("X-Noah-Egress-Admin", "1")
      .send({ domains: [], revision: "a".repeat(32) }).expect(502);
    expect(write.body.error).toContain("NOAH_EGRESS_AUTH_URL");
    expect(services.store.listAudit(user.id, true).some((row) => row.action === "set_egress_policy")).toBe(false);
    expect(services.store.listAudit(user.id, true).find((row) => row.action === "egress_policy_failed")?.detail).toContain("status=401");
    // The admin's own session is still valid: nothing about the controller failure logged them out.
    await admin.get("/api/admin/egress/authorize").expect(200);
  });
});
