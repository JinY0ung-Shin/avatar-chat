<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import {
    BOT_TASK_STATUS_LABELS,
    isUnseenBotTask,
    mergeBotTasks,
    openBotThreadPane,
    openSeededChat,
  } from "../lib/chat";
  import { confirmAction } from "../lib/confirm";
  import { loadAvatars, loadConversations, markBotTasksSeen, refreshBotTaskUnseen } from "../lib/loaders";
  import { goView, syncHash } from "../lib/nav";
  import { appState, notify, readState, updateState } from "../lib/state";
  import type { AvatarSummary, BotTask, BotTaskStatus, PersonalAgent } from "../lib/types";

  // 봇 오피스 — 내 봇에게 맡긴 작업을 한 화면에서 보는 메신저형 뷰.
  // 왼쪽은 입력 대기 인박스 + 봇 로스터, 가운데는 선택한 봇과의 대화 스레드다.
  // 작업 카드는 이 뷰가 아니라 스레드 '안'에 산다(ChatView의 트랜스크립트가
  // 시각을 기준으로 끼워 넣는다) — 맡긴 일은 그 일을 시킨 turn 옆에 있어야
  // 읽히기 때문이다. 그래서 여기 남는 건 한 줄 요약뿐이다.
  // 서버 계약: GET /api/me/bot-tasks, POST /api/me/bot-tasks/:id/cancel,
  // POST /api/me/bot-tasks/seen, 그리고 실행 중인 봇에게 보낸 턴은
  // 202 { queued, task }로 대기열에 들어간다.

  /** 로스터 점과 작업 카드를 함께 되살리는 폴링 주기. */
  const TASK_POLL_MS = 10_000;
  /** 한 번에 들고 오는 작업 행 수 — 카드와 점 계산 모두 이 페이지로 충분하다. */
  const TASK_PAGE_LIMIT = 60;
  /** 끝난 작업이 몰려 들어와도 '봤다' 표시는 한 번만 나가게 모으는 창. */
  const SEEN_DEBOUNCE_MS = 1_000;
  /** 인박스 한 줄에 들어가는 질문 길이. */
  const QUESTION_MAX = 60;

  /** 요약 줄이 세는 상태와 그 자리의 어휘(로스터 점과 같은 말을 쓴다). */
  const SUMMARY_PARTS: [BotTaskStatus, string][] = [
    ["running", "실행 중"],
    ["queued", "대기열"],
    ["waiting_input", "입력 대기"],
  ];

  // 봇은 대화로 만들어진다(내 아바타가 mcp__personal_agent__create_agent를 부른다).
  // 그래서 이 CTA는 컴포저에 요청을 준비만 하고 보내기는 주인이 누른다 — 레일의
  // 같은 CTA와 문구를 맞춘다.
  const BOT_CREATE_SEED =
    "내 봇을 새로 만들고 싶어. 어떤 역할의 봇이 좋을지 같이 정하고, 이름과 페르소나를 제안해서 만들어줘.";
  const BOT_CREATE_NOTICE = "입력창에 봇 만들기 요청을 준비했습니다. 보내기를 누르면 시작해요.";

  /** 삭제가 무엇을 가져가는지 — 설정 ▸ 내 봇의 확인문을 따르되, 비활성화 버튼이 이 화면에는 없으므로 위치를 짚어 준다. */
  const DELETE_WARNING =
    "이 봇과의 모든 대화 기록이 함께 삭제되며 되돌릴 수 없습니다. 기록을 남기려면 설정 → 내 봇의 ‘비활성화’를 사용하세요.";
  /** …그리고 무엇이 남는지. 기억은 지식 저장소에 있고 삭제 대상이 아니다. */
  const MEMORY_KEPT = (dir: string): string =>
    dir
      ? `봇의 기억 폴더(지식 저장소의 agents/${dir}/)는 삭제되지 않고 남습니다.`
      : "봇의 기억 폴더(지식 저장소의 agents/ 아래)는 삭제되지 않고 남습니다.";

  /** 로스터 한 줄의 상태 — 점 색과 라벨을 함께 가진다. */
  interface RosterStatus {
    kind: "running" | "waiting" | "queued" | "idle";
    label: string;
  }

  /** 인박스 한 줄 — 어느 봇이 무엇을 묻고 있는지. */
  interface InboxEntry {
    task: BotTask;
    bot: AvatarSummary;
    question: string;
  }

  let ChatViewComponent: any = null;
  let ready = false;
  let loadError = "";
  let tasksError = "";
  let opening = false;
  /** 이미 스레드를 연 봇 — 같은 봇으로 반복 진입해도 다시 로드하지 않는다. */
  let openedAgentId = "";
  let botCreateBusy = false;
  let deleting = false;
  let pollTimer: number | null = null;

  $: bots = $appState.avatars.filter((avatar) => avatar.personalAgent);
  $: selectedAgentId = $appState.botsAgentId;
  $: selectedBot = bots.find((bot) => bot.personalAgent?.agentId === selectedAgentId) ?? null;
  // 로스터의 세 신호(점·최근 작업·안 본 개수)는 전부 파생 맵으로 만들어 마크업이
  // 맵을 직접 읽게 한다 — 레거시 모드에서 템플릿이 호출한 헬퍼 안에서만 읽은
  // 상태는 추적되지 않아 값이 굳는다.
  $: rosterStatuses = new Map(
    bots.map((bot) => [bot.id, rosterStatus(agentIdOf(bot), $appState.botTasks)] as const),
  );
  $: rosterLatest = new Map(
    bots.map((bot) => [bot.id, latestTaskLine(agentIdOf(bot), $appState.botTasks)] as const),
  );
  $: rosterUnseen = new Map(
    bots.map((bot) => [bot.id, unseenCount(agentIdOf(bot), $appState.botTasks)] as const),
  );
  $: agentTasks = $appState.botTasks.filter((task) => task.agentId === selectedAgentId);
  $: summaryText = summarize(agentTasks);
  // 삭제는 되돌릴 수 없으므로 턴이 도는 중에는 잠근다. 스트리밍은 이 클라이언트가
  // 붙은 스트림만 알므로, 디스패처가 돌리는 무인 작업은 실행 중 task 행으로 본다.
  // 셋 다 최상위 $:로 이름 지어 둔다 — 핸들러 안에서만 읽으면 레거시 모드에서 굳는다.
  $: selectedRunning = selectedBot
    ? rosterStatuses.get(selectedBot.id)?.kind === "running"
    : false;
  $: deleteDisabled = deleting || $appState.streaming || selectedRunning;
  $: deleteTitle =
    $appState.streaming || selectedRunning
      ? "실행 중인 작업이 끝난 뒤 삭제할 수 있습니다"
      : "이 봇과의 모든 대화 기록이 함께 삭제됩니다";
  $: waitingInbox = inboxEntries(bots, $appState.botTasks);
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

  /* ---- 안 본 작업 표시 ------------------------------------------------------
     열려 있는 스레드에서 '아직 안 본' 작업들. 이 키가 바뀌면 새로 끝난 작업이
     도착했다는 뜻이고, 봇을 고르는 순간엔 바로 보냈다고 표시한다. */
  let seenAgentId = "";
  let seenTimer: number | null = null;

  $: unseenSelectedKey = agentTasks
    .filter(isUnseenBotTask)
    .map((task) => task.id)
    .join(",");
  $: syncSeen(selectedAgentId, unseenSelectedKey, threadMounted);

  onMount(() => {
    void import("../views/ChatView.svelte").then((module) => (ChatViewComponent = module.default));
    void boot();
    pollTimer = window.setInterval(onTick, TASK_POLL_MS);
    window.addEventListener("focus", onTick);
    return () => {
      if (pollTimer != null) window.clearInterval(pollTimer);
      pollTimer = null;
      if (seenTimer != null) window.clearTimeout(seenTimer);
      seenTimer = null;
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
    if (typeof document !== "undefined" && document.hidden) return;
    void refreshTasks();
    // 탭으로 돌아왔을 때 그동안 쌓인 '안 본' 작업을 여기서 정리한다 — 볼 게
    // 없으면 scheduleSeen이 아무것도 보내지 않는다.
    scheduleSeen(false);
  }

  async function refreshTasks(): Promise<void> {
    try {
      const { tasks } = await api<{ tasks: BotTask[] }>(`/api/me/bot-tasks?limit=${TASK_PAGE_LIMIT}`);
      mergeBotTasks(Array.isArray(tasks) ? tasks : []);
      tasksError = "";
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
    const agentId = agentIdOf(bot);
    if (!agentId) return;
    applySelection(agentId);
  }

  /**
   * 선택을 옮기는 단 하나의 자리 — 빈 문자열은 "아무 봇도 선택 안 함"이다.
   * 해시까지 같이 맞춰야 북마크와 뒤로가기가 화면과 어긋나지 않는다.
   */
  function applySelection(agentId: string): void {
    if (agentId === readState().botsAgentId) return;
    updateState((state) => {
      state.botsAgentId = agentId;
    });
    syncHash();
  }

  /**
   * 봇을 고르는 순간엔 바로, 그 뒤 새로 끝난 작업이 도착하면 잠깐 모아서 한 번만
   * '봤다'를 보낸다. 탭이 숨어 있으면 본 게 아니므로 보내지 않고, 다음 폴링
   * (포커스 복귀 포함)이 다시 시도한다.
   */
  function syncSeen(agentId: string, unseenKey: string, mounted: boolean): void {
    void unseenKey; // 새 작업이 도착하면 이 문장을 다시 돌리는 의존성
    if (!agentId || !mounted) return;
    const switched = agentId !== seenAgentId;
    seenAgentId = agentId;
    scheduleSeen(switched);
  }

  function scheduleSeen(immediate: boolean): void {
    if (!seenAgentId || !threadMounted) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (!immediate && !unseenSelectedKey) return;
    if (seenTimer != null) window.clearTimeout(seenTimer);
    seenTimer = null;
    if (immediate) {
      void markSeenNow(seenAgentId);
      return;
    }
    seenTimer = window.setTimeout(() => {
      seenTimer = null;
      void markSeenNow(readState().botsAgentId);
    }, SEEN_DEBOUNCE_MS);
  }

  /**
   * 표시한 뒤 목록을 다시 읽는다 — 로스터의 안 본 개수는 state.botTasks의
   * seenAt에서 나오므로, 서버가 찍은 값을 받아와야 칩이 사라진다.
   */
  async function markSeenNow(agentId: string): Promise<void> {
    if (!agentId) return;
    await markBotTasksSeen(agentId);
    await refreshTasks();
  }

  async function startBotCreation(): Promise<void> {
    if (botCreateBusy) return;
    botCreateBusy = true;
    try {
      await openSeededChat(BOT_CREATE_SEED, BOT_CREATE_NOTICE);
    } catch (err) {
      notify(`봇 만들기를 시작하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      botCreateBusy = false;
    }
  }

  /**
   * 확인문에 넣을 이 봇의 기억 폴더 이름. AvatarSummary의 봇 태그는 agentId와
   * 모델만 실어 오므로 memoryDir는 주인의 봇 목록에서만 읽을 수 있다 — 드물고
   * 파괴적인 동작 하나 때문에 뷰가 뜰 때마다 한 번 더 물을 이유는 없으니 누른
   * 순간에 읽고, 못 읽으면 폴더 이름 없이도 참인 문장으로 물러난다.
   */
  async function memoryDirOf(agentId: string): Promise<string> {
    try {
      const { agents } = await api<{ agents: PersonalAgent[] }>("/api/me/agents");
      return (agents ?? []).find((agent) => agent.id === agentId)?.memoryDir ?? "";
    } catch {
      return "";
    }
  }

  /**
   * 선택한 봇을 지운다. 로스터만 다시 읽으면 지워진 봇의 pane이 chatPanes에
   * 남아 스레드가 그대로 굳으므로(openedAgentId도 그 봇을 가리킨 채다), 다음
   * 봇으로 실제로 옮기거나 남은 봇이 없으면 pane까지 걷어낸다.
   */
  async function removeSelected(): Promise<void> {
    const bot = selectedBot;
    if (!bot || deleteDisabled) return;
    const agentId = agentIdOf(bot);
    if (!agentId) return;
    const label = bot.alias || bot.displayName;
    // 다음 선택은 삭제 '전' 로스터에서 고른다 — 새로 읽기가 실패해도 화면이
    // 사라진 봇에 머무르지 않는다.
    const nextBot = bots.find((item) => agentIdOf(item) && agentIdOf(item) !== agentId) ?? null;
    deleting = true;
    try {
      const confirmed = await confirmAction(
        `"${label}" 봇을 삭제할까요?\n${DELETE_WARNING}\n${MEMORY_KEPT(await memoryDirOf(agentId))}`,
        { title: "봇을 삭제할까요?", confirmLabel: "삭제", tone: "danger" },
      );
      if (!confirmed) return;
      // 확인창이 열려 있는 동안 큐의 작업이 시작됐을 수 있다 — 지금 상태로 다시 본다.
      const now = readState();
      if (now.streaming || now.botTasks.some((task) => task.agentId === agentId && task.status === "running")) {
        notify("실행 중인 작업이 끝난 뒤 삭제할 수 있습니다.", "warn");
        return;
      }
      await api(`/api/me/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
      notify(`"${label}" 봇을 삭제했습니다.`, "ok");
      dropDeletedBot(bot);
      applySelection(nextBot ? agentIdOf(nextBot) : "");
      await Promise.all([
        loadAvatars(true).catch(() => {}),
        refreshTasks(),
        refreshBotTaskUnseen(),
      ]);
    } catch (err) {
      notify(`봇 삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      deleting = false;
    }
  }

  /**
   * 지워진 봇의 흔적을 스토어에서 걷어낸다. pane을 남기면 남은 봇이 없을 때
   * 사라진 봇의 대화가 계속 그려지고, closePane은 currentAvatar로 pane을 다시
   * 만들어 주기 때문에 여기서는 쓸 수 없다. 작업 행도 같이 지운다 — 목록 병합은
   * 응답에 없는 행을 '비행 중'으로 보고 남기므로 서버가 지운 뒤에도 굳는다.
   */
  function dropDeletedBot(bot: AvatarSummary): void {
    const agentId = agentIdOf(bot);
    openedAgentId = "";
    updateState((state) => {
      state.chatPanes = state.chatPanes.filter((pane) => pane.avatar.id !== bot.id);
      if (!state.chatPanes.some((pane) => pane.id === state.activePaneId))
        state.activePaneId = state.chatPanes[0]?.id ?? null;
      if (state.currentAvatar?.id === bot.id) state.currentAvatar = null;
      state.botTasks = state.botTasks.filter((task) => task.agentId !== agentId);
    });
  }

  function agentIdOf(bot: AvatarSummary): string {
    return bot.personalAgent?.agentId ?? "";
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

  /** 로스터 둘째 줄: 이 봇이 가장 최근에 맡은 일 하나(없으면 상태 라벨만 남는다). */
  function latestTaskLine(agentId: string, tasks: BotTask[]): string {
    if (!agentId) return "";
    const latest = tasks.find((task) => task.agentId === agentId);
    if (!latest) return "";
    const label = BOT_TASK_STATUS_LABELS[latest.status] ?? latest.status;
    return `${latest.title || "(제목 없는 작업)"} · ${label}`;
  }

  function unseenCount(agentId: string, tasks: BotTask[]): number {
    if (!agentId) return 0;
    return tasks.filter((task) => task.agentId === agentId && isUnseenBotTask(task)).length;
  }

  /** 요약 줄은 0인 항목을 말하지 않는다 — 없는 상태는 정보가 아니다. */
  function summarize(tasks: BotTask[]): string {
    const parts: string[] = [];
    for (const [status, label] of SUMMARY_PARTS) {
      const count = tasks.filter((task) => task.status === status).length;
      if (count) parts.push(`${label} ${count}`);
    }
    return parts.join(" · ");
  }

  /**
   * 입력 대기 인박스: 봇이 나를 기다리는 질문만 봇을 가리지 않고 모은다.
   * botTasks는 최신순이라 그대로 쓰면 방금 온 질문이 위에 온다.
   */
  function inboxEntries(roster: AvatarSummary[], tasks: BotTask[]): InboxEntry[] {
    const byAgent = new Map(roster.map((bot) => [agentIdOf(bot), bot] as const));
    const entries: InboxEntry[] = [];
    for (const task of tasks) {
      if (task.status !== "waiting_input") continue;
      const bot = byAgent.get(task.agentId);
      if (!bot) continue;
      entries.push({ task, bot, question: questionSnippet(task.pendingQuestion || task.title) });
    }
    return entries;
  }

  function questionSnippet(text: string | null): string {
    const trimmed = (text || "").replace(/\s+/g, " ").trim();
    return trimmed.length > QUESTION_MAX ? `${trimmed.slice(0, QUESTION_MAX)}…` : trimmed;
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
      {#if waitingInbox.length}
        <!-- 봇이 나를 기다리는 줄만 맨 위로 — 답을 주기 전엔 그 작업이 멈춰
             있으므로, 로스터 안쪽을 뒤져 찾게 두지 않는다. -->
        <section class="bots-inbox" aria-label="입력 대기 인박스">
          <p class="bots-inbox-title">입력 대기 {waitingInbox.length}</p>
          <div class="bots-inbox-list scroll-thin">
            {#each waitingInbox as entry (entry.task.id)}
              <button class="bots-inbox-row" type="button" on:click={() => selectBot(entry.bot)}>
                <span class="bots-inbox-bot">{entry.bot.alias || entry.bot.displayName}</span>
                <span class="bots-inbox-question">{entry.question}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

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
            {@const latest = rosterLatest.get(bot.id)}
            {@const unseen = rosterUnseen.get(bot.id) ?? 0}
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
                {#if latest}
                  <span class="bots-roster-task">{latest}</span>
                {/if}
              </span>
              {#if unseen}
                <span class="tag bots-roster-unseen" title={`확인하지 않은 작업 ${unseen}건`}>{unseen}</span>
              {/if}
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
              봇은 대화로 만듭니다. 아래 버튼을 누르면 내 아바타와의 대화에 요청이 준비되고,
              보내기를 누르면 어떤 역할의 봇이 좋을지 같이 정할 수 있어요. 설정에서 직접 만들
              수도 있습니다.
            </p>
          </div>
          <div class="bots-empty-actions">
            <button class="btn btn-primary" type="button" disabled={botCreateBusy} on:click={startBotCreation}>
              대화로 봇 만들기
            </button>
            <button class="btn btn-secondary" type="button" on:click={() => goView("settings", "agents")}>
              내 봇 만들러 가기
            </button>
          </div>
        </div>
      {:else if ready && selectedAgentId && !selectedBot}
        <!-- 삭제된 봇을 가리키는 북마크(#/bots/<사라진 id>)로 들어온 경우. -->
        <div class="bots-chat-note muted" role="status">
          그 봇을 찾을 수 없어요. 왼쪽에서 다른 봇을 선택하세요.
        </div>
      {:else}
        {#if summaryText || tasksError || selectedBot}
          <!-- 카드는 스레드 안에 있으니 요약으로 남는 건 지금 몇 건이 움직이는지
               한 줄뿐이다. 0인 항목은 말하지 않는다. 이 줄은 고른 봇의 헤더도
               겸하므로 봇을 고르고 있으면 요약이 비어도 자리는 남는다. -->
          <div class="bots-summary">
            {#if summaryText}
              <span class="bots-summary-text">{summaryText}</span>
            {/if}
            {#if tasksError}
              <span class="bots-summary-error" role="alert">작업 목록 갱신 실패</span>
            {/if}
            {#if selectedBot}
              <!-- 삭제는 로스터 줄이 아니라 '지금 보고 있는 봇'의 헤더에 둔다 —
                   목록에서 스치듯 누를 수 있는 자리에 되돌릴 수 없는 동작을
                   두지 않는다. -->
              <button
                class="ghost-sm danger bots-summary-delete"
                type="button"
                title={deleteTitle}
                disabled={deleteDisabled}
                on:click={removeSelected}
              >{deleting ? "삭제 중…" : "삭제"}</button>
            {/if}
          </div>
        {/if}

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
  /* 밀도 토큰은 뷰 루트에서 선언한다(DESIGN.md §3) — 채팅과 같은 촘촘한 밀도.
     스레드 안의 작업 카드도 이 값을 상속받는다. */
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
    flex: 1;
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
  .bots-roster-task {
    font-size: var(--t-2xs);
    color: var(--text-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 안 본 작업 개수 — `.tag` 베이스 위에 색만 얹는다. */
  .bots-roster-unseen {
    flex: none;
    color: var(--on-accent);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
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

  .bots-inbox {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding-bottom: var(--s-2);
    border-bottom: 1px solid var(--line);
  }
  .bots-inbox-title {
    margin: 0;
    font-size: var(--t-2xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--warn);
  }
  .bots-inbox-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-0-5);
    max-height: 30vh;
    overflow-y: auto;
  }
  .bots-inbox-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-0-5);
    width: 100%;
    padding: var(--s-1-5) var(--s-2);
    border: 1px solid var(--warn-line);
    border-radius: var(--r-sm);
    background: var(--warn-soft);
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .bots-inbox-bot {
    font-size: var(--t-2xs);
    font-weight: 600;
    color: var(--warn);
  }
  .bots-inbox-question {
    font-size: var(--t-xs);
    color: var(--text-soft);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bots-thread {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .bots-summary {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    padding: var(--s-1-5) var(--s-4);
    border-bottom: 1px solid var(--line);
    font-size: var(--t-2xs);
  }
  .bots-summary-text {
    color: var(--muted);
  }
  .bots-summary-error {
    color: var(--warn);
  }
  /* 요약은 왼쪽, 파괴적 동작은 줄 끝 — 읽는 눈이 지나가는 자리에 두지 않는다.
     (`flex: none`은 .ghost-sm이 이미 갖고 있다.) */
  .bots-summary-delete {
    margin-left: auto;
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
  .bots-empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
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
      /* 가로 줄에서는 최근 작업 줄이 칸을 무한정 늘리지 않도록 폭을 묶는다. */
      max-width: 220px;
    }
    .bots-inbox-list {
      max-height: none;
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
