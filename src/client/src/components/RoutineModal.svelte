<script lang="ts">
  // Centered create/edit modal for a routine. `routine === null` = create mode.
  // Mirrors the old openRoutineModal()/buildScheduleForm(): markdown prompt
  // preview, daily/weekly/interval schedule builder with validation, plus
  // run-now/delete actions in edit mode.
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../lib/api";
  import { enhanceMarkdown } from "../lib/dom";
  import { renderMarkdown, WEEKDAY_NAMES } from "../lib/format";
  import { loadRoutinesData } from "../lib/loaders";
  import { notify } from "../lib/state";
  import type { RoutineJob } from "../lib/types";

  export let routine: RoutineJob | null = null;

  const dispatch = createEventDispatcher<{ close: void; saved: void; runNow: { routine: RoutineJob }; deleted: { routine: RoutineJob } }>();
  const isEdit = Boolean(routine);

  let name = routine?.name || "";
  let prompt = routine?.prompt || "";
  let scheduleKind: "daily" | "weekly" | "interval" = routine?.scheduleKind || "daily";
  let time = routine?.time || "09:00";
  const selectedDays = new Set<number>(Array.isArray(routine?.daysOfWeek) ? routine!.daysOfWeek! : []);

  // Interval: split the stored minutes into a value + unit (hour/minute).
  const initialInterval = Number(routine?.intervalMinutes) || 0;
  let intervalUnit: "hour" | "minute" = "hour";
  let intervalValue = 1;
  if (initialInterval > 0 && initialInterval % 60 === 0) {
    intervalUnit = "hour";
    intervalValue = initialInterval / 60;
  } else if (initialInterval > 0) {
    intervalUnit = "minute";
    intervalValue = initialInterval;
  }

  let errorMessage = "";
  let promptInvalid = false;
  let daysInvalid = false;
  let intervalInvalid = false;
  let busy = false;
  let saveLabel = "저장";
  let promptEl: HTMLTextAreaElement;
  let daysWrapEl: HTMLDivElement;
  let intervalEl: HTMLInputElement;

  // Toggle aria-invalid imperatively: the role="group" element triggers a
  // (correct in general, wrong here) svelte a11y warning if bound in markup, but
  // the carried-over CSS still keys its error border off [aria-invalid="true"].
  function ariaInvalid(node: HTMLElement, invalid: boolean) {
    const apply = (v: boolean) => (v ? node.setAttribute("aria-invalid", "true") : node.removeAttribute("aria-invalid"));
    apply(invalid);
    return { update: apply };
  }

  $: dayList = [...selectedDays];

  function toggleDay(idx: number) {
    if (selectedDays.has(idx)) selectedDays.delete(idx);
    else selectedDays.add(idx);
    // Reassign to trigger reactivity on the derived list.
    dayList = [...selectedDays];
    daysInvalid = false;
  }

  function intervalMinutesFromInputs(): number {
    const n = Math.floor(Number(intervalValue) || 0);
    return intervalUnit === "hour" ? n * 60 : n;
  }

  function schedulePayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { scheduleKind };
    if (scheduleKind === "daily" || scheduleKind === "weekly") payload.time = time;
    if (scheduleKind === "weekly") payload.daysOfWeek = [...selectedDays].sort((a, b) => a - b);
    if (scheduleKind === "interval") payload.intervalMinutes = intervalMinutesFromInputs();
    return payload;
  }

  // Returns null if valid, or an error string + sets the relevant invalid flag.
  function validateSchedule(): string | null {
    daysInvalid = false;
    intervalInvalid = false;
    if (scheduleKind === "weekly" && selectedDays.size === 0) {
      daysInvalid = true;
      return "매주 반복은 요일을 1개 이상 선택해 주세요.";
    }
    if (scheduleKind === "interval" && intervalMinutesFromInputs() < 5) {
      intervalInvalid = true;
      return "반복 간격은 5분 이상이어야 합니다.";
    }
    return null;
  }

  function canClose(): boolean {
    return !busy;
  }

  function requestClose() {
    if (canClose()) dispatch("close");
  }

  async function submit() {
    if (!prompt.trim()) {
      errorMessage = "작업 프롬프트를 입력해 주세요.";
      promptInvalid = true;
      promptEl?.focus();
      return;
    }
    promptInvalid = false;
    const schedErr = validateSchedule();
    if (schedErr) {
      errorMessage = schedErr;
      if (daysInvalid) daysWrapEl?.querySelector<HTMLButtonElement>("button")?.focus();
      else if (intervalInvalid) intervalEl?.focus();
      return;
    }
    errorMessage = "";
    busy = true;
    saveLabel = "저장 중…";
    try {
      const payload = {
        name: name.trim() || null,
        prompt,
        ...schedulePayload(),
      };
      if (isEdit && routine) {
        await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/me/routines", { method: "POST", body: JSON.stringify(payload) });
      }
      try {
        await loadRoutinesData();
      } catch (err) {
        busy = false;
        dispatch("close");
        notify(`루틴은 저장했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
        return;
      }
      busy = false;
      dispatch("saved");
      dispatch("close");
      notify(isEdit ? "루틴을 수정했습니다." : "루틴을 추가했습니다.", "ok");
    } catch (err) {
      errorMessage = (err as Error).message || "저장에 실패했습니다.";
      saveLabel = "저장";
      busy = false;
    }
  }

  async function runNowClick() {
    if (!routine) return;
    busy = true;
    try {
      dispatch("runNow", { routine });
      busy = false;
      dispatch("close");
    } catch (err) {
      notify(`루틴 실행 실패: ${(err as Error).message}`);
      busy = false;
    }
  }

  async function deleteClick() {
    if (!routine) return;
    if (!window.confirm("이 루틴을 삭제할까요? 지난 실행 결과 기록은 더 이상 표시되지 않습니다.")) return;
    busy = true;
    try {
      await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
      busy = false;
      dispatch("deleted", { routine });
      dispatch("close");
      notify("루틴을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`);
      busy = false;
    }
  }
</script>

<Modal cardClass="routine-modal-card" ariaLabelledby="routine-modal-title" closeOnBackdrop={false} on:close={requestClose}>
  <h2 id="routine-modal-title">{isEdit ? "루틴 편집" : "루틴 추가"}</h2>
  <form class="routine-modal-form" aria-busy={busy} on:submit|preventDefault={submit}>
    <label class="field">
      <span>이름 (선택)</span>
      <input type="text" placeholder="예: 아침 서비스 점검" aria-label="루틴 이름" disabled={busy} bind:value={name} />
    </label>

    <label class="field">
      <span>작업 프롬프트</span>
      <textarea
        rows="4"
        placeholder="예: 오늘의 서비스 상태를 요약해줘"
        aria-label="작업 프롬프트"
        aria-invalid={promptInvalid ? "true" : undefined}
        disabled={busy}
        bind:this={promptEl}
        bind:value={prompt}
        on:input={() => (promptInvalid = false)}
      ></textarea>
    </label>

    <div class="routine-preview-wrap">
      <span class="field-hint muted">미리보기</span>
      {#if prompt.trim()}
        <div class="routine-prompt-preview md" use:enhanceMarkdown={prompt}>{@html renderMarkdown(prompt)}</div>
      {:else}
        <div class="routine-prompt-preview md"><span class="muted">프롬프트 미리보기가 여기에 표시됩니다.</span></div>
      {/if}
    </div>

    <div class="schedule-builder">
      <div class="schedule-row">
        <label class="schedule-label" for="routine-kind">주기</label>
        <select id="routine-kind" aria-label="주기" disabled={busy} bind:value={scheduleKind}>
          <option value="daily">매일</option>
          <option value="weekly">매주</option>
          <option value="interval">간격</option>
        </select>
      </div>

      {#if scheduleKind !== "interval"}
        <div class="schedule-row">
          <span class="schedule-label">시각</span>
          <input type="time" aria-label="실행 시각" disabled={busy} bind:value={time} />
        </div>
      {/if}

      {#if scheduleKind === "weekly"}
        <div class="schedule-row">
          <span class="schedule-label">요일</span>
          <div class="weekday-chips" role="group" aria-label="반복 요일" use:ariaInvalid={daysInvalid} bind:this={daysWrapEl}>
            {#each WEEKDAY_NAMES as label, idx}
              {@const on = dayList.includes(idx)}
              <button
                type="button"
                class={`weekday-chip ${on ? "selected" : ""}`}
                aria-label={label}
                aria-pressed={on ? "true" : "false"}
                disabled={busy}
                on:click={() => toggleDay(idx)}>{label}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#if scheduleKind === "interval"}
        <div class="schedule-row">
          <span class="schedule-label">반복 간격</span>
          <div class="interval-inputs">
            <input
              type="number"
              min="1"
              step="1"
              class="narrow"
              aria-label="반복 간격 값"
              aria-invalid={intervalInvalid ? "true" : undefined}
              disabled={busy}
              bind:this={intervalEl}
              bind:value={intervalValue}
              on:input={() => (intervalInvalid = false)} />
            <select class="narrow" aria-label="반복 간격 단위" disabled={busy} bind:value={intervalUnit} on:change={() => (intervalInvalid = false)}>
              <option value="hour">시간</option>
              <option value="minute">분</option>
            </select>
          </div>
        </div>
      {/if}
    </div>

    {#if errorMessage}
      <div class="error" role="alert">{errorMessage}</div>
    {/if}

    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        {#if isEdit}
          <button class="ghost-sm" type="button" disabled={busy} on:click={runNowClick}>지금 실행</button>
          <button class="ghost-sm danger" type="button" disabled={busy} on:click={deleteClick}>삭제</button>
        {/if}
      </div>
      <div class="routine-modal-actions-right">
        <button class="ghost-sm" type="button" disabled={busy} on:click={requestClose}>닫기</button>
        <button class="primary" type="submit" disabled={busy}>{saveLabel}</button>
      </div>
    </div>
  </form>
</Modal>
