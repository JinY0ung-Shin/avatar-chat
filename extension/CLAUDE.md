# extension — Claude notes (browser bridge)

The Chrome/Edge extension half of the browser bridge. Read with the **root
[`CLAUDE.md`](../CLAUDE.md)** (§"Browser control is a RELAY…" and §"The browser bridge is a
SIGNED artifact"), install/policy detail in **[`README.md`](README.md)**, and mechanics in
**[`../docs/architecture/browser-bridge.md`](../docs/architecture/browser-bridge.md)** (a 5-page hub —
start with its `contract.md`). This folder ships
to users' machines as a SIGNED artifact — a mistake here fails in the FIELD, not in CI.

Durable constraints for this layer:

- **`background.js` imports TWO pure modules at load — `axtree.js` and `secretInput.js`.** Both are on
  `BUNDLE_FILES` and both are byte-pinned in `tests/infra.test.ts`, because a bundle missing either one
  bricks the WORKER, not just the feature it belongs to: an MV3 module worker whose import fails never
  registers, so every browser op dies with the extension simply unreachable.
- **Every file that should ship MUST be listed in `BUNDLE_FILES`** (`../src/server/browserExtensionBundle.ts`).
  The bundle is an explicit allowlist, NOT a directory walk — a stray key or note dropped here never
  reaches a user, but a real new file (icon, page, script) that you forget to add silently bricks the
  shipped zip. A **binary** file additionally needs `BINARY_BUNDLE_FILES`, or the one-click updater pushes
  it through utf8 and corrupts it. Neither failure shows in CI unless you also add a byte-equality pin to
  `tests/infra.test.ts` (the icon PNGs are pinned there).
- **The four `icon-*.png` are load-bearing and MUST stay tracked in git.** `manifest.json` names them, so a
  missing/corrupted icon makes Chrome refuse to load the WHOLE extension (not a graceful degrade). They are
  also on `BUNDLE_FILES` + `BINARY_BUNDLE_FILES`; every consumer reads them off disk with a throwing
  `fs.readFileSync`, so an untracked icon 500s `GET /api/browser-extension.zip`, breaks the release build,
  and fails two test files.
- **`manifest.json` `key` IS the extension's identity.** The id derives from it, and four places move
  together when it changes: this manifest, the `browserBridge.ts` default id, `README.md`'s example id, and
  any admin policy-registry path naming the id. The private half lives ONLY on the release machine; losing
  it orphans every install. The build script refuses to run on a mismatch and prints the bootstrap list.
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` (`browserExtensionBundle.ts`) is a fleet-wide reinstall order.** Raise
  it ONLY when the agent-facing op contract actually breaks — never merely because this folder changed.
  Below the floor, every install badges orange in the composer. `tests/infra.test.ts` enforces
  min ≤ bundled manifest version.
- **The extension FETCHES NOTHING on its own, and that is a security decision.** The 0.7.0 self-updater page
  (updater.html/js/css) was removed in 0.9.0 because fetch-verify-write-reload is dropper-shaped — Windows
  Defender quarantined the shipped zip over it. Do NOT reintroduce `host_permissions` or any network call
  here. `CDP_ALLOWLIST` in `background.js` stays default-deny (no `Storage.*`; of `Runtime.*` ONLY
  `Runtime.evaluate` behind `read_storage` — the ONE documented page-JS exception, a FIXED bridge-authored
  expression selected by store kind, NOT `Runtime.enable`, because `DOMStorage` is not exposed to
  `chrome.debugger`; of `Network.*` ONLY the consent-gated, current-origin `Network.getCookies` behind
  `read_cookies`). Both reads
  gate on ONE unified per-(host, data type) consent (`dataConsentGrants`): the first read of a site+type
  each browser session prompts a popup (approving cookies never approves localStorage/sessionStorage, and
  vice versa; approval remembered in `chrome.storage.session`, revocable in the options page, cleared on
  browser close) and is audited by KEY NAME only. **`secret` is a FOURTH grant kind in that same store
  (0.28.0), the only one that WRITES** — typing a stored secret into a login field — **and the only one
  whose grant is SESSION-WIDE instead of per site**: it is remembered under the sentinel key
  `SECRET_SESSION_GRANT_HOST` (`"*"`, exported from `secretInput.js`), so the first secret typed in a
  browser session prompts and no allowed site prompts again until the user revokes it or closes the
  browser. `requestDataConsent(host, type, extra, grantKey = host)` is what splits the two: the popup
  always shows the REAL host, only the memory is keyed by `grantKey`. The per-SITE decision for a secret
  lives one layer up (the owner's per-secret host allowlist, re-checked at the keyboard every write), so
  the session grant widens nothing — and the consent copy must say exactly that, or the popup reads as
  approving one site. Adding a kind means
  three places move together: `DATA_CONSENT_COPY` (background.js), the `kind=` branch in `consent.js`, and
  `DATA_TYPE_LABELS` in `options.js` (which `grantedTypes` now enumerates, so a kind can never be
  promptable but unrevokable); a kind keyed by a SENTINEL needs a fourth — the row label in `options.js`
  (`grantRowLabel`), or the list shows a bare `*` that reads as a wildcard site.
- **A SECRET write is a deliberately NARROWER write than an ordinary one, and the narrowing is the
  feature.** The plaintext arrives on `secretText` / a field's `secretValue` — never `text`/`value`, so a
  pre-0.28.0 build reads `message.text || ""` and types NOTHING; keep that property when touching the
  branch. Then: `secretWriteRefusal` gates on tab host → FRAME host (`refDocumentUrl`; an OOPIF is
  attributed through its OWN session because backendNodeIds are per-PROCESS — measured in
  `tests/visual/password-facts.spec.ts`, and a root-session capture would answer with the TOP page's URL,
  which is the allowed host) → password shape → consent, all before a single key. The popup goes LAST
  because it names the field kind it asks about: prompting and then refusing on shape asks the user
  about a write that could not happen, and their approval would leave a session-WIDE grant behind for it
  (the `secret` grant is keyed by sentinel, so a stray approval is not even scoped to one site). The write itself goes
  through `writeSecretField`, NEVER `clearAndWrite`: every end state of the clearing ladder QUOTES what
  the field landed on and rungs B/C re-enter the value twice more. Verification is a LENGTH comparison
  against a read-back Chromium masks (`•` per character), and no note, error or throw may ever carry the
  value. `extension/secretInput.js` holds the pure half and is not wired to the value at all —
  `tests/browser-secret-input.test.ts` pins that structurally.
- **A browser op is a FIVE-layer hand-synced contract** (`agent/browserTools.ts` → `agent/events.ts` →
  `routes/chat.ts` relay → client `lib/browserBridge.ts` → `background.js perform()`); nothing type-checks
  across the gap, so a field missed in the middle arrives `undefined`. `chat.ts` is the PRIMARY size bound on
  extension-supplied strings — `browserTools.report()` adds only a defensive snapshot cap for old
  builds — so any new relayed field must be `.slice()`d there.
- **A capture's pixel mapping is MEASURED from the returned bitmap, and a viewport capture is fitted to
  the size Claude's API will resize it to.** `pxPerCss = scale × zoom × dsf` PREDICTS a bitmap Chrome has
  not produced yet: issue #66 measured every pixel `click_at` landing a constant ≈×1.145 off — consistent with a
  bitmap 7/8 of that prediction — while a tall capture is ALSO resized again by the API (standard tier:
  1568 px per edge, 1568 visual tokens of 28×28 px; ×1.60 on a 1400×2197 shot), so the model answers
  in a pixel space nobody here had computed. So `captureShot` parses
  the JPEG's SOF dimensions (`jpegDimensions`) and stores `imageWidth`/`imageHeight` +
  `pxPerCssX`/`pxPerCssY`, keeping the formula only as the fallback, and the VIEWPORT branch takes its
  `scale` from `viewportShotScale`, which shrinks until `visionFits` holds. Element/fullPage captures
  stay unfitted on purpose (uid fractions are scale-invariant; fullPage never feeds coordinates). The
  tier constants (`VISION_STANDARD_MAX_EDGE`/`VISION_STANDARD_MAX_TOKENS` in `axtree.js`) mirror
  https://platform.claude.com/docs/en/build-with-claude/vision (fetched 2026-09-02) and the server keeps
  an INDEPENDENT TypeScript port for old installs (`agent/visionImage.ts`) — when the documented limits
  move, both move.
- **Language split applies INSIDE this folder.** `background.js`/`axtree.js` strings are ENGLISH on purpose —
  they are model-facing input (refusal reasons, error text the agent reads). Everything a PERSON reads
  (`options.html`, `consent.html`, `action.default_title`, `README.md`) is KOREAN. `manifest.json`
  `description` and `policy-schema.json` are the easy misses.
- **`options.html` is BOTH the action popup and the options tab.** As a popup it shrinks to the body, so
  `options.css` must keep an explicit body width or the popup balloons to Chrome's 800px cap. Setting
  `action.default_popup` means `chrome.action.onClicked` will never fire — do not add a listener for it.
- **Verify manifest changes by LOADING the extension, not by reading it.** Chrome loads an extension with an
  invalid `externally_connectable` pattern (dropping the entry as a warning), so "it loaded" is not evidence
  a pattern works. Drive real `chrome-extension://` pages with Playwright's Chromium
  (`launchPersistentContext` + `--load-extension`) and always run a negative control.
