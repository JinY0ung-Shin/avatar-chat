# Architecture & Operational Notes

Detailed, change-prone reference: file/function/column names, migration mechanics,
refactor history, CSP byte details, test-assertion coupling, and hard-won gotchas.

The `CLAUDE.md` files hold the **durable philosophy and direction**; this file holds the
**operational detail** behind it. When code moves, update here — the principles in
`CLAUDE.md` should rarely need to change.

Companion docs: [`DESIGN.md`](DESIGN.md) (design language), [`REFACTORING-BACKLOG.md`](REFACTORING-BACKLOG.md)
(deferred work, `T*` items), [`SECOND-BRAIN-PLAN.md`](SECOND-BRAIN-PLAN.md).

---

## Build, run, verify

- `npm run dev` — `concurrently` runs `dev:server` (tsx watch, port 48787) + `dev:client`
  (vite, port 5173, proxies `/api`,`/users`,`/fonts` → 48787).
- `npm run lint && npm test && npm run build` — standard verification gate. `lint` =
  `tsc --noEmit` (server) **+ `svelte-check`** (client); `build` = server tsc + `vite build`
  (→ `dist/client`); `pretest` runs `vite build --mode test`, so a client compile break fails
  the test gate.
- **Client checks (run these directly):** `npx tsc --noEmit` and
  `npx svelte-check --tsconfig ./tsconfig.client.json`. ⚠️ The rtk hook misrewrites
  `npm run lint` to eslint and fails — don't rely on it; run the two commands above. `npm run
  build:client` (vite) / `npm run lint:client` (svelte-check) also work. `tsconfig.client.json`
  pulls in `src/server/types.ts` + `routineSchedule.ts` so the client shares server types via
  the `src/client/src/lib/types.ts` re-export barrel — import server types through it.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file (full suite is ~16s); the
  suites are split agent-core/agent-tools/store/infra/app/chat-history.
- `docker compose config` — validate compose/env wiring before Docker changes.
- `CA_CERT_FILE=docker/tls-fullchain.crt docker compose build` — build with a local on-prem CA file.
- **Release = version bump + tag + GitHub release** (since v1.0.0, 2026-07-29; the full procedure
  is encoded as the project **`/release` skill** in `.claude/skills/release/SKILL.md` — keep the two
  in sync; user-facing patch notes (what's-new entry + GitHub notes) require the user's explicit
  sign-off before commit/publish):
  `npm version <x.y.z> --no-git-tag-version` (package.json + lock), commit `chore(release): vX.Y.Z`,
  push main, `gh release create vX.Y.Z --target main --title "Noah Almighty vX.Y.Z" --notes-file <f>`
  (gh is authed on this box; origin = github.com/JinY0ung-Shin/noah-almighty). App semver is
  INDEPENDENT of the what's-new registry (`releaseNotes.ts` keeps date-based ids) — prepend a registry
  entry for user-visible changes either way. The `version: "0.1.0"` strings in the in-process MCP
  servers (`agent/*Tools.ts`) are MCP protocol metadata, NOT the app version — don't bump them.
  **Every release must also attach the two browser-extension assets** (`noah-browser-bridge.crx` +
  `updates.xml`, built by
  `BROWSER_EXTENSION_KEY_FILE=… npm run build:extension-update -- --tag vX.Y.Z`): the enterprise
  policy reads `releases/latest/download/…`, so a release without them breaks the update check for
  the whole fleet. See §Browser bridge.

### Verifying the running app / UI
- Verifying the local server: WHEN a corporate `HTTP_PROXY` is set it intercepts `localhost`
  (returns "Access Denied") — hit the dev server with `curl --noproxy '*' localhost:<port>/...`.
  But the proxy is NOT always present (check `env | grep -i proxy`); with no proxy you CAN install
  a browser engine and runtime-verify isolated UI (Playwright fixture — see client section below).
- Running the FULL app here is impractical (it talks to a separate deployment, no local DB) — so
  feature-level changes ride on svelte-check + careful reading + the `f0a6128` parity reference + a
  human browser smoke test.
- For visual/layout bugs, inspect the *rendered* state (screenshot + DevTools computed styles),
  don't reason from CSS source alone — collisions/inherited rules aren't visible in the source.

### Docker
- `docker build` and `docker run` DO work here. Smoke-test:
  `docker run -d -e SESSION_SECRET=x <img>` then `docker exec <c> curl -fsS --noproxy '*'
  localhost:48787/api/bootstrap` (the unauth health probe + HEALTHCHECK). `SESSION_SECRET`
  is REQUIRED to boot (`NODE_ENV=production`), the image runs as non-root `node` (so `uv` /
  global bins must be world-accessible, NOT symlinked into `/root`), and `docker stop` should
  exit in <1s via the SIGTERM handler in `index.ts`.
- **Native HTTPS mode:** `TLS_CERT_FILE`+`TLS_KEY_FILE` (both, or the boot refuses — never a
  silent HTTP fallback) switch `createAppServer` to `https.createServer`; TLS ends in the app, so
  no proxy read-timeout/buffering sits in front of agent SSE. compose mounts `./docker/tls` →
  `/app/tls` (contents gitignored), HEALTHCHECK probes http then https `-k` (the cert names the
  deploy host, not localhost). Flipping an EXISTING http deployment: set `SECURE_COOKIES=true`,
  and every installed browser-bridge extension keeps answering only the old `http://` origin
  (`externally_connectable` is origin-gated) — users re-download the zip (re-stamped with the
  https origin) or hand-add it; the one-click updater cannot bridge that gap because it rides the
  very page↔extension channel that broke. The container runs as `node` (uid 1000): a root-owned
  mode-600 key in `./docker/tls` reads as EACCES at boot — make the PEMs readable by uid 1000.
- **Dockerfile CA trust is PER-STAGE.** The `CA_CERT_FILE`→`update-ca-certificates` block
  lives in the `base` stage and covers ONLY that stage — an HTTPS fetch (curl/npm/cargo) in a
  *different* earlier stage hits the corporate intercepting proxy with no trusted CA and dies
  `SSL peer certificate ... was not ok`. Put any network step in `base`, AFTER that block.
  (uv is fetched as a pinned prebuilt GitHub-release binary in `base` for exactly this reason;
  rtk — removed 2026-08 along with the whole Bash-rewrite feature, it stalled the single-process
  server with a blocking `spawnSync` per Bash call — originally hit this trap as a `FROM rust`
  `cargo install` builder stage.) Test one RUN step without a full
  build: `docker run --rm node:22-bookworm-slim bash -c '<step>'`.

---

## Server (`src/server/`)

HTTP glue, store, repo plumbing, secrets. Companion to the server-area philosophy in
[`../src/server/CLAUDE.md`](../src/server/CLAUDE.md).

### HTTP layout (after the Tier-1/2 refactor)
- **`app.ts` is thin glue.** `createApp` builds middleware + mounts per-domain routers from
  `routes/`. Handlers live in `routes/{auth,profile,plugins,knowledgeRepo,groups,routines,chat,admin}.ts`,
  each a `(deps) => Router` factory. Shared route helpers (`apiError`, `safeString`, `looksLikeRepo`,
  `avatarDir`, MIME/size/password consts, `AppServices`) live in `routes/_shared.ts`.
  **`createApp`/`createServices`/`expandChatSlashCommand`/`conversationHistoryForPrompt`/`AppServices`/
  `AgentResponse` are still imported from `app.ts`** (re-exported) — don't change those import paths.
- Non-obvious route homes: git-token/secrets/ssh-key/git-identity/**knowledge gap-inbox**
  (`/api/me/knowledge/requests`)/**notifications** all live in `routes/knowledgeRepo.ts`;
  **discovery** (`/api/avatars*`) + **conversations** + the **chat SSE** endpoint live in
  `routes/chat.ts`; `/api/audit` lives in `routes/admin.ts`.
- **Router mount order reproduces the original relative route order**
  (auth→profile→plugins→knowledgeRepo→groups→routines→chat→admin). The error middleware + SPA
  catch-all must stay LAST. Don't reorder mounts.
- The only shared mutable state across routers is the effective model: threaded as an
  `ObservedModelHolder {get,set}` through `deps` (chat router writes via the `onModel` callback;
  `/api/admin/system` reads it). Don't reintroduce a module-level `let`.

### Store (`store.ts` barrel → `store/*.ts`)
- **`store.ts` is a thin barrel; the `Store` facade is COMPOSED from per-domain mixins** (split 2026-06,
  T3.1). `store/index.ts` builds `const ComposedStore = withGroups(withAdmin(…withUsers(StoreBase)))`
  and `export class Store extends ComposedStore`; the shared base + schema/migrations + cross-cutting
  helpers (`db`, `secret`, `count`, `addColumnIfMissing`) live in `store/internal.ts` (`StoreBase`),
  and each domain is a `(Base) => class extends Base {…}` mixin in
  `store/{users,avatars,conversations,groups,routines,knowledgeRepo,secrets,admin}.ts`. The PUBLIC
  surface is UNCHANGED — every caller still does `new Store(config)` + `store.foo()`, and `./store`
  re-exports `normalizeHashtags`/`MAX_HASHTAGS`/the `*_KEY` consts. Compose order is irrelevant
  (method names disjoint), one shared `this.db`/`this.secret`. New methods go in the matching domain
  mixin (or `StoreBase` if cross-cutting).
- **`count(sql, …)` is the only count path** (in the base). Don't hand-roll `(… .get() as {c:number}).c`.
- **Row mappers each have a named `*Row` interface** (`UserRow`/`GroupRow`/`PluginRow`/`GroupMemberRow`/
  `RoutineJobRow`). New mappers follow that — don't use reflective `Parameters<Store["toX"]>[0]`.
- **The co-membership SQL lives in ONE fragment** (T3.2 done): `SHARING_TEAMMATES` in
  `store/avatars.ts` (group_members self-join + `groups.avatar_sharing` gate: NULL/1 = on, only an
  explicit 0 is off — keep the TS `!== 0` reads in lockstep). ALL four consumers build on it —
  `VISIBILITY_WHERE` (list + search share it), `groupTeammateIds`, `shareAnyGroup` (= `isTrustedFor`),
  `sharedGroupNames` — so reach and elevation can never drift apart, and the `search_avatars` MCP
  scope automatically matches the browse scope.
- **Schedule decode lives in ONE place:** `scheduleFromRow` (via `parseDaysOfWeek`, which try/catches
  the `JSON.parse` so a corrupt `days_of_week` row can't abort a scheduler tick). `toRoutineJob` reuses
  it. `create/updateRoutineJob` accept either the legacy flat fields OR a full `RoutineSchedule` object
  (additive, backward-compatible with `{prompt, minuteOfDay}` + NULL `schedule_kind`). When you add a
  schedule field, touch `routineSchedule.ts` + `RoutineJobRow` + this decode together.
- **`deleteUser` does cascade-delete MANUALLY** (no `ON DELETE CASCADE` despite `foreign_keys=ON`). A
  new user-scoped table needs a matching `DELETE` added there or it orphans rows past "permanent deletion."

### Per-user / per-conversation settings mechanics
- **Per-user settings pattern:** add a column to the `users` table + an additive `addColumnIfMissing`
  migration, then mirror it end-to-end
  (`UserRow`→`toUser`→`updateProfile`→`User` type→`PATCH /api/me`→Svelte settings control in the matching
  per-tab component (`SettingsProfileTab`/`SettingsAccessTab`/`SettingsKnowledgeTab`;
  `SettingsView.svelte` is just the tab shell)). A NEW table goes in the always-run schema `db.exec()`
  block (`CREATE TABLE IF NOT EXISTS`) — `addColumnIfMissing` is ONLY for adding a column to an existing table.
- **Per-conversation group-knowledge toggle (owner-only):** `conversations.group_knowledge_off` (JSON
  OFF-set; NULL/`[]` = every group ON) + `get/setConversationGroupKnowledgeOff`. The CLIENT owns the
  selection and sends it on each chat POST (`groupKnowledgeOff`) — there is NO per-conversation PATCH
  endpoint, so it works from a brand-new chat with no row. The chat route turns it into ONE
  `disabledGroupIds` set that filters BOTH `loadAgentPluginRoots` group skill roots AND
  `loadKnowledgeRepoMemory` group CLAUDE.md, and persists it on the row. Colleague turns ignore it
  (always all-on); routines pass no filter.
- **Per-USER default group-knowledge OFF-set:** `users.group_knowledge_off_default` (JSON OFF-set,
  `[]`=all on) + `setGroupKnowledgeOffDefault`, on `User.groupKnowledgeOffDefault`, written by
  `PUT /api/me/group-knowledge-default`. The composer toggle saves here so the choice SEEDS every NEW
  conversation — crucially the **auto-greeting**, which fires before any toggle interaction. Client seeds
  new panes via `defaultGroupKnowledgeOff(avatar)` (own avatar only). Existing conversations still load
  their persisted per-conversation value, which overrides the default for that chat.
- **The composer model/effort/MCP-tool-group pickers remember the owner's last choice** via per-user
  defaults (`users.model_default` / `effort_default` / `mcp_tool_groups_default`), mirroring
  `group_knowledge_off_default`. The setter `store.setChatDefaults` + `PUT /api/me/chat-defaults` write
  them; `toUser` exposes `modelDefault`/`effortDefault`/`mcpToolGroupsDefault` (null = never chosen →
  fall back to the hardcoded server/SDK default; for MCP, `[]` = explicitly all-off as a remembered
  choice). The client seeds new panes from these in `makePane`; the per-conversation `selected_*` value
  still overrides them when resuming an existing thread.
- **What's-new (release notes) notice (#whats-new):** `src/server/releaseNotes.ts` is the shared registry
  (dependency-free leaf in `tsconfig.client.json`, like `experimentalFeatures.ts`) — **PREPEND an entry**
  (Korean `items`, date-based unique `id`, e.g. `2026-07-29` / same-day `2026-07-29.2`) when deploying
  user-visible changes; ordering comes from array position, never id parsing. Tracking:
  `users.last_seen_release` (NULL = never seen — deliberately NOT backfilled, unlike `onboarded_at`:
  existing accounts are exactly the audience for the one-time notice) → `User.lastSeenRelease`;
  `createUser` seeds signups with the then-current id so day-one accounts see nothing. Client: `App.svelte`
  `enterApp` computes `unseenReleases(user.lastSeenRelease)` (≤`MAX_RELEASES_SHOWN`; an UNKNOWN stored id
  — pruned entry / rollback — counts as never-seen, else it would silence every future note) →
  `WhatsNewModal` (root-mounted next to `OnboardingModal`, which takes precedence) → every dismissal path
  fires `POST /api/me/release-seen` (no body; the SERVER stamps its current id via `markReleaseSeen`)
  fire-and-forget, mirroring onboarding. Don't hand-copy the registry client-side.

### Avatar visibility (2-state) — mechanics
- `users.visibility` = `group` | `private` (the `public` state is RETIRED — avatars never reach beyond
  the owner's avatar-sharing groups); `AvatarVisibility` type in types.ts, default `group` for new
  avatars. `migrateVisibility()` folds legacy states (`'public'`, NULL/`''`, the pre-enum `published`
  flag) into `'group'` idempotently on startup; `rowVisibility()` reads anything non-`'private'` as
  `'group'` and no longer consults `published` (the column survives in old DBs, unread). The discovery
  SQL predicate (`VISIBILITY_WHERE`) and `isVisibleTo` (used by `getAvatar`/`resolveChatAvatar`) gate on
  `visibility` over the `SHARING_TEAMMATES` fragment. Owner-self always bypasses the check. Consequence
  of retiring `public`: for native avatars non-owner reach ⇔ trust — the "visible but read-only
  stranger" viewer class survives only for external avatars; the non-elevated code paths stay as a
  fail-closed floor. UI: a 2-option `seg-control` in `SettingsProfileTab.svelte`
  (`PATCH /api/me {visibility}` silently skips invalid values); admin moderation =
  `PUT /api/admin/users/:id/visibility` (400s invalid values incl. the retired `public` — intentional
  asymmetry, both pinned in tests). Admin stats count `groupAvatars` (was `publicAvatars`).

### Trust / elevation — mechanics
- **Trust/elevation is GROUP-ONLY — no per-avatar trust list.** `isTrustedFor` is exactly
  `shareAnyGroup` (symmetric group co-membership); the old directional `avatar_trusted_users` table +
  its store fns (`listTrustedUsers`/`addTrustedUser`/`removeTrustedUser`) + `/api/me/trusted*` routes +
  the 신뢰하는 사용자 settings card are all GONE (table is `DROP`ped in migrate()). To grant elevated tool
  access, add the user to a shared group. `searchUsers`/`GET /api/me/users/search` survive only to
  power the group member-add typeahead. `isTrustedFor` is THE single choke point every elevated/trust
  check flows through (`getAvatar`/`resolveChatAvatar`/`routes/chat.ts` chat `elevated`) — add new trust
  sources THERE, not at call sites.
- **Shared (communal) account (공용 계정)** — `users.shared_account` (per-user settings pattern: column →
  `toUser`/`updateProfile` → `User.sharedAccount` → `PATCH /api/me` → 프로필 탭 공개 설정 카드 토글). When ON,
  trusted same-group teammates chatting with that avatar also get the personal knowledge-repo WRITE
  tools: claudeAgent computes `repoWriteAccess = ownerToolAccess || (sharedAccount && elevatedToolAccess)`
  and passes it as `RepoToolsContext.writeAccess` (defaults to `viewerIsOwner`; still headless-gated).
  Scope is DELIBERATELY narrow: `create_repo`, repo connect/disconnect settings (`knowledgeTools`), group
  repo tools, and every other owner-only tool are untouched; a plain (non-group) viewer stays read-only.
  The write tools' `(owner only)` description suffix is computed per run (`writeGate`) so a shared-account
  teammate turn doesn't self-refuse; `commit` audits the ACTUAL actor (`ctx.viewer`) with a
  `(shared account, owner <username>)` detail when a teammate pushes AND appends a
  `Co-authored-by: <viewer> <username@noah-almighty.local>` trailer (via `commitIdentityFor` on the viewer)
  so git history records the person too — the commit stays authored as the owner. Self-state rides
  `ownerState.sharedAccount` → owner prompt note + teammate-branch writable guidance
  (`promptBuilder`) + a `describe_system` line. Flag lives on the OWNER; toggling it is self-service
  (grants others access to YOUR repo only — no escalation).
- `users.hashtags` is a JSON array of bare tags (`normalizeHashtags`/`parseHashtags` in store.ts) wired
  through the per-user settings pattern, surfaced on BOTH `User` and `AvatarSummary`, edited via
  `HashtagChipEditor.svelte`. Auto-generated like the intro: `POST /api/me/hashtags/generate` mirrors
  `/api/me/intro/generate` (headless, read-only, NOT persisted — parses `#tags` out of the agent reply,
  then `normalizeHashtags`). Searchable in 탐색 (client-side filter in `renderExplore`/`matchesAvatarQuery`)
  AND by the all-viewer read-only `mcp__avatars__search_avatars` MCP (`agent/avatarDirectoryTools.ts`,
  backed by `store.searchAvatars`) — only avatars visible to the viewer, excludes the current avatar.

### Groups
- `groups` + `group_members(role admin|member)` tables (always-run schema). System admin
  creates/deletes groups + assigns group admins (`/api/admin/groups*`); group admins self-serve their
  group's members + repo + policies (`/api/me/groups*`, gated by `canManageGroup` = system admin OR
  group admin). **`isTrustedFor` IS `shareAnyGroup`** → co-members of an AVATAR-SHARING group are
  mutually + SYMMETRICALLY elevated and reach each other's `group`-visible avatars (but NOT each
  other's `private` ones — visibility is a separate axis). Each group has ONE shared **knowledge repo**
  (`groupKnowledgeRepo.ts` mirrors `knowledgeRepo.ts`: full clone at `dataDir/group-knowledge/<groupId>`,
  REUSES its repo-relative file ops; `token` = acting user's `getGitToken`). Members' avatars auto-load
  its skills (`loadGroupKnowledgeRepoRoots`); only group admins edit via the OWNER-ONLY
  `mcp__group_repo__*` server (per-tool role check: member reads, admin
  writes/deletes/moves/commits/`create_repo`). Discovery: `listPublishedAvatars` also returns
  `group`-visible group teammates flagged `sharesGroup`.
- **Per-group avatar-sharing policy** (`groups.avatar_sharing`, `addColumnIfMissing`; NULL/1 = on, 0 =
  off): off makes the group **knowledge-sharing-only** — its co-membership grants NEITHER avatar
  visibility NOR trust/elevation (both ride `SHARING_TEAMMATES`), while the shared repo/brain, tool
  policy (`allowedMcpToolGroupsForUser`), and rosters are untouched. Set via
  `PUT /api/me/groups/:id/avatar-sharing` (`canManageGroup`); echoed on `Group`/`UserGroupMembership`
  (`avatarSharing`). Meta-cognition rides the membership list: groupsSection/describe_system append an
  ", avatar sharing off" marker per group, and the ask_avatar gates (`claudeAgent` `avatarAskActive`,
  promptBuilder, describe_system — 3 hand-synced sites) require `groups.some(g => g.avatarSharing)`.
  Flipping it off fails the NEXT chat turn closed (history preserved), like leaving the group.

### Group shared agents (그룹 에이전트)
- **Several per group** (`group_agents`, uuid `id` PK + `group_id` index), team avatars that are NOT
  users rows: public avatar id `group:<groupId>:<agentId>` (`external:<id>` precedent —
  `conversations.avatar_user_id` has no FK; conversation summaries COALESCE the display name via a
  `group_agents` LEFT JOIN on the composite id). Pre-multi DBs (`group_id` PK, one agent, avatar id
  `group:<groupId>`) are rebuilt by `migrateGroupAgentsMulti` (store/internal.ts — fresh uuid per row +
  conversation-binding rewrite in one transaction) plus `migrateGroupAgentDiskArtifacts` at boot
  (renames the legacy-named image file/workspace tree; idempotent). Managed by `canManageGroup` via
  `POST/PATCH/DELETE /api/me/groups/:id/agents(/:agentId)` (+`/image`); GET `/api/me/groups` carries
  `agents` (disabled included); discovery concatenates `listGroupAgentsForUser` (enabled only) into
  `GET /api/avatars` with the `AvatarSummary.groupAgent` kind tag (`runtime` stays `"native"` — the
  full local SDK stack). Per-agent DELETE cascades THAT agent's conversations (+ disk sweep: image,
  workspace tree, chat image/file dirs from a pre-cascade snapshot); disable stays the
  thread-preserving alternative. `deleteGroup` cascades every agent the same way.
- **Reach = owning-group membership ONLY** through `findChattableGroupAgent` (the single gate used by
  detail/skills/models/chat): independent of `avatar_sharing` (a knowledge-only group still reaches its
  agent), no sysadmin bypass, fail-closed 403/404 shapes; a member-visible DISABLED agent gets a
  dedicated 403. Each member's threads are PRIVATE (`owner_user_id` = viewer) — the team shares via the
  SECOND BRAIN, never the conversation stream.
- **Run kind carries capability** (`AgentRequest.groupAgent {groupId, agentId, groupName, viewerRole,
  captureAllowed}`): `deriveAgentToolAccess` returns the pinned class (ownerToolAccess false, elevated
  built-ins, hex-ssh `colleague`); `claudeAgent` forces every personal-scoped family off
  (`&& !groupAgentRun` on the tool-group booleans), swaps `ownerState` for `emptyOwnerState` +
  `summarizeGroupAgentState` (BOTH consumers: the group-agent prompt branch AND `describe_system`'s
  `groupAgent` ctx — the metacognition invariant), empties `ownerSecrets` explicitly, and loads only
  default + owning-group plugin roots/memory (`loadGroupAgentPluginRoots`/`loadGroupAgentKnowledgeMemory`).
- **Group tools come from SEPARATE pinned factories** (`buildGroupAgentRepoServer/BrainServer`, same
  server names, no `group` arg, no `list_groups`/`create_repo`; allowedTools uses
  `GROUP_AGENT_REPO_TOOL_NAMES`). Handlers re-check LIVE per call: agent enabled → acting member's
  membership → (writes) `groupAgentCaptureAllowed` = `capture_scope` (`'members'` default | `'admins'`)
  vs role → repo exists. Commits push with the ACTING member's token and identity, audited with a
  `(via group agent)` marker — direct `mcp__group_repo__` writes from personal runs stay admin-only,
  unchanged. The personal-avatar factories are byte-untouched (test-pinned strings).
- **Self-configuration tool** (`agent/groupAgentProfileTools.ts`, server `group_agent`): group-agent
  runs also register `mcp__group_agent__update_profile` — the agent patches its OWN
  persona/alias/bio/intro through `store.updateGroupAgent` (never displayName/enabled/captureScope;
  caps alias 64 / bio 200 / intro 2k / persona 8k). Live per-call gate mirrors the settings route's
  `canManageGroup` (group-admin role OR system admin) **but membership stays REQUIRED even for
  sysadmins** (every in-run group tool fails closed on removal); audited as `group_agent_update`
  (`self-config via update_profile`). Changes bind at the NEXT turn (the prompt is assembled at run
  start) and hit EVERY member's conversations — the prompt branch instructs the agent to confirm that
  before calling. State facts (`GroupAgentState.personaSet`/`selfConfigAllowed`, ownerState.ts) feed
  BOTH the prompt branch and `describe_system` (the metacognition invariant).
- **`capture_scope` is an MCP-LAYER policy, not a filesystem boundary.** The group-knowledge clone is
  one shared tree (`dataDir/group-knowledge/<groupId>`) that any elevated run's Bash/file tools can
  touch, `ensureGroupClone` fast-forwards without hard-reset, and `commitAndPushClone` does
  `git add -A` (locally planted changes can ride along on the next authorized capture). Remote push
  still requires an MCP commit + a member token — but don't describe the capture policy as airtight
  below the tool layer.
- **Group-agent elevation is a DELIBERATE carve-out outside `isTrustedFor`.** Every member of the
  owning group runs the elevated built-in class (auto-approved workspace Bash/Edit) regardless of the
  group's `avatar_sharing` policy — membership itself is the gate (`findChattableGroupAgent`), and the
  practical delta over the member's own always-elevated avatar is small. Keep it justified here rather
  than routed through `isTrustedFor` (which stays the single choke point for PEER trust).

### Repo plumbing (`knowledgeRepo.ts` / `groupKnowledgeRepo.ts` / `gitRepos.ts` / `repoGitCore.ts` / `repoGitGuards.ts`)
- **Low-level git is shared in `repoGitCore.ts`** (exec wrapper, `currentBranch`, dirty-status) and arg
  guards in `repoGitGuards.ts`. `knowledgeRepo.ts` + `groupKnowledgeRepo.ts` are thin context-resolvers
  over it; `gitRepos.ts` uses it too. **They were line-for-line mirrors before** — keep the shared core
  the single edit point for git-safety.
- **`dirtyPaths` flag difference is PRESERVED, not unified:** knowledge/group repos use `--porcelain`,
  `gitRepos` uses `--porcelain -uall`, threaded via the `extraStatusArgs` param. The knowledge-repo
  variant misses files inside otherwise-untracked dirs — a **latent bug flagged for a deliberate
  decision** (T3.7), NOT something to "fix" incidentally.
- **Git safety is TWO separate layers — don't merge them.**
  1. **Arg-safety: ONE validator, every clone path.** `assertSafeGitValue` (`repoGitGuards.ts`,
     re-exported via `repoGitCore.ts`) rejects leading-dash values and `scheme::` remote-helper syntax
     (`ext::sh -c …`). Used by `gitRepos.ts`, `knowledgeRepo.ts`, `groupKnowledgeRepo.ts`, and
     `marketplace.ts`'s `assertSafeArg` (plugin clones). It is deliberately **transport-agnostic**: a bare
     local path is a LEGITIMATE repo source (`register_repo` accepts one by design, and every offline repo
     test clones from a local bare remote), so this layer must never reject one. Was T3.8 — the three
     non-`gitRepos` paths used to check only for a leading dash and leaned on git's own default protocol
     policy (`fatal: transport 'ext' not allowed`) to stop `ext::`.
  2. **Source/host POLICY: `isInternalGitSource` (`gitCredentials.ts`), knowledge + group repos only.**
     It answers "is this on the internal GitHub host?" and **must fail CLOSED** — a non-shorthand source
     needs a PARSEABLE host matching `config.githubHost`. It used to return `true` for `host === null`,
     which (since `looksLikeRepo` accepts anything ending in `.git`) let any authenticated user point their
     knowledge repo at `dataDir/knowledge/<otherUserId>/.git` and read another user's private repo back
     through `/contents`, `/note`, `/graph` and the agent read tools. Was T3.11.
  When you add a repo entry point, decide which layer it needs: arg-safety ALWAYS, host policy only if the
  feature promises an internal-host-only source.
- **`withRepoLock` (`gitMutex.ts`) is NOT reentrant by key** — a fn running under `withRepoLock(key,…)`
  must never call it again for the same key (deadlock). Outer ops call the `*Locked` internals directly.
- **`commitAndPushClone` self-heals around the remote:** before pushing it fetches and REBASES local
  commits onto `origin/<branch>` (absorbs non-conflicting external pushes that would otherwise leave the
  clone permanently diverged), and a CLEAN tree with unpushed local commits still pushes them (an explicit
  commit retry after a transient push failure works) — only clean+in-sync returns `false`/"no changes". A
  conflicting rebase is `--abort`ed (local commits preserved) and thrown as **`REBASE_CONFLICT:<files>`**;
  `repoToolKit.commitFailureMessage` decodes that sentinel into a conflict explanation (naming the files,
  telling the model to inform the user, not to retry-loop) instead of the misleading token/branch-protection
  hint. Applies to BOTH personal and group knowledge repos (shared core).
- **`stripManagedMcpServers` mutates `.mcp.json` in place.** Committable-repo write paths MUST
  `restoreTrackedMcpJson` (from HEAD) before `git add -A`, or the strip gets pushed to the user's repo.
  Preserve that ordering.
- **Knowledge repo = one per user, agent-managed.** The personal repo (`knowledge_repo` column,
  `get/setKnowledgeRepo`) is a FULL clone at `dataDir/knowledge/<userId>`. It's (a) auto-loaded as a
  plugin root in chat/skills/intro via `loadKnowledgeRepoRoots`/`knowledgeRepoSkillSources`, AND (b)
  edited by the avatar through the **owner-only** `mcp__repo__*` MCP server (`agent/repoTools.ts`):
  list/read/write/delete/move/scaffold/commit, plus `create_repo` (creates a GitHub repo via
  `gh repo create` server-side using the stored git token, then connects it with `setKnowledgeRepo`).
  `create_repo` is exposed **only when no repo is connected yet** (`allowCreate` ← `!knowledgeRepoConfigured`).
  Settings stores the repo location (`PUT /api/me/knowledge-repo`) plus an optional plugin subset
  (`knowledge_selected` column, `get/setKnowledgeSelected`, `PUT /api/me/knowledge-repo/selected`,
  inspected via `GET /api/me/knowledge-repo/contents`); `selected: null` = load all. `write_file`/
  `scaffold_skill` only touch the local clone — must be followed by `commit` to persist. (`ensureClone`
  re-syncs with `git checkout -B <branch> origin/<branch>`, not a hard reset.)
- **General git repos (`mcp__git_repo__*`) ≠ the knowledge repo.** Arbitrary work/code repos:
  `git_repositories` table (`get/list/upsert/delete/markGitRepoSynced`), plumbing in `gitRepos.ts`, MCP
  server in `agent/gitRepoTools.ts`. **Single working-surface model (NOT MCP file CRUD):** owner-only
  `register_repo`/`remove_repo`; owner OR trusted may `sync_repo`/`push` (remote git) and
  `open_repo`/`close_repo`. There are **NO status/list_files/read_file/write_file/delete_file/diff/commit
  MCP tools** — the avatar OPENS one repo as the conversation's **working directory** (`open_repo`) and
  edits/tests/commits it with NATIVE tools (Read/Edit/Bash local git). Each tool self-gates
  (`ownerGuard`/`elevatedGuard`, both `&& !headless`); the owner's git token is used server-side only
  (`gitAuthArgs`), with arg-injection (`assertSafeGitValue`) and path-traversal (`resolveInRepo`) guards.
  Public repos on internal hosts / github.com / other HTTPS hosts clone without a token; tokens are
  opportunistic. Unlike the knowledge repo, push EXTENDS to trusted users.
- **Working repository (avatar-opened, NOT a UI picker).** The avatar opens ONE registered git repo as
  this conversation's working directory with `open_repo`; `close_repo` clears it. The selection is held
  per-conversation and **persisted on `conversations.working_repo`** (`repoWorkspace.ts`
  `get/setWorkspaceRepo` are thin wrappers over `store.get/setConversationWorkingRepo`; deleting the
  conversation clears it for free). Persistence — not the old in-memory map — is what lets **routines**
  keep a working repo between their spaced-out runs and across restarts.
  **The SDK cwd is fixed when a turn starts**, so `open_repo` takes effect **from the NEXT turn**.
  **One shared resolver, `activeRepoResolve.ts` `resolveActiveWorkspaceRepo`, is used by BOTH the chat
  route (turn start) AND the routine scheduler (before a headless run)** so they can't drift: it reads
  the selection → resolves/ensures the clone (no sync) → takes the per-clone lock → configures commit
  identity → returns the clone path as the SDK **cwd** (per-conversation scratch dir rides along as
  `additionalDirectories`) + a `release()` the caller invokes when the run ends. From then the avatar
  edits/tests with native Read/Edit/Bash + LOCAL git; only `push`/`sync_repo` stay MCP. `open_repo` needs
  `request.conversationId` — the chat route and the scheduler both thread it; only a run with NO
  conversation (e.g. intro gen) can't open one. A per-clone-path lock (`activeRepoLock.ts`) serializes
  concurrent opens (chat → 409; a routine whose repo is busy/missing logs and falls back to scratch).
  `preToolUseHook`'s `activeRepoMode` (= `Boolean(request.activeRepoName)`) is an INTEGRITY (not security)
  guard: denies remote/branch/history-rewriting/destructive Bash git, allows read-only git + local
  staging/commit. The clone path is NEVER returned to the client.

### Knowledge backfill, request_info, second brain — mechanics
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a poll/visibility watcher
  that toasts on new gaps (`refreshKnowledgeStatus`/`startKnowledgeWatch` in `lib/loaders.ts`).
- **Knowledge-repo `CLAUDE.md` is injected as standing memory.** The repo-root `CLAUDE.md` of the
  personal repo (ALWAYS) + each ENABLED group repo is read DIRECTLY from the clone (NOT via
  settingSources, which stays `[]`), size-capped, and pushed into the prompt EVERY turn via
  `AgentRequest.knowledgeMemory` (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in
  promptBuilder.ts) — distinct from on-demand skills, with an injection guard. Wired in chat + scheduler
  (routines = all groups, no toggle); intro/hashtag gen leaves it unset. `writeRepoTemplate` seeds a
  starter root `CLAUDE.md`.
- **Second brain (#53) = a CONVENTION over the SAME knowledge repo, NOT a new store.** `wiki/` (curated)
  + `raw/` (capture) are just directories inside the existing personal/group knowledge repo. **Recall**
  is read-only search: `mcp__brain__*` (personal, `search`/`get_note`, gated `elevated`) and
  `mcp__group_brain__*` (one group, read gated on group-MEMBERship). **Capture/consolidate** is the
  `brain-ingest`/`brain-reflect` default-skills, which WRITE through `mcp__repo__write_file` (personal) /
  `mcp__group_repo__write_file` (group) + `commit` — there is NO separate "brain write" tool, so a
  capture is a repo write plus a commit (uncommitted = not persisted). It composes with the backfill
  loop: `request_info` ESCALATES a true unknown to the owner, `brain-ingest` RETAINS the answer.
- **Capture notice ("기억" chip):** a SUCCESSFUL `write_file`/`edit_file` under `wiki/` (personal or
  group repo, incl. group-agent runs) fires `AgentEvents.onMemory` (`MemoryEvent`, gated in the tool
  handlers via `isBrainNotePath`) → SSE `memory` (server-minted `id` so reattach replays dedupe) → a
  `kind:"memory"` activity row (label "기억/그룹 기억 추가·갱신됨", detail = note path) that persists
  through the normal activity snapshot. **Rendering is summary-line-only:** `ActivityTree` EXCLUDES
  memory rows from the tree; `ChatView.memoryChip` renders them as a 🧠 chip on the activity
  disclosure's `<summary>` (live + completed cards), so the capture is visible while COLLAPSED —
  the whole point, since the tool list is folded by default. `raw/` writes stay silent BY DESIGN
  (a brain-ingest capture writes raw + wiki — one notice per capture, not two). Fires on write, not
  commit: the capture skills commit immediately after, and per-write is what maps 1:1 to notes.

### Secrets / SSH (`crypto.ts` / `gitCredentials.ts` / `sshIdentity.ts` / `sshTrust.ts` / `pythonExec.ts`)
- **Secret-at-rest tiers:** passwords → scrypt (`auth.ts`), session tokens → sha256, **reversible**
  secrets (e.g. per-user git tokens) → AES-256-GCM in `crypto.ts` (keyed from `SESSION_SECRET`). Never
  serialize secrets through `toUser`. App-WIDE secrets (not user-scoped) go in the `app_config` KV table
  (`get/set/deleteAppSecret`, same AES-256-GCM).
- **`SESSION_SECRET` keys EVERY at-rest reversible secret** (`user_secrets`, the legacy `git_token_enc`
  fallback, `app_config`). Rotating it makes `decryptSecret` return `null` (treated as "no secret") —
  **silent data loss, not a crash.** Deploy-migration concern (deployment is a separate corporate box).
- **Per-user secret vault (generic, not just SSH):** `user_secrets` table (AES-256-GCM, keyed on
  `avatar.id`=owner), `get/set/delete/listUserSecretNames`/`getUserSecrets`. Exposed to clients as
  `secretNames` ONLY (values never via `toUser`). `PUT/DELETE /api/me/secrets/:name` (env-key-name
  validated). Settings UI "시크릿" card under the 권한·연결 tab. Owner, non-headless chat prompts include
  only those secret NAMES so the avatar knows what is configured; values never enter the prompt or Bash env.
- **Where secret VALUES actually flow (selective injection, never the shell):** the SDK subprocess env
  (`agentSubprocessEnv`) gets NO user secrets — Bash/`env` stays clean. Known names route to dedicated
  consumers: `SSH_*`/`ALLOWED_HOST*` → the hex-ssh subprocess only (`sshMcpSecretEnv`), `CONFLUENCE_PAT`
  → the in-process Confluence tools, git tokens → server-side git only. **Custom secrets reach plugin MCP
  servers via the lift**: `runClaudeAgent` sets `strictMcpConfig: true` (CLI MCP discovery — plugin
  `.mcp.json`, cwd project `.mcp.json`, user settings — is OFF) and registers every plugin root's
  `.mcp.json` servers itself through `plugins.liftPluginMcpServers` (both the `{"mcpServers":{…}}` wrapper
  and the legacy flat shape parse). OWNED roots (the avatar's own plugin clones + personal knowledge repo)
  get `mcpInjectableSecretEnv` (vault minus git-credential + SSH names); group/default roots are lifted
  verbatim with NO secrets (a group teammate's `.mcp.json` must not read your vault). **Injection is
  additionally gated on `elevatedToolAccess`** (owner or trusted teammate; same line Confluence draws for
  the owner's PAT): plugin servers can't self-gate per viewer and the PreToolUse hook auto-allows every
  `mcp__*`, so REGISTRATION is the gate — plain-colleague and restricted-headless runs get the servers
  credential-less (pre-lift parity), never with the vault.
  `${CLAUDE_PLUGIN_ROOT}` is expanded app-side (the CLI no longer sees the plugin origin); first
  definition of a name wins (load order default → avatar plugins → knowledge repo → group), and app
  in-process servers spread after the lifted map so app names always win.
- **Per-secret AGENT-SHELL exposure (opt-in):** `user_secrets.shell_expose` (0 default) — toggled per key
  via `PATCH /api/me/secrets/:name {shellExpose}` (셸 노출 checkbox in the 시크릿 card; hidden for reserved
  names via the client-imported `secretPolicy.isShellExposableSecret`). Flagged values merge into
  `options.env` on ELEVATED runs only, so `$NAME` works in Bash; the **PostToolUse hook
  (`postToolUseHook.ts`, SDK `updatedToolOutput`) redacts every injectable value from every tool output**
  (`[REDACTED:<NAME>]`, values ≥6 chars) before the model sees it — accident prevention, not containment
  (a prompted model could re-encode a value it can use). Because the CLI env is inherited by every
  CLI-spawned server, non-owned lifted MCP servers get the shell-exposed names BLANKED
  (`liftPluginMcpServers` `maskEnvNames`). Reserved git/SSH names live in `secretPolicy.ts` (leaf module,
  shared with the client; a unit test pins it to the gitCredentials constants).
- **⚠️ MCP secret TRANSPORT is a one-shot file + wrapper, NEVER the server definition.** The SDK
  serializes `options.mcpServers` into the CLI's `--mcp-config` ARGV, and argv is world-readable via
  `/proc/<pid>/cmdline` — the agent's own Bash is a child of that CLI (`cat /proc/$PPID/cmdline`). So
  injected env values (and hex-ssh's `SSH_PRIVATE_KEY`, which used to sit in the def env — a real
  pre-wrapper exposure) ride in per-server mode-0600 files under `dataDir/runtime/mcp-secrets/`, and the
  def becomes `node scripts/mcp-secret-wrapper.mjs --secrets <file> -- <real command…>`. The wrapper
  reads the file, DELETES it (one-shot), and execs the real server with secrets merged over its env;
  `sweepStaleMcpSecretFiles` removes >1h crash leftovers at the next run. Residual (accepted) exposure:
  everything runs as ONE container uid, so a determined Bash user can still read same-uid `/proc/*/environ`
  or files — the wrapper closes the casual `env`-dump and world-readable-argv tiers, not uid isolation.
- **Two git tokens, vault-backed, host-routed.** Each user can store TWO git tokens as named
  `user_secrets`: `GIT_TOKEN` (`INTERNAL_GIT_TOKEN_SECRET_NAME`) for the internal `GITHUB_HOST`, and
  `GITHUB_TOKEN` (`EXTERNAL_GIT_TOKEN_SECRET_NAME`) for github.com. `tokenForGitUrl` in
  `gitCredentials.ts` selects by matching the clone URL's host against `config.githubHost` (internal) or
  `DEFAULT_GITHUB_HOST`/github.com (external); unknown hosts get no token. Both are supplied as
  `http.extraHeader` per git call (`gitAuthArgs`) — never written into `.git/config`, never in a URL. The
  legacy `git_token_enc` column in `users` is only a migration fallback (`setGitToken` writes to the
  vault and NULLs the column; `getGitToken` reads the vault first).
- Git auth for clones uses `http.extraHeader`, never a token-in-URL — keeps the token out of
  `.git/config`. Scrub it from git error text before logging/returning (`scrubGitError`).
- **The per-user git tokens NEVER reach the agent's shell.** Used only server-side: as a per-invocation
  `http.extraHeader` on the app's OWN clone/push (`knowledgeRepo.ts`, `syncPluginRepo`, `gitRepos.ts`) and
  by the server-side `mcp__repo__create_repo` bridge (invokes `gh repo create` with the token in
  child-process env). NOT injected into the SDK subprocess env; `claudeAgent.ts` strips `GIT_TOKEN`/
  `GITHUB_TOKEN`/`GH_TOKEN`-style names from `process.env` before launch and only forwards SSH-specific
  secrets to the hex-ssh subprocess. So the avatar can't `gh repo create`; `create_repo` is the only
  bridge. The prompt surfaces `gitTokenSet` (not the value).
- **The prompt tells the owner how to enable SSH when it's off.** `buildPrompt` adds an SSH enablement
  note on owner, non-headless turns whenever `SSH_PRIVATE_KEY` isn't in `secretNames`. Drops off once
  the key is stored.
- **`sshIdentity`/`sshTrust` shell out to python3** (`pythonExec.ts` centralizes the spawn + timeout).
  They silently depend on the **image carrying python3 + `cryptography` + `paramiko`** (no
  `ssh-keygen`/`ssh-keyscan`). A base-image change breaks them at RUNTIME, not build. A unit test asserts
  the TS `fingerprintOf` and the python SHA256 format agree — keep it green.
- **SSH host-key trust is agent-managed + volume-persistent.** `mcp__ssh_trust__{add,list,remove}_host`
  (sshTrustTools.ts) write a per-owner `known_hosts` under `${dataDir}/ssh/<userId>` (data volume →
  survives restarts), injected into hex-ssh as `KNOWN_HOSTS_PATH` (re-read per connection, so `add_host`
  takes effect mid-session). Fingerprints aren't secrets, so these tools are NOT owner-only.
  `fetchHostKey` uses paramiko (image has no `ssh-keyscan`).
- **Subscription auth is app-wide and admin-managed.** Auth precedence: `.env` `ANTHROPIC_API_KEY` >
  stored subscription token > none. When no API key is set, `claudeAgent.ts` injects the admin-pasted
  `claude setup-token` token (stored under `app_config[CLAUDE_OAUTH_TOKEN_KEY]`) as
  `CLAUDE_CODE_OAUTH_TOKEN` into the SDK subprocess env — decrypted only there, never shown to the agent.
  Managed via `PUT/DELETE /api/admin/claude-token` + the 관리자 ▸ 구독 로그인 card; status surfaces through
  `GET /api/admin/system` (`subscriptionConnected`, `apiKeyOverride`). setup-token tokens are long-lived,
  so there's no refresh logic.
- **External-avatar registry is app-wide and admin-managed.** UI entries are stored as one versioned
  JSON value under encrypted `app_config[external_agents_registry_v1]`; no schema migration is needed.
  `EXTERNAL_AGENTS_JSON` entries remain read-only and take precedence on an ID collision, while the
  remaining managed entries are merged into the live registry on every request. The admin DTO returns
  only `apiKeySet`, never the bearer value. A corrupt/undecryptable registry fails closed. Ciphertext
  identity and the parsed registry are cached per Store instance, so steady-state reads avoid repeating
  synchronous scrypt while a DB change/tamper is still detected on the next request. External IDs are
  immutable: history-bearing entries can be disabled but not deleted, and an endpoint change needs
  explicit confirmation because the next stateless turn sends the complete stored transcript. Existing
  bearer keys are bound to the exact endpoint and cannot be kept across an address change. Each external
  conversation also stores its trusted endpoint; an unapproved env/config re-point fails closed and asks
  the user to start a new conversation instead of forwarding history to the new address. Pre-binding
  legacy rows with `NULL` fail closed instead of adopting the current endpoint. Confirmed managed
  endpoint changes compare-and-swap the encrypted registry and rebind eligible conversation rows in one
  immediate SQLite transaction, so write failure or a concurrent admin update cannot split the two. The
  admin "인증·모델 확인" calls authenticated `/v1/models`, requires at least one Claude model, and
  deliberately does not execute an agent turn or tools. The configured endpoint is separately
  constrained to the exact `/v1/agents/messages` path contract; its SSE stream is validated on the
  first real chat turn.
- **External avatar profile images live OUTSIDE the registry.** Bytes on disk in the same `avatarDir`
  as user photos (stem = the public `external:<id>` avatar id), extension in the
  `external_avatar_images` table (CREATE TABLE IF NOT EXISTS = the migration). Admin-only
  `PUT/DELETE /api/admin/external-agents/:id/image` (works for env entries too — the registry is
  untouched); the public `GET /api/users/:id/avatar-image` route falls back to the external ext
  lookup. `externalAvatarSummary`/`adminExternalAgent` stay pure (`hasImage: false`) — route code
  overlays the stored state (avatars list, avatar detail, admin DTOs). Agent delete manually
  cascades the image row + file. Shared upload validation lives in `_shared.ts`
  (`decodeAvatarImage`/`saveAvatarImageFile`/`deleteAvatarImageFile`, also used by profile photos).
- **`conversations.selected_model` is dual-semantic.** Native conversations store a model TIER alias;
  external conversations store a GATEWAY model id (viewer-picked per conversation, `isSafeExternalModelId`
  charset, cleared→admin default). One column is safe because a conversation is bound to a single avatar
  for life; the chat route branches validation on `externalAgent`. The composer picker's catalog comes
  from viewer-facing `GET /api/avatars/:id/models` (shared visibility helper, `probeExternalAgentGateway`
  behind a 60s per-agent cache in the chat-router closure; native avatars answer `{ models: [] }`). The
  client fetches it EAGERLY per external pane (ChatView reactive loop) because desktop shows composer
  controls inline — the mobile-only settings toggle can't be the fetch trigger. External panes also skip
  the native model/effort default seeding in `makePane` so a tier alias never leaks to the gateway.

### On-prem GitHub CA
- **One var `GITHUB_CA_CERT`** (PEM path, `applyCustomGithubCa` in `tlsCa.ts`, called from `index.ts`).
  Covers Node `fetch` via runtime `tls.setDefaultCACertificates` (appends to system roots), `git`
  clone/push via `GIT_SSL_CAINFO`, and `create_repo` via `SSL_CERT_FILE` passed to `gh` in `repoTools.ts`.
  `GITHUB_HOST` becomes `GH_HOST` for `gh repo create` on GHES.
- Repo shorthand (`owner/repo`) resolves through `config.githubHost` (`GITHUB_HOST`, default
  `github.com`) for both plugin and knowledge-repo clones/pushes. Full `https://...` and `git@...` repo
  values bypass that default and are used as-is.
