import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { stageClipboardImage, readStagedImage } from "../src/server/browserClipboard.js";
import { signup, withTempDir } from "./helpers.js";

// Coverage target: src/server/browserClipboard.ts — the short-lived byte store
// behind copy_image (agent → OS clipboard) and the auth-gated staging routes the
// browser bridge drives. The clipboard WRITE itself is a browser fact proven by
// the Playwright spike, not something a server test can exercise.

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC",
  "base64",
);

let tempDir: string;
const getTempDir = withTempDir("browser-clipboard", () => {
  tempDir = getTempDir();
});

function testApp() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  return createApp(services);
}

describe("clipboard staging store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips bytes + mime and mints the contract path", () => {
    const { token, path } = stageClipboardImage(PNG_BYTES, "image/png");
    expect(path).toBe("/browser-clip/" + token); // CONTRACT: copy_image builds appOrigin + path
    const got = readStagedImage(token);
    expect(got?.mime).toBe("image/png");
    expect(got?.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("returns null for an unknown token", () => {
    expect(readStagedImage("deadbeef")).toBeNull();
  });

  it("evicts the oldest entries when the store is flooded", () => {
    const first = stageClipboardImage(PNG_BYTES, "image/png").token;
    let last = first;
    for (let i = 0; i < 60; i += 1) {
      last = stageClipboardImage(PNG_BYTES, "image/png").token;
    }
    // The cap is well under 60, so the earliest token must have been dropped
    // while the most recent survives.
    expect(readStagedImage(first)).toBeNull();
    expect(readStagedImage(last)).not.toBeNull();
  });

  it("drops an entry once its TTL passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token } = stageClipboardImage(PNG_BYTES, "image/png");
    expect(readStagedImage(token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z")); // +5 min, past the ~2 min TTL
    expect(readStagedImage(token)).toBeNull();
  });
});

describe("clipboard staging routes", () => {
  it("requires authentication for the page and the bytes", async () => {
    const app = testApp();
    const { token } = stageClipboardImage(PNG_BYTES, "image/png");
    await request(app).get(`/browser-clip/${token}`).expect(401);
    await request(app).get(`/browser-clip/${token}/img`).expect(401);
  });

  it("serves the staging page, the bytes, and the script to an authed viewer", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "clip-user").expect(201);
    const { token } = stageClipboardImage(PNG_BYTES, "image/png");

    const page = await agent.get(`/browser-clip/${token}`).expect(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("클립보드로 복사"); // the button label copy_image tells the agent to click
    expect(page.text).toContain("/browser-clip.js"); // external script (CSP forbids inline)

    const img = await agent.get(`/browser-clip/${token}/img`).expect(200);
    expect(img.headers["content-type"]).toContain("image/png");
    expect(img.headers["cache-control"]).toBe("no-store");

    const script = await agent.get(`/browser-clip.js`).expect(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.text).toContain("navigator.clipboard");
    expect(script.text).toContain("ClipboardItem");
  });

  it("404s an unknown or expired token for an authed viewer", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "clip-user-2").expect(201);
    await agent.get("/browser-clip/deadbeef/img").expect(404);
    await agent.get("/browser-clip/deadbeef").expect(404);
  });
});
