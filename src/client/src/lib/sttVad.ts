// End-of-speech detection for the composer mic: Silero VAD (@ricky0123/vad-web
// on onnxruntime-web) listening alongside the MediaRecorder.
//
// This module is an ENDPOINT DETECTOR and nothing else. It never touches the
// recording — lib/stt.ts still owns the MediaRecorder, the container choice,
// the upload and the mic tracks; all this does is say "they stopped talking",
// which lib/stt.ts turns into the same stop it would have got from a second
// mic press. The audio the VAD itself buffers is discarded.
//
// It is also the ONLY place vad-web/onnxruntime-web may be imported, and
// lib/stt.ts reaches it exclusively through `import("./sttVad")`: that keeps
// ~14 MB of model + wasm out of the main bundle (they load on the first mic
// click of a session and are then HTTP-cached), and it keeps jsdom from ever
// pulling onnxruntime in — the tests take the attach-failed path instead.

// Deep import on purpose. The package index also exports NonRealTimeVAD, which
// pulls in onnxruntime-web's ROOT build (WebGPU + WebNN, ~405 kB) on top of the
// wasm-only one this path uses — a second copy of a runtime we never call. The
// version is pinned exactly, so the dist layout cannot move under us.
import { MicVAD } from "@ricky0123/vad-web/dist/real-time-vad";

/**
 * Where the four runtime assets are served from — see the `noah-vad-assets`
 * plugin in vite.config.ts. Both libraries append their own hard-coded file
 * names to this prefix, so it has to be a directory, not per-file URLs.
 */
const ASSET_BASE = "/vad/";

/**
 * Trailing silence before a take is called finished. Maps to vad-web's
 * `redemptionMs` (the grace period after the first sub-threshold frame; speech
 * inside it cancels the pending end), quantised to whole model frames — 96 ms
 * each on the legacy model, so 1400 ms lands on 14 frames ≈ 1.34 s.
 */
const REDEMPTION_MS = 1400;

export interface VadCallbacks {
  /** Speech detected. Fires per utterance, before the minimum-length check. */
  onSpeechStart(): void;
  /** `REDEMPTION_MS` of silence after a long-enough utterance: the take is over. */
  onSpeechEnd(): void;
}

export interface VadHandle {
  /** Stop listening and tear the audio graph down. Idempotent. */
  destroy(): void;
}

/**
 * Start watching `stream` — the recorder's own MediaStream, never a second
 * getUserMedia — for the end of an utterance. Rejects if the model, the wasm
 * or the AudioContext is unavailable; the caller then keeps recording exactly
 * as it did before there was a detector.
 */
export async function attachVad(stream: MediaStream, cb: VadCallbacks): Promise<VadHandle> {
  // Owned here, not by MicVAD: an AudioContext built outside a user gesture can
  // come up suspended (and would then feed the model nothing but silence), and
  // owning it means close() is ours to guarantee even if MicVAD.destroy throws.
  const audioContext = new AudioContext();
  const closeContext = (): void => void audioContext.close().catch(() => {});

  let vad: MicVAD;
  try {
    if (audioContext.state === "suspended") await audioContext.resume();
    vad = await MicVAD.new({
      audioContext,
      // The recorder's stream. The defaults would open the mic a SECOND time,
      // and pauseStream's default stops the tracks — that would cut the
      // recording short; releasing the mic is lib/stt.ts's job alone.
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      startOnLoad: true,
      // vad-web's own DEFAULT_MODEL: 1536-sample frames (96 ms), the smaller of
      // the two bundled models, and plenty of resolution for a 1.4 s window.
      model: "legacy",
      baseAssetPath: ASSET_BASE,
      onnxWASMBasePath: ASSET_BASE,
      ortConfig: (ort) => {
        // Multi-threaded wasm needs SharedArrayBuffer, which needs COOP/COEP
        // headers this app does not send. Ask for one thread rather than let
        // onnxruntime probe, warn, and fall back to it anyway.
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = "error";
      },
      // Silero's probability thresholds, pinned at vad-web's defaults. Keep
      // them sensitive: a missed speech start ends up discarding a take the
      // user actually spoke (lib/stt.ts's no-speech timeout), while an
      // over-eager one only leaves the mic running to its normal cap.
      positiveSpeechThreshold: 0.3,
      negativeSpeechThreshold: 0.25,
      redemptionMs: REDEMPTION_MS,
      // Anything shorter is a cough or a door, not an utterance: vad-web
      // reports it as a misfire, which deliberately does NOT end the take.
      minSpeechMs: 400,
      // The MediaRecorder holds the audio; the VAD's own buffer is dropped, so
      // there is nothing to pad and no reason to retain pre-speech frames.
      preSpeechPadMs: 0,
      // Tearing down must never look like the user finishing a sentence.
      submitUserSpeechOnPause: false,
      onSpeechStart: () => cb.onSpeechStart(),
      onSpeechEnd: () => cb.onSpeechEnd(),
      onVADMisfire: () => {},
    });
  } catch (err) {
    closeContext();
    throw err;
  }

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // destroy() is async and the caller's exit path is not; a failure in it
      // must still not leave the AudioContext (and its worklet) alive.
      void Promise.resolve()
        .then(() => vad.destroy())
        .catch(() => {})
        .then(closeContext);
    },
  };
}
