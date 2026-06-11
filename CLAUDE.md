# Noah Almighty — Claude notes

See README.md for features, setup, env vars, and verification (`npm run lint`/`test`/`build`).

## Frontend (public/)
- Vanilla JS, no framework. `public/app.js` builds DOM manually via an `el(tag, props, children)` helper.
- Single global stylesheet `public/styles.css` (CSS variables for spacing `--s-*`, colors, radii).
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown`).

## Gotchas
- **Project name diverges by layer:** display name "Noah Almighty", code slug
  `noah-almighty` (package name, `noah-almighty.db`, `@noah-almighty.local` git
  identity fallbacks, logs, test temp-dir prefix), but the git remote is
  `avatar-square` and the working dir is `avatar-chat`. Grep both old/new slugs
  when auditing names.
- `.claude/worktrees/` holds full embedded repo checkouts: exclude them from
  greps (`grep -v '\.claude/worktrees'`) and never `git add -A` (stage files
  explicitly — `-A` also pulls in unrelated pre-existing edits like `.env.example`).
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
  (`agent/repoTools.ts`): list/read/write/scaffold/commit. There is NO settings file-editor
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
  (see below).
- Git auth for clones uses `http.extraHeader` (see `gitAuthArgs`), never a
  token-in-URL — keeps the token out of `.git/config`. Scrub it from git error
  text before logging/returning (`scrubGitError`).
- Dynamically-created elements share the global stylesheet — avoid bare generic class names
  (e.g. `main`) on them; they collide with layout rules. The activity-tree root once used
  `class="agent-node main"` and inherited `.main { height: 100dvh }`, stretching the box to
  fill the viewport. Use a scoped name (`is-main`, `agent-root`).
- For visual/layout bugs, inspect the *rendered* state (screenshot + DevTools computed styles),
  don't reason from CSS source alone — collisions/inherited rules aren't visible in the source.
- Verifying the local server: a corporate `HTTP_PROXY` intercepts `localhost`
  (returns "Access Denied"), and no browser engine is installed. Hit the dev
  server with `curl --noproxy '*' localhost:<port>/...` (can't screenshot the UI).
- **Per-user secret vault (generic, not just SSH):** `user_secrets` table (AES-256-GCM via
  `crypto.ts`, keyed on `avatar.id`=owner), `get/set/delete/listUserSecretNames`/`getUserSecrets`.
  Exposed to clients as `secretNames` ONLY (values never via `toUser`). `PUT/DELETE
  /api/me/secrets/:name` (env-key-name validated). Settings UI "시크릿" card under the 권한·연결 tab.
- **hex-ssh (remote SSH) is an APP-registered MCP, not a plugin one.** `claudeAgent` adds it to
  `mcpServers` ONLY when the owner stored an `SSH_PRIVATE_KEY` secret, injecting ALL owner secrets as
  the subprocess `env` (so the key is invisible to the agent's own Bash/`env`). Installed into the
  image at build time and run via `config.hexSshCommand` (`HEX_SSH_COMMAND`, default `hex-ssh-mcp`) —
  NOT a runtime `npx` download, which fails on the closed corporate network.
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
