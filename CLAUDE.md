# Noah Almighty — Claude notes

See README.md for features, setup, env vars, and verification (`npm run lint`/`test`/`build`).

## Module structure & sub-notes
After a 2026-06 cleanup, the big files were split behind **unchanged exports** — import paths are stable:
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers); handlers live in `src/server/routes/{auth,profile,plugins,knowledgeRepo,groups,routines,chat,admin}.ts` (+ `_shared.ts`).
- **Agent:** `claudeAgent.ts` re-exports `buildPrompt` (now in `agent/promptBuilder.ts`), the SDK-message handlers (`agent/sdkMessageHandlers.ts`), and the PreToolUse hook (`agent/preToolUseHook.ts`). Shared self-state in `agent/ownerState.ts`; MCP helpers in `agent/mcpTools.ts`; repo-tool skeleton in `agent/repoToolKit.ts`.
- **Repo git:** low-level plumbing shared via `repoGitCore.ts` + `repoGitGuards.ts`.
- **Tests:** `units.test.ts` split into `agent-core`/`agent-tools`/`store`/`infra` (+ `tests/helpers.ts`).
- Module-level cautions: [`src/server/CLAUDE.md`](src/server/CLAUDE.md), [`src/server/agent/CLAUDE.md`](src/server/agent/CLAUDE.md), [`src/client/CLAUDE.md`](src/client/CLAUDE.md). Deferred/riskier work: [`docs/REFACTORING-BACKLOG.md`](docs/REFACTORING-BACKLOG.md).

## Commands
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

## Frontend (src/client/ — Svelte + Vite)
See [`src/client/CLAUDE.md`](src/client/CLAUDE.md) for the client module map, theme system, CSS
gotchas, and client↔server mirrored validators.
- **The frontend is Svelte + Vite under `src/client/`, NOT vanilla `public/`** (migrated 2026-06,
  commit `b8505fb`). `public/` now holds only static assets (favicons, manifest, PWA icons).
  Entry `src/client/index.html` → `src/client/src/main.ts` → `App.svelte`; views in
  `src/client/src/views/*.svelte`, shared components in `src/client/src/components/*.svelte`,
  non-UI logic/stores in `src/client/src/lib/*.ts`. `lib/state.ts` is the central writable store
  (`appState` + `updateState`/`readState`/`replaceState`/`notify`); other lib: `chat`, `loaders`,
  `api`, `nav`, `slash`, `format`, `dom`, `knowledge`, `onboarding`, `theme`, `sse`. Built by
  `vite build` → `dist/client`, which `app.ts` serves (falling back to `public/` static assets).
- **The old vanilla frontend is preserved in git at commit `f0a6128`** — the canonical behavior
  reference for parity work. Read it with `git show f0a6128:public/js/<file>`.
