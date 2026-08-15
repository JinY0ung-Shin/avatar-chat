import http from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MAX_STT_AUDIO_BYTES, decodeSttAudio } from "../src/server/stt.js";
import { signup, withTempDir } from "./helpers.js";

// Coverage target: src/server/stt.ts + src/server/routes/stt.ts — the composer
// mic's transcription endpoint. The upstream OpenAI-compatible service is a
// throwaway local http server so the multipart the route actually sends (and its
// failure modes) are asserted for real rather than mocked at the fetch boundary.

let tempDir: string;
const getTempDir = withTempDir("stt", () => {
  tempDir = getTempDir();
});

/** `sttUrl` is always passed explicitly so an ambient STT_URL can't leak in. */
function testServices(overrides: { sttUrl?: string; sttModel?: string }) {
  return createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
    sttModel: "Qwen/Qwen3-ASR-1.7B",
    ...overrides,
  });
}

function testApp(overrides: { sttUrl?: string; sttModel?: string }) {
  return createApp(testServices(overrides));
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  await signup(agent, username).expect(201);
  return agent;
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Container magic bytes, padded to clear the sniffer's length checks. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(12)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(20),
]);

interface SttCapture {
  url: string;
  contentType: string;
  body: string;
}

function portOf(server: http.Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

/**
 * Run `fn` against a local stand-in for the STT service, collecting every
 * request it received. `baseUrl` already carries the `/v1` segment the env var
 * is documented to include.
 */
async function withSttServer(
  respond: (res: http.ServerResponse) => void,
  fn: (baseUrl: string, captured: SttCapture[]) => Promise<void>,
): Promise<void> {
  const captured: SttCapture[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        // latin1 keeps the binary part intact while the multipart headers stay readable.
        body: Buffer.concat(chunks).toString("latin1"),
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${portOf(server)}/v1`, captured);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function respondJson(status: number, body: unknown) {
  return (res: http.ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

/** A port nothing listens on, for the connection-refused path. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("decodeSttAudio", () => {
  it("accepts each recorded container, keying the extension off the sniffed bytes", () => {
    expect(decodeSttAudio(dataUrl("audio/webm", WEBM))).toMatchObject({
      audio: { mediaType: "audio/webm", ext: "webm" },
    });
    expect(decodeSttAudio(dataUrl("audio/ogg", OGG))).toMatchObject({
      audio: { mediaType: "audio/ogg", ext: "ogg" },
    });
    expect(decodeSttAudio(dataUrl("audio/mp4", MP4))).toMatchObject({
      audio: { mediaType: "audio/mp4", ext: "m4a" },
    });
  });

  it("tolerates the codec parameter MediaRecorder stamps into its mime", () => {
    // Chrome/Edge report `audio/webm;codecs=opus`; the client echoes it verbatim.
    expect(decodeSttAudio(dataUrl("audio/webm;codecs=opus", WEBM))).toMatchObject({
      audio: { mediaType: "audio/webm" },
    });
    expect(decodeSttAudio(dataUrl("audio/ogg;codecs=opus", OGG))).toMatchObject({
      audio: { mediaType: "audio/ogg" },
    });
  });

  it("rejects non-data-URL input, undeclared types, and empty payloads", () => {
    expect(decodeSttAudio(undefined)).toEqual({ error: "BAD_FORMAT" });
    expect(decodeSttAudio("안녕하세요")).toEqual({ error: "BAD_FORMAT" });
    expect(decodeSttAudio(dataUrl("audio/wav", WEBM))).toEqual({ error: "BAD_FORMAT" });
    expect(decodeSttAudio(dataUrl("image/png", PNG))).toEqual({ error: "BAD_FORMAT" });
    // "=" is valid base64 that decodes to nothing.
    expect(decodeSttAudio("data:audio/webm;base64,=")).toEqual({ error: "BAD_FORMAT" });
  });

  it("rejects bytes that contradict the declared container", () => {
    expect(decodeSttAudio(dataUrl("audio/webm", PNG))).toEqual({ error: "BAD_FORMAT" });
    // Cross-container lies are caught too, not just non-audio bytes.
    expect(decodeSttAudio(dataUrl("audio/webm", OGG))).toEqual({ error: "BAD_FORMAT" });
    expect(decodeSttAudio(dataUrl("audio/mp4", WEBM))).toEqual({ error: "BAD_FORMAT" });
  });

  it("caps the decoded recording at MAX_STT_AUDIO_BYTES", () => {
    const oversize = Buffer.concat([WEBM, Buffer.alloc(MAX_STT_AUDIO_BYTES)]);
    expect(decodeSttAudio(dataUrl("audio/webm", oversize))).toEqual({ error: "TOO_LARGE" });
  });
});

describe("POST /api/stt", () => {
  it("requires authentication", async () => {
    const app = testApp({ sttUrl: "http://stt.invalid/v1" });
    await request(app).post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(401);
  });

  it("503s when the deployment has no STT service configured", async () => {
    const app = testApp({ sttUrl: undefined });
    const agent = await newUser(app, "stt-unconfigured");
    const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(503);
    expect(res.body.error).toBe("음성 인식이 아직 설정되지 않았어요.");
  });

  it("400s on a malformed or mislabelled recording", async () => {
    const app = testApp({ sttUrl: "http://stt.invalid/v1" });
    const agent = await newUser(app, "stt-badformat");
    for (const audio of [
      undefined,
      "not-a-data-url",
      dataUrl("audio/wav", WEBM),
      dataUrl("audio/webm", PNG),
    ]) {
      const res = await agent.post("/api/stt").send({ audio }).expect(400);
      expect(res.body.error).toBe("지원하지 않는 오디오 형식이에요.");
    }
  });

  it("400s with the oversize message on a recording past the cap", async () => {
    const app = testApp({ sttUrl: "http://stt.invalid/v1" });
    const agent = await newUser(app, "stt-oversize");
    const oversize = Buffer.concat([WEBM, Buffer.alloc(MAX_STT_AUDIO_BYTES)]);
    const res = await agent
      .post("/api/stt")
      .send({ audio: dataUrl("audio/webm", oversize) })
      .expect(400);
    expect(res.body.error).toBe("녹음이 너무 커요. 짧게 나눠서 시도해 주세요.");
  });

  it("forwards multipart to /audio/transcriptions and returns the transcript", async () => {
    await withSttServer(respondJson(200, { text: "  안녕하세요  " }), async (baseUrl, captured) => {
      const app = testApp({ sttUrl: baseUrl, sttModel: "Qwen/Qwen3-ASR-1.7B" });
      const agent = await newUser(app, "stt-happy");
      const res = await agent
        .post("/api/stt")
        .send({ audio: dataUrl("audio/webm;codecs=opus", WEBM) })
        .expect(200);
      // Trimmed, so the composer never inserts the upstream's padding.
      expect(res.body).toEqual({ text: "안녕하세요" });

      expect(captured).toHaveLength(1);
      const [sent] = captured;
      expect(sent.url).toBe("/v1/audio/transcriptions");
      expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(sent.body).toContain('name="model"');
      expect(sent.body).toContain("Qwen/Qwen3-ASR-1.7B");
      expect(sent.body).toContain('name="response_format"');
      expect(sent.body).toContain("json");
      // The filename + part type come from the SNIFFED container, not the label.
      expect(sent.body).toContain('name="file"; filename="audio.webm"');
      expect(sent.body).toContain("Content-Type: audio/webm");
      expect(sent.body).toContain(WEBM.toString("latin1"));
    });
  });

  it("passes an empty transcript through as an empty string", async () => {
    await withSttServer(respondJson(200, { text: "   " }), async (baseUrl) => {
      const app = testApp({ sttUrl: baseUrl });
      const agent = await newUser(app, "stt-silence");
      const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/ogg", OGG) }).expect(200);
      expect(res.body).toEqual({ text: "" });
    });
  });

  it("502s when the service answers 500", async () => {
    await withSttServer(respondJson(500, { error: "model not loaded" }), async (baseUrl) => {
      const app = testApp({ sttUrl: baseUrl });
      const agent = await newUser(app, "stt-upstream500");
      const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(502);
      expect(res.body.error).toBe("음성 인식 서비스에 연결할 수 없어요.");
    });
  });

  it("502s when a 200 carries no transcript", async () => {
    // A JSON error body behind HTTP 200 must not read to the user as silence.
    await withSttServer(respondJson(200, { error: "bad request" }), async (baseUrl) => {
      const app = testApp({ sttUrl: baseUrl });
      const agent = await newUser(app, "stt-notext");
      const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(502);
      expect(res.body.error).toBe("음성 인식 서비스에 연결할 수 없어요.");
    });
  });

  it("502s when a 200 is not JSON at all", async () => {
    // What a reverse proxy in front of a down service actually returns.
    await withSttServer(
      (res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>502 Bad Gateway</body></html>");
      },
      async (baseUrl) => {
        const app = testApp({ sttUrl: baseUrl });
        const agent = await newUser(app, "stt-html");
        const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/mp4", MP4) }).expect(502);
        expect(res.body.error).toBe("음성 인식 서비스에 연결할 수 없어요.");
      },
    );
  });

  it("502s when the service is unreachable", async () => {
    const app = testApp({ sttUrl: `http://127.0.0.1:${await closedPort()}/v1` });
    const agent = await newUser(app, "stt-refused");
    const res = await agent.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(502);
    expect(res.body.error).toBe("음성 인식 서비스에 연결할 수 없어요.");
  });

  it("rate-limits per user, not per ip", async () => {
    const app = testApp({ sttUrl: undefined });
    const flooder = await newUser(app, "stt-flooder");
    const bystander = await newUser(app, "stt-bystander");
    // createRateLimiter short-circuits under NODE_ENV=test, so the window is only
    // observable with the bypass off. It is read per REQUEST, so flipping it here
    // needs no injection seam and weakens nothing in production; nothing else in
    // the server reads NODE_ENV outside module load.
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const audio = dataUrl("audio/webm", WEBM);
      // The limiter sits in front of the handler, so an unconfigured 503 still
      // consumes the budget — what matters is the bucket, not the outcome.
      for (let i = 0; i < 20; i += 1) {
        await flooder.post("/api/stt").send({ audio }).expect(503);
      }
      const limited = await flooder.post("/api/stt").send({ audio }).expect(429);
      expect(limited.body.error).toBe("요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.");
      expect(limited.headers["retry-after"]).toBeDefined();
      // A co-worker behind the same corporate NAT keeps their own budget.
      await bystander.post("/api/stt").send({ audio }).expect(503);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe("STT configuration", () => {
  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("defaults the model and leaves the feature off without STT_URL", () => {
    withEnv({ STT_URL: undefined, STT_MODEL: undefined }, () => {
      const config = loadConfig({ dataDir: tempDir, sessionSecret: "test" });
      expect(config.sttUrl).toBeUndefined();
      expect(config.sttModel).toBe("Qwen/Qwen3-ASR-1.7B");
    });
  });

  it("strips a trailing slash off STT_URL so the request path stays single-slashed", () => {
    withEnv({ STT_URL: "http://stt:8000/v1/", STT_MODEL: "whisper-1" }, () => {
      const config = loadConfig({ dataDir: tempDir, sessionSecret: "test" });
      expect(config.sttUrl).toBe("http://stt:8000/v1");
      expect(config.sttModel).toBe("whisper-1");
    });
  });

  it("reports sttEnabled on /api/bootstrap so the composer can hide the mic", async () => {
    const off = await request(testApp({ sttUrl: undefined })).get("/api/bootstrap").expect(200);
    expect(off.body.sttEnabled).toBe(false);
    const on = await request(testApp({ sttUrl: "http://stt:8000/v1" })).get("/api/bootstrap").expect(200);
    expect(on.body.sttEnabled).toBe(true);
  });
});

// The admin panel can re-point the transcription service at runtime, and its
// value WINS over env STT_URL (the inverse of the model override, where env
// wins). Every test here signs its admin up FIRST — the first account created on
// a fresh store is the system admin.
describe("admin-managed STT override", () => {
  it("turns the mic on for a deployment that has no STT_URL at all", async () => {
    await withSttServer(respondJson(200, { text: "  관리자 설정  " }), async (baseUrl, captured) => {
      const app = testApp({ sttUrl: undefined });
      const admin = await newUser(app, "stt-admin");

      const before = await request(app).get("/api/bootstrap").expect(200);
      expect(before.body.sttEnabled).toBe(false);

      await admin.put("/api/admin/stt").send({ url: baseUrl }).expect(200);

      const after = await request(app).get("/api/bootstrap").expect(200);
      expect(after.body.sttEnabled).toBe(true);
      const res = await admin.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(200);
      expect(res.body).toEqual({ text: "관리자 설정" });
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe("/v1/audio/transcriptions");
      // No model in the PUT, so the env default rides along unchanged.
      expect(captured[0].body).toContain("Qwen/Qwen3-ASR-1.7B");
    });
  });

  it("sends the override's own model name when one was given", async () => {
    await withSttServer(respondJson(200, { text: "ok" }), async (baseUrl, captured) => {
      const app = testApp({ sttUrl: undefined, sttModel: "deployment-default" });
      const admin = await newUser(app, "stt-admin");
      await admin.put("/api/admin/stt").send({ url: baseUrl, model: "  whisper-1  " }).expect(200);

      await admin.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(200);
      expect(captured[0].body).toContain("whisper-1");
      expect(captured[0].body).not.toContain("deployment-default");
    });
  });

  it("beats a configured STT_URL — the admin value wins, not the env", async () => {
    await withSttServer(respondJson(200, { text: "from env" }), async (envUrl, envCaptured) => {
      await withSttServer(respondJson(200, { text: "from override" }), async (overrideUrl, overrideCaptured) => {
        const app = testApp({ sttUrl: envUrl });
        const admin = await newUser(app, "stt-admin");
        await admin.put("/api/admin/stt").send({ url: overrideUrl }).expect(200);

        const res = await admin.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(200);
        expect(res.body).toEqual({ text: "from override" });
        expect(overrideCaptured).toHaveLength(1);
        expect(envCaptured).toHaveLength(0);
      });
    });
  });

  it("falls back to the env service once the override is cleared", async () => {
    await withSttServer(respondJson(200, { text: "from env" }), async (envUrl, envCaptured) => {
      await withSttServer(respondJson(200, { text: "from override" }), async (overrideUrl) => {
        const app = testApp({ sttUrl: envUrl });
        const admin = await newUser(app, "stt-admin");
        await admin.put("/api/admin/stt").send({ url: overrideUrl }).expect(200);
        await admin.delete("/api/admin/stt").expect(200);

        const res = await admin.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(200);
        expect(res.body).toEqual({ text: "from env" });
        expect(envCaptured).toHaveLength(1);
      });
    });
  });

  it("turns the feature back off when a cleared override had no env behind it", async () => {
    const app = testApp({ sttUrl: undefined });
    const admin = await newUser(app, "stt-admin");
    await admin.put("/api/admin/stt").send({ url: "http://stt.invalid/v1" }).expect(200);
    await admin.delete("/api/admin/stt").expect(200);

    const res = await admin.post("/api/stt").send({ audio: dataUrl("audio/webm", WEBM) }).expect(503);
    expect(res.body.error).toBe("음성 인식이 아직 설정되지 않았어요.");
    const bootstrap = await request(app).get("/api/bootstrap").expect(200);
    expect(bootstrap.body.sttEnabled).toBe(false);
  });

  it("rejects a missing or non-http(s) address and stores the url normalized", async () => {
    const app = testApp({ sttUrl: undefined });
    const admin = await newUser(app, "stt-admin");

    const missing = await admin.put("/api/admin/stt").send({}).expect(400);
    expect(missing.body.error).toBe("STT 서버 주소를 입력해 주세요.");
    await admin.put("/api/admin/stt").send({ url: "   " }).expect(400);
    for (const url of ["ftp://x", "not a url"]) {
      const res = await admin.put("/api/admin/stt").send({ url }).expect(400);
      expect(res.body.error).toBe("http(s) 주소만 사용할 수 있어요.");
    }
    // None of the rejects reached the store.
    let sys = await admin.get("/api/admin/system").expect(200);
    expect(sys.body.system.sttOverride).toBeNull();

    // Trailing slashes are stripped once on the way in, exactly as config.ts does
    // for the env value, so the request path never doubles its slash.
    const saved = await admin.put("/api/admin/stt").send({ url: "http://stt:8000/v1//" }).expect(200);
    expect(saved.body.sttOverride).toEqual({ url: "http://stt:8000/v1", model: null });
    sys = await admin.get("/api/admin/system").expect(200);
    expect(sys.body.system.sttOverride).toEqual({ url: "http://stt:8000/v1", model: null });
  });

  it("is admin-only", async () => {
    const app = testApp({ sttUrl: undefined });
    await newUser(app, "stt-admin");
    const member = await newUser(app, "stt-member");
    await member.put("/api/admin/stt").send({ url: "http://stt:8000/v1" }).expect(403);
    await member.delete("/api/admin/stt").expect(403);
    // The blocked member changed nothing.
    const bootstrap = await request(app).get("/api/bootstrap").expect(200);
    expect(bootstrap.body.sttEnabled).toBe(false);
  });

  it("surfaces the override next to the env values it falls back to", async () => {
    const app = testApp({ sttUrl: "http://stt:8000/v1", sttModel: "deployment-default" });
    const admin = await newUser(app, "stt-admin");

    let sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.sttOverride).toBeNull();
    expect(sys.sttEnvUrl).toBe("http://stt:8000/v1");
    expect(sys.sttEnvModel).toBe("deployment-default");

    await admin
      .put("/api/admin/stt")
      .send({ url: "http://gpu-box:9000/v1", model: "whisper-1" })
      .expect(200);
    sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.sttOverride).toEqual({ url: "http://gpu-box:9000/v1", model: "whisper-1" });
    // The env pair stays visible: it is what a clear would fall back to, and the
    // panel shows it as the inherited value (it is never seeded into the store).
    expect(sys.sttEnvUrl).toBe("http://stt:8000/v1");
    expect(sys.sttEnvModel).toBe("deployment-default");
  });

  it("reports a null env url when nothing but the override configures STT", async () => {
    const app = testApp({ sttUrl: undefined });
    const admin = await newUser(app, "stt-admin");
    const sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.sttEnvUrl).toBeNull();
    expect(sys.sttEnvModel).toBe("Qwen/Qwen3-ASR-1.7B");
  });

  it("ignores an unreadable stored override instead of breaking the mic", async () => {
    const services = testServices({ sttUrl: "http://stt:8000/v1" });
    const app = createApp(services);
    const admin = await newUser(app, "stt-admin");

    // What a SESSION_SECRET rotation or a hand-edited row leaves behind: the
    // deployment must degrade to the env fallback, not 503 on every click.
    services.store.setAppSecret("stt_override", "not json");
    expect(services.store.getSttOverride()).toBeNull();
    const sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    expect(sys.sttOverride).toBeNull();
    const bootstrap = await request(app).get("/api/bootstrap").expect(200);
    expect(bootstrap.body.sttEnabled).toBe(true);
  });
});
