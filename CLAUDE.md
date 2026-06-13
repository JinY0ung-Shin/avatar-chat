# Noah Almighty — Claude notes

See README.md for features, setup, env vars, and verification (`npm run lint`/`test`/`build`).

## Module structure & sub-notes
After a 2026-06 cleanup, the big files were split behind **unchanged exports** — import paths are stable:
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers); handlers live in `src/server/routes/{auth,profile,plugins,knowledgeRepo,groups,routines,chat,admin}.ts` (+ `_shared.ts`).
- **Agent:** `claudeAgent.ts` re-exports `buildPrompt` (now in `agent/promptBuilder.ts`), the SDK-message handlers (`agent/sdkMessageHandlers.ts`), and the PreToolUse hook (`agent/preToolUseHook.ts`). Shared self-state in `agent/ownerState.ts`; MCP helpers in `agent/mcpTools.ts`; repo-tool skeleton in `agent/repoToolKit.ts`.
- **Repo git:** low-level plumbing shared via `repoGitCore.ts` + `repoGitGuards.ts`.
- **Tests:** `units.test.ts` split into `agent-core`/`agent-tools`/`store`/`infra` (+ `tests/helpers.ts`).
- Module-level cautions: [`src/server/CLAUDE.md`](src/server/CLAUDE.md), [`src/server/agent/CLAUDE.md`](src/server/agent/CLAUDE.md), [`public/CLAUDE.md`](public/CLAUDE.md). Deferred/riskier work: [`docs/REFACTORING-BACKLOG.md`](docs/REFACTORING-BACKLOG.md).

## Commands
- `npm run dev` — local dev server on port 48787.
- `npm run lint && npm test && npm run build` — standard verification gate.
- `docker compose config` — validate compose/env wiring before Docker changes.
- `CA_CERT_FILE=docker/tls-fullchain.crt docker compose build` — build with a local on-prem CA file.

