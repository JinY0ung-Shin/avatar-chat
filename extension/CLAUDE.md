# extension — Claude notes (browser bridge)

The Chrome/Edge extension half of the browser bridge. Read with the **root
[`CLAUDE.md`](../CLAUDE.md)** (§"Browser control is a RELAY…" and §"The browser bridge is a
SIGNED artifact"), install/policy detail in **[`README.md`](README.md)**, and mechanics in
**[`../docs/architecture/browser-bridge.md`](../docs/architecture/browser-bridge.md)** (a 5-page hub —
start with its `contract.md`). This folder ships
to users' machines as a SIGNED artifact — a mistake here fails in the FIELD, not in CI.

Durable constraints for this layer:

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
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` (`browserExtensionUpdate.ts`) is a fleet-wide reinstall order.** Raise
  it ONLY when the agent-facing op contract actually breaks — never merely because this folder changed.
  Below the floor, every install badges orange in the composer. `tests/infra.test.ts` enforces
  min ≤ bundled manifest version.
- **The extension FETCHES NOTHING on its own, and that is a security decision.** The 0.7.0 self-updater page
  (updater.html/js/css) was removed in 0.9.0 because fetch-verify-write-reload is dropper-shaped — Windows
  Defender quarantined the shipped zip over it. Do NOT reintroduce `host_permissions` or any network call
  here. `CDP_ALLOWLIST` in `background.js` stays default-deny (no `Runtime.*`/`Storage.*`; of `Network.*`
  ONLY the consent-gated, current-origin `Network.getCookies` behind `read_cookies` — the first read of a
  site each browser session prompts a popup (approval remembered in `chrome.storage.session`, revocable in
  the options page, cleared on browser close) and is audited by cookie NAME only).
- **A browser op is a FIVE-layer hand-synced contract** (`agent/browserTools.ts` → `agent/events.ts` →
  `routes/chat.ts` relay → client `lib/browserBridge.ts` → `background.js perform()`); nothing type-checks
  across the gap, so a field missed in the middle arrives `undefined`. `chat.ts` is the PRIMARY size bound on
  extension-supplied strings — `browserTools.report()` adds only a defensive snapshot cap for old
  builds — so any new relayed field must be `.slice()`d there.
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