- **Stylesheets were carried over VERBATIM** from `public/styles/*.css` to `src/client/styles/*.css`
  (same filenames `00-tokens`→`70-modals-groups`, same class names), loaded via `@import` in
  `src/client/src/styles.css` (cascade = import order), NOT `<link>` tags. **So porting/restoring a
  feature = reproducing the SAME DOM structure + class names the old vanilla JS emitted — don't
  invent new class names** (e.g. tabs use `.settings-tabs`/`.settings-tab` for BOTH Settings AND
  Admin; a custom `.tabbar` has NO CSS and renders unstyled). Spacing `--s-*`/color/radii tokens
  live in `00-tokens.css`. **Design language → [`docs/DESIGN.md`](docs/DESIGN.md)** (4px-base
  scale, per-screen density, no hardcoded hex/px).
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown` in `lib/format.ts`,
  bundled by Vite — not the old `/vendor` ESM routes).
- **`app.ts` serves a strict same-origin CSP** (`script-src`/`connect-src` `'self'`, `img-src
  'self' data:`). So remote `<img>` in rendered markdown is BLOCKED and the browser can't fetch
  cross-origin — widen the relevant directive in `app.ts` if a feature needs it. The Svelte build
  emits no inline `<script>`, so `script-src 'self'` is safe.
- **Svelte client pitfalls (svelte-check catches these):** `<svelte:window>` cannot live inside
  `{#if}`/blocks — must be top-level. A `use:action` taking a parameter must declare a 2nd arg
  `(node, param?)` or svelte-check errors "Expected 1 arguments, but got 2". `role="dialog"`/
  `"tablist"` on a `<nav>`/`<div>` trips an a11y warning — put the role on the right element.
  `AgentResponse.runtime` is only `"local"|"claude"` (errors/blocked surface via `summary`, NOT
  runtime — don't compare runtime to `"error"`).
- **Split chat:** avatar pool = all visible avatars, duplicates allowed (multiple parallel
  conversations with the same avatar incl. your own); the only gate is the 4-pane max. User message
  bubbles render text directly in `.bubble` (which has `white-space: pre-wrap`), NOT wrapped in
  `<p>` (that adds stray top/bottom margins). `GET /api/avatars` (`listPublishedAvatars`) includes
  the viewer's OWN avatar plus public + group-teammate avatars.
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a
  poll/visibility watcher that toasts on new gaps (`refreshKnowledgeStatus`/`startKnowledgeWatch`
  in `lib/loaders.ts`) — the UI end of the knowledge-backfill loop.
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
- **Image attachments: the user message can carry images.** The composer stages images
  (`ChatPane.pendingImages`, downscaled to ≤1568px + base64 in `ChatView.svelte`), POSTs them on
  `images: [{id, data}]`. `routes/chat.ts` validates/decodes up front (`chatImages.ts` →
  `decodeChatImages`, before SSE), writes bytes to `dataDir/chat-images/<conversationId>/<id>.<ext>`
  (NOT in SQLite — only `MessageAttachment` metadata persists on the message via the new
  `messages.attachments_json` column), and feeds the model `AgentRequest.images` THIS turn. Served by
  owner-scoped `GET /api/conversations/:id/images/:imageId` (`resolveStoredImage` guards traversal);
  same-origin so the strict CSP `img-src 'self' data:` needs no change. Bubbles render from the pane's
  `localImages` (data URL, instant) then fall back to that serving URL on reload. **Client canvas
  resize loads the source via a `data:` URL (FileReader), NOT `URL.createObjectURL` — a `blob:` URL is
  blocked by the prod CSP (`img-src 'self' data:`), so blob would fail the `<img>` load and silently
  drop every attachment (works in `vite` dev, which sets no CSP — a prod-only trap). Same fix applies to
  the avatar-image resize in `SettingsProfileTab`.** **Non-obvious: feeding
  images REQUIRES switching `sdk.query`'s `prompt` from a string to an `AsyncIterable<SDKUserMessage>`
  (text block + image blocks) — `claudeAgent.ts` `buildImageQueryPrompt`, taken ONLY when
  `request.images?.length`; text-only turns keep the unchanged string path (zero regression). `resume`
  works in both modes.** Regenerate re-reads the prior user turn's stored attachments from disk
  (`readChatImages`) since the client doesn't re-send them. `express.json` limit was bumped 3mb→40mb for
  the base64 payloads. Conversation delete sweeps the image dir (`deleteConversationImages`).
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
  persist the server-side `streamedText` accumulator (`routes/chat.ts`), not an empty stub.
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
  (`UserRow`→`toUser`→`updateProfile`→`User` type→`PATCH /api/me`→Svelte settings control in the matching per-tab component (`src/client/src/components/Settings{Profile,Access,Knowledge}Tab.svelte`; `SettingsView.svelte` is just the tab shell)).
  A NEW table just goes in the always-run schema `db.exec()` block (`CREATE TABLE IF
  NOT EXISTS` covers existing DBs too) — `addColumnIfMissing` is ONLY for adding a
  column to an existing table.
  **Not every setting is per-user, though:** the per-conversation model/effort picker is
  INTENTIONALLY per-conversation-only — there is NO per-user default that seeds it (you pick per
  chat each time). Contrast `group_knowledge_off`, which DOES have a per-user default
  (`group_knowledge_off_default`) that seeds new conversations. Don't "add a default" for model/effort.
- **Avatar visibility is a 3-state enum, NOT a boolean.** `users.visibility` =
  `public` (everyone discovers/chats) | `group` (only group teammates) | `private`
  (owner only); `AvatarVisibility` type in types.ts, default `group` for new avatars.
  The legacy `published` INTEGER column is migration-only: `migrateVisibility()`
  backfills `1→public / 0→group` on startup, then nothing reads `published` again
  (`rowVisibility()` is the accessor, with a published fallback for un-backfilled rows).
  The discovery SQL predicate (`listPublishedAvatars`/`searchAvatars`) and
  `isVisibleTo` (used by `getAvatar`/`resolveChatAvatar`) all gate on `visibility`.
  Owner-self always bypasses the check. UI: a `seg-control` segmented radiogroup in `SettingsProfileTab.svelte` (
  `PATCH /api/me {visibility}`); admin moderation = `PUT /api/admin/users/:id/visibility`.
- **Trust/elevation is GROUP-ONLY now — no per-avatar trust list.** `isTrustedFor`
  is exactly `shareAnyGroup` (symmetric group co-membership); the old directional
  `avatar_trusted_users` table + its store fns (`listTrustedUsers`/`addTrustedUser`/
  `removeTrustedUser`) + `/api/me/trusted*` routes + the 신뢰하는 사용자 settings card are all
  GONE (table is `DROP`ped in migrate()). To grant someone elevated tool access, add
  them to a shared group. `searchUsers`/`GET /api/me/users/search` survive only to power
  the group member-add typeahead (inlined in the Svelte settings/admin group components).
- **Capability hashtags (역량 해시태그) + cross-avatar discovery.** `users.hashtags` is a JSON
  array of bare tags (`normalizeHashtags`/`parseHashtags` in store.ts) wired through the
  per-user settings pattern, surfaced on BOTH `User` and `AvatarSummary` (so discovery cards
  carry them), edited via a chip editor (`HashtagChipEditor.svelte`). **Auto-generated like
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
  **Single working-surface model (NOT MCP file CRUD):** the MCP server is intentionally
  minimal — owner-only `register_repo`/`remove_repo`; owner OR **trusted** users may
  `sync_repo`/`push` (remote git, needs server-side creds) and `open_repo`/`close_repo`.
  There are **NO `status`/`list_files`/`read_file`/`write_file`/`delete_file`/`diff`/`commit`
  MCP tools** — the avatar instead OPENS one repo as the conversation's **working directory**
  (`open_repo`) and edits/tests/commits it with NATIVE tools (Read/Edit/Bash local git). See
  the working-repository bullet below. Each tool self-gates (`ownerGuard`/`elevatedGuard`,
  both `&& !headless`); the owner's git token is used server-side only (`gitAuthArgs`, never in
  the agent shell), with arg-injection (`assertSafeGitValue`) and path-traversal
  (`resolveInRepo`) guards. Public repos on internal hosts, github.com, or other HTTPS/git
  hosts must clone/sync without a token; tokens are opportunistic. Unlike the owner-only
  knowledge repo, push EXTENDS to trusted users. Offline-tested against a local bare remote.
  (`gitRepos.ts` still exports the old file/diff/commit/status helpers — now unused by the
  tools, kept for potential reuse; safe to prune later.)
- **Groups = system-admin-created teams; co-membership auto-trusts (symmetrically).**
  `groups` + `group_members(role admin|member)` tables (always-run schema). System admin
  creates/deletes groups + assigns group admins (`/api/admin/groups*`); group admins self-serve
  their group's members + repo (`/api/me/groups*`, gated by `canManageGroup` = system admin OR
  group admin). **`isTrustedFor` IS `shareAnyGroup`** (group co-membership is now the ONLY
  trust source) → group co-members are mutually + SYMMETRICALLY elevated and reach each
  other's `group`-visible avatars (but NOT each other's `private` ones — visibility is a
  separate axis; see the visibility bullet above). `isTrustedFor` is THE single choke point
  every elevated/trust check flows through (`getAvatar`/`resolveChatAvatar`/`routes/chat.ts` chat
  `elevated`) — add new trust sources THERE, not at call sites. Each group has ONE shared **knowledge repo** (`groupKnowledgeRepo.ts`
  mirrors `knowledgeRepo.ts`: full clone at `dataDir/group-knowledge/<groupId>`, REUSES its
  repo-relative file ops `listTree/readFile/writeFile/scaffoldSkill/writeRepoTemplate`; `token` =
  acting user's `getGitToken`, applied per git-call via `tokenForGitUrl`). Members' avatars auto-load
  its skills (`loadGroupKnowledgeRepoRoots`, wired in `routes/chat.ts` + intro/hashtag gen); only group
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
- **Experimental features = per-user beta toggles (`canvas` is the first).** Registry in
  `experimentalFeatures.ts` (`{key,name,description}`; name/description KOREAN, shared with the client
  via `tsconfig.client.json` include like `routineSchedule.ts`). Wired through the per-user-setting
  pattern: `users.experimental_features` JSON column → `toUser`/`getExperimentalFeatures` →
  `updateProfile` (normalizes to KNOWN keys) → `User.experimentalFeatures` → `PATCH /api/me
  {experimentalFeatures}` → "실험 기능" card in `SettingsAccessTab.svelte`. Self-state in BOTH
  `buildPrompt` (owner/routine `experimentalFeaturesSection`) AND `describe_system` (via
  `OwnerState.experimentalFeatures`). Gate a feature on `ownerState.experimentalFeatures.includes(key)`.
- **Visual canvas (`mcp__canvas__show`, experimental `canvas` feature).** CSP-SAFE port of Superpowers'
  visual companion: the avatar DECLARES content (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional
  `controls` (buttons/text); the CLIENT renders sanitized content (DOMPurify; mermaid `securityLevel:
  strict`; **`vega` = a compact Vega-Lite spec compiled+rendered to an SVG STRING via the CSP-safe
  `vega-interpreter` AST evaluator — no `Function` ctor, so `script-src 'self'` is untouched — far
  cheaper in tokens than hand-drawn SVG**; all lazy-loaded as own chunks with a source-`<pre>` fallback)
  + real form controls — **no avatar JS runs, CSP unchanged**.
  `canvasTools.ts` (intentionally NOT self-gated — registration is the boundary) registered in
  `claudeAgent.ts` ONLY when the avatar OWNER enabled `canvas` AND `events.onCanvas` exists (so all
  viewer classes incl. colleagues get it; routines/headless don't). Controls park the run via the SAME
  `awaitResponse`/`/api/chat/respond` path as `onQuestion` (`routes/chat.ts` `onCanvas`); display-only
  returns immediately. Artifacts persist on `AgentResponse.canvases` (success/cancel/error paths) and
  rebuild on reload (`canvasesFromMessages`); live via SSE `canvas` event → `CanvasPanel.svelte`.
  **Refine-in-place:** `show` takes an optional `canvasId`; reusing it UPDATES that artifact instead of
  stacking a tab (client `handleCanvas` + `canvasesFromMessages` AND server `record()` all upsert by id,
  latest-wins) — the tool echoes the id back so the model can target it. **Size-cap:** `canvasTools.ts`
  rejects over-`MAX_CANVAS_CONTENT_CHARS` content / long titles / too many controls with an actionable
  agent-facing error (the content rides every `resume` turn's transcript, so a blob taxes all later turns).
- **Working repository (avatar-opened, NOT a UI picker).** The avatar opens ONE registered
  `mcp__git_repo__*` repo as this conversation's working directory with `mcp__git_repo__open_repo`
  (elevated: owner/trusted); `close_repo` clears it. The selection is held per-conversation,
  **in-memory** (`repoWorkspace.ts` `get/setWorkspaceRepo`, same single-process model as
  `activeRepoLock.ts` — a restart clears it, the avatar re-opens). **The SDK cwd is fixed when a turn
  starts and can't be repointed mid-turn**, so `open_repo` takes effect **from the NEXT message**: the
  chat route reads `getWorkspaceRepo(conversationId)` at turn start → sets the repo's clone as the SDK
  **cwd** (the per-conversation scratch dir rides along as an `additionalDirectories`). From then the
  avatar edits/tests with native Read/Edit/Bash and LOCAL git (`add`/`commit`); only `push`/`sync_repo`
  stay MCP. `open_repo` needs `request.conversationId` (threaded into `GitRepoToolsContext`); a run with
  no conversation (e.g. intro gen) can't open one. **There is NO UI picker** — removing the dual
  "edit via MCP vs edit via cwd" surface (formerly "active repo workspace #47") was the whole point.
  **Security boundary unchanged** — git tokens are stripped from the shell, so push/sync stay MCP-only.
  A per-clone-path lock (`activeRepoLock.ts`) serializes concurrent opens (409, per-turn acquire/release);
  it does NOT block another conversation's MCP sync (worktree isolation is the eventual fix).
  `preToolUseHook`'s `activeRepoMode` (= `Boolean(request.activeRepoName)`) is an INTEGRITY (not security)
  guard: denies remote/branch/history-rewriting/destructive Bash git (push/fetch/pull/reset/checkout/
  commit --amend/…), allows read-only git + local staging/normal commit — advisory/leaky by design.
  Metacognition: `promptBuilder` `gitRepoSection` (open_repo flow) + `activeRepoSection` (relaxes
  GIT_MCP_ONLY_GUIDANCE for local git once a repo is open) + the hook deny reason + git-tool errors.
  The clone path is NEVER returned to the client.
- **Routines = owner-scheduled headless runs, flexible KST schedule.** A routine
  (`routine_jobs` table, `get/list/create/update/deleteRoutineJob`, `markRoutineRun`) runs its
  `prompt` headlessly with owner-level tools and appends results to a dedicated conversation
  (`[루틴] <name|prompt>` title). Schedule kinds (`src/server/routineSchedule.ts`, the ONE place
  for all schedule math + validation): **daily** (`minuteOfDay` KST), **weekly** (`daysOfWeek`
  0=Sun..6=Sat at `minuteOfDay`), **interval** (`intervalMinutes`, 15..10080). `parseRoutineSchedule`
  validates raw API/MCP input → a `RoutineSchedule` or a `ScheduleError` CODE; each caller maps the
  code to its own channel (`routes/_shared.ts` `KOREAN_SCHEDULE_ERROR`, `systemTools.ts` `ENGLISH_SCHEDULE_ERROR`)
  — per the language split. `nextRunIso` computes the next firing in fixed UTC+9 (no DST); a
  name/prompt-only `updateRoutineJob` edit preserves an overdue `next_run_at`, only a schedule change
  recomputes. `store.create/updateRoutineJob` stay backward-compatible with `{prompt, minuteOfDay}`
  (kind defaults daily; legacy rows with NULL `schedule_kind` read as daily). Editable by owner (UI
  modal: clickable title → name/prompt(markdown preview)/schedule builder, `PUT/PATCH /api/me/routines`)
  AND by the avatar (`mcp__system__{create,update}_routine` carry `name` + `scheduleKind`/`time`/
  `daysOfWeek`/`intervalMinutes`). New schedule fields go in `routineSchedule.ts` + the two error maps
  + `RoutineJob` (types.ts) + the `addColumnIfMissing` migration — never re-derive schedule math elsewhere.
- **Routines load the same skills as chat** via the shared `loadAgentPluginRoots` (plugins.ts):
  default + avatar plugins + personal & group knowledge-repo roots. Both the chat endpoint (`routes/chat.ts`)
  and the scheduler (`scheduler.ts`) call it, so they can't drift; `local` runtime returns `[]`.
  (Routines once loaded only default+avatar plugins and silently missed knowledge-repo skills.)
- **Routines fall back down the model tier chain on transient failures.** The scheduler sets
  `AgentRequest.modelFallback: true` (routines ONLY — headless, no live stream, so a clean re-run is
  safe; chat never sets it). `runClaudeAgent` then builds a chain from the resolved model DOWN the tier
  order (`buildModelFallbackChain`: opus→sonnet→haiku; a concrete admin-override id → [id, sonnet,
  haiku]) and retries the next model when the attempt THROWS a transient model/server error
  (`isRetryableModelError`: overload/429/5xx/network — NOT `error_max_turns`/auth/bad-request, and NOT
  on abort). An env-pinned `ANTHROPIC_MODEL` is a hard lock → no fallback (single-element chain).
  In-band error *results* (e.g. max_turns) don't fall back. The completed-run log carries `model` +
  `modelFellBack`. Per-attempt accumulators reset each try; the image prompt is rebuilt per attempt
  (single-use generator) — though routines never carry images.
- **Knowledge-repo `CLAUDE.md` IS now injected as standing memory** (extends the old "settingSources
  `[]` → no CLAUDE.md" understanding). The repo-root `CLAUDE.md` of the personal repo (ALWAYS) + each
  ENABLED group repo is read DIRECTLY from the clone (NOT via settingSources, which stays `[]`),
  size-capped, and pushed into the prompt EVERY turn via `AgentRequest.knowledgeMemory`
  (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in promptBuilder.ts) — distinct
  from on-demand skills, with an injection guard (system/safety instructions win). Wired in chat +
  scheduler (routines = all groups, no toggle); intro/hashtag gen leaves it unset. `writeRepoTemplate`
  seeds a starter root `CLAUDE.md`.
- **Second brain (#53) = a CONVENTION over the SAME knowledge repo, NOT a new store.** `wiki/`
  (curated/durable notes) + `raw/` (unprocessed capture) are just directories inside the existing
  personal/group knowledge repo — there is no separate brain database. **Recall** is read-only search:
  `mcp__brain__*` (personal, `search`/`get_note`, gated `elevated` = owner OR trusted same-group
  teammate) and `mcp__group_brain__*` (one group, read gated on group-MEMBERship). **Capture/consolidate**
  is the `brain-ingest` / `brain-reflect` default-skills, which WRITE through the existing
  `mcp__repo__write_file` (personal) / `mcp__group_repo__write_file` (group) + `commit` — there is NO
  separate "brain write" tool, so a capture is a repo write plus a commit (uncommitted = not persisted).
  It composes with the request_info backfill loop: `request_info` ESCALATES a true unknown to the owner,
  `brain-ingest` RETAINS the owner-supplied answer/fact so brain-search finds it next time instead of
  re-asking (see `default-skills/skills/{brain-*,knowledge-backfill}/SKILL.md`).
- **Language split: agent-facing text is English, user-facing text is Korean.** Classify a new
  string by *"does the model read it as INPUT?"* → English; else Korean. English (model reads it):
  `buildPrompt` (claudeAgent.ts), `GIT_MCP_ONLY_GUIDANCE`, the `PreToolUse` **`hookDeny(...)` reasons**,
  every `agent/*Tools.ts` tool `description`/`.describe()`/`text()` result, and **every bundled
  `default-skills/**/SKILL.md` — both the body AND the `description:` frontmatter** (loaded as plugin
  roots and read by the model as INPUT, so they are ENGLISH; the avatar still REPLIES in the user's
  language); the headless intro/hashtag-generation prompts in `routes/profile.ts` are English too but
  explicitly instruct **Korean OUTPUT**. Korean (a human sees it): `src/client/` UI, `apiError(...)`, **`onStatus`/`onBlocked` event
  labels** (status + activity tree), `resultErrorMessage`, SDK empty/summary fallbacks, **client-expanded**
  slash-command expansions (rendered as the user's OWN message bubble), conversation titles/`[루틴]`/`(중지됨)`.
  EXCEPTION: a slash command flagged `serverExpand` in `src/client/src/lib/slash.ts` (currently **`/learn`**) sends the
  literal `/command` as the bubble + persisted turn and the SERVER swaps in the expanded prompt for the
  model — so that prompt (`LEARN_SLASH_PROMPT` in `routes/chat.ts`) is **agent-facing English** (the avatar still
  REPLIES in the user's language). Such a command carries NO client-side expansion copy; the server-side
  `expandChatSlashCommand` (the stale-client/API fallback, tested in `agent-core.test.ts`) excludes it. The chat handler stores `displayMessage` (raw)
  but feeds `agentMessage` (expanded) to `runAgentStream`.
  A string used on BOTH channels is split (hex-ssh block in `preToolUseHook.ts` = Korean `onBlocked`
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
- Verifying the local server: WHEN a corporate `HTTP_PROXY` is set it intercepts
  `localhost` (returns "Access Denied") — hit the dev server with
  `curl --noproxy '*' localhost:<port>/...`. But the proxy is NOT always present
  (check `env | grep -i proxy`); with no proxy you CAN install a browser engine and
  runtime-verify isolated UI (Playwright fixture — see `src/client/CLAUDE.md` Verification).
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