## Frontend (public/)
- Vanilla JS, no framework. `public/app.js` builds DOM manually via an `el(tag, props, children)` helper.
- Single global stylesheet `public/styles.css` (CSS variables for spacing `--s-*`, colors, radii).
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown`).
- **`app.ts` serves a strict same-origin CSP** (`script-src`/`connect-src` `'self'`, `img-src
  'self' data:`). So remote `<img>` in rendered markdown is BLOCKED and the browser can't fetch
  cross-origin — widen the relevant directive in `app.ts` if a feature needs it. There's no
  inline `<script>`, so `script-src 'self'` is safe.
- `npm run lint` (`tsc --noEmit`) covers only server TS; `public/*.js` is plain JS
  and unchecked — sanity-check frontend edits with `node --check public/app.js`.
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a
  poll/visibility watcher that toasts on new gaps (`updateKnowledgeBadge`/
  `refreshKnowledgeStatus`, app.js) — the UI end of the knowledge-backfill loop.
- **Chat is SSE, and an owner turn can be driven from anywhere in the client.**
  `POST /api/chat/stream {avatarId, message, conversationId?}` streams events
  `open`(→conversationId,runId)/`delta`/`status`/`tool*`/`done`/`error`; omit
  `conversationId` and the server mints one (returned on `open`). Consume with
  `consumeSse(body, (event,data)=>…)`. Interactive prompts are answered out-of-band:
  `POST /api/chat/respond {runId, requestId, value}` — `value` is
  `{behavior:"allow"|"deny"}` (permission) or `{cancelled:true}`/`{result}` (question).
  An owner messaging their OWN avatar is viewerIsOwner+elevated+autoApprove, so `mcp__*`
  tools (repo writes, knowledge `resolve_request`) auto-approve with no prompt — so you can
  trigger a background avatar action outside the chat view by POSTing a turn and silently
  draining the SSE (no view switch needed).

## Gotchas
- **`.env` loading is in-code, not dotenv/`--env-file`.** `src/server/loadEnv.ts`
  calls Node's built-in `process.loadEnvFile()` and is the **first import in
  `index.ts`** (so values land before `auth.ts` SECURE_COOKIES / `logger.ts`
  LOG_LEVEL are read at module-eval). Real env (Docker `-e`, compose, shell export)
  WINS — the file only fills unset keys. Auto-load is **skipped when
  `NODE_ENV==='test'`** so suites use explicit `createServices` overrides, not a
  stray local `.env`. `tsx`/`node` do NOT auto-load `.env` and `--env-file` isn't
  forwarded by `tsx` / allowed in `NODE_OPTIONS`, which is why it's done in code.
- **On-prem GitHub CA = one var `GITHUB_CA_CERT`** (PEM path, `applyCustomGithubCa`
  in `tlsCa.ts`, called from `index.ts`). Covers Node `fetch` via runtime
  `tls.setDefaultCACertificates` (appends to system roots), `git` clone/push via
  `GIT_SSL_CAINFO` (every git execFile inherits `process.env`), and
  `create_repo` via `SSL_CERT_FILE` passed to `gh` in `repoTools.ts`. `GITHUB_HOST`
  becomes `GH_HOST` for `gh repo create` on GHES.
- **Project name diverges by layer:** display name "Noah Almighty", code slug
  `noah-almighty` (package name, `noah-almighty.db`, `@noah-almighty.local` git
  identity fallbacks, logs, test temp-dir prefix), and the git remote `origin` is
  `noah-almighty` (`github.com/JinY0ung-Shin/noah-almighty`) — but the working dir
  is `avatar-chat`, and the older `avatar-square`/`avatar-chat` slugs still surface
  in history. Grep both old/new slugs when auditing names.
- `.claude/worktrees/` holds full embedded repo checkouts: exclude them from
  greps (`grep -v '\.claude/worktrees'`) and never `git add -A` (stage files
  explicitly — `-A` also pulls in unrelated pre-existing edits like `.env.example`).
  When the tree has unrelated pre-existing edits and you must commit only your
  hunks, note `git add -p` is unavailable here: diff → filter hunks by
  `@@ -<oldstart>` → `git apply --cached`, then commit with **NO pathspec**
  (`git commit -- <file>` commits the WORKTREE, ignoring the index).
- **Chat keeps context across turns via SDK session *resume*, not history re-injection.**
  Each `sdk.query()` is stateless: `runClaudeAgent` passes `resume: <sessionId>` and the
  `init` event's `session_id` is persisted to `conversations.agent_session_id`
  (`get/setAgentSessionId`). SDK transcripts live under `config.agentSessionsDir`
  (`dataDir/agent-sessions`, pinned via `CLAUDE_CONFIG_DIR` in the SDK `env` option) so
  resume survives a restart. `greeting` (ephemeral) and `regenerate` (re-runs a turn)
  start a fresh session. SDK `cleanupPeriodDays` (default 30) sweeps old transcripts —
  conversations idle >30d resume as new.
- **A streamed answer must survive completion/reload.** The live bubble shows every
  main-agent `delta` (all turns); on `done`/reload it's rebuilt from the PERSISTED
  `response.text`, NOT `live.text`. So `response.text` must be the full streamed
  transcript (`partialText` in `claudeAgent.ts`, preferred over the SDK terminal
  `result` which is the LAST turn only) — else pre-final-turn narration (preambles,
  text between tool calls) vanishes the instant the run completes. Cancel/error paths
  persist the server-side `streamedText` accumulator (`app.ts`), not an empty stub.
- **Tool permissions go through one gate:** the `PreToolUse` hook in
  `src/server/agent/claudeAgent.ts` (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` are unused (don't fire headlessly). Auto-approve
  applies on the `!headless && elevated && autoApprove` path — **`elevated` = owner
  OR trusted user**, not owner-only; headless routines and plain colleague chats stay
  read-only. But `isAutoAllowed` auto-allows EVERY `mcp__*` tool at the hook BEFORE
  that check, so any in-process MCP server MUST self-gate in its handlers (owner/
  elevated checks) — don't rely on the hook.
- **Per-user settings pattern:** add a column to the `users` table + an additive
  `addColumnIfMissing` migration, then mirror it end-to-end
  (`UserRow`→`toUser`→`updateProfile`→`User` type→`PATCH /api/me`→app.js control).
  A NEW table just goes in the always-run schema `db.exec()` block (`CREATE TABLE IF
  NOT EXISTS` covers existing DBs too) — `addColumnIfMissing` is ONLY for adding a
  column to an existing table.
- **Avatar visibility is a 3-state enum, NOT a boolean.** `users.visibility` =
  `public` (everyone discovers/chats) | `group` (only group teammates) | `private`
  (owner only); `AvatarVisibility` type in types.ts, default `group` for new avatars.
  The legacy `published` INTEGER column is migration-only: `migrateVisibility()`
  backfills `1→public / 0→group` on startup, then nothing reads `published` again
  (`rowVisibility()` is the accessor, with a published fallback for un-backfilled rows).
  The discovery SQL predicate (`listPublishedAvatars`/`searchAvatars`) and
  `isVisibleTo` (used by `getAvatar`/`resolveChatAvatar`) all gate on `visibility`.
  Owner-self always bypasses the check. UI: `buildVisibilitySelect` (segmented control,
  `PATCH /api/me {visibility}`); admin moderation = `PUT /api/admin/users/:id/visibility`.
- **Trust/elevation is GROUP-ONLY now — no per-avatar trust list.** `isTrustedFor`
  is exactly `shareAnyGroup` (symmetric group co-membership); the old directional
  `avatar_trusted_users` table + its store fns (`listTrustedUsers`/`addTrustedUser`/
  `removeTrustedUser`) + `/api/me/trusted*` routes + the 신뢰하는 사용자 settings card are all
  GONE (table is `DROP`ped in migrate()). To grant someone elevated tool access, add
  them to a shared group. `searchUsers`/`GET /api/me/users/search` survive only to power
  the group member-add typeahead (`attachUserSearch` in app.js).
- **Capability hashtags (역량 해시태그) + cross-avatar discovery.** `users.hashtags` is a JSON
  array of bare tags (`normalizeHashtags`/`parseHashtags` in store.ts) wired through the
  per-user settings pattern, surfaced on BOTH `User` and `AvatarSummary` (so discovery cards
  carry them), edited via a chip editor (`buildHashtagEditor` in app.js). **Auto-generated like
  the intro:** `POST /api/me/hashtags/generate` mirrors `/api/me/intro/generate` (headless,
  read-only, NOT persisted — parses `#tags` out of the agent reply, then `normalizeHashtags`).
  Searchable in 탐색 (client-side filter in `renderExplore`/`matchesAvatarQuery`, via a search box;
  cards/panel show tags as display chips) AND by the **all-viewer, read-only** `mcp__avatars__search_avatars`
  MCP (`agent/avatarDirectoryTools.ts`, backed by `store.searchAvatars`, registered like the
  other in-process servers in `claudeAgent.ts`). NOT owner-only (only avatars VISIBLE to the
  viewer — public ones + their group teammates' — same scope the viewer browses) and excludes
  the current avatar from its own results. STANDING
  `buildPrompt` guidance (every turn, all viewer classes) tells the avatar to use it and redirect
  the user to a better-suited teammate avatar — per the META-COGNITION direction.
- **Knowledge repo = one per user, agent-managed.** The personal repo (`knowledge_repo`
  column, `get/setKnowledgeRepo`) is a FULL clone at `dataDir/knowledge/<userId>`
  (`knowledgeRepo.ts`). It's (a) auto-loaded as a plugin root in chat/skills/intro via
  `loadKnowledgeRepoRoots`/`knowledgeRepoSkillSources` (so its skills are usable), AND
  (b) edited by the avatar itself through the **owner-only** `mcp__repo__*` MCP server
  (`agent/repoTools.ts`): list/read/write/delete(file or dir, recursive)/move/scaffold/commit, plus `create_repo` (creates a new
  GitHub repo via `gh repo create` server-side using the stored git token in child env, then connects it
  with `setKnowledgeRepo`). `create_repo` is exposed **only when no repo is connected yet**
  (`allowCreate` ← `!knowledgeRepoConfigured` in `claudeAgent.ts`) to keep the unused tool out
  of the prompt once a repo exists; the manage tools are always present. There is NO settings file-editor
  and NO `/api/me/marketplace/*` routes — settings stores the repo location
  (`PUT /api/me/knowledge-repo`) plus an optional plugin subset (`knowledge_selected`
  column, `get/setKnowledgeSelected`, `PUT /api/me/knowledge-repo/selected`,
  inspected via `GET /api/me/knowledge-repo/contents`). The repo is the avatar's
  by default so ALL its plugins load (`selected: null` on `KnowledgeRepoContext`);
  the owner can deselect a subset — same null=load-all semantics as a marketplace
  plugin's `selected`. Repo tools enforce owner-only IN the handlers
  (`viewerIsOwner && !headless`), relying on the existing `mcp__`-prefix auto-allow — don't
  add a second gate. `write_file`/`scaffold_skill` only touch the local working-tree clone;
  the change isn't on the remote (or visible to a fresh clone elsewhere) until `commit` pushes
  it — so an edit must be followed by `commit` to persist. (`ensureClone` re-syncs with
  `git checkout -B <branch> origin/<branch>`, not a hard reset, so it won't silently clobber
  uncommitted edits, but it also won't preserve or push them.)
- **General git repos (`mcp__git_repo__*`) ≠ the knowledge repo.** A user can register
  arbitrary work/code repos: `git_repositories` table (`get/list/upsert/delete/
  markGitRepoSynced`), plumbing in `gitRepos.ts`, MCP server in `agent/gitRepoTools.ts`.
  Owner-only `register_repo`/`remove_repo`; owner OR **trusted** users may `sync_repo`/
  `status`/`list_files`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`/`push`.
  Each tool self-gates (`ownerGuard`/`elevatedGuard`, both `&& !headless`); the owner's
  git token is used server-side only (`gitAuthArgs`, never in the agent shell), with
  arg-injection (`assertSafeGitValue`) and path-traversal (`resolveInRepo`) guards. Public
  repos on internal hosts, github.com, or other HTTPS/git hosts must clone/sync without a token;
  tokens are opportunistic, not a prerequisite for read access.
  Unlike the owner-only knowledge repo, write/commit/push EXTEND to trusted users.
  Offline-tested against a local bare remote (same as the knowledge-repo tools).
- **Groups = system-admin-created teams; co-membership auto-trusts (symmetrically).**
  `groups` + `group_members(role admin|member)` tables (always-run schema). System admin
  creates/deletes groups + assigns group admins (`/api/admin/groups*`); group admins self-serve
  their group's members + repo (`/api/me/groups*`, gated by `canManageGroup` = system admin OR
  group admin). **`isTrustedFor` IS `shareAnyGroup`** (group co-membership is now the ONLY
  trust source) → group co-members are mutually + SYMMETRICALLY elevated and reach each
  other's `group`-visible avatars (but NOT each other's `private` ones — visibility is a
  separate axis; see the visibility bullet above). `isTrustedFor` is THE single choke point
  every elevated/trust check flows through (`getAvatar`/`resolveChatAvatar`/`app.ts` chat
  `elevated`) — add new trust sources THERE, not at call sites. Each group has ONE shared **knowledge repo** (`groupKnowledgeRepo.ts`
  mirrors `knowledgeRepo.ts`: full clone at `dataDir/group-knowledge/<groupId>`, REUSES its
  repo-relative file ops `listTree/readFile/writeFile/scaffoldSkill/writeRepoTemplate`; `token` =
  acting user's `getGitToken`, applied per git-call via `tokenForGitUrl`). Members' avatars auto-load
  its skills (`loadGroupKnowledgeRepoRoots`, wired in app.ts chat + intro/hashtag gen); only group
  admins edit via the OWNER-ONLY `mcp__group_repo__*` server (per-tool role check: member reads,
  admin writes/deletes/moves/commits/`create_repo`). `buildPrompt` injects group self-state (META-COGNITION).
  Discovery: `listPublishedAvatars` also returns `group`-visible group teammates flagged `sharesGroup`.
- Secret-at-rest tiers: passwords → scrypt (`auth.ts`), session tokens → sha256,
  **reversible** secrets (e.g. per-user git tokens) → AES-256-GCM in `crypto.ts`
  (keyed from `SESSION_SECRET`). Never serialize secrets through `toUser`. Git tokens
  are stored as named entries in the `user_secrets` vault (`INTERNAL_GIT_TOKEN_SECRET_NAME`
  = `"GIT_TOKEN"` for the configured `GITHUB_HOST`, `EXTERNAL_GIT_TOKEN_SECRET_NAME` =
  `"GITHUB_TOKEN"` for github.com); the legacy `git_token_enc` `users` column is a
  read fallback only (`getGitToken` tries the secret vault first). Arbitrary named
  secrets go in the same `user_secrets` vault (see below). App-WIDE secrets (not
  user-scoped) go in the `app_config` KV table (`get/set/deleteAppSecret`, same AES-256-GCM).
- **Subscription auth is app-wide and admin-managed.** Auth precedence: `.env`
  `ANTHROPIC_API_KEY` > stored subscription token > none. When no API key is set,
  `claudeAgent.ts` injects the admin-pasted `claude setup-token` token (stored under
  `app_config[CLAUDE_OAUTH_TOKEN_KEY]`, see `store.ts`) as `CLAUDE_CODE_OAUTH_TOKEN`
  into the SDK subprocess env — decrypted only there, never shown to the agent.
  Managed via `PUT/DELETE /api/admin/claude-token` + the 관리자 ▸ 구독 로그인 card;
  status surfaces through `GET /api/admin/system` (`subscriptionConnected`,
  `apiKeyOverride`). setup-token tokens are long-lived, so there's no refresh logic.
- Git auth for clones uses `http.extraHeader` (see `gitAuthArgs`), never a
  token-in-URL — keeps the token out of `.git/config`. Scrub it from git error
  text before logging/returning (`scrubGitError`).
- **Two git tokens, vault-backed, host-routed.** Each user can store TWO git tokens as
  named `user_secrets`: `GIT_TOKEN` (`INTERNAL_GIT_TOKEN_SECRET_NAME`) for the internal
  `GITHUB_HOST`, and `GITHUB_TOKEN` (`EXTERNAL_GIT_TOKEN_SECRET_NAME`) for github.com.
  `tokenForGitUrl` in `gitCredentials.ts` selects the right one by matching the clone URL's
  host against `config.githubHost` (internal) or `DEFAULT_GITHUB_HOST` / github.com (external);
  unknown hosts get no token. Both tokens are supplied as `http.extraHeader` per git call
  (`gitAuthArgs`) — never written into `.git/config` and never in a URL. The legacy
  `git_token_enc` column in `users` is only a fallback for migration (the new `setGitToken`
  writes to the vault and NULLs the column; `getGitToken` reads the vault first).
- **The per-user git tokens NEVER reach the agent's shell.** They are used only server-side:
  as a per-invocation `http.extraHeader` on the app's OWN clone/push (`knowledgeRepo.ts`,
  `syncPluginRepo`, `gitRepos.ts`) and by the server-side `mcp__repo__create_repo` bridge
  (invokes `gh repo create` with the token in child-process env). They are NOT injected into
  the SDK subprocess env (`options.env`); `claudeAgent.ts` strips `GIT_TOKEN`/`GITHUB_TOKEN`/
  `GH_TOKEN`-style names from `process.env` before launch and only forwards SSH-specific
  secrets to the hex-ssh subprocess. The agent's `gh`/`git`/Bash therefore have NO GitHub
  credential. So the avatar can't `gh repo create`; `create_repo` is the only bridge.
  The prompt surfaces `gitTokenSet` (not the value) so the greeting offers `create_repo`
  when a token is set, else asks the owner to set one (`buildPrompt`, fed from
  `claudeAgent.ts` promptRequest).
- **The prompt tells the owner how to enable SSH when it's off.** `buildPrompt` adds an SSH
  enablement note on owner, non-headless turns whenever `SSH_PRIVATE_KEY` isn't in `secretNames`
  (hex-ssh registers only when that secret exists). Drops off once the key is stored.
- **Design direction — give the avatar META-COGNITION of its own system state.** A core goal of
  this repo: the avatar should accurately know what's configured and what it can do RIGHT NOW —
  knowledge repo connected? (`knowledgeRepoConfigured`), git token set? (`gitTokenSet`), which
  secrets/SSH enabled? (`secretNames`/`SSH_PRIVATE_KEY`), which tools it currently has — so it acts
  and explains correctly instead of guessing or relaying stale manual steps. `buildPrompt` is where
  this self-state is injected (per viewer/headless); when you add a capability, surface its current
  state there too. The git-token, SSH, and `create_repo` bullets above are all instances of this.
  Self-state flows on the `ownerToolAccess` gate (owner chats AND owner-scheduled routines — NOT
  `viewerIsOwner && !headless`), so routines with owner tools also get their repo/group/secret
  state; `mcp__system__describe_system` is the runtime mirror of the same info (effective model =
  env pin > admin override > SDK default, profile publish state, groups/roles, direct-trust list,
  SSH on/off, pending request count) — keep BOTH in sync when adding capability state.
- **Routines = owner-scheduled headless runs, flexible KST schedule.** A routine
  (`routine_jobs` table, `get/list/create/update/deleteRoutineJob`, `markRoutineRun`) runs its
  `prompt` headlessly with owner-level tools and appends results to a dedicated conversation
  (`[루틴] <name|prompt>` title). Schedule kinds (`src/server/routineSchedule.ts`, the ONE place
  for all schedule math + validation): **daily** (`minuteOfDay` KST), **weekly** (`daysOfWeek`
  0=Sun..6=Sat at `minuteOfDay`), **interval** (`intervalMinutes`, 15..10080). `parseRoutineSchedule`
  validates raw API/MCP input → a `RoutineSchedule` or a `ScheduleError` CODE; each caller maps the
  code to its own channel (`app.ts` `KOREAN_SCHEDULE_ERROR`, `systemTools.ts` `ENGLISH_SCHEDULE_ERROR`)
  — per the language split. `nextRunIso` computes the next firing in fixed UTC+9 (no DST); a
  name/prompt-only `updateRoutineJob` edit preserves an overdue `next_run_at`, only a schedule change
  recomputes. `store.create/updateRoutineJob` stay backward-compatible with `{prompt, minuteOfDay}`
  (kind defaults daily; legacy rows with NULL `schedule_kind` read as daily). Editable by owner (UI
  modal: clickable title → name/prompt(markdown preview)/schedule builder, `PUT/PATCH /api/me/routines`)
  AND by the avatar (`mcp__system__{create,update}_routine` carry `name` + `scheduleKind`/`time`/
  `daysOfWeek`/`intervalMinutes`). New schedule fields go in `routineSchedule.ts` + the two error maps
  + `RoutineJob` (types.ts) + the `addColumnIfMissing` migration — never re-derive schedule math elsewhere.
- **Routines load the same skills as chat** via the shared `loadAgentPluginRoots` (plugins.ts):
  default + avatar plugins + personal & group knowledge-repo roots. Both the chat endpoint (`app.ts`)
  and the scheduler (`scheduler.ts`) call it, so they can't drift; `local` runtime returns `[]`.
  (Routines once loaded only default+avatar plugins and silently missed knowledge-repo skills.)
- **Language split: agent-facing text is English, user-facing text is Korean.** Classify a new
  string by *"does the model read it as INPUT?"* → English; else Korean. English (model reads it):
  `buildPrompt` (claudeAgent.ts), `GIT_MCP_ONLY_GUIDANCE`, the `PreToolUse` **`hookDeny(...)` reasons**,
  and every `agent/*Tools.ts` tool `description`/`.describe()`/`text()` result; the headless
  intro/hashtag-generation prompts in `app.ts` are English too but explicitly instruct **Korean
  OUTPUT**. Korean (a human sees it): `public/` UI, `apiError(...)`, **`onStatus`/`onBlocked` event
  labels** (status + activity tree), `resultErrorMessage`, SDK empty/summary fallbacks, **client-expanded**
  slash-command expansions (rendered as the user's OWN message bubble), conversation titles/`[루틴]`/`(중지됨)`.
  EXCEPTION: a slash command flagged `serverExpand` in `public/app.js` (currently **`/learn`**) sends the
  literal `/command` as the bubble + persisted turn and the SERVER swaps in the expanded prompt for the
  model — so that prompt (`LEARN_SLASH_PROMPT` in `app.ts`) is **agent-facing English** (the avatar still
  REPLIES in the user's language). Such a command carries NO client-side `prompt()` copy; the
  `expandChatSlashCommand`↔`app.js` drift test excludes it. The chat handler stores `displayMessage` (raw)
  but feeds `agentMessage` (expanded) to `runAgentStream`.
  A string used on BOTH channels is split (hex-ssh block ~claudeAgent.ts:795 = Korean `onBlocked`
  reason + English `hookDeny`). Response language is anchored in `buildPrompt`'s 2nd line ("respond
  in the user's language; default Korean"). **`units.test.ts` asserts the English agent-facing
  strings** — update them when prompt/tool text changes; `app.test.ts`/`chat-history.test.ts`
  assert the Korean user-facing ones.
- **git remote work is MCP-only BY DESIGN; the prompt + errors enforce it.** The agent shell has
  no git credentials (stripped from the subprocess env), so Bash `git clone/push`/`gh` can never
  authenticate. `GIT_MCP_ONLY_GUIDANCE` (claudeAgent.ts) is injected on every tool-capable turn
  (owner, trusted, owner routine) telling the avatar to use `mcp__repo__*`/`mcp__git_repo__*`/
  `mcp__group_repo__*` ONLY and never retry a failed MCP git call via Bash; the git tools' failure
  messages repeat the no-Bash-fallback line with cause hints (token/permission/branch/URL). When
  adding a git-ish capability, route it through an in-process MCP bridge and keep that line in its
  error text.
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it
  STANDING per-turn guidance (not just the greeting) + an action-trigger in the tool's description +
  an error that redirects (e.g. `NO_REPO` → "use `create_repo`"). Greeting-only text plus a
  config-gated capability blurb once left it unaware it had `create_repo` mid-conversation.
- Repo shorthand (`owner/repo`) resolves through `config.githubHost` (`GITHUB_HOST`,
  default `github.com`) for both plugin and knowledge-repo clones/pushes. Full
  `https://...` and `git@...` repo values bypass that default and are used as-is.
- Dynamically-created elements share the global stylesheet — avoid bare generic class names
  (e.g. `main`) on them; they collide with layout rules. The activity-tree root once used
  `class="agent-node main"` and inherited `.main { height: 100dvh }`, stretching the box to
  fill the viewport. Use a scoped name (`is-main`, `agent-root`).
- For visual/layout bugs, inspect the *rendered* state (screenshot + DevTools computed styles),
  don't reason from CSS source alone — collisions/inherited rules aren't visible in the source.
- Verifying the local server: a corporate `HTTP_PROXY` intercepts `localhost`
  (returns "Access Denied"), and no browser engine is installed. Hit the dev
  server with `curl --noproxy '*' localhost:<port>/...` (can't screenshot the UI).
- Verifying Docker changes: `docker build` and `docker run` DO work here. Smoke-test:
  `docker run -d -e SESSION_SECRET=x <img>` then `docker exec <c> curl -fsS --noproxy '*'
  localhost:48787/api/bootstrap` (the unauth health probe + HEALTHCHECK). `SESSION_SECRET`
  is REQUIRED to boot (`NODE_ENV=production`), the image runs as non-root `node` (so `uv` /
  global bins must be world-accessible, NOT symlinked into `/root`), and `docker stop` should
  exit in <1s via the SIGTERM handler in `index.ts`.
- **Dockerfile CA trust is PER-STAGE.** The `CA_CERT_FILE`→`update-ca-certificates` block
  lives in the `base` stage and covers ONLY that stage — an HTTPS fetch (curl/npm/cargo) in a
  *different* earlier stage hits the corporate intercepting proxy with no trusted CA and dies
  `SSL peer certificate ... was not ok`. Put any network step in `base`, AFTER that block.
  (rtk was a `FROM rust` `cargo install` builder stage with no CA block — exactly this trap — so
  it now downloads a pinned prebuilt binary: `RTK_VERSION` arg, `rtk-ai/rtk` releases, musl/amd64
  + gnu/arm64. Upgrade = bump `RTK_VERSION` + confirm the `rtk rewrite 'git status && git diff'`
  self-test still equals `rtk git status && rtk git diff`.) Test one RUN step without a full
  build: `docker run --rm node:22-bookworm-slim bash -c '<step>'`.
- **Testing git/repo tools offline:** repo-tool tests point the repo at a LOCAL bare remote
  (`git init --bare`) so clone/commit/push need no network — `gitAuthArgs` returns `[]` for
  non-`https://` URLs, so the token is ignored there. For `create_repo`, inject a fake
  `createRemoteRepo` or fake `gh` runner; to drive the post-create clone/seed/push offline,
  have it return a local bare-remote PATH as `fullName` (`marketplaceCloneUrl` leaves
  non-`owner/repo` strings as-is).
- GHES/older `gh` compatibility: do not depend on `gh repo view --json visibility`;
  use `isPrivate` with `nameWithOwner,defaultBranchRef,isPrivate`.
- **Per-user secret vault (generic, not just SSH):** `user_secrets` table (AES-256-GCM via
  `crypto.ts`, keyed on `avatar.id`=owner), `get/set/delete/listUserSecretNames`/`getUserSecrets`.
  Exposed to clients as `secretNames` ONLY (values never via `toUser`). `PUT/DELETE
  /api/me/secrets/:name` (env-key-name validated). Settings UI "시크릿" card under the 권한·연결 tab.
  Owner, non-headless chat prompts include only those secret NAMES so the avatar knows
  what is configured; values still never enter the prompt or generic Bash env.
- **hex-ssh (remote SSH) is an APP-registered MCP, not a plugin one.** `claudeAgent` adds it to
  `mcpServers` only when the owner stored `SSH_PRIVATE_KEY` AND the current viewer class has at least
  one allowed hex-ssh tool. The registered command is `scripts/hex-ssh-policy-proxy.mjs`, which runs
  the upstream command from `config.hexSshCommand` (`HEX_SSH_COMMAND`, default `hex-ssh-mcp`) and
  filters `tools/list` by `HEX_SSH_ALLOWED_TOOLS` before the model sees the schema. The PreToolUse
  hook separately blocks disallowed `mcp__hex-ssh__*` calls, so the proxy is token/UX optimization and
  the hook is the final gate. The upstream package is installed into the image at build time, not via
  runtime `npx`.
- **App-managed MCP servers shadow same-named plugin ones.** MCP config is keyed by server name, so a
  plugin's bundled `.mcp.json` declaring `hex-ssh` (keyless) can win over the app's keyed one.
  `stripManagedMcpServers` (plugins.ts, `APP_MANAGED_MCP_SERVERS`) removes those names from each
  plugin `.mcp.json` in `resolvePluginRoots` before the SDK sees them. For the knowledge repo (a
  committable tree) `commitAndPush` restores tracked `.mcp.json` from HEAD before `git add -A`, so the
  strip is never pushed back to the user's repo.
- **SSH host-key trust is agent-managed + volume-persistent.** `mcp__ssh_trust__{add,list,remove}_host`
  (sshTrustTools.ts) write a per-owner `known_hosts` under `${dataDir}/ssh/<userId>` (data volume →
  survives restarts), injected into hex-ssh as `KNOWN_HOSTS_PATH` (hex-ssh re-reads it per connection,
  so `add_host` takes effect mid-session). Fingerprints aren't secrets, so these tools are NOT
  owner-only. `fetchHostKey` uses paramiko (image has no `ssh-keyscan`).
- **Debugging a launched MCP server:** the SDK spawns it as a subprocess, so failures DON'T appear in
  the app's pino logs. Check `~/.cache/claude-cli-nodejs/<workspace>/mcp-logs-<server>/` — the dir
  name is the server name, so it also reveals WHICH instance won a name collision (`hex-ssh` vs
  `plugin_<plugin>_hex-ssh`).
