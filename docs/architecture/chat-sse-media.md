# Chat, SSE, and generated media

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> SSE sessions and history, image attachments, `share_file` / PPTX / draw.io delivery, and the visual canvas.

## Chat / SSE / sessions
- **Chat is SSE, and an owner turn can be driven from anywhere in the client.**
  `POST /api/chat/stream {avatarId, message, conversationId?}` streams events
  `open`(→conversationId,runId)/`delta`/`status`/`tool*`/`done`/`error`; omit `conversationId` and the
  server mints one (returned on `open`). Consume with `consumeSse(body, (event,data)=>…)`. Interactive
  prompts are answered out-of-band: `POST /api/chat/respond {runId, requestId, value}` — `value` is
  `{behavior:"allow"|"deny"}` (permission) or `{cancelled:true}`/`{result}` (question). An owner messaging
  their OWN avatar is viewerIsOwner+elevated+autoApprove, so `mcp__*` tools auto-approve with no prompt.
- **Chat keeps context across turns via SDK session *resume*, not history re-injection.** Each
  `sdk.query()` is stateless: `runClaudeAgent` passes `resume: <sessionId>` and the `init` event's
  `session_id` is persisted to `conversations.agent_session_id` (`get/setAgentSessionId`). SDK transcripts
  live under `config.agentSessionsDir` (`dataDir/agent-sessions`, pinned via `CLAUDE_CONFIG_DIR` in the SDK
  `env` option) so resume survives a restart. `greeting` (ephemeral) and `regenerate` (re-runs a turn)
  start a fresh session. SDK `cleanupPeriodDays` (default 30) sweeps old transcripts — conversations idle
  >30d resume as new.
- **A streamed answer must survive completion/reload.** The live bubble shows every main-agent `delta`;
  on `done`/reload it's rebuilt from the PERSISTED `response.text`, NOT `live.text`. So `response.text`
  must be the full streamed transcript (`partialText` in `claudeAgent.ts`, preferred over the SDK terminal
  `result` which is the LAST turn only) — else pre-final-turn narration vanishes the instant the run
  completes. Cancel/error paths persist the server-side `streamedText` accumulator (`routes/chat.ts`).
