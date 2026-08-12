// @vitest-environment jsdom
// Voice input (lib/stt.ts): the mic → MediaRecorder → data: URL → POST /api/stt
// chain, plus every way it can fail. jsdom has neither getUserMedia nor
// MediaRecorder, so both are faked here — the fake recorder mirrors the real
// one's ordering (buffered `dataavailable`, then `stop`) because the module's
// tail hangs off exactly that sequence. Two invariants worth naming: the upload
// is a `data:` URL (the production CSP has no `blob:` source, so
// URL.createObjectURL must never be reached), and the mic is released on every
// exit path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STT_MAX_MS, STT_MAX_SEC, startVoiceInput } from "../src/client/src/lib/stt.js";

class FakeMediaRecorder {
  static supported = new Set<string>(["audio/webm;codecs=opus"]);
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  startCalls = 0;
  /** What the take flushes on stop; null models a take that captured nothing. */
  chunk: Blob | null = new Blob(["audio-bytes"], { type: "audio/webm" });
  private listeners: Record<string, Array<(event: Event) => void>> = {};

  constructor(
    readonly stream: MediaStream,
    options: { mimeType?: string } = {},
  ) {
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, cb: (event: Event) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  emit(type: string, props: Record<string, unknown> = {}): void {
    const event = Object.assign(new Event(type), props);
    for (const cb of this.listeners[type] || []) cb(event);
  }

  start(): void {
    this.state = "recording";
    this.startCalls += 1;
  }

  stop(): void {
    this.state = "inactive";
    if (this.chunk) this.emit("dataavailable", { data: this.chunk });
    this.emit("stop");
  }
}

/** The recorder built by the call under test. */
function lastRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances.at(-1);
  expect(recorder).toBeTruthy();
  return recorder!;
}

let createObjectURL: ReturnType<typeof vi.fn>;

function installMedia(getUserMedia?: () => Promise<MediaStream>) {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const mock = vi.fn(getUserMedia ?? (async () => stream));
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: mock },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  return { tracks, getUserMedia: mock };
}

/** Capture every fetch the module makes, answering with one canned reply. */
function stubFetch(reply: { status?: number; body?: unknown } = {}) {
  const status = reply.status ?? 200;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return { status, ok: status < 400, json: async () => reply.body ?? {} } as unknown as Response;
    }),
  );
  return calls;
}

/** The JSON body of the single /api/stt upload. */
function uploadedAudio(calls: Array<{ path: string; init: RequestInit }>): string {
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/api/stt");
  expect(calls[0].init.method).toBe("POST");
  return JSON.parse(String(calls[0].init.body)).audio;
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus"]);
  // jsdom does not implement createObjectURL; a spy proves the module never
  // reaches for it (a blob: URL would be dead under the production CSP).
  createObjectURL = vi.fn(() => "blob:never-used");
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
  } catch {
    /* leave the harmless override */
  }
});

