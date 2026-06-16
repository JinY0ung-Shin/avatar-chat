# src/client — Claude notes (Svelte + Vite frontend)

Client-side cautions. Read alongside the **root `CLAUDE.md`** "Frontend" + CSP sections (architecture,
build commands, SSE chat protocol, language split). This file adds client-specific detail not covered there.

## Structure
- **Svelte 5 + Vite**, rooted at `src/client/`. Entry `index.html` → `src/main.ts` → `App.svelte`.
  Views in `src/views/*.svelte`, reusable components in `src/components/*.svelte`, non-UI logic in
  `src/lib/*.ts`. Built by `vite build` → `dist/client` (served by `app.ts`).
- **`src/lib/state.ts` is the central store.** `appState` is a Svelte `writable`; mutate via
  `updateState(fn)` (mutate-then-reassign; also recomputes `streaming`), read via `readState()`,
  patch via `replaceState(patch)`, toast via `notify(msg, kind?, {actionLabel?, action?})`. Svelte
  reactivity comes from the store subscription (`$appState`) — there's no manual `renderView()` like
  the old vanilla code; just update the store and the template re-renders.
- **Server types are shared, not re-declared.** `src/lib/types.ts` re-exports from
  `../../../server/types.js` (and `tsconfig.client.json` includes `src/server/types.ts` +
  `routineSchedule.ts`). Import server types through that barrel.
- **The old vanilla frontend lives in git at `f0a6128`** (`git show f0a6128:public/js/<file>`) — the
  parity reference. The stylesheets were carried over verbatim into `src/client/styles/*.css`, so
  reproduce the OLD DOM structure + class names rather than inventing new ones (the CSS already fits).

## Theme (light / dark / system) — `src/lib/theme.ts`
- **One device-local preference, resolved in JS, applied as an attribute.** `localStorage["noah-theme"]`
  is `system` (default) | `light` | `dark`; `applyTheme()` resolves it (system →
  `matchMedia('(prefers-color-scheme: dark)')`) and sets `<html data-theme="dark">` (light removes the
  attr). `watchSystemTheme()` re-applies on OS change only while the pref is `system`. The rail-footer
  button cycles 시스템→라이트→다크.
- **The dark token block is SINGLE-SOURCE: `:root[data-theme="dark"]` in `00-tokens.css`**, NOT a
  `@media (prefers-color-scheme: dark)` duplicate — so light/dark values can't drift. There IS a
  deliberate ~3-line `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` fallback
  setting ONLY `--bg`; it stops matching once JS sets `[data-theme]`, and its sole job is to kill the
  first-paint light flash for OS-dark users — keep it minimal.
- **The inline-`<script>`-in-`<head>` anti-FOUC trick is impossible** (CSP `script-src 'self'` blocks
  inline scripts). The CSS-only `--bg` fallback above is the substitute; any first-paint theming must
  stay CSS-only.

## CSS gotchas (`src/client/styles/*.css`)
- **Input chrome comes ONLY from `.field input`, not a global rule.** The global
  `button,input,select,textarea` rule (`10-base.css`) sets just `font`/`color: inherit` — no global
  border/padding/radius/focus-ring. All input styling is the canonical `.field input, .field select, …`
  rule (`20-shell-chat.css`) and applies ONLY inside a `.field` ancestor. A bare `<input>` in a custom
  row renders unthemed — new form controls MUST sit inside `.field` or fold into that canonical selector.
- **Code-block colors are deliberately FIXED across light AND dark** via `--code-*` tokens
  (`00-tokens.css`). Do NOT remap them to semantic `--ok`/`--danger` (those invert in dark and are
  unreadable on the always-dark code surface).
- **Undefined CSS custom props fail silently.** `var(--undefined)` with no fallback renders invalid with
  no console error. Scan after CSS edits.
- **Tabs (Settings AND Admin) use `.settings-tabs`/`.settings-tab`** (icon + `<span>` label). A custom
  `.tabbar` class has NO CSS and renders unstyled.
