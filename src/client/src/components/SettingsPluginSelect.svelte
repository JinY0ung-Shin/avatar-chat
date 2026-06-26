<script context="module" lang="ts">
  let nextPluginSelectId = 0;
</script>

<script lang="ts">
  // Shared plugin-selection contents (per-plugin checkboxes). Ports
  // renderPluginSelectionContents from settings/plugins.js. Used by plugin,
  // personal knowledge repo, and group knowledge repo selectors — identical
  // DOM/behavior, differing only in selection source + save destination.
  import { notify } from "../lib/state";
  import type { RepoPluginContents } from "../lib/types";

  export let info: RepoPluginContents;
  /** Current selection: array of names, or null = "load all". */
  export let selected: string[] | null;
  export let headText: string;
  /** Persist the chosen selection (null = load all). Should reject on failure. */
  export let onSave: (selected: string[] | null) => Promise<void>;

  let saving = false;
  let saved = false;
  let error = "";
  const pluginSelectId = `plugin-select-${++nextPluginSelectId}`;

  $: loadableNames = info.kind === "marketplace" ? info.plugins.filter((p) => p.loadable).map((p) => p.name) : [];
  $: selectedKey = selectionKey(selected);
  $: infoKey = `${info.kind}:${info.plugins.map((p) => `${p.name}:${p.loadable ? "1" : "0"}`).join("|")}`;

  // Per-row checked state, seeded from the current selection (null = all on).
  let checks: Record<string, boolean> = {};
  let seededFor = "";
  $: if (`${infoKey}:${selectedKey}` !== seededFor) {
    seededFor = `${infoKey}:${selectedKey}`;
    checks = checksFromSelection(selected);
    error = "";
  }

  function selectionKey(value: string[] | null): string {
    return value ? [...value].sort().join("\u001f") : "__all__";
  }

  function checksFromSelection(value: string[] | null): Record<string, boolean> {
    const source = value ? new Set(value) : null;
    const next: Record<string, boolean> = {};
    for (const entry of info.plugins) {
      next[entry.name] = entry.loadable && (!source || source.has(entry.name));
    }
    return next;
  }

  function normalizedSelection(): string[] | null {
    const chosen = info.plugins.filter((e) => e.loadable && checks[e.name]).map((e) => e.name);
    // All (or none) selected -> null = "load all".
    return chosen.length === 0 || chosen.length === loadableNames.length ? null : chosen;
  }

  $: chosenCount = info.plugins.filter((e) => e.loadable && checks[e.name]).length;
  $: nextSelection = normalizedSelection();
  $: dirty = selectionKey(nextSelection) !== selectedKey;
  $: allLoadableChecked = Boolean(loadableNames.length) && chosenCount === loadableNames.length;
  $: canSave = Boolean(loadableNames.length && dirty && !saving);
  $: summary = !loadableNames.length
    ? "로드 가능한 플러그인이 없습니다."
    : chosenCount === 0
      ? `선택된 항목이 없습니다. 저장하면 로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
      : chosenCount === loadableNames.length
        ? `로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
        : `${chosenCount}개만 사용하도록 저장됩니다.`;
  $: saveStatus = saving
    ? "저장 중입니다."
    : error
      ? `저장 실패: ${error}`
    : saved && !dirty
      ? "저장되었습니다."
      : dirty
        ? "저장하지 않은 선택 변경이 있습니다."
      : "저장된 선택과 같습니다.";
  $: saveLabel = saving ? "저장 중…" : saved && !dirty ? "저장됨 ✓" : dirty ? "선택 저장" : "변경 없음";

  function useAll(): void {
    const next = { ...checks };
    for (const name of loadableNames) next[name] = true;
    checks = next;
    saved = false;
    error = "";
  }

  function restoreSelection(): void {
    checks = checksFromSelection(selected);
    saved = false;
    error = "";
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    saving = true;
    error = "";
    try {
      await onSave(nextSelection);
      notify("플러그인 선택을 저장했습니다.", "ok");
      saved = true;
      setTimeout(() => (saved = false), 1200);
    } catch (err) {
      error = (err as Error).message;
      notify(`저장 실패: ${error}`, "warn");
    } finally {
      saving = false;
    }
  }
</script>

{#if info.kind === "none"}
  <div class="error-note" role="alert">Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음).</div>
{:else if info.kind === "single"}
  <div class="muted">단일 플러그인 저장소입니다 — 선택할 항목이 없습니다.</div>
{:else if !info.plugins.length}
  <div class="muted">불러올 수 있는 플러그인이 없습니다.</div>
{:else}
  <div class="pc-head-row">
    <div class="pc-head muted" id={`${pluginSelectId}-head`}>{headText}</div>
    {#if loadableNames.length}
      <div class="pc-toolbar" role="group" aria-label="플러그인 선택 빠른 작업">
        <button class="linkish small" type="button" disabled={saving || allLoadableChecked} on:click={useAll}>전체 사용</button>
        <button class="linkish small" type="button" disabled={saving || !dirty} on:click={restoreSelection}>저장값 복원</button>
      </div>
    {/if}
  </div>
  <div class="pc-list" role="group" aria-labelledby={`${pluginSelectId}-head`} aria-describedby={`${pluginSelectId}-summary`}>
    {#each info.plugins as entry (entry.name)}
      <label class={`pc-item ${entry.loadable ? "" : "disabled"}`}>
        <input type="checkbox" bind:checked={checks[entry.name]} disabled={!entry.loadable || saving} />
        <span>{entry.loadable ? entry.name : `${entry.name} (로드 불가)`}</span>
      </label>
    {/each}
  </div>
  <div class="pc-summary muted" id={`${pluginSelectId}-summary`} role="status" aria-live="polite">{summary}</div>
  {#if loadableNames.length}
    <div class="pc-actions">
      <span class:dirty class:invalid={Boolean(error)} class="pc-save-status" role="status" aria-live="polite">{saveStatus}</span>
      <button class="primary small" type="button" disabled={!canSave} on:click={save}>
        {saveLabel}
      </button>
    </div>
  {/if}
{/if}
