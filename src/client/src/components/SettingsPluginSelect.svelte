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

  $: loadableNames = info.kind === "marketplace" ? info.plugins.filter((p) => p.loadable).map((p) => p.name) : [];
  $: selectedSet = selected ? new Set(selected) : null;

  // Per-row checked state, seeded from the current selection (null = all on).
  let checks: Record<string, boolean> = {};
  let seededFor: RepoPluginContents | null = null;
  $: if (info !== seededFor) {
    seededFor = info;
    const next: Record<string, boolean> = {};
    for (const entry of info.plugins) {
      next[entry.name] = entry.loadable && (!selectedSet || selectedSet.has(entry.name));
    }
    checks = next;
  }

  $: chosenCount = info.plugins.filter((e) => e.loadable && checks[e.name]).length;
  $: summary = !loadableNames.length
    ? "로드 가능한 플러그인이 없습니다."
    : chosenCount === 0
      ? `선택된 항목이 없습니다. 저장하면 로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
      : chosenCount === loadableNames.length
        ? `로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
        : `${chosenCount}개만 사용하도록 저장됩니다.`;

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    const chosen = info.plugins.filter((e) => e.loadable && checks[e.name]).map((e) => e.name);
    // All (or none) selected → null = "load all".
    const next = chosen.length === 0 || chosen.length === loadableNames.length ? null : chosen;
    try {
      await onSave(next);
      notify("플러그인 선택을 저장했습니다.", "ok");
      saved = true;
      setTimeout(() => (saved = false), 1200);
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      saving = false;
    }
  }
</script>

{#if info.kind === "none"}
  <div class="error-note">Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음).</div>
{:else if info.kind === "single"}
  <div class="muted">단일 플러그인 저장소입니다 — 선택할 항목이 없습니다.</div>
{:else if !info.plugins.length}
  <div class="muted">불러올 수 있는 플러그인이 없습니다.</div>
{:else}
  <div class="pc-head muted">{headText}</div>
  {#each info.plugins as entry (entry.name)}
    <label class={`pc-item ${entry.loadable ? "" : "disabled"}`}>
      <input type="checkbox" bind:checked={checks[entry.name]} disabled={!entry.loadable || saving} />
      <span>{entry.loadable ? entry.name : `${entry.name} (로드 불가)`}</span>
    </label>
  {/each}
  <div class="pc-summary muted" role="status" aria-live="polite">{summary}</div>
  {#if loadableNames.length}
    <div class="pc-actions">
      <button class="primary small" type="button" disabled={saving} on:click={save}>
        {saved ? "저장됨 ✓" : saving ? "저장 중…" : "선택 저장"}
      </button>
    </div>
  {/if}
{/if}
