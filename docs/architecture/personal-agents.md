# Personal agents (내 봇)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Per-owner chat-contact bots: id namespace, the owner-only reach gate, the full-owner-capability run
> wiring, and every cascade. Phase 1 is ADMIN-ONLY by design.

## What they are
- **Several chat-contact bots per (admin) user** (`personal_agents`, cap `MAX_PERSONAL_AGENTS = 20`
  in `store/personalAgents.ts` — disabled bots still hold a slot). NOT users rows; public avatar id
  `personal:<ownerUserId>:<agentId>` (`src/server/personalAgents.ts` mirrors `groupAgents.ts`:
  prefix + fail-closed `parsePersonalAgentRef` + wire projections). Row: displayName, alias, bio,
  intro, persona, hashtags, image ext, `enabled`, `default_model` (a `modelTiers.ts` tier id that
  seeds NEW conversations client-side in `makePane`; NULL = owner's remembered default; `""`→clear
  accepted at both writers because the settings `<select>` posts `""`).
- **Reach = the owner ALONE, while they hold the system-admin role** — `findChattablePersonalAgent`
  is the single gate (detail/skills/models/chat/image): ref parse → row exists under THAT owner →
  viewer IS owner → `store.isAdmin(viewer)` → enabled unless `includeDisabled`. Null on every miss
  (no existence probe); role loss / disable fails the NEXT turn closed with history preserved
  (the group-agent membership-loss precedent). The chat turn passes `includeDisabled` solely to
  produce the dedicated Korean disabled-403 ("이 봇은 비활성화되어 있습니다…"). Sysadmins do NOT reach
  other admins' bots; discovery (`GET /api/avatars`) appends `listPersonalAgentAvatarSummaries`
  (enabled only, `[]` for non-admins).

## The A-1 capability model — the load-bearing invariant
A personal-agent run **IS a full owner run**; the bot differs in IDENTITY only.
- `AgentRequest.groupAgent` must NEVER be set for one — it is a triple kill-switch
  (`deriveAgentToolAccess` → ownerToolAccess false, `ownerSecrets` → `{}`, `ownerState` → empty).
  The dedicated field is `AgentRequest.personalAgent {agentId, ownerUserId}`, set by the chat route
  and consumed nowhere in the access algebra (`deriveAgentToolAccess` / `planMcpToolFamilies` are
  deliberately untouched — pinned by tests).
