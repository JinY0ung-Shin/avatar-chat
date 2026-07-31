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
- **Done** (with the `public`-removal + avatar-sharing work): the co-membership join now lives in ONE
  module-scope fragment, `SHARING_TEAMMATES` in `src/server/store/avatars.ts` (incl. the
  `groups.avatar_sharing` gate), shared by `VISIBILITY_WHERE` (list + search), `groupTeammateIds`,
  `shareAnyGroup`, and `sharedGroupNames`. Parity is pinned by the store scope-parity + avatar-sharing
  matrix tests.

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

### T3.8 — Close the `ext::sh` arg-injection asymmetry 🔒 SECURITY — ✅ DONE (2026-07)
- **Done:** `assertSafeGitValue` (leading dash + `scheme::` remote-helper) now lives in `repoGitGuards.ts` as the SINGLE arg-safety validator, re-exported through `repoGitCore.ts` and used by **all four** clone paths: `gitRepos.ts` (unchanged behavior), `knowledgeRepo.ts` + `groupKnowledgeRepo.ts` (previously leading-dash only), and `marketplace.ts` `assertSafeArg` (the plugin clone path, also previously leading-dash only). Unit matrix in `infra.test.ts`, clone-path tests in `routes-repo.test.ts`.
- **Measured while fixing:** `ext::` was never actually reachable — git refuses it by default (`fatal: transport 'ext' not allowed`, verified on git 2.43.0). The defense was git's default protocol policy, NOT app code, so `protocol.ext.allow`/`GIT_ALLOW_PROTOCOL` or a differently-built git would have re-opened it. The validator no longer depends on that default.
- **Deliberately NOT changed:** the validator stays transport-agnostic. Local paths must keep cloning — `register_repo` accepts them by design and every offline repo test clones from a local bare remote. Source/host POLICY is a separate layer (see the `isInternalGitSource` note below).

### T3.11 — `isInternalGitSource` failed open on unparseable hosts 🔒 SECURITY — ✅ DONE (2026-07)
- **Files:** `gitCredentials.ts`, entry points `routes/knowledgeRepo.ts` + `routes/groups.ts`
- **The issue:** `isInternalGitSource` returned `true` when `gitHostFromSource` yielded `null`. That branch was already dead for `owner/repo` shorthand (handled above it), so its only effect was to admit values with NO parseable host — bare filesystem paths and `scheme::` syntax — past the single check that enforces "the knowledge repo must live on the internal GitHub host". `looksLikeRepo` accepts anything ending in `.git`, and `marketplaceCloneUrl` passes non-shorthand values through unchanged, so `/data/knowledge/<otherUserId>/.git` cleared every gate.
- **Impact (verified by reproducing the clone):** any authenticated user could connect their knowledge repo to another user's clone under `dataDir/knowledge/<id>`, or a group repo under `dataDir/group-knowledge/<id>` they were not a member of, then read it back via `/api/me/knowledge-repo/{contents,note,graph}` and the agent's `mcp__repo__read_file` / `mcp__brain__search`. No tool access required — plain HTTP. Group admins had the same path for group repos, exposing the target to every member.
- **Done:** the `host === null` fail-open is gone — a non-shorthand source must have a PARSEABLE host equal to the internal host. Regression tests at both route entry points plus an `isInternalGitSource` unit matrix.
- **risk:** high (security) · **effort:** S

### T3.9 — zod-ify HTTP bodies + `asyncHandler`
- **Files:** `src/server/routes/*`, `index.ts`
- (a) Shared validators (`parseSelected`, `parseKnowledgeRepoBody`) — low risk, can do anytime.
- (b) Full zod schemas + Express-5/`asyncHandler` so the central error middleware becomes reachable — **changes error responses**, so it's a behavior change, out of scope for a pure restructure. Defer (b).
- **risk:** med · **effort:** M · **breaking:** (b) yes

### T3.10 — audit remaining untracked template function calls (Svelte 5 legacy)
- **Files:** `src/client/src/components/Shell.svelte` (`isConversationBusy`/`isConversationStreaming`),
  `src/client/src/views/ChatView.svelte` (`canPickModel`)
- Same class as the fixed CONFLUENCE_PAT save-button bug (ARCHITECTURE-NOTES §Svelte 5 runtime gotchas):
  the template calls a helper whose BODY reads reactive state → compiled with `$.untrack` → the attribute
  goes stale until an unrelated invalidation. These are currently masked by coincident list/store
  refreshes (unverified). Verify each with a Playwright fixture, then convert to `$:` derived maps the
  template reads DIRECTLY. Helpers reading only their arguments are fine — leave them.
- **risk:** low · **effort:** S · **breaking:** no

---

## Coverage gaps (not refactors — flagged)
- **`rateLimit.ts` ~26% covered; ZERO tests assert a 429.** Security-adjacent, can silently regress. Add an integration test (hammer an endpoint past the window → expect 429). low/M.
- **`scheduler.ts` tick / due-job selection loop is untested.** Add a due-selection unit test. low/M.
  Partially addressed (2026-07): `tests/scheduler.test.ts` now covers the FAILURE path (timeout-cause
  substitution, partial-output persistence, non-timeout errors) by mocking `runAgentStream` so a run can
  hang until the deadline aborts it. The **tick / due-job selection loop itself is still untested.**
- `claudeAgent.ts` ~36% is expected (the SDK subprocess path); the pure helpers are covered — lower priority.

---

## Recommended order when picking this up
1. Cheap + independent: the two coverage-gap tests, T3.9(a).
2. After Tier-1/2 settle: T3.2 → T3.5 (test-guarded, medium).
3. T3.1 (Store split) — dedicated review + full test run, solo.
4. Deliberate/risky, each on its own: **T3.8 (security review)**, **T3.7 (confirm bug + test)**, then T2.6 (browser-verified), T3.4/T3.6.
