<script lang="ts">
  import { timeLabel } from "../lib/format";
  import { api } from "../lib/api";
  import { notify, readState } from "../lib/state";
  import { recordKnowledgeViaAvatar } from "../lib/knowledge";
  import type { KnowledgeRequest } from "../lib/types";

  export let request: KnowledgeRequest;
  // Re-render the inbox after a record/ignore so the resolved row drops out.
  export let refresh: () => Promise<void>;

  let showCompose = false;
  let answer = "";
  let busy = false; // record in flight
  let ignoring = false;
  let textarea: HTMLTextAreaElement | undefined;

  $: disabled = busy || ignoring;
  $: answerTrimmed = answer.trim();
  $: canSubmitAnswer = Boolean(!disabled && answerTrimmed);
  $: rowBase = request.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  $: questionId = `knowledge-request-question-${rowBase}`;
  $: statusId = `knowledge-request-status-${rowBase}`;
  $: composeId = `knowledge-request-compose-${rowBase}`;
  $: rowStatus = ignoring
    ? "정보 요청을 무시하는 중입니다."
    : busy
      ? "답변을 지식 저장소에 기록 요청하는 중입니다."
      : showCompose
        ? answerTrimmed
          ? "답변을 기록 요청할 수 있습니다."
          : "답변을 입력해 주세요."
        : "정보 추가를 누르면 답변 입력창이 열립니다.";

  function toggleCompose() {
    showCompose = !showCompose;
    if (showCompose) {
      // focus once the textarea is rendered
      queueMicrotask(() => textarea?.focus());
    }
  }

  function cancelCompose() {
    showCompose = false;
  }

  async function ignore() {
    if (disabled) return;
    ignoring = true;
    // Single try/finally so `ignoring` always resets (the success path relied on
    // the row unmounting, which isn't guaranteed if the refresh returns it).
    try {
      await api(`/api/me/knowledge/requests/${encodeURIComponent(request.id)}`, { method: "DELETE" });
      await refresh();
      notify("정보 요청을 무시했습니다.", "ok");
    } catch (e) {
      notify(`무시 처리에 실패했거나 목록 새로고침에 실패했습니다: ${(e as Error).message}`);
    } finally {
      ignoring = false;
    }
  }

  async function submit() {
    const text = answerTrimmed;
    if (!text) {
      textarea?.focus();
      notify("기록할 답변을 입력해 주세요.", "warn");
      return;
    }
    if (disabled) return;
    busy = true;
    // try/finally so busy ALWAYS resets — the stillOpen branch keeps this row
    // rendered, so a success path that forgot to reset locked every button at
    // "기록 중…" until remount.
    try {
      const result = await recordKnowledgeViaAvatar(request, text);
      if (!result.ok) {
        notify(`기록 요청 실패: ${result.error}`);
        return;
      }
      // The avatar resolves the request itself after committing; a refresh then
      // drops this row out. If it's still open afterward the recording didn't
      // complete — say so honestly instead of claiming success.
      try {
        await refresh();
      } catch (e) {
        notify(`기록은 요청했지만 목록 새로고침에 실패했어요: ${(e as Error).message}`, "warn");
        return;
      }
      const stillOpen = readState().knowledgeRequests.some((x) => x.id === request.id && x.status === "open");
      notify(
        stillOpen
          ? "아바타가 기록을 완료하지 못한 것 같아요. ‘대화’의 ‘지식 기록’ 대화를 확인해 주세요."
          : "아바타가 답을 지식 저장소에 기록했어요.",
        stillOpen ? "warn" : "info",
      );
    } finally {
      busy = false;
    }
  }
</script>

<div class="knowledge-row" aria-busy={disabled ? "true" : "false"} aria-describedby={statusId}>
  <div class="inbox-row-head">
    <span class="inbox-chip req">정보 요청</span>
  </div>
  <div class="kr-q" id={questionId}>{request.question}</div>
  <div class="muted kr-meta">
    {#if request.askerName}질문자: {request.askerName} · {timeLabel(request.createdAt)}{:else}{timeLabel(request.createdAt)}{/if}
  </div>
  <div class="sr-only" id={statusId} role="status" aria-live="polite">{rowStatus}</div>
  <div class="kr-actions">
    <button
      class="primary small"
      class:active={showCompose}
      type="button"
      aria-expanded={showCompose ? "true" : "false"}
      aria-controls={composeId}
      aria-describedby={statusId}
      title="답변 입력창 열기"
      disabled={disabled}
      on:click={toggleCompose}
    >정보 추가</button>
    <button class="ghost-sm" type="button" aria-describedby={statusId} disabled={disabled} on:click={ignore}>
      {ignoring ? "무시 중…" : "무시"}
    </button>
  </div>
  {#if showCompose}
    <div id={composeId} class="kr-compose" role="region" aria-labelledby={questionId} aria-describedby={statusId}>
      <textarea
        class="kr-answer"
        rows="3"
        bind:this={textarea}
        bind:value={answer}
        disabled={disabled}
        placeholder="이 질문에 대한 답·정보를 적어 주세요. 아바타가 지식 저장소에 기록하고 이 요청을 닫습니다"
        aria-label="정보 요청 답변"
        aria-describedby={statusId}
      ></textarea>
      <div class="kr-compose-actions">
        <button class="primary small" type="button" aria-describedby={statusId} disabled={!canSubmitAnswer} on:click={submit}>
          {busy ? "기록 중…" : "기록 요청"}
        </button>
        <button class="ghost-sm" type="button" disabled={disabled} on:click={cancelCompose}>취소</button>
      </div>
    </div>
  {/if}
</div>
