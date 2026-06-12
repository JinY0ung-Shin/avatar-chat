# Noah Almighty — Claude notes

See README.md for features, setup, env vars, and verification (`npm run lint`/`test`/`build`).

## Frontend (public/)
- Vanilla JS, no framework. `public/app.js` builds DOM manually via an `el(tag, props, children)` helper.
- Single global stylesheet `public/styles.css` (CSS variables for spacing `--s-*`, colors, radii).
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown`).
- `npm run lint` (`tsc --noEmit`) covers only server TS; `public/*.js` is plain JS
  and unchecked — sanity-check frontend edits with `node --check public/app.js`.
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a
  poll/visibility watcher that toasts on new gaps (`updateKnowledgeBadge`/
  `refreshKnowledgeStatus`, app.js) — the UI end of the knowledge-backfill loop.

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
- **Tool permissions go through one gate:** the `PreToolUse` hook in
  `src/server/agent/claudeAgent.ts` (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` are unused (don't fire headlessly). Auto-approve
  only applies on the `viewerIsOwner && !headless` path; headless routines and
  colleague chats stay read-only.
- **Per-user settings pattern:** add a column to the `users` table + an additive
  `addColumnIfMissing` migration, then mirror the `published` toggle end-to-end
  (`UserRow`→`toUser`→`updateProfile`→`User` type→`PATCH /api/me`→`buildToggle` in app.js).
- **Knowledge repo = one per user, agent-managed.** The personal repo (`knowledge_repo`
  column, `get/setKnowledgeRepo`) is a FULL clone at `dataDir/knowledge/<userId>`
  (`knowledgeRepo.ts`). It's (a) auto-loaded as a plugin root in chat/skills/intro via
  `loadKnowledgeRepoRoots`/`knowledgeRepoSkillSources` (so its skills are usable), AND
  (b) edited by the avatar itself through the **owner-only** `mcp__repo__*` MCP server
  (`agent/repoTools.ts`): list/read/write/scaffold/commit, plus `create_repo` (creates a new
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
- Secret-at-rest tiers: passwords → scrypt (`auth.ts`), session tokens → sha256,
  **reversible** secrets (e.g. per-user git token) → AES-256-GCM in `crypto.ts`
  (keyed from `SESSION_SECRET`). Never serialize secrets through `toUser`. The git
  token is a `users` column; arbitrary named secrets go in the `user_secrets` vault
  (see below). App-WIDE secrets (not user-scoped) go in the `app_config` KV table
  (`get/set/deleteAppSecret`, same AES-256-GCM).
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
- **The per-user git token NEVER reaches the agent's shell.** It's used only as a
  per-invocation `http.extraHeader` on the app's OWN clone/push (`knowledgeRepo.ts`,
  `syncPluginRepo`) and by the `mcp__repo__create_repo` GitHub-API call — all server-side.
  It is NOT injected into the SDK subprocess env (`options.env`), so the agent's `gh`/`git`/Bash
  have NO GitHub credential (the server-wide `GITHUB_TOKEN` fallback was removed). So the avatar
  can't `gh repo create`; `create_repo` is the only bridge. The prompt surfaces `gitTokenSet`
  (not the value) so the greeting offers `create_repo` when a token is set, else asks the owner
  to set one (`buildPrompt`, fed from `claudeAgent.ts` promptRequest).
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
- **Testing git/repo tools offline:** repo-tool tests point the repo at a LOCAL bare remote
  (`git init --bare`) so clone/commit/push need no network — `gitAuthArgs` returns `[]` for
  non-`https://` URLs, so the token is ignored there. For `create_repo`, inject a fake
  `createRemoteRepo` or fake `gh` runner; to drive the post-create clone/seed/push offline,
  have it return a local bare-remote PATH as `fullName` (`marketplaceCloneUrl` leaves
  non-`owner/repo` strings as-is).
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
