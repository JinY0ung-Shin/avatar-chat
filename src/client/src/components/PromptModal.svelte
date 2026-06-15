<script lang="ts">
  import Icon from "./Icon.svelte";
  import { answerPrompt, humanTool, summarizeInput } from "../lib/chat";
  import { appState } from "../lib/state";
  import type { PromptRequest } from "../lib/types";

  $: request = $appState.promptQueue[0] ?? null;

  // Per-question answer state for the AskUserQuestion card, rebuilt whenever the
  // active request changes.
  let activeId = "";
  let selections: string[][] = [];
  let customOn: boolean[] = [];
  let customText: string[] = [];
  let busy = false;
  let error = "";

  $: questions = request?.kind === "question" && Array.isArray(request.data?.payload?.questions) ? request.data.payload.questions : null;

  $: if (request && request.id !== activeId) {
    activeId = request.id;
    error = "";
    busy = false;
    const count = questions?.length ?? 0;
    selections = Array.from({ length: count }, () => []);
    customOn = Array.from({ length: count }, () => false);
    customText = Array.from({ length: count }, () => "");
  }

  $: permissionTitle = request?.kind === "permission"
    ? request.data?.title || `이 아바타가 "${humanTool(request.data?.toolName)}" 작업을 실행하려고 합니다.`
    : "";
  $: permissionArg = request?.kind === "permission" ? summarizeInput(request.data?.input) : "";

  function answeredFor(qi: number): boolean {
    return selections[qi]?.length > 0 || (customOn[qi] && customText[qi].trim().length > 0);
  }
  // Reference selections/customOn/customText directly so Svelte tracks them — a
  // call to answeredFor() alone hides those deps and leaves the submit button
  // stuck in its initial (disabled) state no matter what the user selects/types.
  $: canSubmit =
    !questions ||
    questions.every(
      (_: unknown, qi: number) => selections[qi]?.length > 0 || (customOn[qi] && customText[qi].trim().length > 0),
    );

  function toggleOption(qi: number, q: any, label: string) {
    if (q.multiSelect) {
      const idx = selections[qi].indexOf(label);
      if (idx >= 0) selections[qi].splice(idx, 1);
      else selections[qi].push(label);
    } else {
      selections[qi] = [label];
      customOn[qi] = false;
    }
    selections = [...selections];
    customOn = [...customOn];
  }

  function toggleCustom(qi: number, q: any) {
    customOn[qi] = !customOn[qi];
    if (customOn[qi] && !q.multiSelect) selections[qi] = [];
    customOn = [...customOn];
    selections = [...selections];
  }

  async function respond(value: unknown) {
    if (!request) return;
    busy = true;
    error = "";
    try {
      await answerPrompt(request.id, value);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function submitQuestions() {
    if (!request || !questions) return;
    const answers: Record<string, string> = {};
    questions.forEach((q: any, qi: number) => {
      const vals = [...selections[qi]];
      if (customOn[qi] && customText[qi].trim()) vals.push(customText[qi].trim());
      answers[q.question || `q${qi}`] = vals.join(", ");
    });
    void respond({ result: { questions, answers } });
  }

  function cancel() {
    if (!request) return;
    if (request.kind === "permission") void respond({ behavior: "deny" });
    else void respond({ cancelled: true });
  }
</script>

{#if request}
  <div class="prompt-modal-backdrop" role="presentation">
    {#if request.kind === "permission"}
      <div class="prompt-card permission" role="dialog" aria-modal="true" aria-label="권한 요청">
        <div class="prompt-head">
          <span class="prompt-icon"><Icon name="lock" /></span>
          <span class="prompt-head-label">권한 요청</span>
          <button class="msg-act prompt-close" type="button" aria-label="닫기" title="닫기" on:click={cancel}><Icon name="close" /></button>
        </div>
        <div class="prompt-title">{permissionTitle}</div>
        <div class="prompt-tool">
          <code>{request.data?.toolName || "도구"}</code>
          {#if permissionArg}<span class="prompt-arg">{permissionArg}</span>{/if}
        </div>
        {#if request.data?.description}<div class="prompt-desc">{request.data.description}</div>{/if}
        {#if error}<div class="error-note prompt-error" role="alert">{error}</div>{/if}
        <div class="prompt-actions">
          <button class="btn btn-ghost btn-sm" type="button" disabled={busy} on:click={cancel}>거부</button>
          <button class="btn btn-primary btn-sm" type="button" disabled={busy} on:click={() => respond({ behavior: "allow" })}>승인</button>
        </div>
      </div>
    {:else}
      <div class="prompt-card question" role="dialog" aria-modal="true" aria-label="질문">
        <div class="prompt-head">
          <span class="prompt-icon"><Icon name="chat" /></span>
          <span class="prompt-head-label">질문</span>
          <button class="msg-act prompt-close" type="button" aria-label="닫기" title="닫기" on:click={cancel}><Icon name="close" /></button>
        </div>
        {#if questions}
          {#each questions as q, qi}
            <div class="q-block">
              {#if q.header}<span class="q-chip">{q.header}</span>{/if}
              <div class="q-text">{q.question || ""}</div>
              <div class="q-options" role="group" aria-label={q.multiSelect ? "여러 개 선택 가능" : "하나 선택"}>
                {#each (q.options || []) as opt}
                  <button
                    class="q-option"
                    class:selected={selections[qi]?.includes(opt.label)}
                    type="button"
                    aria-pressed={selections[qi]?.includes(opt.label) ? "true" : "false"}
                    on:click={() => toggleOption(qi, q, opt.label)}
                  >
                    <span class="q-opt-label">{opt.label || ""}</span>
                    {#if opt.description}<span class="q-opt-desc">{opt.description}</span>{/if}
                  </button>
                {/each}
                <button
                  class="q-option q-option-custom"
                  class:selected={customOn[qi]}
                  type="button"
                  aria-pressed={customOn[qi] ? "true" : "false"}
                  on:click={() => toggleCustom(qi, q)}
                >
                  <span class="q-opt-label">✎ 직접 입력</span>
                </button>
              </div>
              {#if customOn[qi]}
                <textarea class="q-custom-input" rows="2" placeholder="직접 답변을 입력하세요…" bind:value={customText[qi]}></textarea>
              {/if}
            </div>
          {/each}
        {:else}
          <pre class="prompt-input">{JSON.stringify(request.data?.payload ?? request.data, null, 2)}</pre>
        {/if}
        {#if error}<div class="error-note prompt-error" role="alert">{error}</div>{/if}
        <div class="prompt-actions">
          <button class="btn btn-ghost btn-sm" type="button" disabled={busy} on:click={cancel}>건너뛰기</button>
          {#if questions}
            <button class="btn btn-primary btn-sm" type="button" disabled={busy || !canSubmit} on:click={submitQuestions}>보내기</button>
          {:else}
            <button class="btn btn-primary btn-sm" type="button" disabled={busy} on:click={() => respond({ result: {} })}>확인</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
