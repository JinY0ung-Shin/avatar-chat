<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { loadRoutineMessages, loadRoutinesData } from "../lib/loaders";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { formatDate } from "../lib/format";
  import { renderMarkdown } from "../lib/format";
  import type { RoutineJob } from "../lib/types";

  let loading = true;
  let error = "";
  let editing: RoutineJob | null = null;
  let form = defaultForm();

  onMount(load);

  $: filtered = $appState.routines.filter((routine) => {
    const q = $appState.routineSearch.trim().toLowerCase();
    const matchesQuery = !q || [routine.name, routine.prompt].filter(Boolean).join(" ").toLowerCase().includes(q);
    const matchesFilter =
      $appState.routineFilter === "all" ||
      ($appState.routineFilter === "enabled" && routine.enabled) ||
      ($appState.routineFilter === "paused" && !routine.enabled) ||
      ($appState.routineFilter === "error" && routine.lastStatus === "error");
    return matchesQuery && matchesFilter;
  });
  $: selectedConversation = $appState.routineConversations.find((conv) => conv.id === $appState.routineConversationId) ?? $appState.routineConversations[0];
  $: if (selectedConversation && selectedConversation.id !== $appState.routineConversationId) {
    updateState((state) => (state.routineConversationId = selectedConversation.id));
    void loadRoutineMessages(selectedConversation.id);
  }

  function defaultForm() {
    return {
      name: "",
      prompt: "",
      scheduleKind: "daily",
      time: "09:00",
      daysOfWeek: [1, 2, 3, 4, 5],
      intervalMinutes: 60,
      enabled: true,
    };
  }

  async function load() {
    loading = true;
    error = "";
    try {
      await loadRoutinesData();
      const conv = $appState.routineConversationId || $appState.routineConversations[0]?.id;
      if (conv) await loadRoutineMessages(conv);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function edit(routine: RoutineJob | null) {
    editing = routine;
    form = routine
      ? {
          name: routine.name || "",
          prompt: routine.prompt,
          scheduleKind: routine.scheduleKind,
          time: routine.time,
          daysOfWeek: routine.daysOfWeek || [1],
          intervalMinutes: routine.intervalMinutes || 60,
          enabled: routine.enabled,
        }
      : defaultForm();
  }

  async function save() {
    const payload = {
      name: form.name || null,
      prompt: form.prompt,
      enabled: form.enabled,
      scheduleKind: form.scheduleKind,
      time: form.time,
      daysOfWeek: form.scheduleKind === "weekly" ? form.daysOfWeek : undefined,
      intervalMinutes: form.scheduleKind === "interval" ? Number(form.intervalMinutes) : undefined,
    };
    try {
      if (editing) {
        const { routine } = await api<{ routine: RoutineJob }>(`/api/me/routines/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        replaceState({ routines: $appState.routines.map((item) => (item.id === routine.id ? routine : item)) });
      } else {
        const { routine } = await api<{ routine: RoutineJob }>("/api/me/routines", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        replaceState({ routines: [routine, ...$appState.routines] });
      }
      edit(null);
      notify("루틴을 저장했습니다.", "ok");
      await loadRoutinesData();
    } catch (err) {
      notify(`루틴 저장 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function remove(routine: RoutineJob) {
    if (!window.confirm("루틴을 삭제할까요?")) return;
    await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
    replaceState({ routines: $appState.routines.filter((item) => item.id !== routine.id) });
  }

  async function toggle(routine: RoutineJob) {
    const { routine: next } = await api<{ routine: RoutineJob }>(`/api/me/routines/${encodeURIComponent(routine.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !routine.enabled }),
    });
    replaceState({ routines: $appState.routines.map((item) => (item.id === next.id ? next : item)) });
  }

  async function runNow(routine: RoutineJob) {
    const result = await api<{ ok: boolean; error?: string; routine: RoutineJob }>(`/api/me/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
    notify(result.ok ? "루틴을 실행했습니다." : `루틴 실행 실패: ${result.error || "오류"}`, result.ok ? "ok" : "warn");
    await loadRoutinesData();
    updateState((state) => (state.routineConversationId = routine.conversationId));
    await loadRoutineMessages(routine.conversationId);
  }

  function toggleDay(day: number) {
    form.daysOfWeek = form.daysOfWeek.includes(day) ? form.daysOfWeek.filter((item) => item !== day) : [...form.daysOfWeek, day].sort();
  }
</script>

<header class="view-header">
  <div>
    <h1>루틴</h1>
    <p>반복 확인 작업을 예약하고 결과를 쌓습니다</p>
  </div>
  <button class="primary" type="button" on:click={() => edit(null)}>새 루틴</button>
</header>

<div class="view-body scroll-thin routines-body">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      루틴 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    <section class="settings-card">
      <h3>{editing ? "루틴 수정" : "새 루틴"}</h3>
      <form class="settings-form" on:submit|preventDefault={save}>
        <div class="grid-2">
          <label class="field"><span>이름</span><input bind:value={form.name} placeholder="비우면 프롬프트에서 자동 제목" /></label>
          <label class="field checkbox-row"><input type="checkbox" bind:checked={form.enabled} /> 활성</label>
        </div>
        <label class="field"><span>프롬프트</span><textarea rows="4" bind:value={form.prompt} required></textarea></label>
        <div class="grid-3">
          <label class="field"><span>종류</span><select bind:value={form.scheduleKind}><option value="daily">매일</option><option value="weekly">매주</option><option value="interval">간격</option></select></label>
          {#if form.scheduleKind !== "interval"}
            <label class="field"><span>시간 (KST)</span><input type="time" bind:value={form.time} /></label>
          {:else}
            <label class="field"><span>간격(분)</span><input type="number" min="15" max="10080" bind:value={form.intervalMinutes} /></label>
          {/if}
        </div>
        {#if form.scheduleKind === "weekly"}
          <div class="weekday-row">
            {#each ["일", "월", "화", "수", "목", "금", "토"] as day, i}
              <button type="button" class:active={form.daysOfWeek.includes(i)} on:click={() => toggleDay(i)}>{day}</button>
            {/each}
          </div>
        {/if}
        <div class="button-row">
          <button class="primary" type="submit" disabled={!form.prompt}>저장</button>
          {#if editing}<button class="ghost-sm" type="button" on:click={() => edit(null)}>취소</button>{/if}
        </div>
      </form>
    </section>

    <section class="routines-layout">
      <div class="settings-card">
        <div class="field-row">
          <h3>예약 목록</h3>
          <input class="explore-search" type="search" placeholder="루틴 검색" value={$appState.routineSearch} on:input={(event) => updateState((state) => (state.routineSearch = event.currentTarget.value))} />
        </div>
        <div class="tabbar compact">
          {#each [
            { id: "all", label: "전체" },
            { id: "enabled", label: "활성" },
            { id: "paused", label: "일시정지" },
            { id: "error", label: "오류" },
          ] as item}
            <button type="button" class:active={$appState.routineFilter === item.id} on:click={() => updateState((state) => (state.routineFilter = item.id as any))}>{item.label}</button>
          {/each}
        </div>
        {#if !filtered.length}
          <div class="empty-note">조건에 맞는 루틴이 없습니다.</div>
        {:else}
          <div class="routine-list">
            {#each filtered as routine (routine.id)}
              <article class="routine-card">
                <div>
                  <strong>{routine.name || routine.prompt.slice(0, 40)}</strong>
                  <p>{routine.prompt}</p>
                  <div class="muted">
                    {routine.scheduleKind === "interval" ? `${routine.intervalMinutes}분마다` : `${routine.time} KST`}
                    {routine.nextRunAt ? ` · 다음 ${formatDate(routine.nextRunAt)}` : ""}
                  </div>
                  {#if routine.lastStatus === "error"}<div class="warn-text">{routine.lastError}</div>{/if}
                </div>
                <div class="button-row">
                  <button class="ghost-sm" type="button" on:click={() => runNow(routine)}><Icon name="play" />실행</button>
                  <button class="ghost-sm" type="button" on:click={() => toggle(routine)}>{routine.enabled ? "일시정지" : "활성화"}</button>
                  <button class="ghost-sm" type="button" on:click={() => edit(routine)}>수정</button>
                  <button class="danger small" type="button" on:click={() => remove(routine)}>삭제</button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>

      <div class="settings-card">
        <h3>실행 결과</h3>
        {#if !$appState.routineConversations.length}
          <div class="empty-note">아직 실행 결과가 없습니다.</div>
        {:else}
          <select value={$appState.routineConversationId} on:change={(event) => {
            updateState((state) => (state.routineConversationId = event.currentTarget.value));
            loadRoutineMessages(event.currentTarget.value);
          }}>
            {#each $appState.routineConversations as conv}
              <option value={conv.id}>{conv.title || conv.routinePrompt || conv.avatarDisplayName}</option>
            {/each}
          </select>
          <div class="routine-transcript">
            {#each $appState.routineMessages as message (message.id)}
              <div class={`message ${message.role}`}>
                <div class="bubble">
                  {#if message.role === "assistant"}
                    <div class="md">{@html renderMarkdown(message.response?.text || message.content)}</div>
                  {:else}
                    <p>{message.content}</p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {/if}
</div>
