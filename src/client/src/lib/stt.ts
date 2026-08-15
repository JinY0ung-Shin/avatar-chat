// Voice input for the composer: microphone → MediaRecorder → base64 data URL →
// POST /api/stt → transcript. All the media plumbing lives here; the composer
// only tracks which pane owns the session and which phase it is in.
//
// The recording travels as a `data:` URL, never `URL.createObjectURL`: the
// production CSP ships no `blob:` source, so a blob URL is unusable in the page
// (same rule as the image paths in lib/dom.ts).

import { api } from "./api";
import { readFileAsDataUrl } from "./dom";

/** Hard cap on one take: it is stopped and transcribed rather than dropped. */
export const STT_MAX_MS = 60_000;
export const STT_MAX_SEC = STT_MAX_MS / 1000;

/**
 * How long the end-of-speech detector may hear nothing at all before the take
 * is dropped. Armed only once the detector is actually listening, and cleared
 * for good by the first word — so this is "the mic was opened by accident",
 * never "they paused". Dropping beats uploading: silence costs GPU time and
 * comes back as an empty transcript anyway.
 */
const STT_NO_SPEECH_MS = 10_000;

// First container the browser admits. Opus-in-WebM is what Chromium/Firefox on
// the Windows/Linux fleet produce; the plain fallbacks cover a build that
// reports no codec support for the preferred string.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

const UNSUPPORTED = "이 브라우저에서는 음성 입력을 사용할 수 없어요.";
const DENIED = "마이크 사용 권한이 필요해요. 브라우저 권한 설정을 확인해 주세요.";
const NO_DEVICE = "사용할 수 있는 마이크를 찾지 못했어요.";
const MIC_BUSY = "마이크를 사용할 수 없어요. 다른 프로그램이 마이크를 쓰고 있는지 확인해 주세요.";
const NOTHING_HEARD = "음성이 인식되지 않았어요. 다시 시도해 주세요.";
const RECORD_FAILED = "녹음에 실패했어요. 다시 시도해 주세요.";

export type SttPhase = "recording" | "transcribing";

export interface SttSession {
  /** Finish the take and transcribe it. Safe to call more than once. */
  stop(): void;
  /** Drop the take without transcribing (pane closed, view unmounted). */
  cancel(): void;
  /**
   * The transcript, or `null` when the session was cancelled. Rejects with a
   * Korean message the caller can surface as-is.
   */
  done: Promise<string | null>;
}

export interface SttOptions {
  /** Entering each phase — the 60s auto-stop reaches "transcribing" on its own. */
  onPhase?: (phase: SttPhase) => void;
  /** Whole seconds recorded so far, once per second. */
  onElapsed?: (seconds: number) => void;
  /**
   * The end-of-speech detector is listening, so this take really will stop on
   * its own. Never fires where the detector could not load, which is exactly
   * where the UI must not promise it.
   */
  onAutoStopArmed?: () => void;
}

// One line per page, not per take: a browser that cannot run the detector
// cannot run it on the twentieth mic press either.
let vadWarned = false;

// getUserMedia rejects with a DOMException whose NAME is the only reliable
// signal (messages are browser-specific), so branch on that and never on text.
function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return DENIED;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return NO_DEVICE;
  return MIC_BUSY;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Open the mic and start recording. Rejects (before any recording exists) when
 * the browser cannot record or the user denies access; every later failure
 * arrives through the returned session's `done`.
 */