- GHES/older `gh` compatibility: do not depend on `gh repo view --json visibility`; use `isPrivate` with
  `nameWithOwner,defaultBranchRef,isPrivate`.

### Routines
- A routine (`routine_jobs` table, `get/list/create/update/deleteRoutineJob`, `markRoutineRun`) runs its
  `prompt` headlessly with owner-level tools and appends results to a dedicated conversation
  (`[예약 작업] <name|prompt>` title; legacy rows may retain `[루틴]`). Schedule kinds (`src/server/routineSchedule.ts`, the ONE place for all
  schedule math + validation): **once** (`runDate` YYYY-MM-DD KST + `minuteOfDay`; disabled with
  `completedAt` after its single attempt), **daily** (`minuteOfDay` KST), **weekly** (`daysOfWeek`
  0=Sun..6=Sat at `minuteOfDay`), **interval** (`intervalMinutes`, 5..10080).
  `parseRoutineSchedule` validates raw
  API/MCP input → a `RoutineSchedule` or a `ScheduleError` CODE; each caller maps the code to its own
  channel (`routes/_shared.ts` `KOREAN_SCHEDULE_ERROR`, `systemTools.ts` `ENGLISH_SCHEDULE_ERROR`).
  One-time schedules retain `run_date` separately from `next_run_at`, so disabling/completing does not
  lose the configured date; `completed_at` distinguishes completion from a manual pause.
  `nextRunIso` computes the next firing in fixed UTC+9 (no DST); a name/prompt-only `updateRoutineJob`
  edit preserves an overdue `next_run_at`, only a schedule change recomputes. `store.create/updateRoutineJob`
  stay backward-compatible with `{prompt, minuteOfDay}`. Editable by owner (UI modal: clickable title →
  name/prompt/schedule builder, `PUT/PATCH /api/me/routines`) AND by the avatar
  (`mcp__system__{create,update}_routine`). New schedule fields go in `routineSchedule.ts` + the two
  error maps + `RoutineJob` (types.ts) + the `addColumnIfMissing` migration.