- **Tool permissions go through one gate:** the `PreToolUse` hook (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` are unused (don't fire headlessly). Auto-approve applies on the
  `!headless && elevated && autoApprove` path — **`elevated` = owner OR trusted user**, not owner-only;
  headless routines and plain colleague chats stay read-only. But `isAutoAllowed` auto-allows EVERY
  `mcp__*` tool at the hook BEFORE that check, so any in-process MCP server MUST self-gate in its handlers.
- **The CLI bounds SDK callback hooks with a per-hook abort (10 min default, `hh=600000` in the CLI;
  CLIs before 2.1.218 misreport the abort to the model as a USER REJECTION).** Our gate legitimately
  parks awaiting the owner's modal answer, so the PreToolUse matcher pins `timeout` (SECONDS) to
  `PROMPT_TTL_MS/1000 + 60` — the run registry always settles a parked prompt (answer / 30-min TTL /
  run end) BEFORE the CLI gives up. This bit since CLI 2.1.212 made subagents background-by-default:
  their prompts now arrive after the visible turn, i.e. typically unattended. When the prompt resolves
  with NO answer (TTL/stop), `onPermission` returns `{behavior:"deny", unanswered:true}` and the hook
  words the deny as "went unanswered — not a refusal" (+ an `onBlocked` notice), never as a user refusal.
- **Background SUBAGENTS bypass the permission gate entirely — the hook forces every Task/Agent spawn
  foreground** (`run_in_background:true` rewritten to `false` via `updatedInput`).
  Verified on the bundled CLI 2.1.222 (subagents background-by-default since ~2.1.198): a background
  subagent's tool calls consult NEITHER SDK-callback hooks NOR `canUseTool` NOR even bare `allowedTools`
  entries, and every permission-needing call is auto-denied with user-refusal wording ("The user doesn't
  want to take this action right now"), which the avatar relays as the user having refused. Upstream
  treats the subagent-hook gap as known/unplanned (claude-code #34692, #27661). Bash KEEPS
  `run_in_background` (a running shell makes no further tool calls, and timeout auto-backgrounding is
  Bash-only), so the background phase below still exists — it is just Bash-fed now. Re-verify on every
  SDK bump and drop the rewrite once bg subagents inherit the session's permission wiring.
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is the blunt alternative — strips `run_in_background` from
  tool schemas entirely, but kills Bash background tasks too.)
- **Background phase (`run_in_background` tasks outliving the visible reply).** A `query()` is NOT one
  model turn: with live background tasks (Bash `run_in_background` — subagent spawns are forced
  foreground, see above) the SDK emits the first
  `result` but KEEPS the process alive, wakes the model when a task settles (`task_notification`), and
  streams follow-up turns, each ending in another `result`; the iterator only ends when everything
  settled (empirically verified on SDK 0.3.220). Background-task state is **per-process** — a `resume`
  in a new process cannot recover it, which is why the phase must ride the ORIGINAL run. Wiring:
  `background_tasks_changed` (level signal, REPLACE semantics) → `LoopState.backgroundTasks` +
  `onBackgroundTasks` → SSE `bg_tasks`; every `result` fires `onTurnResult` with the text SINCE the last
  boundary (`segment*Start` indexes in `claudeAgent.ts`). The chat route finalizes the visible turn at
  the FIRST boundary that has live tasks (persist + `done{background:true}`, run kept open,
  `markRunBackground` → 409s get a background-specific message), persists each wake-up turn as a NEW
  assistant message (`bg_message`, tail-sliced via `persisted*Offset`), and emits `bg_end` when the
  iterator drains. Cancel during the phase KILLS the tasks (abort → subprocess dies): the cancel/error
  paths persist only the tail past the last boundary, and the client seals still-running activity rows
  as **failed** (not "done") via `snapshotActivity(pane, terminal)` before the stopped bubble. Client
  keeps `streaming=true` through the phase (stop button = the kill switch), renders the `bg-task-note`
  chip from `pane.backgroundTasks`, keeps the live tree mounted until `bg_end`, then re-PUTs the sealed
  snapshot onto the first message (`backgroundMessageId`). Replay-safety: every message push dedupes by
  id (a reattach replays the whole event log). Known v1 limits (deliberate): a new user message still
  409s during the phase, and a server restart kills pending background work — both stated in the
  standing prompt guidance (`promptBuilder.ts`) and `describe_system`.

## Image attachments
- The user message can carry images. The composer stages images (`ChatPane.pendingImages`, downscaled to
  ≤1568px + base64 in `ChatView.svelte`), POSTs them on `images: [{id, data}]`. `routes/chat.ts`
  validates/decodes up front (`chatImages.ts` → `decodeChatImages`, before SSE), writes bytes to
  `dataDir/chat-images/<conversationId>/<id>.<ext>` (NOT in SQLite — only `MessageAttachment` metadata
  persists via `messages.attachments_json`), and feeds the model `AgentRequest.images` THIS turn. Served
  by owner-scoped `GET /api/conversations/:id/images/:imageId` (`resolveStoredImage` guards traversal).
  Bubbles render from the pane's `localImages` (data URL, instant) then fall back to that serving URL on
  reload. **Client canvas resize loads the source via a `data:` URL (FileReader), NOT
  `URL.createObjectURL` — a `blob:` URL is blocked by the prod CSP, a prod-only trap.** **Feeding images
  REQUIRES switching `sdk.query`'s `prompt` from a string to an `AsyncIterable<SDKUserMessage>` (text block
  + image blocks) — `claudeAgent.ts` `buildImageQueryPrompt`, taken ONLY when `request.images?.length`;
  text-only turns keep the unchanged string path. `resume` works in both modes.** Regenerate re-reads the
  prior user turn's stored attachments from disk (`readChatImages`). `express.json` limit was bumped
  3mb→40mb. Conversation delete sweeps the image dir (`deleteConversationImages`).
- **Vision gating is PER-RUN, per-model-tier** (`modelVisionPolicy.ts`): effective vision =
  admin per-tier policy (`app_config` row `model_vision_policy`, admin panel "모델별 이미지 입력";
  `{tierId: boolean}`, absent tier inherits) ∘ deployment default (`MODEL_VISION=off` env). Resolution
  mirrors the model chain (`env pin > user tier > admin override > default`; a concrete model id can't
  consult the tier policy → deployment default). When the RUN's model is text-only, every path that
  would put image bytes in MODEL input is cut off BEFORE the API can 400 the whole turn — upload POST
  rejects (`turnVisionEnabled` in routes/chat.ts; the composer hides the attach UI via
  `paneVisionEnabled` off bootstrap `modelSelection.tiers[].vision`/`defaultVision`; `addImages` is the
  single client intake), the PreToolUse hook denies `Read` on raster/PDF paths (must fire BEFORE the
  read-only auto-allow; SVG stays readable; redirect: `pdftotext` for PDFs, `show_file` to show the
  USER), Confluence tools return a note instead of MCP image blocks (per-run `ctx.visionEnabled`), and
  the regenerate re-feed is skipped. Surfaced in the standing prompt (`noVisionSection`) +
  describe_system. `show_file`/slide previews are unaffected (user-facing only).

## Generated-file delivery + PPTX deck pipeline (`share_file`, hidden publishes)
- **`chatFiles.ts` mirrors `chatImages.ts` for agent-GENERATED documents** (there is deliberately NO
  upload path): `mcp__file_output__share_file` → `onShareFile` (routes/chat.ts) → `publishWorkspaceFile`
  (same realpath+roots containment; extension allowlist pptx/docx/xlsx/zip/pdf/csv/md/txt/drawio with
  magic-byte checks for the container formats; 30 MB cap) → bytes at
  `dataDir/chat-files/<conversationId>/<id>.<ext>`, metadata on `messages.attachments_json` as
  `kind:"file"` (+`size`). Download route `GET /api/conversations/:id/files/:fileId` is owner-scoped and
  ALWAYS `Content-Disposition: attachment` (never inline; `?name=` only picks the sanitized save-dialog
  name — the client card passes it). Sweeps: conversation bulk/single delete + regenerate mirror the
  image sweeps, and **user-delete (routes/admin.ts) snapshots the owner's conversation ids BEFORE
  `store.deleteUser`** to rm both chat-images and chat-files dirs (the rows are gone afterwards).
- **`MessageAttachment.hidden`** = published for URL use only: `show_file` with `hidden:true` stores the
  image + returns its serving URL to the model (for canvas markdown embeds), but every ChatView render
  loop filters hidden entries. Per-turn caps: 6 visible images (unchanged), 30 hidden, 3 files —
  enforced in the `onFile`/`onShareFile` handlers, counted per kind off `shownAttachments`.
- **Deck (PPTX) pipeline**: bundled `pptx` skill = python-pptx authoring (NanumGothic — 맑은 고딕 is not
  in the image, LibreOffice would silently substitute) → `share_file`. **Delivery previews are
  SERVER-AUTOMATIC**: the `onShareFile` handler calls `renderDocumentPreviews` (deckRender.ts —
  async execFile soffice→pdf with an isolated profile, then `pdftoppm -l 30`; **direct pptx→png
  converts only the FIRST slide**; pdf skips soffice; also docx/xlsx) and attaches the pages via
  `savePreviewImages` (chatImages.ts, trusted-input hidden PNGs) — best-effort, a render failure
  still delivers the file. The agent renders manually (scripts/render_deck.sh + hidden `show_file`
  + ONE canvas markdown) only for mid-work review/self-check. **Availability = boot-time probe**
  (`deckRender.ts`, memoized `spawnSync` soffice/pdftoppm/python-pptx — a NEW pattern, nothing else
  probes at boot), threaded per-run like `fileOutputEnabled`: `AgentRequest.deckRenderingEnabled`
  (probe && fileOutput) drives the promptBuilder `deckSection`, `SystemToolsContext.deckRenderingAvailable`
  the describe_system line (UNAVAILABLE → "admin must rebuild the image"). Docker: `libreoffice-impress` +
  `fonts-nanum` + `poppler-utils` via apt mirror; `python-pptx` is NOT in Debian → pip at build with
  `PIP_INDEX_URL`/`PIP_TRUSTED_HOST` build-args (compose passthrough).
- **draw.io viewer (.drawio share): preview is CLIENT-side, not a deckRender format.** `drawio` sits in
  the `chatFiles.ts` allowlist (mediaType `application/vnd.jgraph.mxfile`, no magic — text like csv/md/txt)
  but deliberately NOT in `PREVIEWABLE_EXTENSIONS`: `FilePreviewPanel.svelte` fetches the file and renders
  it with the **vendored draw.io viewer** (`src/client/public/drawio/`, pinned upstream tag — see its
  README for provenance/upgrade). The ~4 MB global script is NOT in the Vite bundle; `lib/drawioViewer.ts`
  injects a same-origin `<script>` on first use. **Verified under the app CSP: no `unsafe-eval`, no
  iframe.** Gotchas: (1) the `window.*_PATH` asset globals MUST be set before the script evaluates (the
  loader does) or they default to diagrams.net URLs; (2) only the basic/arrows/flowchart/bpmn stencil sets
  are vendored — other `shape=mxgraph.*` sets render as labeled placeholder boxes; drop more XMLs from the
  SAME upstream tag into `stencils/` to extend (no code change); (3) expected noise: one
  `/drawio/math/startup.js` request that 404s/nosniff-blocks per session (MathJax intentionally not
  vendored); (4) the render target div must NOT have the `mxgraph` class (the script's load-time auto-scan
  would double-process it); (5) the viewer lays out for the width it was created at — the panel repaints
  (debounced) on resize; (6) compressed `<diagram>` payloads render fine (the viewer inflates them), but
  the `drawio` skill tells the agent to AUTHOR uncompressed so later turns can edit the XML.
- **Regenerate caveat:** replacing the last assistant turn deletes its attachments (images AND files),
  so a canvas from the REPLACED turn loses its embedded slide images — accepted (regenerate means
  "redo the turn"; the new run re-renders and re-shows).

## Visual canvas (`mcp__canvas__show`, experimental `canvas` feature)
- CSP-SAFE port of Superpowers' visual companion: the avatar DECLARES content
  (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional `controls` (buttons/text); the CLIENT renders
  sanitized content (DOMPurify; mermaid `securityLevel: strict`; **`vega` = a compact Vega-Lite spec
  compiled+rendered to an SVG STRING via the CSP-safe `vega-interpreter` AST evaluator — no `Function`
  ctor, so `script-src 'self'` is untouched**; all lazy-loaded with a source-`<pre>` fallback) + real form
  controls — no avatar JS runs, CSP unchanged. `canvasTools.ts` (NOT self-gated — registration is the
  boundary) registered in `claudeAgent.ts` ONLY when the avatar OWNER enabled `canvas` AND
  `events.onCanvas` exists. Controls park the run via the SAME `awaitResponse`/`/api/chat/respond` path as
  `onQuestion`; display-only returns immediately. **A parked (blocking) form must stay ENABLED while
  `pane.streaming` is true** — the answer posts to `/api/chat/respond` MID-run and the run resumes only on
  submit/skip, so `CanvasPanel` locks on `streaming` only for the new-turn paths (async submit, re-submit,
  content edit); locking the blocking form deadlocks the question (8aed88d regression). While parked the
  frame handler pins the status line to `캔버스 응답을 기다리는 중…`, suppressing the periodic `tool_progress`
  status ticks (`실행 중: 캔버스 표시`) until the park resolves; the curated MCP tool labels live in
  `shared/sdkToolPresentation.ts` (`MCP_TOOL_LABELS`) so server status line and client activity rows agree.
  Artifacts persist on `AgentResponse.canvases` and rebuild
  on reload (`canvasesFromMessages`); live via SSE `canvas` event → `CanvasPanel.svelte`. **Refine-in-place:**
  `show` takes an optional `canvasId`; reusing it UPDATES that artifact (client `handleCanvas` +
  `canvasesFromMessages` AND server `record()` all upsert by id, latest-wins). **Size-cap:** `canvasTools.ts`
  rejects over-`MAX_CANVAS_CONTENT_CHARS` content (it rides every `resume` turn's transcript).