- **`request.avatar` is the OWNER's own avatar (`avatar.id` = owner uuid)**: every capability key
  (ownerState, secrets, plugin roots, knowledge memory, work repos, `AgentOwner` commit identity)
  works untouched. The composite id lives ONLY in `threadAvatarId` inside `routes/chat.ts` — the
  conversation binding (`conversations.avatar_user_id`), `workspaceDirFor` cwd, the run registry /
  SSE `open` frame, logs/audit — and in client-facing summaries. The chat route OVERLAYS the
  conversational identity onto `request.avatar` (displayName/alias/persona = the bot's, `??` so an
  empty bot persona stays empty and never inherits the owner's); that overlay is the ONLY channel
  the persona TEXT reaches the prompt on (`PersonalAgentState` carries `personaSet`, not the text).
- Conversation summaries resolve the display name via a third LEFT JOIN in `store/conversations.ts`
  (BOTH sql sites) whose string concat mirrors `personalAgentAvatarId()` — keep in lockstep, same as
  the group_agents join.

## Run wiring (`runPlan.ts` / `claudeAgent.ts`)
- `personalAgentRun = Boolean(request.personalAgent)` drives ONLY: `summarizePersonalAgentState`
  (stamped as `request.personalAgentState`), the `personal_agent` MCP server, routine suppression,
  and `describe_system` ctx.
- **One server name, two mutually exclusive tool sets** (`agent/personalAgentProfileTools.ts`):
  a bot run registers `mcp__personal_agent__update_profile` (self-config: persona/alias/bio/intro,
  never displayName/enabled — the owner manages those); a NON-bot owner run registers
  `mcp__personal_agent__create_agent` when `ownerToolAccess && !groupAgentRun && !personalAgentRun
  && !consultationRun && !request.headless && ownerState.personalAgentsEnabled` (interactive only —
  a routine must not mint chat contacts unattended). Both handlers re-check the LIVE owner + admin
  role + enabled per call (the `mcp__` auto-allow fires first). Field caps are defined ONCE in
  `src/server/personalAgents.ts` (`PERSONAL_AGENT_FIELD_CAPS` {persona 8000, alias 64, bio 200,
  intro 2000} + `PERSONAL_AGENT_DISPLAY_NAME_CAP` 64) and imported by the HTTP route AND the tools.
  Audits: `personal_agent_create/update/delete/image`.
- **Metacognition rides both surfaces** from the same facts: `OwnerState.personalAgentsEnabled`
  (= `store.isAdmin`, eager — the registration gate reads it) + lazy count/names/max feed the
  owner-branch standing guidance (`personalBotsSection`) and describe_system's roster line;
  `PersonalAgentState` feeds the bot-identity prompt block (`personalAgentSection`) and
  describe_system's bot block (fail-closed UNAVAILABLE on deleted/disabled/demoted, then fall
  THROUGH to owner state — a bot run's owner state is its real capability). `claudeAgent` stamps
  `personalAgentsEnabled`/`personalAgentNames` onto the request from `personalAgentCreateActive`,
  so the prompt can never advertise a tool the run didn't register. Getting-started nagging is
  suppressed on bot runs (`&& !request.personalAgentState` at the call site).

## Routines are OFF in bot threads (phase 1)
Composite avatar ids break routines structurally (`resolveChatAvatar` does a bare users lookup;
`listDueRoutineJobs` JOINs users and silently drops non-user ids), so the suppression is explicit
and double-gated: runPlan filters `ROUTINE_TOOL_NAMES` (exported by `systemTools.ts`) out of
`allowedTools`, and the four handlers refuse with an English redirect when `ctx.personalAgent` is
set. Both metacognition surfaces state the unavailability. Phase-2 note: binding routines to bots
means fixing those two store sites + a `routine_jobs` sweep in `deletePersonalAgent`/`deleteUser`.

## Cascades (both halves, per deletion kind)
- **Per-bot DELETE** (`DELETE /api/me/agents/:agentId`): store cascade in one transaction
  (`deletePersonalAgent` — per-conversation canvas artifacts + messages + conversations, then the
  row) with the route snapshotting `conversationIds` + `imageExt` BEFORE the delete, then
  best-effort disk sweep (avatar image by composite id, `personalAgentWorkspaceParent` tree,
  per-conversation image/file dirs). Disable (`enabled=false`) is the thread-preserving alternative.
- **deleteUser**: `store/admin.ts` drops `personal_agents WHERE owner_user_id` (bot conversations
  already cascade via the `owner_user_id` arm); `routes/admin.ts` snapshots each bot's
  {compositeId, imageExt, workspaceParent} pre-delete and sweeps them (the `<userId>.`-prefixed
  avatar-image sweep cannot match composite-named files).
- The avatar-image GET (`routes/profile.ts`) resolves ext through the third namespaced lookup
  (`getPersonalAgentImageExtByAvatarId`); ids contain no `/`, preserving the raw-filename invariant.

## Client
- 탐색: `내 봇` badge (`tag accent`), ranked right after the own avatar. Rail: "내 봇" section in
  `Shell.svelte` from a top-level `$: personalBots = $appState.avatars.filter(...)` (legacy-mode
  compile-time dep rule — the template names the derived array); `Shell` also calls `loadAvatars()`
  on mount so a `#/settings` boot still populates it. The section shows on `isAdmin ||
  personalBots.length` — an admin with ZERO bots still gets it, or the admin-only feature would have
  no entry point; its empty state is a `첫 봇 만들기` CTA (`.rail-bot-create`) that calls
  `openSeededChat` to open a fresh thread with the OWNER's own avatar and SEED (never send) a
  bot-creation request, which the avatar then fulfils via `mcp__personal_agent__create_agent`.
  Management = 설정 4th tab `내 봇`
  (`SettingsPersonalAgentsCard.svelte`, admin-gated three ways: tab filter + `{#if isAdmin}` mount +
  reactive tab-guard back to 프로필; ALWAYS-MOUNT `active`-prop rule inside). `makePane` seeds
  `modelTier` from `personalAgent.defaultModel` when the tier exists in this deployment's
  `bootstrap.modelSelection`; when the deployment pins the model (`locked`) the select is replaced
  by a note and `defaultModel` is omitted from save bodies.

## Tests
`tests/personal-agent-store.test.ts` (CRUD/cap/cascades/parse/reach), `-routes.test.ts` (admin
gates, ownership 404s, AgentRequest shape incl. identity overlay + never-inherit pin, disabled 403,
role-revoked fail-closed, image round-trip, delete sweeps), `-tools.test.ts` (access-algebra
baseline, both tool gate matrices, describe_system, prompt pins, routine-name filtering),
`tests/svelte-personal-agents.test.ts` (badge/rail incl. the admin-only empty-state CTA and the
owner-avatar seeded pane it opens/management fetches/seeding). Getting-started
exclusion extended in `tests/agent-core.test.ts`; `tests/agent-run.test.ts:377`'s system-only
mcpServers pin now includes `personal_agent` (admin owner).
