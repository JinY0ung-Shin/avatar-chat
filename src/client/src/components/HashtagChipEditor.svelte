<script lang="ts">
  // Chip editor for capability hashtags: type + Enter/comma/space to add, click
  // × or Backspace-on-empty to remove. Ports buildHashtagEditor from explore.js.
  // Bind `tags` for the current value; the parent reads it on save.
  import { normalizeTags } from "../lib/format";
  import { notify } from "../lib/state";

  export let tags: string[] = [];

  let value = "";

  function addFromInput(): void {
    const parts = value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const truncated = parts.some((p) => p.replace(/^[#*•·\-\s]+/, "").length > 30);
    tags = normalizeTags([...tags, ...parts]);
    value = "";
    if (truncated) notify("해시태그는 최대 30자까지만 사용할 수 있어 일부가 잘렸습니다.", "info");
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFromInput();
    } else if (e.key === " " && value.trim()) {
      e.preventDefault();
      addFromInput();
    } else if (e.key === "Backspace" && !value && tags.length) {
      tags = tags.slice(0, -1);
    }
  }

  function remove(index: number): void {
    tags = tags.filter((_, i) => i !== index);
  }

  let inputEl: HTMLInputElement;
  function focusInput(e: MouseEvent): void {
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("tag-chips")) {
      inputEl?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="hashtag-editor" on:click={focusInput}>
  <div class="tag-chips">
    {#each tags as tag, i (tag + i)}
      <span class="tag accent hashtag-chip">
        <span>#{tag}</span>
        <button type="button" class="chip-x" aria-label={`${tag} 제거`} on:click={() => remove(i)}>×</button>
      </span>
    {/each}
  </div>
  <input
    class="tag-input"
    type="text"
    placeholder="태그 입력 후 Enter"
    aria-label="역량 해시태그 추가"
    bind:value
    bind:this={inputEl}
    on:keydown={onKeydown}
    on:blur={() => value.trim() && addFromInput()}
  />
</div>
