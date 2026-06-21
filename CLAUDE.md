# Noah Almighty — Claude notes

The durable **direction and philosophy** of this codebase. Operational detail (file/function/column
names, migration mechanics, refactor history, CSP byte rules, test coupling, and the long gotcha list)
lives in **[`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md)** — read it before touching the
relevant subsystem. See README.md for features, setup, env vars, verification.

## Core design direction

These are the invariants the project is built around. New work should reinforce them, not erode them.

- **Give the avatar META-COGNITION of its own system state.** The avatar should accurately know what's
  configured and what it can do RIGHT NOW — knowledge repo connected? git token set? which secrets/SSH
  enabled? which tools it currently has — so it acts and explains correctly instead of guessing or
  relaying stale manual steps. `buildSystemPromptAppend` (per viewer/headless) appends this self-state to
  the SDK's default Claude Code system prompt; `mcp__system__describe_system` is the runtime mirror of the
  same info. **When you add a capability, surface its current state in BOTH.** The structural sync point is
  `agent/ownerState.ts` (`summarizeOwnerState` → unformatted facts shared by both consumers).
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it
  STANDING per-turn guidance + an action-trigger in the tool's description + an error that redirects.
- **Language split: agent-facing text is English, user-facing text is Korean.** Classify a new string by
  *"does the model read it as INPUT?"* → English (prompts, tool descriptions, hook-deny reasons, server
  slash-command expansions, bundled `SKILL.md` body + frontmatter); else Korean (UI, `apiError`,
  status/activity labels, conversation titles). The avatar always REPLIES in the user's language (default
  Korean), anchored in `buildSystemPromptAppend`. A string used on BOTH channels is split.
- **Trust/elevation is GROUP-ONLY.** `isTrustedFor` IS `shareAnyGroup` (symmetric group co-membership) —
  the single choke point every elevated/trust check flows through. Add new trust sources THERE, not at
  call sites. There is no per-avatar trust list anymore.
- **Avatar visibility is a 3-state enum** (`public` | `group` | `private`), NOT a boolean. Visibility and
  trust are SEPARATE axes (a group teammate reaches your `group` avatars but not your `private` ones).
- **git remote work is MCP-only BY DESIGN.** The agent shell has NO git credentials (stripped from the
  subprocess env), so Bash `git push`/`gh` can never authenticate. Route every git-ish capability through
  an in-process MCP bridge (`mcp__repo__*`/`mcp__git_repo__*`/`mcp__group_repo__*`) and keep the
  no-Bash-fallback line in its error text. Per-user git tokens are used server-side only, never reach the
  agent.
- **Tool permissions go through ONE gate:** the `PreToolUse` hook (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` don't fire headlessly. The `mcp__`-prefix auto-allow fires BEFORE the owner
  check, so every in-process MCP server MUST self-gate in its handlers.
- **Knowledge repo = one per user, agent-managed** (the avatar edits its own repo via `mcp__repo__*`).
  **Second brain = a CONVENTION (`wiki/`+`raw/`) over that SAME repo, NOT a new store** — recall is
  read-only MCP search; capture writes through the repo-write tools + commit (uncommitted = not persisted).
- **Per-user settings follow ONE pattern** (column → migration → `toUser` → `updateProfile` → `User` type →
  `PATCH /api/me` → settings tab). Some defaults are written from the composer, not a settings tab: the
  model/effort/MCP-tool-group pickers remember the owner's last choice via per-user defaults
  (`*_default` columns + `setChatDefaults` + `PUT /api/me/chat-defaults`) that seed new conversations,
  mirroring `groupKnowledgeOffDefault`. The per-conversation `selected_*` value still overrides the
  default when resuming an existing thread.
- **Modules are split behind UNCHANGED exports.** When refactoring, keep import paths stable via
  re-exports rather than forcing callers to move.

## Module map
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers); handlers in
  `src/server/routes/{auth,profile,plugins,knowledgeRepo,groups,routines,chat,admin}.ts` (+ `_shared.ts`).
- **Agent:** `claudeAgent.ts` re-exports `buildPrompt` / `buildSystemPromptAppend` / `buildUserPrompt`
  (`agent/promptBuilder.ts`), SDK-message handlers (`agent/sdkMessageHandlers.ts`), the PreToolUse hook
  (`agent/preToolUseHook.ts`). Shared self-state in `agent/ownerState.ts`; MCP helpers in
  `agent/mcpTools.ts`; repo-tool skeleton in `agent/repoToolKit.ts`.
- **Store:** `store.ts` is a thin barrel; the `Store` facade is composed from per-domain mixins in
  `store/*.ts`. Public surface unchanged (`new Store(config)` + `store.foo()`).
- **Repo git:** low-level plumbing shared via `repoGitCore.ts` + `repoGitGuards.ts`.
- **Client:** Svelte + Vite under `src/client/` (NOT vanilla `public/`); central store `lib/state.ts`.
- **Tests:** split agent-core / agent-tools / store / infra / app / chat-history (+ `tests/helpers.ts`).
- Module-level cautions: [`src/server/CLAUDE.md`](src/server/CLAUDE.md),
  [`src/server/agent/CLAUDE.md`](src/server/agent/CLAUDE.md), [`src/client/CLAUDE.md`](src/client/CLAUDE.md).
  Operational detail: [`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md). Design language:
  [`docs/DESIGN.md`](docs/DESIGN.md). Deferred work: [`docs/REFACTORING-BACKLOG.md`](docs/REFACTORING-BACKLOG.md).

## Verification gate
- `npm run lint && npm test && npm run build`. **Client checks: run directly** —
  `npx tsc --noEmit` + `npx svelte-check --tsconfig ./tsconfig.client.json`. ⚠️ The rtk hook misrewrites
  `npm run lint` to eslint and fails — don't rely on it.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file (full suite ~16s).
- `npm run dev` — server (tsx watch, :48787) + client (vite, :5173, proxies `/api`,`/users`,`/fonts`).
- Command/Docker/proxy/Playwright detail → [`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md).

## Deploy topology (don't forget)
- **Coding happens on this WSL2 box; deployment is a SEPARATE internal corporate server** — `localhost`
  here is NOT the deploy env, and there's no local DB. Schema/UID/volume/`SESSION_SECRET` changes need an
  EXISTING-deployment migration path, not just fresh-install behavior.
- **Project name diverges by layer:** display "Noah Almighty", code slug `noah-almighty`, working dir
  `avatar-chat`. Grep both old/new slugs when auditing names.
