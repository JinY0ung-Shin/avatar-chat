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

## Delegated tasks (봇 오피스, `bot_tasks`) — the Grok-Bot-style work model
Every EXECUTED user turn in a bot thread is tracked as a `bot_tasks` row (store mixin
`store/botTasks.ts`; the status machine lives in its header comment and is enforced by guarded
UPDATEs — illegal transitions are atomic null no-ops, so double finalizes can't race). Capability is
UNTOUCHED: a task row is bookkeeping over the same A-1 full-owner run.
- **Chat-route seams:** `routes/chat.ts` exports `resolveChatTarget` (avatar/bot resolution with
  typed refusals) and `executeChatTurn(deps, ctx, hooks)` — the ENTIRE former turn body as one
  function, HTTP-free after `hooks.onRunOpen(runId)` (the route's SSE handshake lives in that hook;
  a server-started turn returns `true` and relies on the registry journal). Refusals are typed
  (`ChatTurnRefusal.reason: "active_run" | "task_gone"`, plus `userMessagePersisted` so the queue
  fallback never double-writes the user bubble). The pre-persist active-run check lives INSIDE
  `executeChatTurn` (before any DB write/clone), preserving the old 409-before-persist behavior for
  non-bot threads.
- **Queue instead of 409:** a message to a busy BOT thread is persisted immediately, becomes a
  `queued` task (cap `MAX_QUEUED_BOT_TASKS` 20/thread → 429), and answers **202 `{queued, task}`**
  (plain JSON, never SSE). Regenerate keeps the 409; images-while-busy 400 (a queued replay is
  text-only). The enqueue pokes the dispatcher afterwards to close the settle race.
- **Dispatcher** (`botTaskRunner.ts`, scheduler.ts's never-throw style): `maybeDispatchNextBotTask`
  DRAINS a thread's queue in a loop (the settle hook fires inside `executeChatTurn`'s finally while
  the dispatcher still holds its `dispatching` guard, so a re-entrant call would strand the 3rd+
  item — the loop is the fix), re-resolves the bot LIVE per item (deleted/disabled/demoted →
  `failQueuedBotTask`, Korean reason), and runs the turn with `existingBotTaskId` +
  `unattendedDeadlineMs` (`config.botTaskRunTimeoutMs`, env `BOT_TASK_TIMEOUT_MINUTES`, 30-min
  default/1-min floor; timeout substitutes the SDK's "aborted by user" like routines) +
  `modelFallback` + `skipUserMessagePersist`. Dispatched turns stay **headless:false** ON PURPOSE —
  same prompt shape as "the owner stepped away"; unattended-ness rides the deadline + the standing
  guidance, not the routine prompt branch. Boot: `startBotTaskDispatcher` =
  `sweepInterruptedBotTasks` (in-memory run ids die with the process) + sequential backlog drain.
  `index.ts` starts it next to the routine scheduler; `app.ts` injects `onBotTurnSettled` into the
  chat router (chat.ts must NOT import botTaskRunner — the runner imports `executeChatTurn` back).
- **Turn-boundary approvals:** the run registers `mcp__personal_agent__report_task`
  (`done`/`need_input` + summary → `setBotTaskReport`, mid-run, status untouched); the DONE finalize
  reads `reportedOutcome` to park the task as `waiting_input` instead of done, and the owner's next
  message in that thread RESUMES the row (`markBotTaskRunning` from waiting_input clears
  question/outcome, keeps startedAt). AskUserQuestion is DENIED on every bot run
  (`buildPreToolUseHook`'s `personalAgentRun` last-param, redirect: report need_input + end the turn
  with the question). Both metacognition surfaces carry the task/queue/protocol lines
  (`PersonalAgentState.queuedTaskCount` via `summarizePersonalAgentState`'s conversationId param).
- **SSE naming trap:** the task frame is **`bot_task`** `{task: <full row>}` — `task`/`task_update`/
  `task_end` already belong to the SDK activity relay whose client handler keys on `data.taskId`
  and silently drops anything else. Pinned on both sides (route tests assert the event name; the
  client test proves SDK rows never enter the board).
- **Task API:** `routes/botTasks.ts` — `GET /api/me/bot-tasks?agentId&limit` (admin-gated like
  /api/me/agents, owner-scoped) and `POST /api/me/bot-tasks/:id/cancel` (queued/waiting_input →
  row-cancel via `cancelQueuedBotTask`, which preserves `pendingQuestion` on an abandoned card;
  running → registry `cancelRun` + `{task, stopping:true}`; terminal → 409; misses are 404 with no
  existence probe).
- **Client (`#/bots` 봇 오피스):** rail-less third arm in `App.svelte`; roster (with 입력 대기
  inbox + latest-task line + per-bot unseen chips) + a one-line status summary bar + the EXISTING
  ChatView mounted for the thread (pane must live in `state.chatPanes` —
  `lib/chat.ts`'s private updatePane resolves by id there; `loadPaneForConversation` is the
  extraction that lets `openBotThreadPane` place a pane without navigating to #/bots). Task cards
  render INLINE in the transcript (`components/BotTaskCard.svelte`): ChatView derives ONE
  pane→anchor→tasks map (`anchorBotTasksToMessages`, time-anchored after the last user message ≤
  task.createdAt, -1 = above the first bubble) whose first line returns a shared empty Map outside
  the bots view — the {#each} only ever does Map lookups, so ordinary chat has ZERO DOM/alloc
  difference at token rate (pinned by `tests/svelte-bots-thread.test.ts`). Inline cards filter by
  agentId (not conversation) so the summary bar and cards agree. `bot_task`
  frames + a 10s/focus/streaming-edge poll of the task API feed `state.botTasks` (terminal-wins
  merge prevents 완료→실행 중 flicker); 202 handling in `sendMessage` branches BEFORE the SSE
  reader. `PromptModal`'s visible-pane set covers both "chat" and "bots" or prompts double-render;
  `currentRoute()` needs the bots branch or `syncHash` on send strips the agent id from the URL.
- **Seen/unseen (the rail badge):** UNSEEN = settled (`done`/`failed`/`waiting_input`) AND
  `seen_at IS NULL` — ONE predicate (`UNSEEN_WHERE` in store/botTasks.ts) shared by
  `countUnseenBotTasks` (single GROUP BY; a bot with none is ABSENT from `agents`) and
  `markBotTasksSeen`. Every finalize + dispatch CLEARS the stamp (a resumed-then-finished task
  badges again); the owner's own row-cancel STAMPS it. Endpoints (admin-gated like the rest):
  `GET /api/me/bot-tasks/unseen` and `POST /api/me/bot-tasks/seen {agentId?}` — the POST answers
  the FRESH counts and the client REPLACES `state.botTaskUnseen` from responses, never decrements
  locally. `lib/loaders.ts` `refreshBotTaskUnseen`/`markBotTasksSeen` are admin-guarded no-ops for
  everyone else and piggyback the startKnowledgeWatch minute tick; 봇 오피스 marks a lane seen on
  selection + debounced when a settled row lands while visible. Clearing a badge is always the
  client saying "I looked" — an attended turn still badges until then.
- **Legacy UX migrated (2단계):** the rail 내 봇 section is REMOVED (its dead `.rail-bot*` CSS
  too); the rail nav's 봇 오피스 entry carries the unseen badge (inbox-badge pattern, 99+ cap,
  sr-only text), the 첫 봇/대화로 봇 만들기 seeded-chat CTA lives in BotsView's empty state, and a
  탐색 personal-agent card opens 봇 오피스 (`openBotOffice` falls back to a plain chat pane when
  the view gate refuses, so a widened gate never leaves a dead click). Shell no longer eager-loads
  avatars (that load belonged to the removed section; 봇 오피스/탐색 load their own).
- **Per-bot DELETE** (`DELETE /api/me/agents/:agentId`): store cascade in one transaction
  (`deletePersonalAgent` — per-conversation canvas artifacts + messages + conversations + the bot's
  `bot_tasks` swept BY agent_id, so a task whose thread already died still goes, then the
  row) with the route snapshotting `conversationIds` + `imageExt` BEFORE the delete, then
  best-effort disk sweep (avatar image by composite id, `personalAgentWorkspaceParent` tree,
  per-conversation image/file dirs). Disable (`enabled=false`) is the thread-preserving alternative.
- **deleteUser**: `store/admin.ts` drops `personal_agents WHERE owner_user_id` AND
  `bot_tasks WHERE owner_user_id` (bot conversations
  already cascade via the `owner_user_id` arm); single/bulk conversation deletes in
  `store/conversations.ts` also sweep `bot_tasks WHERE conversation_id`; `routes/admin.ts` snapshots each bot's
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
`tests/personal-agent-store.test.ts` (CRUD/cap/cascades/parse/reach),
`-tasks-store.test.ts` (bot_tasks status machine/orderings/sweeps/cascades),
`-tasks-routes.test.ts` (queue 202/caps, dispatcher drain + undispatchable-fail, resume,
finalize transitions incl. reportedOutcome→waiting_input, `bot_task` frame-name pins, task API +
cancel matrix, boot sweep/dispatch), `tests/svelte-bots-view.test.ts` (봇 오피스 roster/cards/
cancel-vs-stop/frame routing), `-routes.test.ts` (admin
gates, ownership 404s, AgentRequest shape incl. identity overlay + never-inherit pin, disabled 403,
role-revoked fail-closed, image round-trip, delete sweeps), `-tools.test.ts` (access-algebra
baseline, both tool gate matrices, describe_system, prompt pins, routine-name filtering),
`tests/svelte-personal-agents.test.ts` (badge/rail incl. the admin-only empty-state CTA and the
owner-avatar seeded pane it opens/management fetches/seeding). Getting-started
exclusion extended in `tests/agent-core.test.ts`; `tests/agent-run.test.ts:377`'s system-only
mcpServers pin now includes `personal_agent` (admin owner).
