<script lang="ts">
  // The routines tab is the single home for routines: a two-panel workspace whose
  // left side MANAGES them (add/edit/toggle/run/delete + filter/search) and whose
  // right side shows the selected routine's per-run result transcript. Mirrors the
  // old routines.js renderRoutinesView()/buildRoutineManagePanel()/buildRoutineResultPanel().
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import Toggle from "../components/Toggle.svelte";
  import RoutineModal from "../components/RoutineModal.svelte";
  import RoutineRunBlock from "../components/RoutineRunBlock.svelte";
  import { api } from "../lib/api";
  import { enhanceMarkdown } from "../lib/dom";
  import { formatRoutineSchedule, renderMarkdown, routineTitle, timeLabel } from "../lib/format";
  import { loadConversations, loadRoutineMessages, loadRoutinesData, refreshNotificationStatus } from "../lib/loaders";
  import { selectConversation } from "../lib/chat";
  import { appState, notify, readState, replaceState, updateState } from "../lib/state";
  import type { RoutineJob, StoredMessage } from "../lib/types";

  type FilterId = "all" | "enabled" | "paused" | "error";

  const FILTER_DEFS: { id: FilterId; label: string; match: (r: RoutineJob) => boolean }[] = [
    { id: "all", label: "전체", match: () => true },
    { id: "enabled", label: "사용 중", match: (r) => r.enabled },
    { id: "paused", label: "일시 정지", match: (r) => !r.enabled },
    { id: "error", label: "실패", match: (r) => r.lastStatus === "error" },
  ];

  let loading = true;
  let error = "";
  let messageLoadError = "";
  let modalRoutine: RoutineJob | null = null;
  let modalOpen = false;
  let busyRoutineId = "";

  onMount(load);

  $: routines = $appState.routines;
  $: filterId = (FILTER_DEFS.some((f) => f.id === $appState.routineFilter) ? $appState.routineFilter : "all") as FilterId;
  $: activeFilter = FILTER_DEFS.find((f) => f.id === filterId) ?? FILTER_DEFS[0];
  $: query = $appState.routineSearch.trim().toLowerCase();
  $: filteredByTab = routines.filter(activeFilter.match);
  $: filtered = query
    ? filteredByTab.filter((r) => {
        const haystack = [
          routineTitle(r),
          r.prompt || "",
          formatRoutineSchedule(r),
          r.enabled ? "사용 중" : "일시 정지",
          r.lastStatus === "error" ? "실패" : "완료",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : filteredByTab;
  $: countLabel = filtered.length === routines.length ? `총 ${routines.length}개` : `표시 ${filtered.length}개 / 전체 ${routines.length}개`;
  $: filterLabel = (id: FilterId) => FILTER_DEFS.find((f) => f.id === id)?.label || "전체";

  $: selectedConv = $appState.routineConversations.find((c) => c.id === $appState.routineConversationId) || null;
  $: selectedRoutine = selectedConv ? routines.find((r) => r.conversationId === selectedConv.id) || null : null;
  $: currentPrompt = (selectedRoutine?.prompt || "").trim();
  $: runs = groupRoutineRuns($appState.routineMessages);

  async function load() {
    loading = true;
    error = "";
    messageLoadError = "";
    try {
      await loadRoutinesData();
    } catch (err) {
      error = (err as Error).message || "네트워크 오류";
      loading = false;
      return;
    }
    // Pin a sensible selection: keep the current one if still present, else first.
    const convs = readState().routineConversations;
    let convId = readState().routineConversationId;
    if (convId && !convs.some((c) => c.id === convId)) convId = convs[0]?.id || "";
    else if (!convId && convs.length) convId = convs[0].id;
    updateState((state) => (state.routineConversationId = convId));
    if (convId) {
      try {
        await loadRoutineMessages(convId);
      } catch (err) {
        messageLoadError = (err as Error).message || "네트워크 오류";
        replaceState({ routineMessages: [] });
      }
    } else {
      replaceState({ routineMessages: [] });
    }
    loading = false;
  }

  function setFilter(id: FilterId) {
    updateState((state) => (state.routineFilter = id));
  }

  function filterCount(id: FilterId): number {
    const def = FILTER_DEFS.find((f) => f.id === id);
    return def ? routines.filter(def.match).length : 0;
  }

  function clearSearch() {
    updateState((state) => (state.routineSearch = ""));
  }

  function openModal(routine: RoutineJob | null) {
    modalRoutine = routine;
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false;
    modalRoutine = null;
  }

  // Group the alternating user/assistant transcript into runs: each user message
  // starts a new run; the assistant message(s) after belong to it.
  function groupRoutineRuns(messages: StoredMessage[]) {
    const out: { prompt: StoredMessage | null; responses: StoredMessage[]; at: string | null }[] = [];
    let current: { prompt: StoredMessage | null; responses: StoredMessage[]; at: string | null } | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        current = { prompt: m, responses: [], at: m.createdAt || null };
        out.push(current);
      } else {
        if (!current) {
          current = { prompt: null, responses: [], at: m.createdAt || null };
          out.push(current);
        }
        current.responses.push(m);
        if (m.createdAt) current.at = m.createdAt;
      }
    }
    return out;
  }

  async function selectResult(routine: RoutineJob) {
    const wasActive = $appState.routineConversationId === routine.conversationId;
    updateState((state) => (state.routineConversationId = routine.conversationId));
    messageLoadError = "";
    try {
      await loadRoutineMessages(routine.conversationId);
    } catch (err) {
      messageLoadError = (err as Error).message || "네트워크 오류";
      replaceState({ routineMessages: [] });
    }
    const title = routineTitle(routine);
    notify(wasActive ? `"${title}" 루틴 결과를 보고 있습니다.` : `"${title}" 루틴 결과를 표시했습니다.`, "info");
  }

  function onRowKeydown(event: KeyboardEvent, routine: RoutineJob) {
    if (busyRoutineId === routine.id) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void selectResult(routine);
    }
  }

  async function toggleRoutine(routine: RoutineJob, next: boolean) {
    const title = routineTitle(routine);
    try {
      await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
    } catch (err) {
      notify(`변경 실패: ${(err as Error).message}`);
      throw err;
    }
    try {
      await loadRoutinesData();
      notify(`"${title}" 루틴을 ${next ? "사용" : "일시 정지"}했습니다.`, "ok");
    } catch (err) {
      notify(`루틴 상태는 변경했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }

  async function runRoutineNow(routine: RoutineJob) {
    const res = await api<{ ok?: boolean; error?: string }>(`/api/me/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
    let refreshError: Error | null = null;
    try {
      await loadRoutinesData();
      // A run may have left the owner a notification — surface it immediately.
      await refreshNotificationStatus();
    } catch (err) {
      refreshError = err as Error;
    }
    if (res && res.ok === false) {
      notify(`루틴 실행 실패: ${res.error || "알 수 없는 오류"}`);
    } else if (refreshError) {
      notify(`루틴은 실행했지만 상태 새로고침에 실패했습니다: ${refreshError.message}`, "warn");
    } else {
      notify(`"${routineTitle(routine)}" 루틴을 실행했습니다.`, "ok");
    }
    // Jump straight to the result this run just produced.
    updateState((state) => (state.routineConversationId = routine.conversationId));
    messageLoadError = "";
    try {
      await loadRoutineMessages(routine.conversationId);
    } catch {
      replaceState({ routineMessages: [] });
    }
  }

  async function runFromButton(routine: RoutineJob) {
    busyRoutineId = routine.id;
    try {
      await runRoutineNow(routine);
    } catch (err) {
      notify(`루틴 실행 실패: ${(err as Error).message}`);
    } finally {
      busyRoutineId = "";
    }
  }

  function onModalSaved() {
    void load();
  }

  function onModalDeleted(event: CustomEvent<{ routine: RoutineJob }>) {
    const routine = event.detail.routine;
    replaceState({
      routines: readState().routines.filter((r) => r.id !== routine.id),
      routineConversations: readState().routineConversations.filter((c) => c.routineId !== routine.id),
    });
    if (readState().routineConversationId === routine.conversationId) {
      updateState((state) => (state.routineConversationId = ""));
      replaceState({ routineMessages: [] });
    }
    void load();
  }

  async function openAsConversation() {
    if (!selectedConv) return;
    await selectConversation(selectedConv.id);
  }
</script>

<header class="view-header">
  <div>
    <h1>루틴</h1>
    <p>아바타가 스스로 실행하는 예약 작업과 그 결과를 관리하세요</p>
  </div>
</header>

<div class="view-body routines-body">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      루틴 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    <div class="routine-workspace">
      <!-- ===== Left: manage panel ===== -->
      <div class="routine-side scroll-thin">
        <section class="settings-card routine-card">
          <div class="panel-section-head">
            <div>
              <h3>내 루틴</h3>
              <p class="muted">매일·매주 또는 일정 간격(KST)으로 아바타가 스스로 실행합니다. 카드를 누르면 결과가 오른쪽에 표시돼요.</p>
            </div>
            <button class="primary small routine-add-btn" type="button" on:click={() => openModal(null)}>
              <Icon name="plus" size={16} /><span>루틴 추가</span>
            </button>
          </div>

          <div class="routine-tools">
            <input
              class="routine-search"
              type="search"
              placeholder="루틴 검색"
              aria-label="루틴 검색"
              disabled={!routines.length}
              value={$appState.routineSearch}
              on:input={(event) => updateState((state) => (state.routineSearch = event.currentTarget.value))} />
            <span class="muted nowrap">{routines.length ? countLabel : "총 0개"}</span>
          </div>

          {#if routines.length}
            <div class="routine-filter seg-control" role="radiogroup" aria-label="루틴 필터">
              {#each FILTER_DEFS as f}
                {@const active = filterId === f.id}
                <button
                  class={`seg-btn ${active ? "active" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked={active ? "true" : "false"}
                  tabindex={active ? 0 : -1}
                  data-value={f.id}
                  on:click={() => setFilter(f.id)}>{f.label} {filterCount(f.id)}</button>
              {/each}
            </div>
          {/if}

          <div class="routine-manage-list">
            {#if !routines.length}
              <div class="empty-note">
                아직 등록한 루틴이 없습니다.{" "}
                <button class="linkish small" type="button" on:click={() => openModal(null)}>첫 루틴 추가</button>
              </div>
            {:else if !filtered.length}
              <div class="empty-note">
                {#if query}
                  "{$appState.routineSearch.trim()}"에 맞는 {filterId === "all" ? "루틴" : `${filterLabel(filterId)} 루틴`}이 없습니다.{" "}
                  <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
                {:else}
                  {filterLabel(filterId)} 루틴이 없습니다.{" "}
                {/if}
                {#if filterId !== "all"}
                  <button class="linkish small" type="button" on:click={() => setFilter("all")}>전체 루틴 보기</button>
                {/if}
              </div>
            {:else}
              {#each filtered as routine (routine.id)}
                {@const active = $appState.routineConversationId === routine.conversationId}
                {@const errored = routine.lastStatus === "error"}
                {@const dotClass = !routine.enabled ? "off" : errored ? "err" : "on"}
                {@const title = routineTitle(routine)}
                {@const rowLabel = active ? `선택된 루틴 결과: ${title}` : `루틴 결과 보기: ${title}`}
                <div
                  class={`routine-manage-row ${active ? "active" : ""} ${routine.enabled ? "" : "paused"}`}
                  role="button"
                  tabindex="0"
                  aria-pressed={active ? "true" : "false"}
                  aria-label={rowLabel}
                  aria-busy={busyRoutineId === routine.id ? "true" : undefined}
                  title={rowLabel}
                  on:click={() => {
                    if (busyRoutineId !== routine.id) void selectResult(routine);
                  }}
                  on:keydown={(event) => onRowKeydown(event, routine)}>
                  <div class="routine-manage-head">
                    <span class={`routine-dot ${dotClass}`} aria-hidden="true"></span>
                    <strong class="routine-manage-title">{title}</strong>
                    <Toggle
                      on={routine.enabled}
                      label={`루틴 사용: ${title}`}
                      onChange={(next) => toggleRoutine(routine, next)} />
                  </div>
                  <div class="routine-manage-meta">
                    {formatRoutineSchedule(routine)}{#if routine.enabled && routine.nextRunAt} · <span class="routine-next">다음 실행 {timeLabel(routine.nextRunAt)}</span>{/if} · {routine.lastRunAt
                      ? `최근 실행 ${timeLabel(routine.lastRunAt)} · ${errored ? "실패" : "완료"}`
                      : "아직 실행되지 않음"}
                  </div>
                  {#if errored && routine.lastError}
                    <div class="error-note">{routine.lastError}</div>
                  {/if}
                  <div class="routine-manage-actions">
                    <button class="ghost-sm" type="button" on:click|stopPropagation={() => openModal(routine)}>
                      <Icon name="edit" size={16} /><span>편집</span>
                    </button>
                    <button
                      class="ghost-sm"
                      type="button"
                      disabled={busyRoutineId === routine.id}
                      on:click|stopPropagation={() => runFromButton(routine)}>
                      {busyRoutineId === routine.id ? "실행 중…" : "지금 실행"}
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </section>
      </div>

      <!-- ===== Right: result panel ===== -->
      <section class="settings-card routine-result-card">
        <div class="panel-section-head">
          <div>
            <h3>{selectedConv?.title || "루틴 결과"}</h3>
            <p class="muted">
              {#if selectedConv}{selectedConv.avatarDisplayName} · {timeLabel(selectedConv.updatedAt)}{:else}루틴 실행 기록을 선택하세요.{/if}
            </p>
          </div>
          {#if selectedConv}
            <button class="ghost-sm" type="button" on:click={openAsConversation}>일반 대화로 열기</button>
          {/if}
        </div>

        {#if selectedRoutine}
          <div class="routine-result-prompt">
            <div class="routine-result-prompt-label muted">지시 프롬프트</div>
            {#if currentPrompt}
              <div class="routine-result-prompt-body md scroll-thin" use:enhanceMarkdown={currentPrompt}>{@html renderMarkdown(currentPrompt)}</div>
            {:else}
              <div class="routine-result-prompt-body md scroll-thin"><span class="muted">(프롬프트 없음)</span></div>
            {/if}
          </div>
        {/if}

        <div class="routine-result-transcript transcript scroll-thin">
          <div class="transcript-inner">
            {#if !selectedConv}
              {#if routines.length}
                <div class="empty-note">
                  아직 확인할 실행 결과가 없습니다. 바로 실행하거나 다음 예약 실행 후 결과가 표시됩니다.{" "}
                  <button class="linkish small" type="button" on:click={() => runFromButton(routines[0])}>첫 루틴 지금 실행</button>
                </div>
              {:else}
                <div class="empty-note">
                  아직 확인할 루틴 결과가 없습니다.{" "}
                  <button class="linkish small" type="button" on:click={() => openModal(null)}>첫 루틴 추가</button>
                </div>
              {/if}
            {:else if messageLoadError}
              <div class="warn-box">
                루틴 결과를 불러오지 못했습니다: {messageLoadError}
                <button class="linkish" type="button" on:click={load}>다시 시도</button>
              </div>
            {:else if !$appState.routineMessages.length}
              <div class="empty-note">
                아직 실행 메시지가 없습니다.{" "}
                {#if selectedRoutine}
                  <button class="linkish small" type="button" on:click={() => runFromButton(selectedRoutine)}>지금 다시 실행</button>
                {/if}
              </div>
            {:else}
              {#each runs as run, i (i)}
                {@const reverseIndex = runs.length - 1 - i}
                {@const r = runs[reverseIndex]}
                <RoutineRunBlock
                  run={r}
                  runNumber={reverseIndex + 1}
                  expanded={reverseIndex === runs.length - 1}
                  {currentPrompt}
                  onRun={selectedRoutine ? () => runFromButton(selectedRoutine) : null} />
              {/each}
            {/if}
          </div>
        </div>
      </section>
    </div>
  {/if}
</div>

{#if modalOpen}
  <RoutineModal
    routine={modalRoutine}
    on:close={closeModal}
    on:saved={onModalSaved}
    on:deleted={onModalDeleted}
    on:runNow={(event) => runFromButton(event.detail.routine)} />
{/if}
