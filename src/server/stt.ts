import type { AppConfig, SttOverride } from "./types.js";

/**
 * Speech-to-text for the chat composer's mic button: the browser records with
 * MediaRecorder, POSTs one base64 data URL to `/api/stt`, and gets the
 * transcript back as text the user can still edit before sending. Validation
 * mirrors the sibling image upload (`chatImages.ts` — data URL regex → decode →
 * size cap → magic-byte sniff) so the two client-fed binary intakes can't drift
 * apart on what they trust. The bytes are NEVER stored: they live only for the
 * length of the upstream request. See `routes/stt.ts` for the HTTP wiring.
 */

/** Per-recording byte cap (decoded). ~15 minutes of Opus at the recorder's bitrate. */
export const MAX_STT_AUDIO_BYTES = 15 * 1024 * 1024;
/** Upstream deadline: a GPU transcribe of a long recording is slow, a hung one is worse. */
const STT_REQUEST_TIMEOUT_MS = 60_000;

/** The service one transcription is sent to: where, and under which model name. */
export interface SttTarget {
  url: string;
  model: string;
}

/**
 * Where this request's transcription goes, or null when the feature is off.
 *
 * The ADMIN override wins over the env — deliberately the inverse of the model
 * override, where an env `ANTHROPIC_MODEL` shadows the panel. An STT endpoint is
 * operational plumbing (a GPU box moves, a port changes) that an operator has to
 * be able to re-point without a redeploy, so the panel is the authority and env
 * `STT_URL` is only the fallback it displays. Resolved PER REQUEST so a change
 * takes effect on the next mic click, with no restart.
 *
 * The store is taken structurally rather than as the `Store` class: this module
 * stays a leaf that the route wires up, not a consumer of the store facade.
 */
export function resolveSttTarget(
  config: AppConfig,
  store: { getSttOverride(): SttOverride | null },
): SttTarget | null {
  const override = store.getSttOverride();
  const url = override?.url ?? config.sttUrl;
  if (!url) return null;
  // A stored override with no model of its own inherits the env default, so an
  // admin who only re-points the URL keeps the deployment's model name.
  return { url, model: override?.model ?? config.sttModel };
}

/** Containers the browsers on the fleet actually record (Chrome/Edge webm, Firefox ogg, mp4). */
export type SttMediaType = "audio/webm" | "audio/ogg" | "audio/mp4";

const MIME_EXT: Record<SttMediaType, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

// MediaRecorder stamps its codec into the mime it reports (Chrome/Edge emit
// `audio/webm;codecs=opus`), and the client echoes that verbatim into the data
// URL — so the parameters between the type and `;base64` must be tolerated
// rather than matched exactly.
const DATA_URL = /^data:(audio\/(?:webm|ogg|mp4))(?:;[^;,]+)*;base64,(.+)$/;

/**
 * The container the BYTES say this is, or null when they say nothing we accept.
 * WebM/Ogg carry their magic at offset 0; ISO-BMFF (mp4/m4a) puts the `ftyp` box
 * type at offset 4, after the box length.
 */
export function detectAudioMediaType(buffer: Buffer): SttMediaType | null {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "audio/webm";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return "audio/mp4";
  }
  return null;
}

/** A decoded, validated recording ready to forward upstream. */
export interface DecodedSttAudio {
  mediaType: SttMediaType;
  ext: string;
  /**
   * The backing store is pinned to `ArrayBuffer` (not the default
   * `ArrayBufferLike`) because a bare `Buffer` is not a `BlobPart` — widening it
   * forces a copy of the whole recording into the `Blob` below.
   */
  buffer: Buffer<ArrayBuffer>;
}

export type SttDecodeError = "BAD_FORMAT" | "TOO_LARGE";

/**
 * Validate + decode the `audio` data URL from an STT POST. Trust the BYTES, not
 * the client-declared MIME: the declaration only picks which container we expect,
 * and a recording whose magic bytes disagree with it is REJECTED rather than
 * guessed at — an mp4 announced as webm would otherwise reach the upstream
 * demuxer under a filename its own contents contradict.
 */
export function decodeSttAudio(raw: unknown): { audio: DecodedSttAudio } | { error: SttDecodeError } {
  const match = typeof raw === "string" ? DATA_URL.exec(raw) : null;
  if (!match) return { error: "BAD_FORMAT" };
  // Buffer.from never throws on malformed base64 (it stops at the first bad
  // char), so no decode-failure branch is reachable here.
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) return { error: "BAD_FORMAT" };
  if (buffer.length > MAX_STT_AUDIO_BYTES) return { error: "TOO_LARGE" };
  const mediaType = detectAudioMediaType(buffer);
  if (!mediaType || mediaType !== match[1]) return { error: "BAD_FORMAT" };
  return { audio: { mediaType, ext: MIME_EXT[mediaType], buffer } };
}

/** A transcript, or the English upstream detail for the server log. */
export type TranscribeResult = { ok: true; text: string } | { ok: false; detail: string };

/**
 * POST the recording to the OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * Deliberately the NATIVE global fetch with NO dispatcher: the STT service lives
 * on the internal docker network, which the corporate HTTP proxy cannot reach.
 * Do NOT adopt webFetchTools' `EnvHttpProxyAgent` here — honouring
 * `HTTP_PROXY`/`HTTPS_PROXY` would send every transcription out through the
 * proxy and fail closed on a deployment that sets them.
 */
export async function transcribeAudio(target: SttTarget, audio: DecodedSttAudio): Promise<TranscribeResult> {
  const form = new FormData();
  // The filename extension comes from the SNIFFED container, so the upstream
  // demuxer is never handed a name the bytes disagree with.
  form.append("file", new Blob([audio.buffer], { type: audio.mediaType }), `audio.${audio.ext}`);
  form.append("model", target.model);
  form.append("response_format", "json");

  try {
    const res = await fetch(`${target.url}/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}${raw ? `: ${summarize(raw)}` : ""}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, detail: `unparseable response: ${summarize(raw)}` };
    }
    const text = (parsed as { text?: unknown } | null)?.text;
    // A 200 without a `text` string is not an empty transcript, it is a service
    // answering something else (a JSON error body, a different API). Surfacing it
    // as "" would read to the user as "nothing was said".
    if (typeof text !== "string") {
      return { ok: false, detail: `response has no text field: ${summarize(raw)}` };
    }
    return { ok: true, text: text.trim() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Collapse an upstream body to one loggable line. */
function summarize(raw: string): string {
  return raw.replace(/\s+/g, " ").slice(0, 500);
}
