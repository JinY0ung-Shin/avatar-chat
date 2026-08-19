<script lang="ts">
  import { onMount } from "svelte";
  import { BOT_TASK_STATUS_LABELS } from "../lib/chat";
  import type { BotTask, BotTaskStatus } from "../lib/types";

  // 위임 작업 카드 하나. 봇 오피스에서는 스레드(트랜스크립트) 안에 메시지들과
  // 섞여 놓이므로, 카드가 스스로 상태·경과·중지 컨트롤을 모두 들고 있어야
  // 어느 자리에 놓이든 같은 것을 말한다.

  /**
   * 카드에서 직접 멈출 수 있는 상태 — 종료된 작업(done/failed/cancelled)에는
   * 컨트롤을 달지 않는다. 셋 다 같은 엔드포인트를 쓰지만 running은 이미 돌고
   * 있는 턴이라 "취소"가 아니라 "중지"로 읽힌다(라벨은 stopButtonLabel).
   */
  const STOPPABLE: BotTaskStatus[] = ["queued", "waiting_input", "running"];
  /** 진행 중 작업의 경과를 흐르게 하는 주기 — 작업 폴링과 같은 박자. */
  const ELAPSED_TICK_MS = 10_000;

  export let task: BotTask;
  /** 이 카드의 중지/취소 요청이 아직 날아가는 중. */
  export let busy = false;
  /** 촘촘한 자리에 놓일 때 여백을 줄인다(카드가 주인공이 아닌 화면용). */
  export let compact = false;
  export let onCancel: (task: BotTask) => void = () => {};

  // 경과 시계는 카드가 직접 가진다 — 카드가 놓이는 자리(스레드)는 봇 작업을
  // 모르는 화면이라 바깥에서 틱을 내려줄 주인이 없다. 이미 끝난 작업의 경과는
  // 고정값이라 시계도 걸지 않는다.
  let now = Date.now();
  onMount(() => {
    if (task.finishedAt) return;
    const timer = window.setInterval(() => (now = Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  });

  // 파생값은 최상위 `$:`로 — 레거시 모드에서 템플릿이 호출한 헬퍼 안에서만 읽은
  // 상태는 추적되지 않아 값이 굳는다. 인자만 읽는 헬퍼(stopButtonLabel)는 마크업이
  // 인자를 이름으로 적으므로 그대로 호출해도 안전하다.
  $: detail = taskDetail(task);
  $: elapsed = elapsedLabel(task, now);
  $: statusLabel = BOT_TASK_STATUS_LABELS[task.status] ?? task.status;

  /** 카드 한 줄 요약: 상태별로 지금 알아야 할 문장 하나만 고른다. */
  function taskDetail(item: BotTask): string {
    const text =
      item.status === "waiting_input"
        ? item.pendingQuestion
        : item.status === "failed"
          ? item.error
          : item.status === "done"
            ? item.resultSummary
            : "";
    const trimmed = (text || "").replace(/\s+/g, " ").trim();
    return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed;
  }

  /** 생성 → 종료(진행 중이면 지금)까지의 경과. 인자만 읽으므로 안전하다. */
  function elapsedLabel(item: BotTask, nowMs: number): string {
    const start = Date.parse(item.createdAt || "");
    if (Number.isNaN(start)) return "";
    const finished = item.finishedAt ? Date.parse(item.finishedAt) : NaN;
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
  function stopButtonLabel(status: BotTaskStatus, pending: boolean): string {
    const verb = status === "running" ? "중지" : "취소";
    return pending ? `${verb}하는 중…` : verb;
  }
</script>

<article class="card bots-task-card" class:compact data-status={task.status}>
  <div class="bots-task-top">
    <span class="bots-task-chips">
      <span class="tag bots-task-chip" data-status={task.status}>{statusLabel}</span>
      <!-- 예약이 맡긴 일은 주인이 타이핑한 일과 섞여 한 스레드에 쌓인다. "이건
           내가 시킨 게 아니다"가 카드에서 바로 읽혀야 하므로 상태 칩 옆에 출처를
           붙이되, 상태보다 조용하도록 색 모디파이어 없는 기본 `.tag`로 둔다.
           두 글자만으로는 무엇의 예약인지 모르니 낭독 텍스트는 문장으로 편다. -->
      {#if task.routineJobId}
        <span class="tag bots-task-sched" title="예약 작업이 자동으로 맡긴 작업">
          <span aria-hidden="true">예약</span>
          <span class="sr-only">예약 작업이 자동으로 맡긴 작업</span>
        </span>
      {/if}
    </span>
    <span class="bots-task-elapsed">{elapsed}</span>
  </div>
  <p class="bots-task-title">{task.title || "(제목 없는 작업)"}</p>
  {#if detail}
    <p class="bots-task-detail">{detail}</p>
  {/if}
  {#if STOPPABLE.includes(task.status)}
    <div class="bots-task-actions">
      <!-- Several cards each carrying a bare "취소" are ambiguous to a screen
           reader, so the accessible name names the task; it stays STABLE while
           busy and the progress rides aria-busy instead. -->
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        aria-label={`${task.title || "작업"} ${stopButtonLabel(task.status, false)}`}
        aria-busy={busy ? "true" : "false"}
        disabled={busy}
        on:click={() => onCancel(task)}
      >
        {stopButtonLabel(task.status, busy)}
      </button>
    </div>
  {/if}
</article>

<style>
  .bots-task-card {
    /* 스레드 안에서는 말풍선들과 같은 열을 쓴다 — 고정 폭 카드였던 스트립 시절과
       달리 흐르는 너비가 맞다. */
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding: var(--pad-card, var(--s-3));
    border-radius: var(--r-md);
  }
  .bots-task-card.compact {
    gap: var(--s-0-5);
    padding: var(--s-2-5);
  }
  .bots-task-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
  }
  /* 칩들을 한 덩어리로 묶어야 경과 시간이 계속 오른쪽 끝에 붙는다 —
     space-between은 아이템이 셋이 되는 순간 가운데를 벌린다. */
  .bots-task-chips {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1-5);
    min-width: 0;
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
</style>
