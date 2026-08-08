# Browser bridge — extension release and environment

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> The signing key and update channel, build-time origins, verified Chrome/Edge facts, corporate DLP, and local verification.

- **The signing key IS the extension's identity.** It lives off-repo on the release machine only;
  manifest `key` is its public half and Chrome derives the id from it. Change the key and the id
  changes — `extension/manifest.json`, the `browserBridge.ts` default id, `extension/README.md`, and any
  admin policy path naming the id must move together, and every install reloads once (done 2026-08-07:
  `fbohmmep…` → `gdaheigee…`). The build script refuses to run on a manifest/key mismatch and prints the
  exact bootstrap list.
- **One auto-update channel, one key: the POLICY channel** (signed `.crx` + Omaha `updates.xml`,
  Chrome `ExtensionSettings force_installed`, zero user action). The extension-side GitHub
  self-updater (0.7.0's `updater*.js`, removed in 0.9.0) is deliberately gone and must not come
  back: fetch-verify-write-reload is dropper-shaped — Windows Defender quarantined the shipped zip
  over it (`Trojan:Win32/Fauppod.A!cl`) — and it carried real attack surface (`github.com`
  host_permissions + a disk-write path). The extension fetches NOTHING on its own.
  `browserExtensionUpdate.ts` / `browserExtensionCrx.ts` are RELEASE-TIME modules — only
  `scripts/build-browser-extension-update.ts` and tests import them; never pull them onto a request
  path, because a server holding the signing key turns a server compromise into fleet-wide browser
  control. The policy's update_url reads `releases/latest/download/…`, so EVERY release must attach
  both assets.
- **Origins are BUILD-TIME for the policy channel.** Chrome enforces `externally_connectable` before any
  extension code runs and a policy install cannot be hand-edited, so a missing Noah address fails
  SILENTLY on every machine (`chrome.runtime` simply isn't there — no error to see). The manual zip path
  needs none of this: the download route stamps the requesting origin into that bundle's manifest.
- **Chrome facts verified by experiment, not by docs.** `externally_connectable` match patterns IGNORE
  the port (a pattern with no port matched a `:48787` page ⇒ writing a port grants EVERY port on that
  host); the scheme IS matched; IP literals are valid; trailing `/*` is mandatory. Chrome LOADS an
  extension whose pattern is invalid, dropping the entry as a warning — **"it loaded" is not evidence a
  pattern works; always run a negative control.** GitHub redirects release-asset downloads to
  `release-assets.githubusercontent.com`, not `objects.*` (a 404 probe never redirects, which is why
  this hid until real assets existed) — it bit the since-removed self-updater's `host_permissions`
  and applies to any future extension-side GitHub fetch (there is none today, by design).
- **Corporate DLP can intercept the browser's file dialog** ("not an allowed upload URL"), which kills
  every File System Access path on managed machines — that is why the policy channel exists. The
  no-dialog interim is "unzip in Explorer + `chrome://extensions` ↻". Don't try to code around it.
- **Edge is served by the SAME build.** Every API the extension touches (`tabGroups`/`tabs.group`,
  `debugger`, `storage.managed`, `externally_connectable`) is on Edge's supported-API list, and the id
  derives from the manifest `key` identically, so one zip/crx covers both browsers. The only per-browser
  fork is the ADMIN POLICY TREE — the same JSON registered once under `Software\Policies\Google\Chrome`
  and once under `Software\Policies\Microsoft\Edge` (Linux: `/etc/opt/chrome` vs `/etc/opt/edge`); the
  build script prints both. User-facing guidance resolves the extensions page at runtime instead of
  hardcoding `chrome://` (`extensionsPageUrl()` in `lib/browserBridge.ts`).
- **Verifying extension behavior locally:** Playwright's Chromium loads the unpacked extension
  (`chromium.launchPersistentContext(dir, { channel: "chromium", args: ["--disable-extensions-except=<extension/>",
  "--load-extension=<extension/>"] })`), which drives real `chrome-extension://` pages and settles what a
  match pattern actually does. Only `@playwright/test` is installed (no `playwright`/`playwright-core`,
  and `node_modules/.bin` has no `playwright` symlink). Ad-hoc harness — not committed as a test.
