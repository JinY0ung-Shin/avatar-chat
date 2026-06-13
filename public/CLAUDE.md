# public — Claude notes

Frontend cautions. Vanilla JS, **no framework, no build step, no bundler**. Read with the root `CLAUDE.md` Frontend + CSP sections.

## Verification is weak here — be conservative
- **`node --check public/app.js` is the ONLY automated check** for `app.js` (the `pretest` hook runs it; `tsc` is server-only). It validates **syntax, not behavior** — there are NO frontend tests, and the app **cannot be runtime-verified in this environment** (corporate `HTTP_PROXY` intercepts `localhost`, no browser engine installed). So any `app.js` change rides on careful reading + `node --check` + a human browser smoke-test. Treat frontend edits as higher-risk than server edits and keep them mechanical/behavior-preserving unless you can have someone load it in a browser.

## Structure
- `app.js` is a single ~7.3k-line module (`<script type="module">`). Splitting it into ES modules is **feasible without a bundler** (CSP `script-src 'self'` + same-origin `/vendor` ESM imports both allow it) but is **deliberately deferred** — see [`docs/REFACTORING-BACKLOG.md`](../docs/REFACTORING-BACKLOG.md) (T2.6). If you do it: ALL shared mutable state + core primitives (`state`, `dom`, `abortController`, `sessionExpired`, `promptQueue`, the `el()` helper, `notify`, the `api`/fetch wrappers, `goView`/`renderView`) MUST live in ONE core module the others import — forking them across modules silently forks state. `app.js` stays the thin entry. Verify the import graph statically (every `import {X} from './y.js'` has a matching export; every path exists) since `node --check` won't.

## Behavior gotchas (don't "fix" these)
- **No reactivity.** After mutating `state` you MUST explicitly call `renderView()` / the relevant render. But some cards (settings profile/visibility/secrets) update **in place** on purpose, to avoid wiping unsaved form text on a re-render — preserve that; don't replace them with a full re-render.
- **`renderExploreGrid` / `renderExploreGridImpl` late-bound indirection is deliberate** (the search box calls the grid before the impl is assigned) — not dead code.
- **`RUNTIME_BADGE_LABELS.claude === null` → no badge.** `.runtime-claude` CSS is unreachable, but `.runtime-blocked`/`.runtime-local` are built dynamically via `runtime-${raw}` (a class-name grep misses them) — keep those CSS rules.
- Dynamically-created elements share the global stylesheet — avoid bare generic class names (e.g. `main`) that collide with layout rules (root CLAUDE.md has the `.agent-node main` cautionary tale).

## Client ↔ server contracts mirrored by hand
There is no shared module across the TS/JS boundary, so the client re-implements several server validators. Update these in lockstep:
- `normalizeTagList` ↔ server `normalizeHashtags`
- repo-href building ↔ server `githubHost` resolution
- the schedule form (`buildScheduleForm` / routine modal) ↔ server `routineSchedule.ts` (daily/weekly/interval semantics)

## CSP
`app.ts` serves a strict same-origin CSP (`script-src`/`connect-src` `'self'`, `img-src 'self' data:`). Remote `<img>` in rendered markdown is BLOCKED and cross-origin fetch is impossible — widen the directive in `app.ts` if a feature needs it. There is no inline `<script>`, so `script-src 'self'` is safe.