- **Routines load the same skills as chat** via the shared `loadAgentPluginRoots` (plugins.ts): default
  + avatar plugins + personal & group knowledge-repo roots. Both `routes/chat.ts` and `scheduler.ts` call
  it, so they can't drift; `local` runtime returns `[]`.
- **Routines fall back down the model tier chain on transient failures.** The scheduler sets
  `AgentRequest.modelFallback: true` (routines ONLY — headless, no live stream; chat never sets it).
  `runClaudeAgent` builds a chain from the resolved model DOWN the tier order (`buildModelFallbackChain`:
  opus→sonnet→haiku; a concrete admin-override id → [id, sonnet, haiku]) and retries the next model when
  the attempt THROWS a transient model/server error (`isRetryableModelError`: overload/429/5xx/network —
  NOT `error_max_turns`/auth/bad-request, NOT on abort). An env-pinned `ANTHROPIC_MODEL` is a hard lock →
  no fallback. In-band error *results* (e.g. max_turns) don't fall back. The completed-run log carries
  `model` + `modelFellBack`.
- **A routine has a HARD wall-clock deadline (default 30 min), and it is the budget for the WHOLE run** —
  `config.routineRunTimeoutMs` (env `ROUTINE_RUN_TIMEOUT_MINUTES`, clamped to a 1-minute floor; `0` does
  NOT disable it, unlike `PLUGIN_AUTO_REFRESH_MINUTES`), armed by one `AbortController` created per run
  OUTSIDE `runClaudeAgent`. So all model-fallback attempts (opus→sonnet→haiku) plus the resume self-heal
  retry SHARE that budget; a slow first attempt starves the rest of the chain. Note the mismatch with
  `maxTurns` (default 1000) — the turn budget is far larger than the wall-clock one, so a work-heavy
  routine hits the deadline, not max_turns.
