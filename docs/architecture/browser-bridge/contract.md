# Browser bridge — wire contract and versioning

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> The five hand-synced layers an op crosses, extension version compatibility, the composer badge, and screenshots.

- **One op crosses FIVE hand-synced layers**, none of which type-check each other:
  `agent/browserTools.ts` (tool + `BROWSER_TOOL_NAMES`) → `agent/events.ts`
  (`BrowserRequest`/`BrowserResult`) → `routes/chat.ts` (parks the op on the SSE run, relays each field,
  writes the audit row) → `src/client/src/lib/browserBridge.ts` (`BridgeOperation`/`BridgeReply`) →
  `extension/background.js`. Then the two metacognition surfaces (`promptBuilder.ts` browser paragraph +
  `systemTools.describe_system`), the Korean progress label in client `lib/chat.ts`, and the tool-group
  description in `shared/mcpToolGroups.ts`. A field missed in the relay arrives `undefined` at the
  extension with no error anywhere.
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` (`browserExtensionBundle.ts`) is a REINSTALL order** — raise it
  only when the op contract breaks. Below it every install badges orange (`outdated`) in the composer.
  `tests/infra.test.ts` pins it at or below the bundled manifest version: above it, even a
  just-downloaded extension badges orange forever, telling users to update to something no download
  provides.
- **The composer badge has FOUR rungs, and `compatible` is the one that keeps getting re-collapsed.**
  `ChatView.svelte` holds ONE `bridgeCompat.level` (`current`/`compatible`/`outdated`/`unreachable`) —
  the reachability and version axes were two fields that always moved together. `compatible` (at/above
  the floor, behind the bundle) is deliberately NOT folded into `current`: it works right now, so the
  temptation is to call it healthy, but that hides an available update. It renders `--info` blue with
  its own "· 업데이트 있음" text and IS clickable into 설정 → 접근/보안; only `current` is an inert span.
  `tests/svelte-chat-bridge-badge.test.ts` pins all of that.
- **`screenshot` is gated on the RUN's resolved vision policy, and with it click_at's PIXEL mode only**
  (`runVisionEnabled` → `BrowserToolsContext.vision`, defaulting to `false` so an unwired caller gets a
  polite refusal rather than an API error; pixel coordinates have no source without a screenshot).
  click_at's UID mode is measured off the element and stays available on a text-only model — gating the
  whole tool left canvas/map surfaces with no escape hatch at all on such a deployment. Both
  metacognition surfaces branch accordingly: click_at is listed unconditionally, and the vision-off
  branch says pixel mode is out while uid mode still works. `routes/chat.ts` caps
  the relayed base64 and whitelists the mime type — the extension is semi-trusted and that string lands
  in an API image block. The caption restates that the pixels are untrusted page content.
- **Every screenshot is AUTO-SHARED to the user** as the same card+slides pair share_file produces:
  `routes/chat.ts` (onBrowser continuation, after the size bound) calls
  `publishBrowserScreenshot` (`chatFiles.ts`) — one visible `kind:"file"` card (chat-files store; its
  image extensions live in `SERVED_IMAGE_TYPES`, deliberately NOT in share_file's `FILE_TYPES`) plus one
  hidden `kind:"image"` slide (chat-images store) linked via `attachment.parentId`, which the client's
  `panelSlides` (`bubbleSegments.ts`) uses to scope panel slides to their own card. MIME comes from byte
  sniffing, never the extension's claim. Outcome rides `BrowserResult.shareNote`/`sharedAttachments`
  (SERVER-INTERNAL fields — not part of the five-layer wire contract): browserTools appends the note to
  the report so the model knows whether the user saw the capture, and claudeAgent's execute wrapper
  stamps the text anchor exactly like the file-output wrappers. Own per-turn budget
  (`MAX_SHARED_SCREENSHOTS_PER_MESSAGE`) so a browsing loop can't exhaust the share_file cap; past it
  (or on publish failure) the MODEL still gets the image — only the user-facing card is skipped, and the
  note says so. Best-effort BY DESIGN: publish failure never fails the tool call.