- Global stylesheet + `{@html}`-rendered markdown share class names — avoid bare generic class names
  (e.g. `main`) on dynamically-rendered nodes; the activity-tree root uses `is-main`, not `main`
  (`.main { height: 100dvh }` once stretched the box). Svelte component `<style>` is scoped, but the
  carried-over global CSS and `{@html}` output are not.

## Client ↔ server contracts mirrored by hand
No shared module across the TS/Svelte ↔ server boundary, so the client re-implements several server
validators. Update these in lockstep:
- `normalizeTags` (`lib/format.ts`) ↔ server `normalizeHashtags`
- repo-href building ↔ server `githubHost` resolution
- the schedule builder (`RoutineModal.svelte` + `formatRoutineSchedule`/`timeToMinute`/`minuteToTime`
  in `lib/format.ts`) ↔ server `routineSchedule.ts` (daily/weekly/interval semantics)

## Behavior gotchas (don't "fix" these)
- **Group-knowledge toggle saves a per-USER default, fire-and-forget with NO readback.** A new chat pane
  seeds `groupKnowledgeOff` from `state.user.groupKnowledgeOffDefault` (own-avatar panes only; colleague
  chats / existing conversations pass their persisted per-conversation value). This is what lets the
  toggle reach the **auto-greeting** (fires before the composer is touched — the value rides the
  greeting's chat POST). The toggle updates `state.user.groupKnowledgeOffDefault` optimistically and PUTs
  `/api/me/group-knowledge-default` in the background; it deliberately does NOT sync `state.user` from the
  response (rapid toggles resolve out of order; the optimistic value is the latest pick) and only toasts
  on failure. Don't "fix" this into an await-and-sync.
- **The model/effort picker is per-conversation-ONLY — no per-user default**, unlike the group-knowledge
  toggle above (which DOES persist a per-user default via `groupKnowledgeOffDefault`). The model/effort
  choice is made per chat and does not seed new conversations; don't add a per-user default for it.
- Some settings cards (profile/visibility/secrets) save WITHOUT a full reload to avoid wiping unsaved form
  text — preserve in-place updates there.
- **Splitting a multi-tab view into per-tab components: ALWAYS-MOUNT + `active` prop, never `{#if tab}`
  around the child.** In a monolithic tab view, `{#if settingsTab===…}` only swaps the *template* branch
  while the single `<script>`'s `let` form vars (typed-but-unsaved fields) persist across tab switches.
  Rendering each new child *inside* `{#if}` unmounts it on every switch and silently loses that state.
  Faithful split: render all tab components UNCONDITIONALLY (always mounted) and pass
  `active={settingsTab === "…"}`; each child gates only its own template (`{#if active && user}`) and
  initializes form state ONCE at script-init from `readState().user` (safe — tabs only mount inside the
  parent's post-`load()` `{:else if user}` branch). Same unsaved-form concern as the bullet above, now
  spanning a component boundary. `SettingsView.svelte` is the worked example (1,013→130 lines; tabs in
  `components/Settings{Profile,Access,Knowledge}Tab.svelte`); the groups tab stays inline (delegates to
  `SettingsGroupCard`, holds no cross-tab form state).

## Verification
- **`npx svelte-check --tsconfig ./tsconfig.client.json`** is the real client type/template check
  (also `npm run lint:client`); `npx tsc --noEmit` covers shared server types. `vite build` (`npm run
  build:client`) is the production compile; `pretest` runs `vite build --mode test` so a client compile
  break fails the test gate. ⚠️ Don't trust `npm run lint` — the rtk hook misrewrites it to eslint.
- **The UI cannot be runtime-verified here** — corporate `HTTP_PROXY` intercepts `localhost`, no browser
  engine is installed, and the app talks to a separate deployment (no local DB). So changes ride on
  svelte-check + careful reading + the `f0a6128` parity reference + a human browser smoke test.