- **The deadline doubles as the max hang of the manual-run HTTP request.** `POST /api/me/routines/:id/run`
  (`routes/routines.ts`) `await`s the entire run and the "지금 실행" button awaits that fetch
  (`RoutinesView.svelte`), so the practical ceiling on `ROUTINE_RUN_TIMEOUT_MINUTES` is whatever read
  timeout a fronting reverse proxy allows — past it the button reports a network failure while the run
  keeps going server-side. Making run-now return 202 + poll is the prerequisite for a much larger value.
  Two more costs scale with the deadline: a wedged job stays un-runnable for the whole window (the
  `runningJobs` overlap guard makes the scheduler skip its ticks), and it holds the active-repo lock,
  which REFUSES (409) rather than queues any other conversation opening the same clone.
- **Never surface the SDK's abort message to the owner.** The SDK labels EVERY abort
  `"Claude Code process aborted by user"` (it only checks `signal.aborted`), so storing it verbatim blamed
  a user for a run nothing but the deadline touched — routines have no cancel route and are NOT in the run
  registry, so `cancelAllRuns()` on shutdown can't reach them either; that message could ONLY have meant a
  timeout. The scheduler now tracks its own `timedOut` flag and substitutes a Korean
  `routineTimeoutMessage()` (derived from `RUN_TIMEOUT_MS` so they can't drift). When adding another abort
  trigger, give it its own flag + message rather than letting the SDK text through.
- **A failed routine persists its PARTIAL output into the thread.** The catch path accumulates `onDelta`
  into `streamedText` (the only reason routines pass an events sink at all — they still take no
  `onQuestion`/`onPermission`) and writes `partial + "\n\n" + cause` as the assistant turn, mirroring the
  chat route's cancel/error paths. Before this, a failed run wrote NOTHING to its conversation and the
  sole trace was the one-line `last_error` in the routines list. The persist is best-effort and wrapped so
  it can never mask the original failure. `response.text` is NOT usable here — it never arrives on abort.

---

## Agent & MCP tools (`src/server/agent/`)

Agent orchestration + in-process MCP tool servers. Companion to the agent-area philosophy in
[`../src/server/agent/CLAUDE.md`](../src/server/agent/CLAUDE.md).

### claudeAgent.ts is split (behind unchanged exports)
`claudeAgent.ts` is the orchestrator (`runClaudeAgent` + subprocess-env helpers) and **re-exports** the
moved symbols so importers keep their paths:
- `promptBuilder.ts` — `buildSystemPromptAppend` + `buildUserPrompt` + compatibility `buildPrompt` +
  `compactConversationHistory`/`conversationHistoryBlock` + `GIT_MCP_ONLY_GUIDANCE`.
  `claudeAgent.ts` uses the SDK's default Claude Code system prompt via `systemPrompt: { type: "preset",
  preset: "claude_code", append, excludeDynamicSections: true }`; app/permission/self-state guidance goes
  in the append, while stored history + the current user/task instruction stay in the user prompt. **`agent-core.test.ts`
  checks the prompt with `toContain`/`not.toContain` substrings, NOT byte-for-byte** — ADDING a section is
  safe; only changing an EXISTING string (or its presence per viewer class) breaks a test.
- `sdkMessageHandlers.ts` — SDK-message→`AgentEvents` translation (`handle*` + Task helpers + `LoopState`
  + `interpretResult`/`resultErrorMessage`).
- `preToolUseHook.ts` — `buildPreToolUseHook` + `hookAllow`/`hookDeny`/`isAutoAllowed`/`safeToolInput`.
- `agentUtils.ts` — small shared helpers.
Keep the re-export set in `claudeAgent.ts` minimal to the original public surface.

### Admin builtin tool/skill on-off policy (`toolSkillPolicy.ts` + `agent/skillDiscovery.ts`)
- **What it is:** the admin panel (system tab → "내장 도구·스킬 정책") disables SDK BUILT-IN tools
  (WebFetch/WebSearch/NotebookEdit/Task+Agent/SendMessage — the `TOGGLABLE_BUILTIN_TOOLS` catalog; core
  tools are deliberately NOT togglable and the strict parser rejects them) and individual SKILLS (CLI built-ins
  like code-review/deep-research AND app/plugin skills) deployment-wide. Storage mirrors the hex-ssh
  policy: one JSON blob in `app_config` (`getToolSkillPolicy`/`setToolSkillPolicy` in `store/secrets.ts`,
  lenient `normalize*` on read / strict `parse*` at `PUT /api/admin/tool-skill-policy`), read FRESH per
  agent run. Empty policy == pre-feature behavior (safe under `SESSION_SECRET` rotation).
- **Three-layer enforcement (all from ONE `toolSkillPolicy` read in `runClaudeAgent`):**
  1. `disallowedTools` = `UNUSED_SDK_BUILTIN_TOOLS ∪ disallowedEntriesForPolicy(policy)` — bare names
     remove built-ins from the advertised set; `Skill(<name>)` denies that one skill at the CLI (a
     content-carrying deny never strips the whole Skill tool — verified against the bundled CLI matcher).
  2. `options.skills` — `"all"` normally; when skills are disabled AND the discovery cache matches the
     bundled CLI version, an explicit allowlist (`computeSkillsOption`) HIDES them from the skill
     listing. **Visibility fail-open / execution fail-closed:** missing or stale cache → `"all"` (skills
     must never vanish because a preflight failed); the hook still denies.
  3. PreToolUse hook — denies disabled skills (`Skill` is otherwise an auto-allowed meta tool, so this
     branch runs BEFORE the auto-allow; matches bare AND `plugin:name` forms) and disabled tool names.
     English deny reason, Korean `onBlocked`.
- **Skill discovery** (`agent/skillDiscovery.ts`, gateway-proven pattern): one preflight SDK session in
  streaming-input mode that never sends a turn → `query.supportedCommands()` (~0.3s, no API call/auth) →
  cached in `app_config` keyed by the SDK's `claudeCodeVersion`. Runs lazily from
  `GET /api/admin/system` (claude runtime only — the `local` test runtime is cache-only), single-flight
  guarded. Per-avatar plugin skills are NOT in the cache: `listPluginRootSkills` scans each run's plugin
  roots (`skills/<dir>/SKILL.md`) so the allowlist covers them. Over-inclusion in the allowlist is inert;
  omission hides a skill — hence fail-open on any doubt. Known edge: an availability-gated CLI skill
  absent at preflight (e.g. `commit`) stays hidden while any skill is disabled.
- **Meta-cognition:** `buildSystemPromptAppend` standing note (`adminDisabledTools/-Skills` on
  `AgentRequest`) + `describe_system` "Admin-disabled …" lines (via `SystemToolsContext.toolSkillPolicy`)
  — a disabled skill may still be LISTED when the cache is stale, so the note pre-empts wasted attempts.
- **Beware `*/` in JSDoc:** a glob like `skills/*/SKILL.md` inside a block comment TERMINATES it and the
  rest of the file parses as code (surfaced as bizarre TS1443/TS1160 errors far below). Write
  `skills/<dir>/SKILL.md` in block comments; `//` line comments are safe.

### Agent teams (experimental — named subagents + SendMessage)
- **Enablement is three-legged** (2026-08): `agentSubprocessEnv` sets
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; `SendMessage` is exposed via `SDK_TEAM_TOOLS` (removed from
  `UNUSED_SDK_BUILTIN_TOOLS`) and folded into the hook's `TASK_ORCHESTRATION_TOOLS` auto-allow +
  `allowedTools`; and ONE admin toggle (`agent_teams` in the togglable-tool catalog) switches the WHOLE
  feature: it disallows the `SendMessage` tool AND (via `isAgentTeamsDisabled` →
  `agentSubprocessEnv`'s third arg) forces the CLI flag to "0". **Precedence:** admin toggle (off wins
  over everything) > operator-set env value in the deploy environment > default-on. The CLI-side gate
  (`isAgentSwarmsEnabled` in the bundled CLI) also consults a statsig gate that DEFAULTS TRUE offline.
  Keep the tool-name→feature semantic in `isAgentTeamsDisabled` (next to the catalog), never inline
  `includes("SendMessage")` at call sites.
- **Usage shape in CLI ≥2.1.x:** there are NO TeamCreate/TeamDelete tools and `Agent.team_name` is
  deprecated — a session has ONE implicit team; `Agent` with `name:` spawns an addressable teammate and
  `SendMessage({to: name})` messages it. Teammates' own tool calls still hit the PreToolUse hook
  individually, so per-viewer gating is unchanged.
- **Presentation:** `SendMessage` is deliberately NOT in `SDK_HIDDEN_ACTIVITY_TOOLS` — coordination
  renders as a visible tool row ("팀원 메시지 전송", detail = `recipient · summary|content` via the
  `summarizeToolInput` special case; CLI input keys are recipient/content/summary). Teammate lifecycles
  surface through the existing subagent/task event paths (`SUBAGENT_TOOLS`, `task_started` system
  events); the teammate's addressable identity rides on `AgentSpawnEvent.name` (from `input.name` /
  `teammate_name`) and the client prefixes the agent node label with `@<name>`. The persisted activity
  snapshot needs no schema change — it stores the rendered label.
- **Headless caveat:** `teammateMode` ('auto'|'tmux'|'iterm2'|'in-process') comes from settings files,
  which Noah never loads (`settingSources: []`) — runs rely on 'auto' resolving to in-process in a
  TTY-less server. Verified only at the unit level; watch the first live runs on the deploy server.

### Adding / changing an MCP tool server
- **One template per `*Tools.ts`:** `buildXTools` (handler-level owner/elevated guards) + `buildXServer`
  + a `SERVER_NAME`/`TOOL_NAMES` const pair.
- **A new tool means updating BOTH `mcpServers` AND `allowedTools` in `claudeAgent.ts`** — two hand-synced
  lists. Add to one but not the other and the model either sees a tool it can't call or can call a tool it
  can't see. (Making this data-driven is deferred, T3.5.)
- **Guard convention differs per file BY DESIGN:** groupRepo/system/sshIdentity/knowledge-write gate on
  `ctx.viewerIsOwner` (= `ownerToolAccess` = owner chat OR owner routine); `repoTools` (personal knowledge
  repo) splits READ (`list_files`/`read_file`, gated on `ctx.elevated` = owner OR trusted same-group
  teammate) vs WRITE/commit/create (owner-only); `gitRepoTools` splits owner vs elevated; `confluenceTools`
  and `webFetchTools` gate on `ctx.elevated`; `sshTrustTools` and `search_avatars` are intentionally
  UNGATED (fingerprints aren't secrets; directory search is all-viewer read-only) while its sibling
  `ask_avatar` in the SAME file is owner-driven (see the consultation section below). Don't "normalize"
  these.
- **Second-brain read tools (`brainTools`/`groupBrainTools`):** read-only RECALL servers
  (`search`/`get_note`) over the same knowledge-repo clones. `brainTools` (personal) gates reads on
  `ctx.elevated`; `groupBrainTools` gates reads on group-MEMBERship. There is NO brain WRITE tool — route
  writes through `mcp__repo__write_file`/`mcp__group_repo__write_file` + `commit`.
- **Web fetch (`webFetchTools.ts`, server `web`, tool-group id `web`):** one `mcp__web__fetch` tool that
  fetches from the APP process, NOT the CLI subprocess — that's the whole point: the built-in WebFetch
  force-upgrades `http://`→`https://` (verified on the bundled binary), so plain-HTTP intranet pages only
  work here. Proxy: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` via undici's `EnvHttpProxyAgent` — must use
  undici's OWN `fetch` (node's global fetch is a different bundled undici and rejects the dispatcher).
  Live-verified: undici tunnels EVERY proxied request via `CONNECT` (even `http://` targets; curl uses
  absolute-form GET instead), so a corporate proxy that only allows `CONNECT :443` refuses proxied
  plain-HTTP to EXTERNAL port-80 sites. Intranet http bypasses the proxy via `NO_PROXY`/direct, so this
  bites rarely — check the proxy's CONNECT port policy before blaming the tool.
  Private CAs: `NODE_EXTRA_CA_CERTS` (node-native) and `GITHUB_CA_CERT` (process-wide
  `tls.setDefaultCACertificates`, tlsCa.ts) both cover it. Guards: handler gates on `ctx.elevated`;
  loopback + link-local/metadata (169.254.x, `::1`, `localhost`, v4-mapped) refused while PRIVATE ranges
  (10.x/172.16-31/192.168) are deliberately allowed; same-host redirects followed (≤5) but cross-host
  redirects REPORTED for an explicit re-fetch (the built-in WebFetch contract, and it re-runs the guard);
  2MB streamed body cap; 20k-char result window with `offset` continuation; charset from the header or a
  `<meta charset>` sniff (KR intranets still serve euc-kr). HTML→text is deliberately dependency-free
  (entities decoded AFTER tag-strip; links kept as `label (abs-url)`). Proxy self-state comes from ONE
  helper, `webFetchProxyState()` (values redacted to scheme://host:port — proxy creds never enter a
  prompt), read by BOTH `buildSystemPromptAppend` (`AgentRequest.webFetchProxy`, set in `runClaudeAgent`)
  and `describe_system` — the Confluence-style deployment-fact sync. The built-in WebFetch stays
  available (its own description tells the model to prefer an MCP web fetch tool); admins can still kill
  it via the builtin-tool policy toggle.
- **The `mcp__`-prefix auto-allow in the PreToolUse hook fires BEFORE the owner check**, so every tool
  MUST self-gate in its handler. Don't rely on the hook.

### Avatar consultation (`mcp__avatars__ask_avatar`, #ask-avatar)

- **What it is:** an OWNER-DRIVEN turn (owner chat or owner routine) may ask a **same-group teammate's
  avatar** one question and get its answer back as tool text. Core in `agent/avatarAsk.ts`
  (`askAvatar`), tool + outcome decoding beside `search_avatars` in `avatarDirectoryTools.ts` (same
  `avatars` server + tool group).
- **Gates (in order):** `store.getUserByUsername` → self-refusal → `resolveChatAvatar` (visibility:
  unknown, `private`, group-invisible, and suspended all return the SAME `not_found` so the tool can't
  probe existence) → `isTrustedFor` (= `shareAnyGroup`, the single trust choke point). So a consult
  grants exactly what the asking USER could already get by chatting with that avatar directly — no new
  trust surface.
- **The inner run is the trusted-colleague viewer class**, constructed only in `avatarAsk.ts`:
  `viewerIsOwner: false, elevated: true, headless: true, allowHeadlessTools: true` — `allowHeadlessTools`
  only lifts the headless read-restriction so the target's second-brain recall registers; owner-only
  tools stay locked because `viewerIsOwner` is false (combo pinned in `deriveAgentToolAccess` tests).
  Plus `mcpToolGroups: ["personal_knowledge"]` (recall + `request_info` — the target can escalate a true
  unknown to ITS owner with the asker attributed), the TARGET's plugin roots + knowledge memory,
  `modelFallback: true`, a 3-min wall clock (`AVATAR_ASK_TIMEOUT_MS`), an 8k-char answer cap
  (`AVATAR_ASK_ANSWER_CAP` — the answer is another user's model output entering the asker's context, so
  it's bounded like the directory bio), and the OUTER run's abort signal propagated in.
- **Machine-initiated ⇒ STRICTLY read-only, beyond what a human teammate turn gets** (`consultationRun`
  in claudeAgent.ts): the shared-account write-widening is withheld (`repoWriteAccess`'s
  `sharedAccount && elevatedToolAccess` arm adds `&& !consultationRun` — no human sees the request, so
  no unattended write+commit into a communal repo), plugin MCP servers are NOT lifted at all
  (third-party servers can't self-gate per viewer; registration is their only gate) and neither
  plugin-secret injection nor shell secret exposure happens. The target keeps skills (prompt-level) but
  answers with recall tools only; the consultation prompt branch states the read-only level and the
  `brainSection` "consultation" mode never invites capture, even on a shared account.
- **Per-turn budget:** the tool closure in `avatarDirectoryTools.ts` counts consultations and refuses
  past `AVATAR_ASK_MAX_PER_TURN` (5) — each consult is a full agent subprocess with its own model calls,
  so an unbounded loop would be a cost amplifier on the shared deployment credentials.
- **In-band error results never masquerade as answers:** `runClaudeAgent` doesn't throw on an error
  *result* — it substitutes a Korean fallback into `response.text` (`resultErrorMessage(subtype)`, or
  `EMPTY_SDK_RESPONSE_MESSAGE` for an empty success). `AgentResponse.resultError` now carries the error
  subtype (set only when nothing real streamed), and `askAvatar` maps it to a `failed` outcome — and the
  exported empty sentinel to `empty` — instead of relaying user-facing Korean as the teammate's claim.
- **Depth guard = `AgentRequest.avatarConsultation`:** set only by `askAvatar`. A consultation run never
  registers `ask_avatar` (no A→B→C chains) and takes a dedicated prompt branch — the headless
  consultation framing in `promptBuilder.ts`, NOT the routine one (which would claim owner-level
  permissions this run doesn't have).
- **Registration:** `avatarAskActive` (= `avatars` group enabled && `ownerToolAccess` &&
  `!avatarConsultation`) drives the `allowedTools` entry AND the ctx executor injection byte-identically;
  the tool joins the server's tool list only when the executor is present, and the handler still
  self-gates on `viewerIsOwner`. Timeout on a busy model returns the PARTIAL streamed text in the error.
- **Nothing persists on the target's side** — deliberate: a teammate chatting with your avatar in the UI
  leaves you no transcript either, and the intro/hashtag headless runs persist nothing. The exchange
  lives in the ASKER's conversation; durable retention is the asker's own `brain-ingest` capture (the
  success text nudges it when the asking run has a connected repo). Revisit as an `is_routine`-style
  tagged conversation if target-side auditability is ever wanted.

### Skill sharing between avatars (`mcp__skill_exchange__*` + 스킬 배우기, #skill-share)
- **What it is:** an owner shares skills FROM their knowledge repo (`skills/<slug>/` dirs); teammates
  browse them in the 스킬 배우기 left tab or via `mcp__skill_exchange__find_shared_skills`, and LEARN one —
  the server copies the directory into the learner's repo, registers it in the learner's
  `.claude-plugin/marketplace.json`, and commits+pushes with the LEARNER's identity. Share rows
  (`shared_skills`, store/avatars.ts) are METADATA SNAPSHOTS only; content is read from the sharer's
  clone at preview/learn time (`ensureClone` refresh), so learners always get the current version.
- **Version updates (전수 후 원본 변경):** every shared_skills row carries a `content_hash` (sha256 of
  the sharer's skill dir via `hashSkillDir`, origin-marker excluded), refreshed wherever the server
  touches the sharer's clone — share, owner mine reconciliation (this ALSO bumps updated_at), and
  teammate preview/learn (`setSharedSkillContentHash`, hash-only so a viewer can't reorder the owner's
  listing). Each learn writes a provenance marker `skills/<slug>/.noah-skill-origin.json`
  (owner id/@username, source skillName, source hash, learnedAt; chain-shares record their IMMEDIATE
  source). The client joins mine.origin.contentHash × listing.contentHash → "업데이트 있음" +
  업데이트 받기; the update path (`learn {updateSlug}` / `learn_skill {update:true}`) replaces the
  learner's copy IN PLACE and is authorized by the origin marker, NOT the directory name — a mismatch
  fails closed (`NOT_LEARNED_FROM_SHARE`). The MCP update resolves the learner's slug from the markers
  (0 → redirect, >1 → ambiguous, ask the user). The marker ALSO records `localHash` (the copy's own
  post-rewrite hash): an update whose copy no longer matches — i.e. the learner CUSTOMIZED it, or a
  legacy marker can't prove otherwise — throws `SKILL_LOCALLY_MODIFIED` until the caller passes
  explicit consent (`overwriteModified` on the route after a danger confirm; `overwrite_modified` on
  the MCP tool after the model asks the user). Git history retains the overwritten customization.
  UNLINK (구독 해지) is the marker's deletion: `unlinkSkillOrigin` (route `POST /api/skill-share/unlink`,
  mine-row 연결 끊기 action, `mcp__skill_exchange__unlink_skill`) commits the removal — the copy stays,
  tracking/badges stop, and re-learning the same share later is a fresh copy.
- **The feed includes the viewer's OWN shares** (route merges `listSharedSkillsByOwner` ahead of
  `listLearnableSkills`, mirroring 탐색's "나" card): that's how an owner sees their skill's 전수 count
  in context. The client badges them 나 and drops the learn button; `listLearnableSkills` itself stays
  others-only (it feeds the MCP find tool + the metacognition count).
- **Learn counts (전수된 횟수):** every successful learn inserts a `skill_learn_events` row keyed by
  (owner, skill_name) — NOT the share-row id — so counts survive unshare→re-share; recorded at the two
  call sites (route + MCP tool) AFTER copy+commit succeed. Surfaces: `SharedSkill.learnCount`
  (correlated subquery in every shared_skills SELECT), the mine view's per-skill counts
  (`skillLearnCounts` — an unshared skill keeps its history), the tab's "전수 N회" badges, find's
  `learned N×` marker, and describe_system's owner total (`OwnerState.sharedSkillLearnTotal`,
  describe_system-only like gitRepoCount). Learner ids are stored ONLY for the deleteUser cascade
  (both axes purge — product data, not an audit trail); the UI never shows who learned.
- **Reach = avatar discovery, exactly.** `LEARNABLE_SKILLS_FROM` (store/avatars.ts) mirrors
  `VISIBILITY_WHERE` minus the self-exception: not suspended + `visibility='group'` + SHARING_TEAMMATES
  co-membership. A `private` avatar's shares vanish; an `avatar_sharing`-off group grants nothing; your
  own shares are never "learnable" (managed via `listSharedSkillsByOwner`). Keep the two SQL fragments in
  lockstep.
- **Transfer plumbing lives in `skillTransfer.ts`** (server root, NOT knowledgeRepo.ts — it imports both
  knowledgeRepo and agent/skillDiscovery without cycles): `listRepoSkills` (scan `skills/<dir>/SKILL.md`),
  `copySkillDir` (lstat walk — symlinks SKIPPED never followed, 512KB/file + 4MB + 200 files + depth 8
  caps, containment via the exported `resolveInRepo`/`realpathContained`), `learnSkillIntoRepo`
  (ensureClone both → copy → rewrite identity → `ensureMarketplaceManifest` → `commitAndPush`).
  On rename the SKILL.md frontmatter `name:` AND `.claude-plugin/plugin.json` `name` are rewritten (a
  stale frontmatter name would load the skill under the OLD name and collide); a missing plugin.json is
  created (the marketplace entry is unloadable without one).
- **Message-coded errors** in the knowledgeRepo style: `SKILL_NOT_FOUND`/`SKILL_EXISTS`/`INVALID_NAME`/
  `SKILL_FILE_TOO_LARGE`/`SKILL_TOO_LARGE`/`TOO_MANY_FILES`. Decoded to Korean in `routes/skillShare.ts`
  (`LEARN_ERROR_KO`, 409 drives the client's rename flow) and to English redirects in
  `skillExchangeTools.decodeLearnError`.
- **Registration:** `skillExchangeActive` (= `avatars` group enabled && `ownerToolAccess`) drives
  `allowedTools` + `mcpServers` byte-identically; every handler ALSO self-gates on `viewerIsOwner`
  (find included — the listing is the OWNER's group view, and a trusted teammate driving this avatar has
  their own avatar for their view). Group-agent runs are excluded twice over (avatars family forced off +
  `ownerToolAccess=false`). Owner routines keep the tools.
- **Metacognition:** `OwnerState.learnableSkillCount`/`sharedSkillCount` (lazy getters) feed BOTH the
  standing prompt section (promptBuilder, inside the avatars-group block, re-deriving the registration
  gate) and `describe_system`'s "Skill exchange" line. A LEARNED skill only LOADS on the NEXT
  conversation (plugin roots mount at run start), so both surfaces + the learn tool result tell the model
  to `mcp__repo__read_file` the new SKILL.md to apply it immediately.
- **Hygiene:** `GET /api/skill-share/mine` reconciles rows against the working tree (dir gone → unshare;
  drifted name/description → re-snapshot); a learn/preview that finds the dir deleted also prunes the
  stale row; the knowledge-repo PUT clears ALL of the owner's shares on disconnect or repoint
  (`clearSharedSkills` — a same-repo re-save keeps them). `deleteUser` cascades `shared_skills` by owner
  (learned copies are FILES in learners' repos, intentionally untouched — like ask_avatar, what crossed
  the boundary belongs to the receiver).
- **Bundled/plugin skills are deliberately NOT shareable** — everyone already has the default bundle, and
  plugin skills are shared by installing the same plugin; only knowledge-repo skills (what the avatar
  authored/accumulated, incl. `scaffold_skill` output) are listed by `mine`/`share_skill`.

### Shared helpers (don't re-copy)
- **`mcpTools.ts`** — `text(message, isError?)` (the MCP result wrapper), `decodeRepoFsError`
  (INVALID_PATH/FILE_TOO_LARGE/NOT_A_FILE/SKILL_EXISTS sentinels), `decodeExecError(err, {redactToken?,
  fallback?})` (git/gh stderr + `scrubGitError`). Use these; don't reintroduce a local `text()`.
- **`repoToolKit.ts`** — the shared guard→resolve→ensureClone→decode skeleton for skill/file CRUD used by
  `repoTools` (owner-only) and `groupRepoTools` (owner + group + admin-role write gate). `commit` handlers
  and `create_repo` are intentionally NOT folded in. `OWNER_ONLY` here =
  `'This tool can only be used by the avatar owner.'`; **`systemTools` has a DIFFERENT `OWNER_ONLY` string**
  (`…in a conversation the avatar owner is participating in.`).
- **`ownerState.ts`** — `summarizeOwnerState(store, config, avatarUserId): OwnerState` returns UNFORMATTED
  self-state DATA shared by `buildPrompt` (English prompt paragraphs) and
  `systemTools.describe_system` (tool text). This module is the structural sync point for the
  metacognition principle. It returns ungated facts; gating + formatting stay at each call site (e.g.
  `buildPrompt` blanks secrets/groups to `[]` unless `ownerToolAccess`). When you add a self-state fact to
  one consumer, add it to `OwnerState` and the other.
- **Owner identity:** the `AgentOwner` type (`{id, username, displayName, alias?}`) lives in `../types.ts`
  and the descriptor is built ONCE in `runClaudeAgent` and passed to all tool servers. Don't re-declare
  the shape or rebuild the literal per server.

### Browser bridge (`mcp__browser__*` + the Chrome extension)
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
- **`click_at` has TWO modes and they share nothing but a name.** UID mode (`uid` +
  `xFraction`/`yFraction`, 0–1, default 0.5 centre) resolves the ref, takes `DOM.getContentQuads` on the
  ref's OWN session, and clicks a fraction of the element's bounding box clamped 1px inside — no
  screenshot, no `lastShot`, no drift check. `landedOn` is BEST-EFFORT here: `describePoint` takes the
  full session target (not a bare tabId) and is asked on the ref's own session with the same point that
  is clicked, so a frame-local coordinate is resolved in the space it was measured in — and its
  `getContentQuads` containment cross-check is what makes that safe by construction, degrading to null
  whenever the spaces disagree instead of naming the wrong element. Missing `landedOn` is therefore
  still EXPECTED in uid mode and must not warn (unlike pixel mode, whose absence IS the warning); the
  tool text tells the model to confirm the effect in the returned snapshot instead. The mode is chosen
  in `background.js` by `typeof message.uid === "string" && message.uid`, and `browserTools` rejects
  both-or-neither before the wire. `clampFraction` refuses `Number(null) === 0` explicitly — the relay
  sends `null` for an omitted field, which would otherwise click the left edge instead of the centre.
- **PIXEL mode clicks by SCREENSHOT-PIXEL coordinates, not CSS coordinates.** Screenshots are
  downscaled (`SCREENSHOT_MAX_WIDTH` 1400), so the pixels the model sees ≠ CSS px. The extension
  remembers the LAST capture's mapping (`lastShot`: tabId/mode/scale/clip dims) and inverts the scale at
  click time — viewport captures only; element/fullPage clips are page-absolute and refused with a
  redirect to a plain viewport screenshot. Same lifetime rule as uids: coordinates are only valid for
  the screenshot that produced them — enforced at CLICK time, not mint time: the branch re-reads
  `Page.getLayoutMetrics` and refuses on URL/scroll/viewport-size drift (a stale image size would even
  pass the bounds check). Before dispatching, the point is hit-tested read-only
  (`DOM.getNodeForLocation` + `describeNode`, geometry cross-checked via `getContentQuads` so a
  wrong-space hit degrades to silence, never a lie) and the
  landed-on element rides back (`landedOn`, quarantined as page content, capped in the relay). An
  UNIDENTIFIED landing is stated as a warning in the tool result ("could NOT be identified") — absence
  must never read as success, since the landed-on report is the one thing keeping a blind click honest.
- **A uid is STABLE for the life of the worker, not for one snapshot.** `refMap` (uid → ref) plus the
  reverse `uidByNode` (`${tabId}:${sessionId||"root"}:${backendNodeId}` → uid) are never reset per
  snapshot: `mintUid` returns the uid an element already has, so re-snapshotting a page that re-orders
  itself (a rolling newsstand) no longer repoints "e42" at a stranger — a re-rendered element is simply
  a NEW element with a new uid, and a dead one fails loudly. Bound by `REF_MAP_MAX` (30k, both maps
  cleared at the start of a snapshot past it) and swept per tab on `close_tab` and `chrome.tabs.onRemoved`.
  `refSeq` deliberately keeps counting across an eviction — reusing numbers would reintroduce exactly
  the wrong-element bug. A uid that RESOLVES but whose node is gone gets a written recovery instruction,
  not raw CDP text: `nodeCall(ref, …)` maps `/no node|not found|could not find node/i` and wraps
  `centerOf`/`quadsOf`, `focusForInput`, captureShot's uid branch and selectOption's `describeNode`.
  `resolveRef`'s unknown-uid message is unchanged.
- **The common action tail settles, and it never reports a done action as failed.** `SETTLE_OPS`
  (INPUT_OPS + navigate/navigate_back/new_tab/handle_dialog) wait `ACTION_SETTLE_MS` (350) before the
  tail re-reads the tab: a page's answer to input is async, so the old immediate snapshot showed the
  state BEFORE the autocomplete/menu/validation appeared and the agent read the action as a no-op
  (`wait_for` keeps its own loop and does not settle). If the tail snapshot then THROWS, the reply is
  still `ok:true` with `snapshot: ""` plus `snapshotError` — the action already happened, and failing
  the whole op made the agent retry and navigate twice. `snapshotError` is a full five-layer field
  (`browserTools.report` appends it OUTSIDE the untrusted wrapper, since it is bridge-authored, and
  names read_text/snapshot as the check instead of the action).
- **`getFullAXTree` covers only the MAIN frame, so frames are walked THREE ways.** `axSources(tab)`
  returns the root session, then one source per non-main frame id from `Page.getFrameTree` (the only
  addition to `CDP_ALLOWLIST` here — read-only structure, ids only), then one per OOPIF child session.
  Without the middle kind a SAME-process iframe rendered as an empty `Iframe "name"` line with all its
  content missing. Root-session frame ids for OOPIFs fail there and are absorbed by the per-source
  try/continue, since that content arrives via the child session. Frame uids ride the session that
  fetched them (backendNodeIds are unique per target), so click/type are unchanged. `read_text`'s
  uid-scoped path stays session-scoped but falls through that session's frame trees when
  `renderAxText` returns null, before raising the stale-uid error.
- **Audit policy: actions PLUS deliberate reads.** `screenshot`/`read_text` get rows (they are the
  exfiltration surface); `snapshot`/`wait_for` never do — they fire between every step and would bury
  the rows that matter. URLs are scrubbed of userinfo and query string.
- **No JS execution, and that shapes op design.** `CDP_ALLOWLIST` is default-deny with no
  `Runtime.*`/`Network.*`/`Storage.*`; elements are AX-tree `backendNodeId`s. So `select_option` clicks a
  rendered option, or walks a collapsed native `<select>` with arrow keys and then RE-READS the landed
  value (the keyboard path silently no-ops on some platforms — macOS opens the native popup instead).
  `read_text` reuses the same `extension/axtree.js` walker as snapshot (`renderAxText` vs
  `renderAxTree`), is offset-chunked, and mints no uids so it never invalidates a snapshot. With
  `expand: true` it scrolls the page in viewport steps and MERGES the captures
  (`mergeTextLines` — virtualized feeds DELETE what scrolls out, so one read at the bottom would
  hold only the tail); expand is page-level by definition and refused together with `uid`.
- **Snapshots are budgeted uid-first.** `capSnapshot` (extension side, `axtree.js`) fits every
  snapshot into a fixed character budget by keeping `[uid]` lines before prose — cut TEXT is
  recoverable via offset-chunked `read_text`, a cut uid is unreachable — and says what it dropped;
  `browserTools.report()` keeps a coarser defensive cap for old installed builds. Related renderer
  choices: links print their AX `url` property (`→ https://…`, so results can be compared without a
  click-and-load per candidate), NAMED table/tree rows and focusable non-opaque nodes mint uids
  (`NAMED_CLICKABLE_ROLES` — draw.io-style `<tr>` menus were visible but unclickable), and input ops
  focus via `focusForInput`, which falls back to a real centre click when `DOM.focus` refuses
  (ProseMirror bodies, canvases).
- **Seven `axtree.js` rules exist because each one silently DELETED, DROWNED, or made UNREACHABLE real
  page content.**
  (1) `AXValue.value` is not always a string — a slider/spinbutton reports a number and `.trim()` threw,
  failing all three read tools on the whole page; both name and value are `String(… ?? "")`, with `??`
  not `||` so a numeric 0 prints as "0". (2) Echo suppression matches on TOKEN boundaries
  (`containsAsToken`), not `String.includes`: a substring hit let an ancestor label like
  "달력 2026.08.08" swallow every calendar cell named "2"/"8"/"20"/"26". (3) `walkAxNodes` passes each
  emission its nearest emitting ancestor as `container`, which is what lets both renderers rejoin a
  paragraph that per-word `<span>`s split into a word per line, and lets `renderAxText` keep a table's
  row on one ` | `-separated line (`CELL_ROLES` inside `ROW_ROLES`) instead of a vertical list of cells.
  (4) `renderAxTree` folds links sharing a FULL href onto one line at the first occurrence's position,
  upgrading it in place when a later duplicate carries a longer name — one SERP result arrives as four
  to six links to the same destination. `linkHref` returns the URL untruncated because it is the dedupe
  identity; `printableUrl` applies `LINK_URL_MAX`. Three later rules answer the same class of failure:
  (5) NAMED `region`/`application` containers mint uids (`NAMED_CONTAINER_UID_ROLES`) — a map's drawn
  body has no accessible children at all, so the container's own uid is the only thing click_at's uid
  mode can aim at; nameless ones stay structure, and `region` remains in `OPAQUE_NAME_ROLES` (a uid says
  "actionable", not "my name covers my subtree"). (6) `renderAxTree` falls back to the AX `description`
  (where a `title` attribute lands) when an interactive node has neither name nor value, so a page of
  icon-only `button ""` lines becomes distinguishable; it never replaces a real name and never feeds
  ancestor coverage. (7) Echo suppression is TWO-layered: per-node token matching, plus a RUN-level
  whitespace-insensitive check at close — a `<mark>` highlight splits a sentence mid-word, so no fragment
  sits on a token boundary and the rejoined run repeated the container's whole label as a second line.
  Only runs of ≥ 2 segments may be dropped (a lone StaticText inside a longer label is the calendar
  case, rule 2), and suppression NULLS the slot, filtered out once at the end, because `byHref` holds
  line indices that must stay valid for the rest of the walk.
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

### Chat / SSE / sessions
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

### Image attachments
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

### Generated-file delivery + PPTX deck pipeline (`share_file`, hidden publishes)
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

### Visual canvas (`mcp__canvas__show`, experimental `canvas` feature)
- CSP-SAFE port of Superpowers' visual companion: the avatar DECLARES content
  (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional `controls` (buttons/text); the CLIENT renders
  sanitized content (DOMPurify; mermaid `securityLevel: strict`; **`vega` = a compact Vega-Lite spec
  compiled+rendered to an SVG STRING via the CSP-safe `vega-interpreter` AST evaluator — no `Function`
  ctor, so `script-src 'self'` is untouched**; all lazy-loaded with a source-`<pre>` fallback) + real form
  controls — no avatar JS runs, CSP unchanged. `canvasTools.ts` (NOT self-gated — registration is the
  boundary) registered in `claudeAgent.ts` ONLY when the avatar OWNER enabled `canvas` AND
  `events.onCanvas` exists. Controls park the run via the SAME `awaitResponse`/`/api/chat/respond` path as
  `onQuestion`; display-only returns immediately. Artifacts persist on `AgentResponse.canvases` and rebuild
  on reload (`canvasesFromMessages`); live via SSE `canvas` event → `CanvasPanel.svelte`. **Refine-in-place:**
  `show` takes an optional `canvasId`; reusing it UPDATES that artifact (client `handleCanvas` +
  `canvasesFromMessages` AND server `record()` all upsert by id, latest-wins). **Size-cap:** `canvasTools.ts`
  rejects over-`MAX_CANVAS_CONTENT_CHARS` content (it rides every `resume` turn's transcript).

### Experimental features
- Per-user beta toggles (`canvas` is the first). Registry in `experimentalFeatures.ts`
  (`{key,name,description}`; name/description KOREAN, shared with the client via `tsconfig.client.json`).
  Wired through the per-user-setting pattern: `users.experimental_features` JSON column →
  `toUser`/`getExperimentalFeatures` → `updateProfile` (normalizes to KNOWN keys) →
  `User.experimentalFeatures` → `PATCH /api/me {experimentalFeatures}` → "실험 기능" card in
  `SettingsAccessTab.svelte`. Self-state in BOTH `buildPrompt` (owner/routine `experimentalFeaturesSection`)
  AND `describe_system` (via `OwnerState.experimentalFeatures`). Gate a feature on
  `ownerState.experimentalFeatures.includes(key)`.

### hex-ssh (remote SSH)
- An APP-registered MCP, not a plugin one. `claudeAgent` adds it to `mcpServers` only when the owner stored
  `SSH_PRIVATE_KEY` AND the current viewer class has at least one allowed hex-ssh tool. The registered
  command is `scripts/hex-ssh-policy-proxy.mjs`, which runs the upstream command from
  `config.hexSshCommand` (`HEX_SSH_COMMAND`, default `hex-ssh-mcp`) and filters `tools/list` by
  `HEX_SSH_ALLOWED_TOOLS` before the model sees the schema. The PreToolUse hook separately blocks
  disallowed `mcp__hex-ssh__*` calls, so the proxy is token/UX optimization and the hook is the final gate.
  The upstream package is installed into the image at build time, not via runtime `npx`.
- **App-managed MCP servers shadow same-named plugin ones.** MCP config is keyed by server name, so a
  plugin's bundled `.mcp.json` declaring `hex-ssh` (keyless) can win over the app's keyed one.
  `stripManagedMcpServers` (plugins.ts, `APP_MANAGED_MCP_SERVERS`) removes those names from each plugin
  `.mcp.json` in `resolvePluginRoots` before the SDK sees them. For the knowledge repo, `commitAndPush`
  restores tracked `.mcp.json` from HEAD before `git add -A`, so the strip is never pushed back.
- **Debugging a launched MCP server:** the SDK spawns it as a subprocess, so failures DON'T appear in the
  app's pino logs. Check `~/.cache/claude-cli-nodejs/<workspace>/mcp-logs-<server>/` — the dir name is the
  server name, so it also reveals WHICH instance won a name collision (`hex-ssh` vs `plugin_<plugin>_hex-ssh`).

### Slash commands (server-expanded)
- **ALL built-in slash commands are server-expanded** (`/learn`/`/summarize`/`/remember`/`/routine`/`/find`):
  `src/client/src/lib/slash.ts` carries only metadata (name/title/description/argsLabel/ownerOnly/
  requiresArgs) — no client-side `prompt`, no `serverExpand` flag. The client always sends the literal
  `/command [args]` (chat.ts `submit`); the SERVER `expandChatSlashCommand` (`routes/chat.ts`) swaps in the
  expanded prompt for the model (agent-facing English). The literal stays the bubble + persisted turn; only
  the user-facing `error` strings in `expandChatSlashCommand` stay Korean. The chat handler stores
  `displayMessage` (raw literal) but feeds `agentMessage` (expanded) to `runAgentStream`. `agent-core.test.ts`
  asserts the client bundle carries NO copy of any server expansion. (Skill entries are NOT slash commands —
  the menu sends a Korean natural-language instruction naming the skill, built by `skillToSlashCommand`.)

### git remote work is MCP-only
- The agent shell has no git credentials (stripped from the subprocess env), so Bash `git clone/push`/`gh`
  can never authenticate. `GIT_MCP_ONLY_GUIDANCE` (claudeAgent.ts) is injected on every tool-capable turn
  telling the avatar to use `mcp__repo__*`/`mcp__git_repo__*`/`mcp__group_repo__*` ONLY and never retry a
  failed MCP git call via Bash; the git tools' failure messages repeat the no-Bash-fallback line with cause
  hints. When adding a git-ish capability, route it through an in-process MCP bridge and keep that line in
  its error text.
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it STANDING
  per-turn guidance (not just the greeting) + an action-trigger in the tool's description + an error that
  redirects (e.g. `NO_REPO` → "use `create_repo`"). Greeting-only text once left it unaware it had
  `create_repo` mid-conversation.

### Testing git/repo tools offline
- Point the repo at a LOCAL bare remote (`git init --bare`) so clone/commit/push need no network —
  `gitAuthArgs` returns `[]` for non-`https://` URLs. For `create_repo`, inject a fake `createRemoteRepo`
  or fake `gh` runner; to drive the post-create clone/seed/push offline, have it return a local bare-remote
  PATH as `fullName` (`marketplaceCloneUrl` leaves non-`owner/repo` strings as-is).

---

## Client (`src/client/` — Svelte + Vite)

Companion to the client-area philosophy in [`../src/client/CLAUDE.md`](../src/client/CLAUDE.md).

### Structure
- **The frontend is Svelte + Vite under `src/client/`, NOT vanilla `public/`** (migrated 2026-06, commit
  `b8505fb`). `public/` now holds only static assets (favicons, manifest, PWA icons). Entry
  `src/client/index.html` → `src/client/src/main.ts` → `App.svelte`; views in `src/views/*.svelte`, shared
  components in `src/components/*.svelte`, non-UI logic/stores in `src/lib/*.ts`. `lib/state.ts` is the
  central writable store (`appState` + `updateState`/`readState`/`replaceState`/`notify`); other lib:
  `chat`, `loaders`, `api`, `nav`, `slash`, `format`, `dom`, `knowledge`, `onboarding`, `theme`, `sse`.
  Built by `vite build` → `dist/client`, which `app.ts` serves (falling back to `public/`).
- **`src/lib/state.ts`:** `appState` is a Svelte `writable`; mutate via `updateState(fn)`
  (mutate-then-reassign; also recomputes `streaming`), read via `readState()`, patch via
  `replaceState(patch)`, toast via `notify(msg, kind?, {actionLabel?, action?})`. Reactivity comes from the
  store subscription (`$appState`) — no manual `renderView()`.
- **Server types are shared, not re-declared.** `src/lib/types.ts` re-exports from
  `../../../server/types.js` (and `tsconfig.client.json` includes `src/server/types.ts` +
  `routineSchedule.ts`). Import server types through that barrel.
- **The old vanilla frontend lives in git at `f0a6128`** (`git show f0a6128:public/js/<file>`) — the parity
  reference. Stylesheets were carried over VERBATIM from `public/styles/*.css` to `src/client/styles/*.css`
  (same filenames `00-tokens`→`70-modals-groups`, same class names), loaded via `@import` in
  `src/client/src/styles.css` (cascade = import order), NOT `<link>` tags. So porting/restoring a feature =
  reproducing the SAME DOM structure + class names the old vanilla JS emitted — don't invent new class
  names (e.g. tabs use `.settings-tabs`/`.settings-tab` for BOTH Settings AND Admin; a custom `.tabbar` has
  NO CSS and renders unstyled). Spacing `--s-*`/color/radii tokens live in `00-tokens.css`.
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown` in `lib/format.ts`,
  bundled by Vite — not the old `/vendor` ESM routes).

### CSP
- **`app.ts` serves a strict same-origin CSP** (`script-src`/`connect-src` `'self'`, `img-src 'self'
  data:`). So remote `<img>` in rendered markdown is BLOCKED and the browser can't fetch cross-origin —
  widen the relevant directive in `app.ts` if a feature needs it. The Svelte build emits no inline
  `<script>`, so `script-src 'self'` is safe.

### Theme (light / dark / system) — `src/lib/theme.ts`
- **One device-local preference, resolved in JS, applied as an attribute.** `localStorage["noah-theme"]` is
  `system` (default) | `light` | `dark`; `applyTheme()` resolves it (system →
  `matchMedia('(prefers-color-scheme: dark)')`) and sets `<html data-theme="dark">` (light removes the
  attr). `watchSystemTheme()` re-applies on OS change only while the pref is `system`. The rail-footer
  button cycles 시스템→라이트→다크.
- **The dark token block is SINGLE-SOURCE: `:root[data-theme="dark"]` in `00-tokens.css`**, NOT a
  `@media (prefers-color-scheme: dark)` duplicate. There IS a deliberate ~3-line
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` fallback setting ONLY `--bg`; it
  stops matching once JS sets `[data-theme]`, and its sole job is to kill the first-paint light flash for
  OS-dark users — keep it minimal.
- **The inline-`<script>`-in-`<head>` anti-FOUC trick is impossible** (CSP blocks inline scripts). The
  CSS-only `--bg` fallback is the substitute; any first-paint theming must stay CSS-only.

### CSS gotchas (`src/client/styles/*.css`)
- **Input chrome comes ONLY from `.field input`, not a global rule.** The global
  `button,input,select,textarea` rule (`10-base.css`) sets just `font`/`color: inherit`. All input styling
  is the canonical `.field input, .field select, …` rule (`20-shell-chat.css`) and applies ONLY inside a
  `.field` ancestor. A bare `<input>` in a custom row renders unthemed — new form controls MUST sit inside
  `.field` or fold into that canonical selector.
- **Code-block colors are deliberately FIXED across light AND dark** via `--code-*` tokens
  (`00-tokens.css`). Do NOT remap them to semantic `--ok`/`--danger` (those invert in dark and are
  unreadable on the always-dark code surface).
- **Undefined CSS custom props fail silently.** `var(--undefined)` with no fallback renders invalid with no
  console error. Scan after CSS edits.
- **Tabs (Settings AND Admin) use `.settings-tabs`/`.settings-tab`** (icon + `<span>` label). A custom
  `.tabbar` class has NO CSS and renders unstyled.
- Global stylesheet + `{@html}`-rendered markdown share class names — avoid bare generic class names (e.g.
  `main`) on dynamically-rendered nodes; the activity-tree root uses `is-main`, not `main`
  (`.main { height: 100dvh }` once stretched the box). Svelte component `<style>` is scoped, but the
  carried-over global CSS and `{@html}` output are not.

### Svelte client pitfalls (svelte-check catches these)
- `<svelte:window>` cannot live inside `{#if}`/blocks — must be top-level. A `use:action` taking a
  parameter must declare a 2nd arg `(node, param?)` or svelte-check errors "Expected 1 arguments, but got
  2". `role="dialog"`/`"tablist"` on a `<nav>`/`<div>` trips an a11y warning — put the role on the right
  element. `AgentResponse.runtime` is only `"local"|"claude"` (errors/blocked surface via `summary`, NOT
  runtime — don't compare runtime to `"error"`).

### Svelte 5 runtime gotchas (svelte-check does NOT catch these)
- **A green svelte-check does NOT mean the behavior is correct — for interaction/layout/timing changes,
  runtime-verify (Playwright fixture, see Verification).** The `autosize` fix (passing `item.draft` as the
  action param + a 2nd-arg signature) compiled AND passed svelte-check yet was a pure no-op at runtime;
  only a real-DOM measurement caught it.
- **A `use:action={param}`'s `update()` runs BEFORE Svelte flushes the bound `value` to the DOM node.** So
  reading layout (`scrollHeight`) synchronously inside `update()` measures the OLD content. This bit the
  composer `autosize` (`lib/dom.ts`): on send, `ChatView` sets `draft=""`; the action's `update()` fired but
  `node.value` was still the old multi-line text at that instant, so `grow()` re-pinned the tall height,
  then Svelte set `value=""` without re-measuring → the textarea never shrank back. Fix: defer the
  param-driven grow with `queueMicrotask(grow)`; keep the `input`-listener path synchronous. General rule:
  when an action must react to a programmatic value change, defer any layout read to a microtask.
- **Legacy mode compiles template FUNCTION CALLS inside `$.untrack()`** (Svelte-4 compile-time dependency
  semantics: only variables referenced DIRECTLY in the expression are tracked). A helper like
  `hasPresetValue(name)` that reads a reactive `let` in its BODY never re-runs when that state changes —
  the CONFLUENCE_PAT 저장 button stayed disabled while typing (`SettingsAccessTab`). Fix pattern: derive
  per-item state in a `$:` map (`presetFilled`/`presetStatusText`) and have the template read the map
  DIRECTLY. Functions that read only their ARGUMENTS (e.g. `canSendMessage(item)`) are fine — the arg is
  the tracked dep. Known latent same-class instances (masked by coincident list refreshes, unverified):
  `Shell.isConversationBusy`/`isConversationStreaming`, `ChatView.canPickModel` — see REFACTORING-BACKLOG.
- **One `updateState` re-evaluates EVERY each-block item's template expressions — and streaming calls it
  once per SSE token.** `$: panes = $appState.chatPanes` re-emits the same array, but `safe_not_equal` is
  always true for objects, so the dirt propagates down to each keyed item. Measured with a probe component
  matching ChatView's shape: a 200-message pane ran 200 template evaluations *per token* (2,000 over 10
  tokens). In the transcript that expression is `renderMarkdown(...)` — 57 ms of `marked` + `DOMPurify` per
  token, all thrown away because the html was identical. Two mitigations are in place, keep them:
  `renderMarkdownCached` (`lib/format.ts`) memoizes PERSISTED message bodies on their source text — live
  streaming text must keep the plain `renderMarkdown` or it just churns the map; and `enhanceMarkdown`
  (`lib/dom.ts`) skips its two `querySelectorAll` sweeps when the param is identity-equal, which is why
  every call site MUST pass the same source string its sibling `{@html}` renders. The real fix is runes
  for this subtree (REFACTORING-BACKLOG T3.10); until then, assume anything in a chat `{#each}` runs at
  token rate and keep it cheap or memoized.
- **`<details>` hides its children, it does not skip rendering them.** A body left in the template costs a
  full markdown parse / component mount for every message on load, on a card most users never open. The
  transcript's "생각 과정" and "작업 내역" cards therefore render on first open, driven by an
  `expandedCards` set fed from `on:toggle` (`ChatView`). Note `toggle` fires as a TASK after `open` flips
  (spec behavior, jsdom matches) — a test must await a macrotask, not just `tick()`. Trade-off accepted:
  Chrome's find-in-page can no longer reach inside an unopened card.

### Chat transcript auto-scroll (stick-to-bottom)
- **User intent is read from INPUT events (wheel/touch/pointer), never inferred from scroll deltas.**
  Scroll-event heuristics lost twice over: mid-stream re-pins reset the viewport between wheel notches
  (so per-event deltas/distances never accumulate — slow trackpad drags are 1–4px/event and a single
  notch always lands back inside any near-bottom zone), and the wheel's scroll event can coalesce with
  our own pin into one net-downward move. That's what made auto-scroll "work sometimes" for years.
  Mechanism (all in `lib/autoscroll.ts` `createStickController`, one per pane; decision function
  `lib/scroll.ts` `nextStickBottom` is pure + unit-tested):
  - wheel-up → detach SYNCHRONOUSLY (before the scroll even applies); touch drag-down > 8px → detach;
    held pointer (scrollbar drag) or recent wheel/touch marks scroll events `userGesture`, which
    detaches on ANY ≥1px upward move that doesn't land at the bottom.
  - Browser range-clamps (content shrink / composer autosize growing the viewport) also decrease
    scrollTop but always LAND at the new bottom — that landing spot is the discriminator, both for
    detach (skip clamps) and re-engage (require top to INCREASE into the bottom zone; you can't reach
    the bottom by scrolling up, so a clamp can never re-stick a reader).
  - **Chromium ANIMATES wheel/keyboard scrolls**: after a re-engage/FAB-jump our pin overtakes the
    still-flying animation, whose next frame then looks like an upward move. A 250ms grace window
    (re-armed by down-wheels) suppresses heuristic detaches; direct input (wheel-up/touch/scrollbar)
    bypasses it. Without this, wheeling down to the bottom re-engaged and instantly un-engaged.
  - Nested vertical scrollers inside the transcript (`.activity-live > .agent-activity`) consume
    wheel-up themselves while they can still scroll up — the controller walks target→transcript and
    skips detach so the inner pane scrolls without killing the outer stick.
  - `overflow-anchor: none` sits on BOTH `.transcript` and `.transcript-inner` (scroll anchoring would
    silently reposition scrollTop after our pin, invisible to JS).
  - ChatView keeps only thin wiring: `use:transcriptStick={item.id}` + `afterUpdate → pin()` + the FAB's
    `jumpToBottom()`; `stickBottom` stays in the pane store (send re-arms it in `lib/chat.ts`).

### Split chat
- Avatar pool = all visible avatars, duplicates allowed (multiple parallel conversations with the same
  avatar incl. your own); the only gate is the 4-pane max. User message bubbles render text directly in
  `.bubble` (which has `white-space: pre-wrap`), NOT wrapped in `<p>` (that adds stray top/bottom margins).
  `GET /api/avatars` (`listPublishedAvatars`) includes the viewer's OWN avatar plus public + group-teammate
  avatars.

### Client ↔ server contracts mirrored by hand
- No shared module across the TS/Svelte ↔ server boundary, so the client re-implements several server
  validators. Update these in lockstep:
  - `normalizeTags` (`lib/format.ts`) ↔ server `normalizeHashtags`
  - repo-href building ↔ server `githubHost` resolution
  - the schedule builder (`RoutineModal.svelte` + `formatRoutineSchedule`/`timeToMinute`/`minuteToTime` in
    `lib/format.ts`) ↔ server `routineSchedule.ts` (once/daily/weekly/interval semantics)
- **Admin presence badge: the client poll interval bounds the server window from BELOW.**
  `users.last_seen_at` is stamped by EVERY authenticated request, and `startKnowledgeWatch`
  (`lib/loaders.ts`) is what keeps it warm for an idle-but-open tab — it polls once a minute and ONLY while
  `document.hidden` is false. `PRESENCE_WINDOW_MS` (`store/internal.ts`) must therefore stay above that
  interval with room for one missed tick, so ~2 min is the floor; shortening the window below it, or
  lengthening the poll interval, makes the badge flicker to zero for people who are right there.
- **The window is currently 1 hour, which means "around recently", NOT "at the screen now."** At that width
  the visibility gate stops being load-bearing (one visible moment in the hour is enough) and someone who
  closed the tab 59 minutes ago still counts. It was widened from 3 min deliberately — 3 min emptied the
  badge whenever people switched tabs. Consequences to respect: never relabel the badge as live presence,
  always surface `AdminPresence.windowMinutes` in the UI (the tooltip and empty state do), and expect the
  per-row ages to carry the real signal. Still not `AdminStats.activeSessions`, which counts 14-DAY login
  cookies and so never decays within a workday. If the window ever changes, the two `windowMinutes`
  assertions (`tests/store.test.ts` straddles the boundary at 59/61 min, `tests/app.test.ts`) fail loudly by
  design.

### Behavior gotchas (don't "fix" these)
- **Group-knowledge toggle saves a per-USER default, fire-and-forget with NO readback.** A new chat pane
  seeds `groupKnowledgeOff` from `state.user.groupKnowledgeOffDefault` (own-avatar panes only). This is what
  lets the toggle reach the **auto-greeting** (fires before the composer is touched). The toggle updates
  `state.user.groupKnowledgeOffDefault` optimistically and PUTs `/api/me/group-knowledge-default` in the
  background; it deliberately does NOT sync `state.user` from the response (rapid toggles resolve out of
  order) and only toasts on failure. Don't "fix" this into an await-and-sync.
- **The model/effort/MCP-group pickers write through to a per-user default** (`PUT /api/me/chat-defaults`),
  same optimistic-update pattern as the group-knowledge toggle: update `state.user.{model,effort,
  mcpToolGroups}Default` then PUT in the background, toast only on failure. New panes seed from these.
- Some settings cards (profile/visibility/secrets) save WITHOUT a full reload to avoid wiping unsaved form
  text — preserve in-place updates there.
- **Splitting a multi-tab view into per-tab components: ALWAYS-MOUNT + `active` prop, never `{#if tab}`
  around the child.** In a monolithic tab view, `{#if settingsTab===…}` only swaps the *template* branch
  while the single `<script>`'s `let` form vars persist across tab switches. Rendering each new child
  *inside* `{#if}` unmounts it on every switch and silently loses that state. Faithful split: render all tab
  components UNCONDITIONALLY (always mounted) and pass `active={settingsTab === "…"}`; each child gates only
  its own template (`{#if active && user}`) and initializes form state ONCE at script-init from
  `readState().user`. `SettingsView.svelte` is the worked example (1,013→130 lines; tabs in
  `components/Settings{Profile,Access,Knowledge}Tab.svelte`). The former inline groups tab moved to its
  own left-rail view (`views/GroupsView.svelte`, 2026-08): my-groups cards + the system-admin group
  management that used to be the admin view's 그룹 tab; legacy `#/settings/groups`·`#/admin/groups`
  hashes normalize to `#/groups` in `lib/nav.ts` `routeFromHash`.
- **Admin external avatars are independently lazy-loaded.** `AdminExternalAgentsPanel.svelte` stays
  mounted with an `active` prop so its API cannot blank the existing admin overview and unsaved editor
  state is not coupled to tab switches. Its modal uses explicit `keep|set|clear` API-key intent and
  forces an Explore cache refresh after CRUD so runtime visibility changes appear immediately.

### Client verification
- **`npx svelte-check --tsconfig ./tsconfig.client.json`** is the real client type/template check (also
  `npm run lint:client`); `npx tsc --noEmit` covers shared server types. `vite build` (`npm run
  build:client`) is the production compile; `pretest` runs `vite build --mode test`. ⚠️ Don't trust
  `npm run lint` — the rtk hook misrewrites it to eslint.
- **Svelte component tests** live in `tests/svelte-*.test.ts` (vitest "components" project: jsdom +
  `@sveltejs/vite-plugin-svelte` + `@testing-library/svelte`; `tests/svelte-components.test.ts` is the
  worked example). The glob is load-bearing THREE ways: it routes the file into that project
  (vitest.config.ts), OUT of the root NodeNext tsc program (tsconfig.json `exclude`), and INTO
  `tsconfig.client.json`'s include (svelte-check typechecks it). Non-component client-lib tests use the
  sibling `tests/client-*.test.ts` glob (same tsconfig routing; node env with per-file jsdom pragmas; no
  Svelte plugin). `.svelte` files are NOT in the coverage `include` yet — adding them would sink totals
  below the vitest thresholds until component tests broaden.
- **Isolated UI/layout/interaction behavior CAN be runtime-verified** when no `HTTP_PROXY` is set (check
  `env | grep -i proxy`). Install Playwright on demand (`npm i -D playwright && npx playwright install
  chromium`), build a MINIMAL Svelte fixture **inside the project dir** (a `/tmp` fixture can't resolve
  `vite`/`@sveltejs/vite-plugin-svelte` from `node_modules`) that imports the REAL action/component under
  test, serve it (`node_modules/.bin/vite --config <fixture>/vite.config.mjs`, `configFile:false`,
  `plugins:[svelte()]`), and drive it headless to measure real DOM/layout. Clean up after: `rm -rf` the
  fixture and `npm uninstall` the playwright devDeps so `package.json`/lock stay clean. This caught the
  `autosize` shrink-after-send fix PASSING svelte-check yet FAILING at runtime, and the wheel-animation
  re-engage race in the transcript auto-scroll rewrite.
- ⚠️ **Vite full-reloads the fixture page once after a source edit** (dep re-optimize): everything you
  `evaluate()`d before the reload — seeded DOM, started intervals, window hooks — is silently wiped while
  the driver keeps talking to the fresh page. Warm up first: `goto` → wait ~700ms → `reload()` → then
  run the scenario. (Symptom: assertions on state you "just set" find defaults; `[vite] connecting...`
  appears twice with console piped.) Playwright can't synthesize scrollbar drags in headless Chromium —
  assert that path via unit tests, and report the browser check as skipped rather than green.

### UI-consistency invariants (2026-08 pass) — load-bearing, don't regress
- **`00-tokens.css`가 라운드·그림자·이징의 단일 정의처.** `80-apple-design.css`는 재정의 금지
  (해당 자리에 금지 주석). 과거 이중 정의로 00 값이 전부 죽은 값이 되는 사고가 있었다.
- **`App.svelte`의 모달 DOM 순서가 스택킹을 결정한다** — 전부 같은 `--z-modal`이라
  `ConfirmationDialog`가 마지막이어야 다른 모달 위에 그려진다. 순서 변경 금지(DESIGN.md §4.4).
- **모달 동작(포커스 트랩·inert·초기 포커스·복원)은 `lib/modalBehavior.ts` 공유 모듈** —
  `Modal.svelte`/`PromptModal.svelte`/`CanvasPanel.svelte`(canvas-fs)가 공용. PromptModal 루트
  인스턴스는 Escape=거부·백드롭 닫기 없음(의도), pane 인스턴스는 non-modal(aria-modal/inert 없음).
- **테마 반응성:** `lib/theme.ts`의 `theme` 스토어는 `applyTheme()`만 발행하는 single-writer.
  캔버스형 렌더러(GraphCanvas의 cytoscape 스타일, CanvasPanel의 Vega/mermaid)는 이 스토어를
  구독해 재스타일한다 — `data-theme`을 init에서 한 번만 읽는 패턴으로 되돌리면 토글 시 색이 낡는다.
- **차단 이벤트는 2채널:** `BlockedEvent.uiReason`(한국어, UI 표시용) vs `reason`(영어
  `decision_reason`, SDK/진단용). 클라이언트 `lib/chat.ts`는 `uiReason` 우선. 모델에 가는
  영어 텍스트를 한국어로 바꾸지 말 것(반대도 금지) — `preToolUseHook.ts`가 레퍼런스.
- **admin 외부 아바타 검증 메시지는 `routes/adminExternalAgents.ts`가 `EXTERNAL_AGENTS_JSON[0].`
  접두사를 정규식으로 벗겨 렌더한다** — `externalAgents.ts`의 한국어 throw는 `.field` 형태를
  유지해야 조사가 어색하게 잘리지 않는다.
- **audit log의 status는 `success`/`error` 외에 `ok`도 존재**(`agent/sshIdentityTools.ts`).
  클라이언트 라벨 매핑(`AdminView.svelte`)은 세 값 모두 처리한다.
- **아이콘 경로의 단일 출처는 `lib/icons.ts`** (`ICON_PATHS` + `iconSvg`) — `Icon.svelte`와
  `lib/dom.ts`(imperative innerHTML)가 함께 소비한다. `Icon.svelte`에 경로를 직접 추가하지 말 것.
  `Icon`의 `name`은 bare string이라 **오타는 조용히 빈 SVG로 렌더**된다 — 이름 추가 시 육안 확인.

---

## Cross-cutting gotchas

### Env loading
- **`.env` loading is in-code, not dotenv/`--env-file`.** `src/server/loadEnv.ts` calls Node's built-in
  `process.loadEnvFile()` and is the **first import in `index.ts`** (so values land before `auth.ts`
  SECURE_COOKIES / `logger.ts` LOG_LEVEL are read at module-eval). Real env (Docker `-e`, compose, shell
  export) WINS — the file only fills unset keys. Auto-load is **skipped when `NODE_ENV==='test'`** so suites
  use explicit `createServices` overrides. `tsx`/`node` do NOT auto-load `.env` and `--env-file` isn't
  forwarded by `tsx` / allowed in `NODE_OPTIONS`, which is why it's done in code.

### Project name divergence
- Display name "Noah Almighty", code slug `noah-almighty` (package name, `noah-almighty.db`,
  `@noah-almighty.local` git identity fallbacks, logs, test temp-dir prefix), git remote `origin` is
  `noah-almighty` (`github.com/JinY0ung-Shin/noah-almighty`) — but the working dir is `avatar-chat`, and the
  older `avatar-square`/`avatar-chat` slugs still surface in history. Grep both old/new slugs when auditing
  names.

### Worktrees / staging
- `.claude/worktrees/` holds full embedded repo checkouts: exclude them from greps
  (`grep -v '\.claude/worktrees'`) and never `git add -A` (stage files explicitly — `-A` also pulls in
  unrelated pre-existing edits like `.env.example`). When the tree has unrelated pre-existing edits and you
  must commit only your hunks, note `git add -p` is unavailable here: diff → filter hunks by
  `@@ -<oldstart>` → `git apply --cached`, then commit with **NO pathspec** (`git commit -- <file>` commits
  the WORKTREE, ignoring the index).

### Dynamically-created elements
- Share the global stylesheet — avoid bare generic class names (e.g. `main`) on them; they collide with
  layout rules. The activity-tree root once used `class="agent-node main"` and inherited
  `.main { height: 100dvh }`, stretching the box to fill the viewport. Use a scoped name (`is-main`,
  `agent-root`).
</content>
</invoke>