describe("stt.startVoiceInput — happy path", () => {
  it("records, uploads a data: URL, and resolves the trimmed transcript", async () => {
    const { tracks, getUserMedia } = installMedia();
    const calls = stubFetch({ body: { text: "  회의록 정리해 줘  " } });
    const phases: string[] = [];

    const session = await startVoiceInput({ onPhase: (phase) => phases.push(phase) });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    const recorder = lastRecorder();
    expect(recorder.mimeType).toBe("audio/webm;codecs=opus"); // first supported candidate
    expect(recorder.startCalls).toBe(1);
    expect(recorder.state).toBe("recording");
    expect(phases).toEqual(["recording"]);
    expect(calls).toHaveLength(0); // nothing is uploaded until the take ends

    session.stop();
    await expect(session.done).resolves.toBe("회의록 정리해 줘");
    expect(phases).toEqual(["recording", "transcribing"]);

    const audio = uploadedAudio(calls);
    expect(audio.startsWith("data:audio/webm")).toBe(true);
    expect(audio).toContain(";base64,");
    expect(createObjectURL).not.toHaveBeenCalled();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1); // mic released
  });

  it("stops only once, so a double press cannot upload the take twice", async () => {
    installMedia();
    const calls = stubFetch({ body: { text: "한 번만" } });

    const session = await startVoiceInput();
    session.stop();
    session.stop();
    await expect(session.done).resolves.toBe("한 번만");
    expect(calls).toHaveLength(1);
  });

  it("falls back through the container candidates, then lets the browser choose", async () => {
    installMedia();
    FakeMediaRecorder.supported = new Set(["audio/ogg;codecs=opus"]);
    stubFetch({ body: { text: "ogg" } });
    const ogg = await startVoiceInput();
    expect(lastRecorder().mimeType).toBe("audio/ogg;codecs=opus");
    ogg.stop();
    await expect(ogg.done).resolves.toBe("ogg");

    FakeMediaRecorder.supported = new Set(); // nothing advertised
    const calls = stubFetch({ body: { text: "default" } });
    const fallback = await startVoiceInput();
    expect(lastRecorder().mimeType).toBe(""); // no mimeType forced on the recorder
    fallback.stop();
    await expect(fallback.done).resolves.toBe("default");
    // The type then comes from the recorded chunk itself, so the upload is still typed.
    expect(uploadedAudio(calls).startsWith("data:audio/webm")).toBe(true);
  });

  it("cancel() drops the take: no upload, mic released, done resolves null", async () => {
    const { tracks } = installMedia();
    const calls = stubFetch({ body: { text: "버려질 텍스트" } });

    const session = await startVoiceInput();
    session.cancel();
    await expect(session.done).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stt.startVoiceInput — guard rails", () => {
  it("reports an unusable browser when MediaRecorder or getUserMedia is missing", async () => {
    installMedia();
    vi.stubGlobal("MediaRecorder", undefined);
    await expect(startVoiceInput()).rejects.toThrow("이 브라우저에서는 음성 입력을 사용할 수 없어요.");

    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    await expect(startVoiceInput()).rejects.toThrow("이 브라우저에서는 음성 입력을 사용할 수 없어요.");
  });

  it("maps a denied permission prompt to the permission message", async () => {
    const { getUserMedia } = installMedia(async () => {
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    });
    const calls = stubFetch();
    await expect(startVoiceInput()).rejects.toThrow(
      "마이크 사용 권한이 필요해요. 브라우저 권한 설정을 확인해 주세요.",
    );
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(0); // nothing was recorded
    expect(calls).toHaveLength(0);
  });

  it("maps a missing device to the no-mic message and anything else to a busy mic", async () => {
    installMedia(async () => {
      throw Object.assign(new Error("no device"), { name: "NotFoundError" });
    });
    await expect(startVoiceInput()).rejects.toThrow("사용할 수 있는 마이크를 찾지 못했어요.");

    installMedia(async () => {
      throw Object.assign(new Error("in use"), { name: "NotReadableError" });
    });
    await expect(startVoiceInput()).rejects.toThrow("마이크를 사용할 수 없어요.");
  });

  it("rejects a silent take and a transcript the server returns empty", async () => {
    installMedia();
    const silentCalls = stubFetch({ body: { text: "무시됨" } });
    const silent = await startVoiceInput();
    lastRecorder().chunk = null; // the take captured no audio at all
    silent.stop();
    await expect(silent.done).rejects.toThrow("음성이 인식되지 않았어요. 다시 시도해 주세요.");
    expect(silentCalls).toHaveLength(0); // never uploaded

    stubFetch({ body: { text: "   " } });
    const blank = await startVoiceInput();
    blank.stop();
    await expect(blank.done).rejects.toThrow("음성이 인식되지 않았어요. 다시 시도해 주세요.");
  });

  it("surfaces the server's own Korean error and releases the mic", async () => {
    const { tracks } = installMedia();
    stubFetch({ status: 503, body: { error: "음성 인식 서버에 연결할 수 없습니다." } });
    const session = await startVoiceInput();
    session.stop();
    await expect(session.done).rejects.toThrow("음성 인식 서버에 연결할 수 없습니다.");
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("turns a recorder error into a Korean failure instead of a pending promise", async () => {
    const { tracks } = installMedia();
    const calls = stubFetch({ body: { text: "안 올라감" } });
    const session = await startVoiceInput();
    lastRecorder().emit("error");
    await expect(session.done).rejects.toThrow("녹음에 실패했어요. 다시 시도해 주세요.");
    expect(calls).toHaveLength(0);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stt.startVoiceInput — 60s cap", () => {
  it("ticks elapsed seconds and hard-stops the take at the cap", async () => {
    vi.useFakeTimers();
    installMedia();
    const calls = stubFetch({ body: { text: "1분 녹음" } });
    const elapsed: number[] = [];
    const phases: string[] = [];

    const session = await startVoiceInput({
      onElapsed: (seconds) => elapsed.push(seconds),
      onPhase: (phase) => phases.push(phase),
    });
    const recorder = lastRecorder();

    await vi.advanceTimersByTimeAsync(3000);
    expect(elapsed).toEqual([1, 2, 3]);
    expect(recorder.state).toBe("recording"); // still well inside the cap

    await vi.advanceTimersByTimeAsync(STT_MAX_MS - 3000);
    expect(recorder.state).toBe("inactive"); // stopped without any user press
    expect(phases).toEqual(["recording", "transcribing"]);
    // The last tick races the cap's own timer, so only the count matters here.
    expect(elapsed.at(-1)).toBeGreaterThanOrEqual(STT_MAX_SEC - 1);

    await vi.runAllTimersAsync(); // let the FileReader + upload settle
    await expect(session.done).resolves.toBe("1분 녹음");
    expect(calls).toHaveLength(1);

    // The per-second ticker is cleared with the take, not left running.
    const ticks = elapsed.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(elapsed).toHaveLength(ticks);
  });
});
