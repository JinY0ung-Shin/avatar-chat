<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { mergeBotTasks, openBotThreadPane, upsertBotTask } from "../lib/chat";
  import { loadAvatars, loadConversations } from "../lib/loaders";
  import { goView, syncHash } from "../lib/nav";
  import { appState, notify, readState, updateState } from "../lib/state";
  import type { AvatarSummary, BotTask, BotTaskStatus } from "../lib/types";

  // 봇 오피스 — 내 봇에게 맡긴 작업을 한 화면에서 보는 메신저형 뷰.
  // 왼쪽은 봇 로스터(작업 상태 점), 가운데는 선택한 봇과의 대화 스레드이고
  // 그 위에 위임 작업 카드 스트립이 붙는다. 대화 화면 자체는 기존 ChatView를
  // 그대로 마운트해서 쓴다(컴포저·트랜스크립트·권한 프롬프트 전부 재사용).
  // 서버 계약: GET /api/me/bot-tasks, POST /api/me/bot-tasks/:id/cancel,
  // 그리고 실행 중인 봇에게 보낸 턴은 202 { queued, task }로 대기열에 들어간다.

  /** 로스터 점과 작업 카드를 함께 되살리는 폴링 주기. */
  const TASK_POLL_MS = 10_000;
  /** 한 번에 들고 오는 작업 행 수 — 카드 스트립과 점 계산 모두 이 페이지로 충분하다. */
  const TASK_PAGE_LIMIT = 60;

  const TASK_STATUS_LABELS: Record<BotTaskStatus, string> = {
    queued: "대기 중",
    running: "실행 중",
    waiting_input: "입력 대기",
    done: "완료",
    failed: "실패",
    cancelled: "취소됨",
  };
  /**
   * 카드에서 직접 멈출 수 있는 상태 — 종료된 작업(done/failed/cancelled)에는
   * 컨트롤을 달지 않는다. 셋 다 같은 엔드포인트를 쓰지만 running은 이미 돌고
   * 있는 턴이라 "취소"가 아니라 "중지"로 읽힌다(라벨은 stopButtonLabel).
   */
  const STOPPABLE: BotTaskStatus[] = ["queued", "waiting_input", "running"];

  /** 로스터 한 줄의 상태 — 점 색과 라벨을 함께 가진다. */
  interface RosterStatus {
    kind: "running" | "waiting" | "queued" | "idle";
    label: string;
  }

  let ChatViewComponent: any = null;
  let ready = false;
  let loadError = "";
  let tasksError = "";
  let opening = false;
  /** 이미 스레드를 연 봇 — 같은 봇으로 반복 진입해도 다시 로드하지 않는다. */
  let openedAgentId = "";
  let cancellingId = "";
  /** 진행 중 작업의 경과 시간을 흐르게 하는 시계(폴링 틱마다 갱신). */
  let now = Date.now();
  let pollTimer: number | null = null;

  $: bots = $appState.avatars.filter((avatar) => avatar.personalAgent);
  $: selectedAgentId = $appState.botsAgentId;
  $: selectedBot = bots.find((bot) => bot.personalAgent?.agentId === selectedAgentId) ?? null;
  // 상태 점은 파생 맵으로 만들어 마크업이 맵을 직접 읽게 한다 — 레거시 모드에서
  // 템플릿이 호출한 헬퍼 안에서만 읽은 상태는 추적되지 않아 값이 굳는다.
  $: rosterStatuses = new Map(
    bots.map((bot) => [bot.id, rosterStatus(bot.personalAgent?.agentId ?? "", $appState.botTasks)] as const),
  );
  $: agentTasks = $appState.botTasks.filter((task) => task.agentId === selectedAgentId);
  // 봇 스레드가 실제로 열렸는지 — ChatView는 이 조건에서만 마운트한다. 봇에서
  // 봇으로 옮길 때 이전 봇의 pane이 아직 남아 있으므로 언마운트되지 않는다.
  $: activePane =
    $appState.chatPanes.find((pane) => pane.id === $appState.activePaneId) ?? $appState.chatPanes[0] ?? null;
  $: threadMounted = Boolean(ChatViewComponent && activePane?.avatar.personalAgent);

  // 로스터/해시가 준비되는 대로 선택한 봇의 스레드를 연다. 의존성은 이 문장이
  // 이름으로 적은 것뿐이므로 `opening`도 여기서 읽는다 — 안에서만 검사하면
  // 앞선 열기가 끝나도 이 블록이 다시 돌지 않아 그 사이의 클릭이 통째로 사라진다.
  $: if (!opening) void syncSelection(ready, selectedAgentId, bots);

  // 보낸 직후엔 작업 행이 막 생겼을 때라 폴링 주기를 기다릴 이유가 없다.
  // 턴 종료(내려가는 엣지)도 마찬가지로 결과 요약을 바로 당겨온다.
  let lastStreaming = false;
  $: if (ready && $appState.streaming !== lastStreaming) {
    lastStreaming = $appState.streaming;
    void refreshTasks();
  }

  onMount(() => {
    void import("../views/ChatView.svelte").then((module) => (ChatViewComponent = module.default));
    void boot();
    pollTimer = window.setInterval(onTick, TASK_POLL_MS);
    window.addEventListener("focus", onTick);
    return () => {
      if (pollTimer != null) window.clearInterval(pollTimer);
      pollTimer = null;
      window.removeEventListener("focus", onTick);
    };
  });

  // 뷰를 떠나도 봇 pane은 chatPanes에 남는다 — 이 단계에선 의도된 동작이라
  // 별도의 정리 없이 다음 화면이 pane을 교체하게 둔다.

  async function boot(): Promise<void> {
    try {
      // 대화 목록이 먼저 있어야 "이 봇의 최근 스레드"를 고를 수 있다 — 없으면
      // 저장된 스레드 대신 새 pane이 열려 지난 대화가 사라진 것처럼 보인다.
      await Promise.all([loadAvatars(), loadConversations()]);
    } catch (err) {
      loadError = (err as Error).message;
    }
    await refreshTasks();
    ready = true;
    // 아무 봇도 안 고른 채로 들어오면 첫 봇을 연다 — 메신저에서 빈 가운데
    // 화면은 고장처럼 보인다. 히스토리에는 남기지 않는다(replace).
    if (!readState().botsAgentId) {
      const first = readState().avatars.find((avatar) => avatar.personalAgent)?.personalAgent?.agentId;
      if (first) {
        updateState((state) => {
          state.botsAgentId = first;
        });
        syncHash(true);
      }
    }
  }

  function onTick(): void {
    now = Date.now();
    if (typeof document !== "undefined" && document.hidden) return;
    void refreshTasks();
  }

  async function refreshTasks(): Promise<void> {
    try {
      const { tasks } = await api<{ tasks: BotTask[] }>(`/api/me/bot-tasks?limit=${TASK_PAGE_LIMIT}`);
      mergeBotTasks(Array.isArray(tasks) ? tasks : []);
      tasksError = "";
      now = Date.now();
    } catch (err) {
      tasksError = (err as Error).message;
    }
  }

  /** 이 봇과의 가장 최근 일반 대화 — 없으면 undefined(새 스레드로 연다). */
  function latestConversationId(bot: AvatarSummary): string | undefined {
    return readState()
      .conversations.filter((conversation) => conversation.avatarUserId === bot.id && !conversation.isRoutine)
      .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))[0]?.id;
  }

  async function syncSelection(isReady: boolean, agentId: string, roster: AvatarSummary[]): Promise<void> {
    if (!isReady || !agentId || openedAgentId === agentId) return;
    const bot = roster.find((item) => item.personalAgent?.agentId === agentId);
    // 로스터가 아직 안 왔을 수 있다 — 도착하면 이 블록이 다시 돈다.
    if (!bot) return;
    opening = true;
    openedAgentId = agentId;
    try {
      await openBotThreadPane(bot, latestConversationId(bot));
    } catch (err) {
      openedAgentId = "";
      notify(`봇 대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      opening = false;
    }
  }

  function selectBot(bot: AvatarSummary): void {
    const agentId = bot.personalAgent?.agentId;
    if (!agentId || agentId === readState().botsAgentId) return;
    updateState((state) => {
      state.botsAgentId = agentId;
    });
    syncHash();
  }

  function rosterStatus(agentId: string, tasks: BotTask[]): RosterStatus {
    if (!agentId) return { kind: "idle", label: "쉬는 중" };
    const mine = tasks.filter((task) => task.agentId === agentId);
    if (mine.some((task) => task.status === "running")) return { kind: "running", label: "작업 중" };
    if (mine.some((task) => task.status === "waiting_input")) return { kind: "waiting", label: "입력 대기" };
    const queued = mine.filter((task) => task.status === "queued").length;
    if (queued) return { kind: "queued", label: `대기열 ${queued}` };
    return { kind: "idle", label: "쉬는 중" };
  }

  /** 카드 한 줄 요약: 상태별로 지금 알아야 할 문장 하나만 고른다. */
  function taskDetail(task: BotTask): string {
    const detail =
      task.status === "waiting_input"
        ? task.pendingQuestion
        : task.status === "failed"
          ? task.error
          : task.status === "done"
            ? task.resultSummary
            : "";
    const text = (detail || "").replace(/\s+/g, " ").trim();
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }

  /** 생성 → 종료(진행 중이면 지금)까지의 경과. 인자만 읽으므로 템플릿에서 안전하다. */
  function elapsedLabel(task: BotTask, nowMs: number): string {
    const start = Date.parse(task.createdAt || "");
    if (Number.isNaN(start)) return "";
    const finished = task.finishedAt ? Date.parse(task.finishedAt) : NaN;
    const end = Number.isNaN(finished) ? nowMs : finished;
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}시간`;
    return `${Math.round(hours / 24)}일`;
  }

  /** 인자만 읽으므로 템플릿에서 호출해도 값이 굳지 않는다. */
  function stopButtonLabel(status: BotTaskStatus, busy: boolean): string {
    const verb = status === "running" ? "중지" : "취소";
    return busy ? `${verb}하는 중…` : verb;
  }

  async function cancelTask(task: BotTask): Promise<void> {
    if (cancellingId) return;
    cancellingId = task.id;
    const running = task.status === "running";
    try {
      const result = await api<{ task: BotTask; stopping?: boolean }>(
        `/api/me/bot-tasks/${encodeURIComponent(task.id)}/cancel`,
        { method: "POST" },
      );
      // 서버가 준 행을 그대로 받는다 — 실행 중이던 작업은 여기서 끝나지 않고
      // 최종 상태가 bot_task 프레임이나 다음 폴링으로 따로 온다. 그래서
      // "취소됨"이라고 단정하지 않고 요청을 보냈다고만 알린다.
      if (result?.task) upsertBotTask(result.task);
      notify(
        result?.stopping ? "중지 요청을 보냈어요 — 곧 작업이 종료됩니다" : "작업을 취소했습니다.",
        "ok",
      );
    } catch (err) {
      const verb = running ? "중지" : "취소";
      notify(`작업을 ${verb}하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      cancellingId = "";
    }
  }
</script>

<div class="bots-view">
  <header class="view-header bots-head">
    <div class="bots-head-left">
      <button class="icon-button" type="button" title="대화로 돌아가기" aria-label="대화로 돌아가기" on:click={() => goView("chat")}>
        <Icon name="back" size={18} />
      </button>
      <div class="title">
        <h1>봇 오피스</h1>
        <p>내 봇에게 맡긴 작업을 한곳에서 보고, 바쁘면 대기열에 쌓아 둡니다.</p>
      </div>
    </div>
  </header>

  <div class="bots-body">
    <aside class="bots-roster" aria-label="내 봇 목록">
      {#if !ready}
        <div class="bots-roster-note muted" role="status">봇 목록을 불러오는 중…</div>
      {:else if loadError}
        <div class="bots-roster-note" role="alert">봇 목록을 불러오지 못했습니다. {loadError}</div>
      {:else if !bots.length}
        <div class="bots-roster-note muted">아직 봇이 없어요.</div>
      {:else}
        <div class="bots-roster-list scroll-thin" role="group" aria-label="봇 선택">
          {#each bots as bot (bot.id)}
            {@const status = rosterStatuses.get(bot.id)}
            {@const active = bot.personalAgent?.agentId === selectedAgentId}
            <button
              class="bots-roster-row"
              class:active
              type="button"
              aria-current={active ? "true" : undefined}
              on:click={() => selectBot(bot)}
            >
              <AvatarImage user={bot} size={32} alt="" />
              <span class="bots-roster-text">
                <span class="bots-roster-name">{bot.alias || bot.displayName}</span>
                <span class="bots-roster-status" data-state={status?.kind ?? "idle"}>
                  <span class="bots-dot" aria-hidden="true"></span>{status?.label ?? "쉬는 중"}
                </span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <section class="bots-thread" aria-label="봇 대화">
      {#if ready && !bots.length}
        <div class="empty-state bots-empty">
          <div class="hero">
            <h3>아직 만든 봇이 없습니다</h3>
            <p>
              설정 ▸ 내 봇에서 봇을 만들거나, 내 아바타와의 대화에서 “내 봇을 새로 만들고 싶어”라고 말해
              보세요. 봇이 생기면 여기에서 작업을 맡길 수 있습니다.
            </p>
          </div>
          <button class="btn btn-primary" type="button" on:click={() => goView("settings", "agents")}>
            내 봇 만들러 가기
          </button>
        </div>
      {:else if ready && selectedAgentId && !selectedBot}
        <!-- 삭제된 봇을 가리키는 북마크(#/bots/<사라진 id>)로 들어온 경우. -->
        <div class="bots-chat-note muted" role="status">
          그 봇을 찾을 수 없어요. 왼쪽에서 다른 봇을 선택하세요.
        </div>
      {:else}
        <div class="bots-tasks" aria-label="맡긴 작업">
          <div class="bots-tasks-head">
            <span class="bots-tasks-title">맡긴 작업</span>
            {#if tasksError}
              <span class="bots-tasks-error" role="alert">작업 목록 갱신 실패</span>
            {/if}
          </div>
          {#if !agentTasks.length}
            <p class="bots-tasks-empty muted">아직 맡긴 작업이 없어요</p>
          {:else}
            <div class="bots-task-strip scroll-thin">
              {#each agentTasks as task (task.id)}
                {@const detail = taskDetail(task)}
                <article class="card bots-task-card" data-status={task.status}>
                  <div class="bots-task-top">
                    <span class="tag bots-task-chip" data-status={task.status}>
                      {TASK_STATUS_LABELS[task.status] ?? task.status}
                    </span>
                    <span class="bots-task-elapsed">{elapsedLabel(task, now)}</span>
                  </div>
                  <p class="bots-task-title">{task.title || "(제목 없는 작업)"}</p>
                  {#if detail}
                    <p class="bots-task-detail">{detail}</p>
                  {/if}
                  {#if STOPPABLE.includes(task.status)}
                    <div class="bots-task-actions">
                      <!-- A strip of cards each carrying a bare "취소" is
                           ambiguous to a screen reader, so the accessible name
                           names the task; it stays STABLE while busy and the
                           progress rides aria-busy instead. -->
                      <button
                        class="btn btn-ghost btn-sm"
                        type="button"
                        aria-label={`${task.title || "작업"} ${stopButtonLabel(task.status, false)}`}
                        aria-busy={cancellingId === task.id ? "true" : "false"}
                        disabled={cancellingId === task.id}
                        on:click={() => cancelTask(task)}
                      >
                        {stopButtonLabel(task.status, cancellingId === task.id)}
                      </button>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </div>

        <div class="bots-chat">
          {#if threadMounted}
            <svelte:component this={ChatViewComponent} />
          {:else}
            <div class="bots-chat-note muted" role="status">
              {opening || !ready ? "봇 대화를 여는 중…" : "왼쪽에서 봇을 선택하세요."}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  /* 밀도 토큰은 뷰 루트에서 선언한다(DESIGN.md §3) — 채팅과 같은 촘촘한 밀도. */
  .bots-view {
    --pad-card: var(--s-3);
    --gap-stack: var(--s-2);
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .bots-head-left {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-width: 0;
  }

  .bots-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
  }

  .bots-roster {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3);
    border-right: 1px solid var(--line);
    background: var(--bg-subtle);
    overflow: hidden;
  }
  .bots-roster-note {
    padding: var(--s-2) var(--s-2-5);
    font-size: var(--t-sm);
  }
  .bots-roster-list {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .bots-roster-row {
    display: flex;
    align-items: center;
    gap: var(--s-2-5);
    width: 100%;
    padding: var(--s-2);
    border: 1px solid transparent;
    border-radius: var(--r-md);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .bots-roster-row:hover {
    background: var(--panel);
  }
  .bots-roster-row.active {
    background: var(--panel);
    border-color: var(--line);
  }
  .bots-roster-text {
    display: flex;
    flex-direction: column;
    gap: var(--s-0-5);
    min-width: 0;
  }
  .bots-roster-name {
    font-size: var(--t-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bots-roster-status {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    font-size: var(--t-2xs);
    color: var(--muted);
  }
  .bots-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  /* 상태는 색만이 아니라 라벨로도 구분된다 — 점 하나로만 나뉘면 한 단계다. */
  .bots-roster-status[data-state="running"] {
    color: var(--accent);
  }
  .bots-roster-status[data-state="waiting"] {
    color: var(--warn);
  }
  .bots-roster-status[data-state="queued"] {
    color: var(--info);
  }

  .bots-thread {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .bots-tasks {
    flex: none;
    padding: var(--s-2-5) var(--s-4);
    border-bottom: 1px solid var(--line);
  }
  .bots-tasks-head {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
  }
  .bots-tasks-title {
    font-size: var(--t-2xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
  }
  .bots-tasks-error {
    font-size: var(--t-2xs);
    color: var(--warn);
  }
  .bots-tasks-empty {
    margin: var(--s-1-5) 0 0;
    font-size: var(--t-sm);
  }
  .bots-task-strip {
    display: flex;
    gap: var(--s-2);
    margin-top: var(--s-2);
    overflow-x: auto;
    padding-bottom: var(--s-1);
  }
  .bots-task-card {
    flex: none;
    width: 240px;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding: var(--pad-card);
    border-radius: var(--r-md);
  }
  .bots-task-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
  }
  /* `.tag` 베이스 위에 색 모디파이어만 얹는다(패딩·라운드 재정의 금지). */
  .bots-task-chip[data-status="running"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .bots-task-chip[data-status="waiting_input"] {
    color: var(--warn);
    border-color: var(--warn-line);
  }
  .bots-task-chip[data-status="failed"] {
    color: var(--danger);
    border-color: var(--danger-line);
  }
  .bots-task-chip[data-status="done"] {
    color: var(--ok);
    border-color: var(--ok-line);
  }
  .bots-task-elapsed {
    font-size: var(--t-2xs);
    color: var(--muted);
  }
  .bots-task-title {
    margin: 0;
    font-size: var(--t-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bots-task-detail {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--text-soft);
    line-height: 1.4;
  }
  .bots-task-actions {
    display: flex;
    justify-content: flex-end;
  }

  .bots-chat {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .bots-chat-note {
    padding: var(--s-6);
    text-align: center;
    font-size: var(--t-sm);
  }
  .bots-empty {
    flex: 1;
  }

  /* 좁은 화면에서는 로스터를 가로 칩 줄로 접는다. */
  @media (max-width: 860px) {
    .bots-body {
      display: flex;
      flex-direction: column;
    }
    .bots-roster {
      flex: none;
      border-right: 0;
      border-bottom: 1px solid var(--line);
      padding: var(--s-2);
    }
    .bots-roster-list {
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .bots-roster-row {
      width: auto;
      flex: none;
    }
  }

  /* ---- 마운트한 ChatView 억제 (범위는 .bots-main 하위로만) ----------------
     이 뷰는 메신저라 분할/새 대화 컨트롤이 들어설 자리가 없다. ChatView 자체는
     건드리지 않고, 봇 오피스 안에서만 헤더 액션을 감춘다. */
  :global(.bots-main) {
    width: 100%;
  }
  :global(.bots-main .chat-head .chat-head-actions) {
    display: none;
  }
  /* ChatView의 상단 헤더는 이 뷰의 자체 헤더 아래에 놓이므로 붙박이 배경/블러를
     빼서 두 겹으로 보이지 않게 한다. */
  :global(.bots-main .chat-head) {
    backdrop-filter: none;
    background: transparent;
  }
</style>
