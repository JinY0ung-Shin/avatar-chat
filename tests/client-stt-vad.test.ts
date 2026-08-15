// @vitest-environment jsdom
// Voice input's end-of-speech detector (lib/stt.ts × lib/sttVad.ts). The
// detector itself is Silero VAD on onnxruntime-web, which jsdom cannot run, so
// lib/sttVad is mocked here at the specifier lib/stt.ts lazily imports — that
// lazy import is the whole seam: the recording pipeline is unchanged and the
// detector only ever calls the stop path a second mic press would.
//
// What this file pins is the wiring, not the model: an auto-stop transcribes
// like a manual stop, a take nobody speaks into is DROPPED rather than uploaded
// (silence costs GPU time), a detector that cannot load leaves the old manual
// behavior exactly as it was, and no exit path leaves an audio graph running.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startVoiceInput } from "../src/client/src/lib/stt.js";

const NOTHING_HEARD = "음성이 인식되지 않았어요. 다시 시도해 주세요.";

interface VadCallbacks {
  onSpeechStart(): void;
  onSpeechEnd(): void;
}

/** The mocked detector, driven by hand from each test. */
const vad = vi.hoisted(() => ({
  /** Set to make attachVad reject, i.e. an old browser or a missing asset. */
  failWith: null as Error | null,
  /** Set to hold attachVad pending; call `release()` to let it resolve. */
  hold: false,
  release: null as null | (() => void),
  calls: 0,
  stream: null as MediaStream | null,
  callbacks: null as VadCallbacks | null,
  destroy: vi.fn(),
}));

vi.mock("../src/client/src/lib/sttVad.js", () => ({
  attachVad: async (stream: MediaStream, callbacks: VadCallbacks) => {
    vad.calls += 1;
    vad.stream = stream;
    vad.callbacks = callbacks;
    if (vad.hold) await new Promise<void>((resolve) => (vad.release = resolve));
    if (vad.failWith) throw vad.failWith;
    return { destroy: vad.destroy };
  },
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
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

  private emit(type: string, props: Record<string, unknown> = {}): void {
    const event = Object.assign(new Event(type), props);
    for (const cb of this.listeners[type] || []) cb(event);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.emit("dataavailable", { data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.emit("stop");
  }
}

function lastRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances.at(-1);
  expect(recorder).toBeTruthy();
  return recorder!;
}

function installMedia(): MediaStream {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => stream) },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  return stream;
}

function stubFetch(text = "받아쓴 문장") {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return { status: 200, ok: true, json: async () => ({ text }) } as unknown as Response;
    }),
  );
  return calls;
}

/**
 * Let the lazy `import("./sttVad")` and the attach that follows it settle. The
 * chain is promise-only, so draining microtasks is enough — but it takes more
 * than one turn, and nothing in the session is awaitable from outside.
 */
async function settleAttach(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  vad.failWith = null;
  vad.hold = false;
  vad.release = null;
  vad.calls = 0;
  vad.stream = null;
  vad.callbacks = null;
  vad.destroy = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  } catch {
    /* leave the harmless override */
  }
});

describe("stt.startVoiceInput — end-of-speech auto-stop", () => {
  it("transcribes on speech end exactly as a manual stop would", async () => {
    const stream = installMedia();
    const calls = stubFetch("회의록 정리해 줘");
    const armed: boolean[] = [];

    const session = await startVoiceInput({ onAutoStopArmed: () => armed.push(true) });
    await settleAttach();
    // The detector listens to the RECORDER's stream — never a second mic open.
    expect(vad.calls).toBe(1);
    expect(vad.stream).toBe(stream);
    expect(armed).toEqual([true]);
    expect(calls).toHaveLength(0); // still recording

    vad.callbacks!.onSpeechStart();
    vad.callbacks!.onSpeechEnd();

    await expect(session.done).resolves.toBe("회의록 정리해 줘");
    expect(lastRecorder().state).toBe("inactive"); // stopped without a second press
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/stt");
    expect(vad.destroy).toHaveBeenCalledTimes(1); // no audio graph left running
  });

  it("drops a take nobody spoke into instead of uploading silence", async () => {
    vi.useFakeTimers();
    installMedia();
    const calls = stubFetch();

    const session = await startVoiceInput();
    await vi.advanceTimersByTimeAsync(0); // let the attach settle
    expect(vad.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(lastRecorder().state).toBe("recording"); // inside the window, still going

    // Claim the rejection before the timer fires it: the take is dropped from
    // inside advanceTimersByTimeAsync, and an unclaimed rejection there reads
    // as an unhandled error rather than the expected outcome.
    const dropped = expect(session.done).rejects.toThrow(NOTHING_HEARD);
    await vi.advanceTimersByTimeAsync(1_000);
    await dropped;
    // The recorder DID flush a chunk; the take is dropped anyway, so no GPU time
    // is spent transcribing a silent clip.
    expect(calls).toHaveLength(0);
    expect(vad.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps recording once anything is heard, however short", async () => {
    vi.useFakeTimers();
    installMedia();
    const calls = stubFetch("한참 뒤에 끝난 문장");

    const session = await startVoiceInput();
    await vi.advanceTimersByTimeAsync(0);

    // A cough at 2s: too short to be an utterance (the detector reports it as a
    // misfire and never calls onSpeechEnd), but it proves the mic is not idle.
    await vi.advanceTimersByTimeAsync(2_000);
    vad.callbacks!.onSpeechStart();

    // Well past the no-speech window: the timer is gone for the whole take.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lastRecorder().state).toBe("recording");
    expect(calls).toHaveLength(0);

    vad.callbacks!.onSpeechEnd();
    await vi.runAllTimersAsync();
    await expect(session.done).resolves.toBe("한참 뒤에 끝난 문장");
  });

  it("falls back to manual stop when the detector cannot load, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installMedia();
    const calls = stubFetch("직접 멈춘 문장");
    const armed: boolean[] = [];
    vad.failWith = new Error("no AudioContext in this browser");

    const session = await startVoiceInput({ onAutoStopArmed: () => armed.push(true) });
    await settleAttach();
    expect(armed).toEqual([]); // nothing to promise the user
    expect(lastRecorder().state).toBe("recording"); // the take is unaffected

    session.stop();
    await expect(session.done).resolves.toBe("직접 멈춘 문장");
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // A browser that cannot run the detector cannot run it on the next press
    // either, so the warning does not repeat.
    const second = await startVoiceInput();
    await settleAttach();
    second.stop();
    await expect(second.done).resolves.toBe("직접 멈춘 문장");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tears the detector down when the take is cancelled", async () => {
    installMedia();
    const calls = stubFetch();

    const session = await startVoiceInput();
    await settleAttach();
    session.cancel();

    await expect(session.done).resolves.toBeNull();
    expect(vad.destroy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("tears down a detector that finishes loading after the take ended", async () => {
    installMedia();
    stubFetch();
    vad.hold = true;

    const session = await startVoiceInput();
    await settleAttach();
    expect(vad.destroy).not.toHaveBeenCalled(); // still loading the model

    session.cancel();
    await expect(session.done).resolves.toBeNull();

    vad.release!(); // the handle arrives after everything is over
    await settleAttach();
    expect(vad.destroy).toHaveBeenCalledTimes(1);
  });
});
