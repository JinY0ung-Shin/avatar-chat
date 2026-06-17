# src/client — Claude notes (Svelte + Vite frontend)

Client-area direction. Read with the **root [`CLAUDE.md`](../../CLAUDE.md)** ("Frontend"/CSP, build,
SSE chat, language split). The detailed mechanics (state store API, theme single-source, every CSS
gotcha, the Svelte 5 timing traps, hand-mirrored validators, Playwright verification recipe) live in
**[`../../docs/ARCHITECTURE-NOTES.md`](../../docs/ARCHITECTURE-NOTES.md) §Client**. Design language →
[`../../docs/DESIGN.md`](../../docs/DESIGN.md).

Durable principles for this layer:

- **Svelte 5 + Vite under `src/client/`, NOT vanilla `public/`** (migrated 2026-06). `lib/state.ts` is the
  central writable store — mutate via `updateState`, read via `readState`; reactivity comes from the
  `$appState` subscription, there's no manual `renderView()`.
- **Stylesheets were carried over VERBATIM from the old vanilla frontend** (same filenames, same class
  names). So porting/restoring a feature = reproducing the SAME DOM structure + class names — don't invent
  new ones (a custom class with no CSS renders unstyled). The old frontend is the parity reference at git
  `f0a6128`. Server types are SHARED via the `lib/types.ts` re-export barrel, never re-declared.
- **`app.ts` serves a strict same-origin CSP** (`script-src`/`connect-src` `'self'`). So: no inline
  `<script>` (the build emits none), no `blob:`/remote `<img>`, no `Function`-ctor renderers — any
  first-paint theming or content rendering must stay CSP-safe (the canvas/theme designs are built around
  this). Widen a directive in `app.ts` only when a feature genuinely needs it.
- **A green svelte-check does NOT mean the behavior is correct.** For interaction/layout/timing changes,
  runtime-verify (Playwright fixture). svelte-check catches type/template errors; it shipped a no-op
  `autosize` fix that only a real-DOM measurement caught.
- **No shared module across the client↔server boundary**, so several server validators are re-implemented
  by hand (`normalizeTags`, repo-href, the schedule builder). Update them in lockstep with the server.
- **Splitting a multi-tab view: ALWAYS-MOUNT children + an `active` prop, never `{#if tab}` around the
  child** — wrapping in `{#if}` unmounts and silently loses typed-but-unsaved form state. Several settings
  cards also save WITHOUT a full reload for the same reason; preserve those in-place updates.
