<script lang="ts">
  // Centered create/edit modal for a routine. `routine === null` = create mode.
  // Mirrors the old openRoutineModal()/buildScheduleForm(): markdown prompt
  // preview, once/daily/weekly/interval schedule builder with validation, plus
  // run-now/delete actions in edit mode.
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { enhanceMarkdown } from "../lib/dom";
  import { formatRoutineSchedule, renderMarkdown, WEEKDAY_NAMES } from "../lib/format";
  import { loadRoutinesData } from "../lib/loaders";
  import { notify } from "../lib/state";
  import type { RoutineJob, RoutinePreset } from "../lib/types";

  export let routine: RoutineJob | null = null;
  /**
   * Create-mode seed (from the empty-state starter cards). Only consulted when
   * `routine` is null — an edit always wins over a preset.
   */
  export let preset: RoutinePreset | null = null;

  const dispatch = createEventDispatcher<{ close: void; saved: void; runNow: { routine: RoutineJob }; deleted: { routine: RoutineJob } }>();
  const isEdit = Boolean(routine);
  const seed = isEdit ? null : preset;

  let name = routine?.name || seed?.name || "";
  let prompt = routine?.prompt || seed?.prompt || "";
  let scheduleKind: RoutineJob["scheduleKind"] = routine?.scheduleKind || seed?.scheduleKind || "daily";
  let time = routine?.time || seed?.time || "09:00";
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  function kstDateString(offsetDays = 0): string {
    const shifted = new Date(Date.now() + KST_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
  function validWallTime(wallTime: string): boolean {
    const match = /^(\d{2}):(\d{2})$/.exec(wallTime);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  }
  function onceRunTimestamp(date: string, wallTime: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validWallTime(wallTime)) return null;
    const timestamp = Date.parse(`${date}T${wallTime}:00+09:00`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const todayKst = kstDateString();
  let runDate = routine?.runDate || kstDateString(1);
  const initialDays = Array.isArray(routine?.daysOfWeek) ? routine!.daysOfWeek! : seed?.daysOfWeek;
  const selectedDays = new Set<number>(Array.isArray(initialDays) ? initialDays : []);

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
  let dateInvalid = false;
  let busy = false;
  let routineStatus = "";
  let promptEl: HTMLTextAreaElement;
  let daysWrapEl: HTMLDivElement;
  let intervalEl: HTMLInputElement;
  let dateEl: HTMLInputElement;
  const descId = "routine-modal-desc";
  const statusId = "routine-modal-status";
  const errorId = "routine-modal-error";

  const initialName = routine?.name || "";
  const initialPrompt = routine?.prompt || "";
  const initialScheduleKind = routine?.scheduleKind || "daily";
  const initialTime = routine?.time || "09:00";
  const initialRunDate = routine?.runDate || runDate;
  const initialDayKey = [...selectedDays].sort((a, b) => a - b).join(",");
  const initialScheduleKey = [
    initialScheduleKind,
    initialScheduleKind === "interval" ? initialInterval : initialTime,
    initialScheduleKind === "weekly" ? initialDayKey : "",
    initialScheduleKind === "once" ? initialRunDate : "",
  ].join("|");

  // Toggle aria-invalid imperatively: the role="group" element triggers a
  // (correct in general, wrong here) svelte a11y warning if bound in markup, but
  // the carried-over CSS still keys its error border off [aria-invalid="true"].
  function ariaInvalid(node: HTMLElement, invalid: boolean) {
    const apply = (v: boolean) => (v ? node.setAttribute("aria-invalid", "true") : node.removeAttribute("aria-invalid"));
    apply(invalid);
    return { update: apply };
  }

  $: dayList = [...selectedDays];
  $: promptTrimmed = prompt.trim();
  $: nameTrimmed = name.trim();
  $: intervalMinutes = (intervalUnit === "hour" ? 60 : 1) * Math.floor(Number(intervalValue) || 0);
  $: dayKey = [...dayList].sort((a, b) => a - b).join(",");
  $: currentScheduleKey = [
    scheduleKind,
    scheduleKind === "interval" ? intervalMinutes : time,
    scheduleKind === "weekly" ? dayKey : "",
    scheduleKind === "once" ? runDate : "",
  ].join("|");
  $: scheduleDirty = currentScheduleKey !== initialScheduleKey;
  $: onceTimestamp = onceRunTimestamp(runDate, time);
  $: timeReady = validWallTime(time);
  $: scheduleReady = scheduleKind === "weekly"
    ? dayList.length > 0 && timeReady
    : scheduleKind === "interval"
      ? intervalMinutes >= 5
      : scheduleKind === "once"
        ? Boolean(runDate && timeReady && ((onceTimestamp ?? 0) > Date.now() || (isEdit && !scheduleDirty)))
        : timeReady;
  // Plain-language echo of the schedule under construction, so the user can
  // confirm intent ("매주 금 18:00") without mentally re-assembling four inputs.
  $: schedulePreview = scheduleReady
    ? formatRoutineSchedule({
        scheduleKind,
        time,
        daysOfWeek: [...dayList].sort((a, b) => a - b),
        intervalMinutes,
        runDate,
      })
    : "";
  $: routineDirty = !isEdit || nameTrimmed !== initialName || prompt !== initialPrompt || scheduleDirty;
  $: routineCanSave = Boolean(!busy && promptTrimmed && scheduleReady && routineDirty);
  $: saveButtonLabel = busy ? "저장 중…" : isEdit ? "저장" : "예약 작업 추가";
  $: {
    if (busy) routineStatus = "저장 중…";
    else if (!promptTrimmed) routineStatus = "작업 프롬프트를 입력해 주세요.";
    else if (scheduleKind === "weekly" && !dayList.length) routineStatus = "매주 반복할 요일을 선택해 주세요.";
    else if (scheduleKind === "interval" && intervalMinutes < 5) routineStatus = "반복 간격은 5분 이상이어야 합니다.";
    else if (scheduleKind === "once" && !runDate) routineStatus = "실행 날짜를 선택해 주세요.";
    else if (!timeReady) routineStatus = "실행 시각을 입력해 주세요.";
    else if (
      scheduleKind === "once" &&
      (onceTimestamp ?? 0) <= Date.now() &&
      (!isEdit || scheduleDirty)
    ) routineStatus = "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.";
    else if (isEdit && !routineDirty) routineStatus = "저장됨";
    else routineStatus = "저장할 준비가 됐습니다.";
  }
  $: fieldDescribedBy = errorMessage ? `${statusId} ${errorId}` : statusId;

  function toggleDay(idx: number) {
    if (selectedDays.has(idx)) selectedDays.delete(idx);
    else selectedDays.add(idx);
    // Reassign to trigger reactivity on the derived list.
    dayList = [...selectedDays];
    daysInvalid = false;
    if (errorMessage === "매주 반복은 요일을 1개 이상 선택해 주세요.") errorMessage = "";
  }

  function onScheduleKindChange(): void {
    daysInvalid = false;
    intervalInvalid = false;
    dateInvalid = false;
    errorMessage = "";
  }

  // How often a routine fires is the decision this modal is really about, so it
  // gets a visible segmented control rather than a collapsed <select> whose
  // options you have to open to even know exist.
  const SCHEDULE_KINDS: { id: RoutineJob["scheduleKind"]; label: string }[] = [
    { id: "once", label: "한 번만" },
    { id: "daily", label: "매일" },
    { id: "weekly", label: "매주" },
    { id: "interval", label: "간격" },
  ];

  function pickKind(id: RoutineJob["scheduleKind"]): void {
    scheduleKind = id;
    onScheduleKindChange();
  }

  function onKindKeydown(event: KeyboardEvent, currentId: RoutineJob["scheduleKind"]): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = SCHEDULE_KINDS.findIndex((k) => k.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? SCHEDULE_KINDS.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + SCHEDULE_KINDS.length) % SCHEDULE_KINDS.length;
    const next = SCHEDULE_KINDS[nextIndex].id;
    pickKind(next);
    requestAnimationFrame(() => document.getElementById(`routine-kind-${next}`)?.focus());
  }

  function clearDateError(): void {
    dateInvalid = false;
    if (
      errorMessage === "실행 날짜를 선택해 주세요." ||
      errorMessage === "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다."
    ) {
      errorMessage = "";
    }
  }

  function clearTimeError(): void {
    if (scheduleKind === "once") dateInvalid = false;
    if (
      errorMessage === "실행 시각을 입력해 주세요." ||
      errorMessage === "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다."
    ) {
      errorMessage = "";
    }
  }

  function clearIntervalError(): void {
    intervalInvalid = false;
    if (errorMessage === "반복 간격은 5분 이상이어야 합니다.") errorMessage = "";
  }

  function intervalMinutesFromInputs(): number {
    return intervalMinutes;
  }

  function schedulePayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { scheduleKind };
    if (scheduleKind === "once") payload.date = runDate;
    if (scheduleKind === "once" || scheduleKind === "daily" || scheduleKind === "weekly") payload.time = time;
    if (scheduleKind === "weekly") payload.daysOfWeek = [...selectedDays].sort((a, b) => a - b);
    if (scheduleKind === "interval") payload.intervalMinutes = intervalMinutesFromInputs();
    return payload;
  }

  // Returns null if valid, or an error string + sets the relevant invalid flag.
  function validateSchedule(): string | null {
    daysInvalid = false;
    intervalInvalid = false;
    dateInvalid = false;
    if (scheduleKind === "once" && !runDate) {
      dateInvalid = true;
      return "실행 날짜를 선택해 주세요.";
    }
    if (scheduleKind !== "interval" && !timeReady) {
      return "실행 시각을 입력해 주세요.";
    }
    if (
      scheduleKind === "once" &&
      (onceTimestamp ?? 0) <= Date.now() &&
      (!isEdit || scheduleDirty)
    ) {
      dateInvalid = true;
      return "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.";
    }
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
    if (busy) return;
    if (!promptTrimmed) {
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
      else if (dateInvalid) dateEl?.focus();
      return;
    }
    if (!routineDirty) return;
    errorMessage = "";
    busy = true;
    try {
      const payload: Record<string, unknown> = {
        name: nameTrimmed || null,
        prompt,
      };
      if (!isEdit || scheduleDirty) Object.assign(payload, schedulePayload());
      // Editing the date of a completed one-time task is an explicit reschedule.
      // Reactivate it in the same save instead of requiring a second toggle.
      if (isEdit && routine?.completedAt && scheduleDirty) payload.enabled = true;
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
        notify(`예약 작업은 저장했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
        return;
      }
      busy = false;
      dispatch("saved");
      dispatch("close");
      notify(isEdit ? "예약 작업을 수정했습니다." : "예약 작업을 추가했습니다.", "ok");
    } catch (err) {
      errorMessage = (err as Error).message || "저장에 실패했습니다.";
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
      notify(`예약 작업 실행 실패: ${(err as Error).message}`);
      busy = false;
    }
  }

  async function deleteClick() {
    if (!routine) return;
    if (!(await confirmAction("이 예약 작업을 삭제할까요? 지난 실행 결과 기록은 더 이상 표시되지 않습니다."))) return;
    busy = true;
    try {
      await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
      busy = false;
      dispatch("deleted", { routine });
      dispatch("close");
      notify("예약 작업을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`);
      busy = false;
    }
  }
</script>

<Modal
  cardClass="routine-modal-card"
  ariaLabelledby="routine-modal-title"
  ariaDescribedby={descId}
  closeOnBackdrop={false}
  closeDisabled={busy}
  on:close={requestClose}
>
  <h2 id="routine-modal-title">{isEdit ? "예약 작업 편집" : "예약 작업 추가"}</h2>
  <p class="sr-only" id={descId}>예약 작업 이름, 작업 프롬프트, 실행 날짜 또는 반복 주기를 설정합니다. 저장 중에는 닫을 수 없습니다.</p>
  <form class="routine-modal-form" aria-busy={busy} on:submit|preventDefault={submit}>
    <label class="field">
      <span>이름 (선택)</span>
      <input type="text" placeholder="예: 아침 서비스 점검" aria-label="예약 작업 이름" disabled={busy} bind:value={name} />
    </label>

    <label class="field">
      <span>작업 프롬프트</span>
      <textarea
        rows="4"
        placeholder="예: 오늘의 서비스 상태를 요약해줘"
        aria-label="작업 프롬프트"
        aria-describedby={fieldDescribedBy}
        aria-invalid={promptInvalid ? "true" : undefined}
        disabled={busy}
        bind:this={promptEl}
        bind:value={prompt}
        on:input={() => { promptInvalid = false; if (errorMessage === "작업 프롬프트를 입력해 주세요.") errorMessage = ""; }}
      ></textarea>
    </label>

    <!-- Markdown preview only exists once there's markdown to preview, and stays
         folded: an always-open empty box doubled the modal's height for nothing. -->
    {#if promptTrimmed}
      <details class="routine-preview-wrap">
        <summary class="routine-preview-head">미리보기</summary>
        <div class="routine-prompt-preview md" use:enhanceMarkdown={prompt}>{@html renderMarkdown(prompt)}</div>
      </details>
    {/if}

    <div class="schedule-builder">
      <div class="schedule-row kinds">
        <span class="schedule-label" id="routine-kind-label">실행 방식</span>
        <div class="schedule-kinds seg-control" role="radiogroup" aria-labelledby="routine-kind-label">
          {#each SCHEDULE_KINDS as k}
            {@const on = scheduleKind === k.id}
            <button
              id={`routine-kind-${k.id}`}
              class="seg-btn"
              class:active={on}
              type="button"
              role="radio"
              aria-checked={on ? "true" : "false"}
              tabindex={on ? 0 : -1}
              disabled={busy}
              on:click={() => pickKind(k.id)}
              on:keydown={(event) => onKindKeydown(event, k.id)}>{k.label}</button>
          {/each}
        </div>
      </div>

      {#if scheduleKind === "once"}
        <div class="schedule-row">
          <span class="schedule-label">실행 날짜</span>
          <input
            type="date"
            min={todayKst}
            aria-label="실행 날짜"
            aria-describedby={fieldDescribedBy}
            aria-invalid={dateInvalid ? "true" : undefined}
            disabled={busy}
            bind:this={dateEl}
            bind:value={runDate}
            on:input={clearDateError} />
        </div>
      {/if}

      {#if scheduleKind !== "interval"}
        <div class="schedule-row">
          <span class="schedule-label">시각</span>
          <input type="time" aria-label="실행 시각" disabled={busy} bind:value={time} on:input={clearTimeError} />
        </div>
      {/if}

      {#if scheduleKind === "weekly"}
        <div class="schedule-row">
          <span class="schedule-label">요일</span>
          <div class="weekday-chips" role="group" aria-label="반복 요일" aria-describedby={fieldDescribedBy} use:ariaInvalid={daysInvalid} bind:this={daysWrapEl}>
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
              aria-describedby={fieldDescribedBy}
              aria-invalid={intervalInvalid ? "true" : undefined}
              disabled={busy}
              bind:this={intervalEl}
              bind:value={intervalValue}
              on:input={clearIntervalError} />
            <select class="narrow" aria-label="반복 간격 단위" disabled={busy} bind:value={intervalUnit} on:change={clearIntervalError}>
              <option value="hour">시간</option>
              <option value="minute">분</option>
            </select>
          </div>
        </div>
      {/if}

      {#if schedulePreview}
        <p class="schedule-echo">이렇게 실행돼요 — <strong>{schedulePreview}</strong></p>
      {/if}
    </div>

    {#if errorMessage}
      <div class="error" id={errorId} role="alert">{errorMessage}</div>
    {/if}

    <div
      class="routine-form-status"
      id={statusId}
      class:invalid={!busy && (!promptTrimmed || !scheduleReady)}
      class:dirty={!busy && routineDirty && Boolean(promptTrimmed) && scheduleReady}
      role="status"
    >{routineStatus}</div>

    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        {#if isEdit}
          {#if !routine?.completedAt}
            <button class="ghost-sm" type="button" disabled={busy} on:click={runNowClick}>지금 실행</button>
          {/if}
          <button class="ghost-sm danger" type="button" disabled={busy} on:click={deleteClick}>삭제</button>
        {/if}
      </div>
      <div class="routine-modal-actions-right">
        <button class="ghost-sm" type="button" disabled={busy} on:click={requestClose}>닫기</button>
        <button class="primary" type="submit" disabled={!routineCanSave}>{saveButtonLabel}</button>
      </div>
    </div>
  </form>
</Modal>
