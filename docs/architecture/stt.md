# Speech-to-text (composer mic → `/api/stt`)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The mic button's wire contract, why the clip crosses as a data URL, the limits that make an
> unauthenticated GPU service safe to sit behind, and the knobs for the self-hosted engine.

Self-hosted transcription for the chat composer, **opt-in twice**: with no endpoint configured (neither
`STT_URL` nor the admin override below) the mic button is never rendered, and the compose service sits
behind a `stt` profile that a plain `docker compose up` ignores. Operator-facing setup is [`../../README.md`](../../README.md#speech-to-text-optional).

## Wire contract
- **Three hops, two encodings.** The browser records a clip → `POST /api/stt` with a JSON body carrying
  it as a base64 **`data:` URL** → the server decodes + validates the bytes and re-sends them as
  **multipart `file=`** to `POST <STT_URL>/audio/transcriptions` (OpenAI's transcription shape) →
  the route answers `{ text }`, which the client drops into the chat input. The encoding switch is the
  whole point of the middle hop: JSON-in / multipart-out keeps the browser on the app's existing
  same-origin JSON path while the upstream gets the standard OpenAI form.
- **A model name is sent on every upstream request** — the admin override's, else `STT_MODEL` (default
  `Qwen/Qwen3-ASR-1.7B`) — and must equal what the upstream serves, vLLM's `--served-model-name`. A
  mismatch is a 404 from vLLM, not a fallback, so it surfaces as a failed transcription rather than a
  silently wrong model. The base URL is normalized (trailing slashes stripped) on the way IN on both
  paths — `config.ts` for the env value, the admin route for the stored one — so a copy-pasted
  `.../v1/` is safe and `resolveSttTarget` can hand out either without re-normalizing.
- **A 200 without a `text` string is a FAILURE, not an empty transcript.** The route asks for
  `response_format=json` and requires `text` to be a string; anything else (a JSON error body, a
  different API answering on that port) becomes a 502 rather than an empty string, which the user would
  read as "it didn't hear me". That single field is the whole compatibility surface an alternative engine
  has to satisfy.
- **Error mapping follows the language split**: the user gets one Korean `apiError` line per case —
  503 (no endpoint resolved), 400 (unsupported container / too large), 502 (upstream unreachable, non-2xx, or
  timed out) — while the English upstream detail (status, body excerpt, timeout) goes only to the server
  log. The upstream call has its own 60s `AbortSignal.timeout`, and time spent queued behind
  `--max-num-seqs` counts against it.
- **The mic is a composer input, not an agent capability.** Transcription finishes BEFORE the message is
  sent; the agent receives ordinary text. So there is nothing to add to `buildSystemPromptAppend` or
  `describe_system` — the avatar has no STT tool, no per-turn guidance, and no state to report. This is
  the deliberate exception to the metacognition rule in [`../../CLAUDE.md`](../../CLAUDE.md): the
  capability belongs to the composer, not to the run.

## Admin-managed override
- **Resolution is per REQUEST and the ADMIN value WINS: `override ?? env`** (`resolveSttTarget` in
  `stt.ts`, the single seam both `routes/stt.ts` and `/api/bootstrap` call). The stored shape is
  `{ url, model | null }`, with a null model inheriting `STT_MODEL`, so an operator who only re-points
  the URL keeps the deployment's model name. Nothing is resolved at boot — a change takes effect on the
  next mic click, no restart. **This is the INVERSE of `MODEL_OVERRIDE_KEY`**, where an env
  `ANTHROPIC_MODEL` shadows the panel: a deployment pins its agent model deliberately, while an STT
  endpoint is operational plumbing (the GPU box moves, the port changes) that has to be re-pointable
  without a redeploy. Don't "fix" the inconsistency by flipping one of them — they differ on purpose.
- **Storage is `app_config` via `setAppSecret`** (`STT_OVERRIDE_KEY`, JSON), so it is AES-encrypted with
  `SESSION_SECRET` like every other at-rest value. Rotating that secret therefore drops the override
  SILENTLY and the deployment falls back to env — the same rotation caveat as the rest of the vault
  (`src/server/CLAUDE.md`), and the reason `getSttOverride` treats anything unreadable or malformed as
  "no override" instead of throwing: a garbled row must degrade to env, never 503 every mic click.
- **There is deliberately NO boot-time seeding of the env values into the DB.** A seed-if-unset write
  re-fires on every `new Store()` (the same trap as a value-guarded backfill), so it would resurrect an
  override an admin had just cleared, and it would freeze the first-ever `STT_URL` into the DB where
  later `.env` edits are silently ignored. The panel reads `sttEnvUrl`/`sttEnvModel` off
  `GET /api/admin/system` and renders them as the inherited fallback instead.
- **`sttEnabled` rides `/api/bootstrap`**, which the client reads at page load — so a user who was
  already signed in when the endpoint was configured sees the mic on their NEXT load, not immediately.
  There is no push channel for it, and adding one would buy little: the route itself is the authority
  and 503s coherently either way.
- **Trust stance: sysadmin-only, audited, http(s)-only.** `PUT`/`DELETE /api/admin/stt` sit behind
  `requireAuth` + `requireAdmin` and write `set_stt_override` / `clear_stt_override` audit rows; the URL
  must parse as `http:`/`https:` and is normalized (trailing slashes stripped) exactly as `config.ts`
  does for the env value. Same trust model as an admin-managed external-agent endpoint: an operator who
  can already re-point the deployment's `.env` is the only one who can re-point this, and every
  recording thereafter goes to whatever they named — so the audit row, not a validation rule, is what
  makes the change accountable.

## Where the pieces live
- `src/server/routes/stt.ts` — the route: auth, rate limit, and the 503/400/502 mapping to one Korean
  `apiError` line each.
- `src/server/stt.ts` — decode + validate the data URL, then the upstream call. **Mirrors
  `chatImages.ts`** (data-URL regex → decode → size cap → magic-byte sniff), including the
  "`Buffer.from` never throws on malformed base64" caution. Two audio-specific deltas: the regex must
  TOLERATE codec parameters (`data:audio/webm;codecs=opus;base64,…` — MediaRecorder stamps its codec into
  the type it reports and the client echoes it verbatim), and the sniffed container must AGREE with the
  declared one or the clip is rejected rather than guessed at. Accepted containers are what the fleet's
  browsers actually record: `audio/webm` (Chrome/Edge), `audio/ogg` (Firefox), `audio/mp4` — WebM/Ogg
  carry their magic at offset 0, ISO-BMFF puts `ftyp` at offset 4. **The bytes are never stored** — no
  data-volume namespace, nothing for `deleteUser` to sweep, unlike every other client-fed binary.
- `src/client/src/lib/stt.ts` — the MediaRecorder lifecycle, the 60s hard stop (`STT_MAX_MS`, a timer
  that auto-stops into the transcribing phase), the container negotiation (`MediaRecorder.isTypeSupported`
  down a candidate list, so what the fleet's browser actually supports decides the type), and the upload.
  The clip becomes a named `File` fed to the SHARED `readFileAsDataUrl` (`lib/dom.ts`) rather than a
  hand-rolled `FileReader` — the same helper the image-attach path uses.
- `src/client/src/views/ChatView.svelte` — the composer wiring, and **`Alt+M`, which is the mic button
  reached from the keyboard**: a `<svelte:window on:keydown>` that calls the SAME `toggleVoiceInput` the
  click does (start when idle, stop→transcribe when recording), so no second recording path exists. It
  matches on `event.code === "KeyM"` rather than `event.key`, which keeps it working on non-QWERTY
  layouts, and requires `altKey` with `ctrlKey`/`metaKey`/`shiftKey` all clear — the ctrlKey exclusion is
  what drops **AltGr** (Windows/Linux report it as ctrl+alt), so European layouts keep typing their
  Alt-Gr characters. The target pane is the composer holding focus, falling back to the only pane when
  the view is unsplit and to nothing when several panes are open with focus elsewhere; a take already
  running owns the shortcut outright, so its stop half works from anywhere. It is gated on `sttEnabled`
  and on chat being the active view — App.svelte swaps one top-level view at a time so the listener
  already dies with the component, but the check keeps it honest under the always-mount pattern used
  elsewhere.
- **`sttEnabled` on `GET /api/bootstrap`** (`routes/auth.ts`) is the client's only signal, following
  `confluenceConfigured`: a boolean derived from the RESOLVED target (config ∘ admin override), never the
  URL itself. The composer renders the
  mic button on it. Absent (older server) = disabled, so the flag is safe to add to `BootstrapInfo` as
  optional.

## End-of-speech auto-stop (Silero VAD)

- **The VAD is an endpoint DETECTOR and nothing else.** It watches the SAME `MediaStream` the recorder is
  already fed and calls the existing stop when speech ends (~1.4s of silence); the `MediaRecorder`
  lifecycle, the container negotiation, the data-URL upload, the server's decode/validate, and the
  upstream engine contract are all untouched. Nothing downstream can tell whether the take was stopped by
  the VAD or by a click — which is the property to preserve: a change that makes the detector produce
  audio, choose the container, or talk to `/api/stt` has crossed out of its job.
- **Every asset is same-origin and lazy.** `@ricky0123/vad-web` + `onnxruntime-web` ship the Silero
  `.onnx` model, the ort `.wasm` binaries, and the audio worklet as static files served from this origin,
  imported on the FIRST mic use rather than at page load, so a user who never records pays nothing. ort
  runs SINGLE-THREADED wasm on purpose: cross-origin isolation (`COOP`/`COEP`) buys threads at the cost of
  headers that would break other same-origin embeds, and one utterance does not need them. Do not
  reintroduce a CDN default for the asset paths — the CSP's `connect-src 'self'` would block it and the
  failure looks like a broken mic, not a blocked fetch.
- **Init failure degrades SILENTLY to today's behavior.** If the model or the wasm fails to load — old
  browser, missing asset, wasm compilation refused — the recording still starts and still stops on the
  manual click and the 60s cap. The auto-stop is an affordance layered on the existing path, never a
  precondition for it, so no error is surfaced for it. The composer's "말이 끝나면 자동으로 멈춰요" hint
  follows the same rule: it renders only after the detector reports itself armed (`onAutoStopArmed`), so a
  degraded take is never PROMISED an auto-stop it will not get.
- **A 10s no-speech timeout cancels the take WITHOUT an upstream call.** Armed only when the VAD is
  actually live (a degraded take has no such timer, since nothing would be listening for the speech that
  cancels it): a mic opened by accident in a silent room discards its own clip instead of spending GPU
  time on a transcription of nothing.

## Security properties
- **`requireAuth` (`src/server/auth.ts`) runs BEFORE a per-user rate limit** (`createRateLimiter`,
  20/minute, keyed on the user id — the order is load-bearing, `keyFn` needs a user to key on). Keying on
  the user rather than the IP is deliberate: the fleet sits behind a shared corporate NAT, where an
  IP-keyed bucket would let one talkative user throttle a whole office. Both matter more here than on a
  typical route — the endpoint is a GPU-time amplifier, so it is DoS-shaped long before it is data-shaped.
- **15MB cap, enforced on the DECODED length, not the base64 string** (`MAX_STT_AUDIO_BYTES`). Base64
  inflates ~4/3, so the express `json({ limit: "50mb" })` ceiling (raised for chat images) is far too
  loose to be the real bound. It is intentionally looser than the client's 60s recording limit: the
  composer can't produce a 15MB clip, so this cap only ever catches a request that bypassed it (see the
  three-caps note under GPU tuning).
- **Magic-byte sniff.** The declared MIME in the data URL only picks which container is expected; the
  bytes decide, exactly as `detectImageMediaType` does for images, and disagreement is a rejection. The
  filename sent upstream (`audio.<ext>`) is derived from the SNIFFED type, so the upstream demuxer never
  gets a name its own contents contradict.
- **The STT container publishes no host port.** vLLM's OpenAI server has no auth of its own and would
  happily transcribe for anyone who can reach port 8000, so the compose service is deliberately
  network-internal (`http://stt:8000`) and Noah's authenticated route is the only door. Adding a
  `ports:` mapping — even "just to test" — removes the only thing gating it.
- **The upstream fetch deliberately bypasses the corporate-proxy dispatcher.** `STT_URL` names a
  container on the compose network; routing it through the `EnvHttpProxyAgent` used by
  `agent/webFetchTools.ts` would send internal traffic to an external proxy that cannot resolve it (the
  same reason the Dockerfile healthcheck uses `curl --noproxy '*'`). Use a plain `fetch` here and keep
  the proxy dispatcher for genuinely outbound calls. Because there is no dispatcher at all, `NO_PROXY`
  has no effect on this path either way: an STT service sitting BEYOND the corporate proxy would need a
  code change, not an env tweak.

## Why the client uses a data URL
- **The CSP has no `blob:`** (`app.ts`: `default-src 'self'`, `img-src 'self' data:`, `connect-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`),
  and it is not getting one — that narrowness is what neutralizes several exfiltration and injection paths
  for the untrusted markdown the avatar renders. `MediaRecorder` itself is unaffected, but everything
  downstream of it is: with no `media-src` of its own the directive falls back to `'self'`, so a
  `blob:` object URL will not load in an `<audio>` preview, and `connect-src 'self'` blocks fetching one
  back. The recorded `Blob` therefore goes through `FileReader` into a `data:` URL, the same house pattern
  as `canvasExport.ts`'s `copyPng` and `browserClipboard.ts`. A `URL.createObjectURL` version works in a
  bare page and dies under Noah's own headers — a confusing failure to debug, so don't reintroduce it for
  local playback either.
- **`'wasm-unsafe-eval'` in `script-src` is the ONE deliberate widening the mic cost us**, and it is
  narrower than its name reads: it permits WebAssembly COMPILATION (`WebAssembly.compile` /
  `instantiate`, which the VAD's ort runtime needs) and nothing else. It does not enable `eval`, the
  `Function` constructor, or inline `<script>` — the injection paths this CSP exists to close against the
  untrusted markdown the avatar renders stay closed, and a DOMPurify miss still cannot execute. Nor does
  it open an exfiltration path: the wasm bytes are fetched under `default-src`/`connect-src 'self'`, so
  the only module the browser will compile is one this origin served. Widen no further — `'unsafe-eval'`
  (a superset that DOES enable JS eval) and `'unsafe-inline'` stay out.

## Swapping the engine
- **The resolved base URL is the entire seam** (`STT_URL` or the admin override — same contract either
  way). Anything serving OpenAI's `/v1/audio/transcriptions` contract drops in with no code change: **speaches / faster-whisper** on a CPU-only host (the fallback when a
  deployment has no GPU to spare, or when the pinned vLLM build turns out not to expose transcriptions
  for Qwen3-ASR), or an **internal STT API** later. Keep it that way — resist adding engine-specific
  request fields to the route; anything Qwen-specific belongs behind the URL, not in `routes/stt.ts`.
- **Phase-2 option, not built: Qwen3-ASR context priming.** The model accepts a text context that biases
  decoding toward supplied vocabulary — the natural fix for internal product names, team jargon, and
  acronyms that generic ASR mangles. It is deliberately deferred because it is the one feature that would
  make the route engine-specific; if it lands, gate it on the served model and keep the plain path intact.

## GPU tuning (shared 8–12GB card)
- The flags live in `docker-compose.yml`'s `stt` service and are sized for a card shared with other
  workloads, not for throughput: **`--gpu-memory-utilization 0.7`** (vLLM claims that fraction of the
  WHOLE device up front, including memory another process already holds — lower it further on a busy
  GPU), **`--max-num-seqs 4`** (mic input is one short utterance at a time; extra requests queue rather
  than fail), **`--max-model-len 4096`** (must cover audio tokens + transcript for the longest clip;
  raising it reserves more KV cache, so raise it only alongside a longer recording cap).
- **THREE caps bound one recording, and they must move together.** The client hard-stops at 60s
  (`STT_MAX_MS`, an auto-stop timer — not a hint), `--max-model-len 4096` is sized for exactly that, and
  the server's 15MB `MAX_STT_AUDIO_BYTES` is deliberately looser than either: it is a byte-level backstop
  for a request that did NOT come from our composer, not the normal path's limit. So raising `STT_MAX_MS`
  alone silently pushes clips past the upstream's context, where they fail as the generic 502 with the
  real cause only in the server log. Change the duration cap and `--max-model-len` in the same commit.
  A take now has FOUR stop triggers — VAD speech-end (~1.4s of silence), the manual click, the 60s
  `STT_MAX_MS` cap, and the 10s no-speech cancel — but only the 60s cap bounds the LONGEST clip that can
  reach the engine, so it and `--max-model-len` remain the pair that must move together. The VAD makes
  hitting that cap rare; it does not raise it.
- `shm_size: 1gb` is not optional padding — PyTorch shares tensors between worker processes over
  `/dev/shm` and Docker's 64MB default is too small. The healthcheck drives vLLM's `/health` with
  `python3` because curl/wget are not guaranteed in that image, and its 5-minute `start_period` covers
  weight loading + CUDA graph capture on a contended card.
- The deploy host has no Hugging Face access, so the service runs with `HF_HUB_OFFLINE=1` /
  `TRANSFORMERS_OFFLINE=1`: a config or tokenizer path that is not fully local fails immediately instead
  of hanging on a hub lookup. Weights are bind-mounted read-only from `./docker/stt-models` (git-ignored,
  `.gitkeep`-tracked, mirroring `docker/tls`), and the image tag carries a `REPLACE_WITH_PINNED_TAG`
  placeholder so an unedited file fails at pull time rather than drifting onto an arbitrary build.
