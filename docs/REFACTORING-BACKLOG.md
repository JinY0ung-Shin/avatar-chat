# Refactoring backlog (Tier 3 + deferred)

This is the deferred remainder of the 2026-06 codebase-cleanup pass. **Tier 1** (24 behavior-preserving dedup/cleanup wins) and **Tier 2** (structural god-file splits) have **landed** on the work branch and are verified green (lint clean, build clean, 300 tests pass). What follows is the work that was **intentionally NOT done** because it is larger, riskier, alters behavior, or needs a dedicated review — captured so it isn't lost.

Each item lists: files · why · risk · effort · breaking.

---

## Deferred from Tier 2

### T2.6 — Split `public/app.js` into ES modules — ✅ DONE (2026-06)
- **Done:** `public/app.js` is now a thin entry; feature code lives in `public/js/*.js` with `core.js` as the leaf primitives module (and `public/styles.css` split into `public/styles/*.css`). `pretest` now `node --check`s every module; import graph validated statically. Module map + the core-stays-a-leaf rule are documented in [`public/CLAUDE.md`](../public/CLAUDE.md). **Still needs a human browser smoke-test before relying on it** (no runtime verification in this env).

---

## Tier 3 — larger / riskier (behavior-preserving but needs care)

### T3.1 — Split the `Store` god-class — ✅ DONE (2026-06)
- **Done:** `src/server/store.ts` is now a barrel re-exporting an UNCHANGED public surface. The single `Store` facade is preserved via mixin composition (`store/index.ts` `Store extends ComposedStore`); shared base + schema/migrations live in `store/internal.ts` (`StoreBase`); per-domain method groups + `*Row` interfaces moved into `store/{users,avatars,conversations,groups,routines,knowledgeRepo,secrets,admin}.ts`. All ~110 call sites + `createServices` keep `new Store(config)` + `store.foo()`. Verified by full lint/test/build.

### T3.2 — Centralize the avatar-visibility SQL predicate
- **Files:** `src/server/store.ts`
- **Why:** The `visibility='public' OR id=? OR (visibility='group' AND id IN (teammate subquery))` predicate is duplicated char-for-char in `listPublishedAvatars` + `searchAvatars`, and the teammate join runs a 3rd time in `groupTeammateIds` (every list runs it twice). A shared `visibleAvatarsPredicate()` would enforce the sync the root CLAUDE.md mandates (the `search_avatars` MCP scope must match the browse scope).
- **Why deferred:** Touches discovery + the MCP search scope — verify against the discovery/MCP tests deliberately.
- **risk:** med · **effort:** M · **breaking:** no

### T3.3 — Dedupe the knowledge-repo MCP tool family (3-way, incl. `create_repo`)
- **Files:** `src/server/agent/repoTools.ts`, `groupRepoTools.ts`
- **Why:** Larger version of the Tier-2 `repoToolKit` extraction, now including the `create_repo` body (host/token/name-regex, best-effort seed). Preserve the create→connect→best-effort-seed ordering.
- **risk:** med · **effort:** M · **breaking:** no

### T3.4 — Type the SDK message / hook surface
- **Files:** `src/server/agent/sdkMessageHandlers.ts`, `events.ts`, `preToolUseHook.ts`
- **Why:** ~15 sites thread SDK messages through `Record<string,unknown>` + `asString`/`isRecord`. Hand-authored discriminated unions matching the pinned SDK version would catch field-name typos at compile time. Also fix the stale `PermissionRequest` doc comment (`canUseTool` is unused headlessly).
- **Why deferred:** Large, and coupled to the pinned SDK version.
- **risk:** med · **effort:** L · **breaking:** no

### T3.5 — Make `allowedTools` + `mcpServers` data-driven
- **Files:** `src/server/agent/claudeAgent.ts`
- **Why:** Two hand-synced lists keyed on the same servers — adding a server to one but not the other is a silent bug. Reduce a descriptor array `{name, server, toolNames, active}` into both. Verify against the `agent-core`/`agent-tools` test expectations.
- **risk:** med · **effort:** M · **breaking:** no

### T3.6 — Converge the two git-token context conventions
- **Files:** `src/server/gitRepos.ts`, `knowledgeRepo.ts`, `groupKnowledgeRepo.ts`
- **Why:** `gitRepos` pre-resolves a single token at context-build; the knowledge contexts carry raw `{token, externalToken}` + per-call `tokenForGitUrl`. Adopting `gitRepos`' model removes the "optional for back-compat" debt but **alters when host-routing runs** — needs a token-routing test pass.
- **risk:** med · **effort:** M · **breaking:** no

---

## Explicitly breaking / needs a deliberate decision — DO NOT batch

### T3.7 — Unify the `dirtyPaths` porcelain flag ⚠️ BEHAVIOR CHANGE
- **Files:** `knowledgeRepo.ts`/`groupKnowledgeRepo.ts` (`--porcelain`) vs `gitRepos.ts` (`--porcelain -uall`), parameterized today via `repoGitCore`'s `extraStatusArgs`.
- **The issue:** the knowledge-repo "any changes?" short-circuit currently **misses files inside otherwise-untracked directories**. This looks like a **latent bug, not intent** — but switching to `-uall` everywhere **changes when commits fire**. Confirm it's a bug, add explicit test coverage, then change deliberately.
- **risk:** high (behavior) · **effort:** S

### T3.8 — Close the `ext::sh` arg-injection asymmetry 🔒 SECURITY
- **Files:** `knowledgeRepo.ts`/`groupKnowledgeRepo.ts` vs `gitRepos.ts`
- **The issue:** the `REMOTE_HELPER_RE` (`scheme::`) guard exists ONLY in `gitRepos.assertSafeGitValue`. The knowledge-repo clone paths only check leading dashes, so `ext::sh -c …` isn't blocked there. Consolidate arg-safety into ONE audited validator used by all clone paths.
- **Action:** route through a single validator and run `/security-review`. **Do NOT fold into a routine dedupe PR.**
- **risk:** high (security) · **effort:** S

### T3.9 — zod-ify HTTP bodies + `asyncHandler`
- **Files:** `src/server/routes/*`, `index.ts`
- (a) Shared validators (`parseSelected`, `parseKnowledgeRepoBody`) — low risk, can do anytime.
- (b) Full zod schemas + Express-5/`asyncHandler` so the central error middleware becomes reachable — **changes error responses**, so it's a behavior change, out of scope for a pure restructure. Defer (b).
- **risk:** med · **effort:** M · **breaking:** (b) yes

---

## Coverage gaps (not refactors — flagged)
- **`rateLimit.ts` ~26% covered; ZERO tests assert a 429.** Security-adjacent, can silently regress. Add an integration test (hammer an endpoint past the window → expect 429). low/M.
- **`scheduler.ts` tick / due-job selection loop is untested.** Add a due-selection unit test. low/M.
- `claudeAgent.ts` ~36% is expected (the SDK subprocess path); the pure helpers are covered — lower priority.

---

## Recommended order when picking this up
1. Cheap + independent: the two coverage-gap tests, T3.9(a).
2. After Tier-1/2 settle: T3.2 → T3.5 (test-guarded, medium).
3. T3.1 (Store split) — dedicated review + full test run, solo.
4. Deliberate/risky, each on its own: **T3.8 (security review)**, **T3.7 (confirm bug + test)**, then T2.6 (browser-verified), T3.4/T3.6.