export async function startVoiceInput(opts: SttOptions = {}): Promise<SttSession> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error(UNSUPPORTED);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(micErrorMessage(err));
  }

  // The mic stays hot (and the browser keeps showing the recording indicator)
  // until every track is stopped, so this runs on EVERY exit path below.
  const releaseMic = (): void => {
    for (const track of stream.getTracks?.() || []) track.stop();
  };

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch {
    releaseMic();
    throw new Error(UNSUPPORTED);
  }

  const chunks: Blob[] = [];
  let settle: (text: string | null) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const done = new Promise<string | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let stopRequested = false;
  let finished = false;
  let cancelled = false;
  let failure = "";
  let elapsed = 0;
  let hardStopTimer = 0;
  let elapsedTimer = 0;
  let noSpeechTimer = 0;
  let vad: { destroy(): void } | null = null;
  let vadWanted = true;

  const clearTimers = (): void => {
    if (hardStopTimer) window.clearTimeout(hardStopTimer);
    if (elapsedTimer) window.clearInterval(elapsedTimer);
    if (noSpeechTimer) window.clearTimeout(noSpeechTimer);
    hardStopTimer = 0;
    elapsedTimer = 0;
    noSpeechTimer = 0;
  };

  // Tears down the detector's audio graph (worklet + AudioContext). `vadWanted`
  // covers the race the other way: the take can end while the model is still
  // loading, and the handle that arrives afterwards must be dropped at once.
  const releaseVad = (): void => {
    vadWanted = false;
    vad?.destroy();
    vad = null;
  };

  async function transcribe(): Promise<string> {
    const type = mimeType || chunks[0]?.type || "audio/webm";
    // A named File (not a bare Blob) so the shared FileReader helper does the
    // base64 conversion — one data-URL path for every upload in the client.
    const file = new File(chunks, type.includes("ogg") ? "recording.ogg" : "recording.webm", { type });
    const dataUrl = await readFileAsDataUrl(file);
    const reply = await api<{ text?: string }>("/api/stt", {
      method: "POST",
      body: JSON.stringify({ audio: dataUrl }),
    });
    const text = (reply.text || "").trim();
    if (!text) throw new Error(NOTHING_HEARD);
    return text;
  }

  // Single exit point for the session: idempotent, always releases the mic, and
  // settles `done` exactly once.
  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimers();
    releaseVad();
    releaseMic();
    if (cancelled) {
      settle(null);
      return;
    }
    if (failure) {
      fail(new Error(failure));
      return;
    }
    if (!chunks.length) {
      fail(new Error(NOTHING_HEARD));
      return;
    }
    opts.onPhase?.("transcribing");
    transcribe().then(settle, (err: unknown) => fail(err instanceof Error ? err : new Error(NOTHING_HEARD)));
  }

  const endRecording = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    clearTimers();
    releaseVad();
    try {
      recorder.stop();
    } catch {
      // An already-inactive recorder fires no "stop" event, so drive the tail
      // ourselves rather than leaving `done` pending forever.
      finish();
    }
  };

  recorder.addEventListener("dataavailable", (event) => {
    const data = (event as BlobEvent).data;
    if (data?.size) chunks.push(data);
  });
  recorder.addEventListener("stop", () => finish());
  recorder.addEventListener("error", () => {
    failure = RECORD_FAILED;
    stopRequested = true;
    finish();
  });

  try {
    recorder.start();
  } catch {
    releaseMic();
    throw new Error(RECORD_FAILED);
  }
  opts.onPhase?.("recording");
  hardStopTimer = window.setTimeout(endRecording, STT_MAX_MS);
  elapsedTimer = window.setInterval(() => {
    elapsed += 1;
    opts.onElapsed?.(elapsed);
  }, 1000);

  // End-of-speech detection is a LATE ADD-ON to a take that is already running:
  // it listens to the same stream and, when the user stops talking, calls the
  // very stop a second mic press would. So it is attached without awaiting, and
  // any failure — no module, missing asset, no AudioContext, browser too old —
  // simply leaves the take where it has always been: manual stop plus the 60s
  // cap. (That failure path is also the one jsdom takes.)
  void import("./sttVad")
    .then(({ attachVad }) =>
      attachVad(stream, {
        onSpeechStart: () => {
          // Something was said, so silence can no longer condemn this take —
          // even if it turns out too short to be an utterance.
          if (noSpeechTimer) window.clearTimeout(noSpeechTimer);
          noSpeechTimer = 0;
        },
        onSpeechEnd: endRecording,
      }),
    )
    .then((handle) => {
      if (!vadWanted) {
        handle.destroy();
        return;
      }
      vad = handle;
      noSpeechTimer = window.setTimeout(() => {
        noSpeechTimer = 0;
        failure = NOTHING_HEARD;
        endRecording();
      }, STT_NO_SPEECH_MS);
      opts.onAutoStopArmed?.();
    })
    .catch((err: unknown) => {
      if (vadWarned) return;
      vadWarned = true;
      console.warn("[stt] end-of-speech detection unavailable; recording stops on the button or the 60s cap", err);
    });

  return {
    done,
    stop: endRecording,
    cancel(): void {
      cancelled = true;
      endRecording();
    },
  };
}
