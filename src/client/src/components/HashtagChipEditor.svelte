<script context="module" lang="ts">
  let nextHashtagEditorId = 0;
</script>

<script lang="ts">
  // Chip editor for capability hashtags: type + Enter/comma/space to add, click
  // × or Backspace-on-empty to remove. Ports buildHashtagEditor from explore.js.
  // Bind `tags` for the current value; the parent reads it on save.
  import { normalizeTags } from "../lib/format";
  import { notify } from "../lib/state";

  export let tags: string[] = [];
  export let disabled = false;

  let value = "";
  const editorId = `hashtag-editor-${++nextHashtagEditorId}`;
  $: statusText = tags.length ? `${tags.length}개 해시태그가 선택되었습니다.` : "선택된 해시태그가 없습니다.";

  function addFromInput(): void {
    if (disabled) return;
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
    if (disabled) return;
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

  function onEditorKeydown(e: KeyboardEvent): void {
    if (disabled) return;
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      inputEl?.focus();
    }
  }

  function remove(index: number): void {
    if (disabled) return;
    tags = tags.filter((_, i) => i !== index);
  }

  let inputEl: HTMLInputElement;
  function focusInput(e: MouseEvent): void {
    if (disabled) return;
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("tag-chips")) {
      inputEl?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions - clicks on editor whitespace focus the chip input; keyboard users tab directly to the input/buttons. -->
<div
  class="hashtag-editor"
  role="group"
  aria-label="역량 해시태그 편집"
  aria-describedby={`${editorId}-status`}
  aria-disabled={disabled ? "true" : "false"}
  on:click={focusInput}
  on:keydown={onEditorKeydown}
>
  <div class="tag-chips" role="list" aria-label="현재 해시태그">
    {#each tags as tag, i (tag + i)}
      <span class="tag accent hashtag-chip" role="listitem">
        <span>#{tag}</span>
        <button type="button" class="chip-x" aria-label={`${tag} 제거`} disabled={disabled} on:click={() => remove(i)}>×</button>
      </span>
    {/each}
  </div>
  <span class="sr-only" id={`${editorId}-status`} role="status" aria-live="polite">{statusText} Enter, 쉼표, 공백으로 추가할 수 있습니다.</span>
  <input
    class="tag-input"
    type="text"
    placeholder="태그 입력 후 Enter"
    aria-label="역량 해시태그 추가"
    aria-describedby={`${editorId}-status`}
    disabled={disabled}
    bind:value
    bind:this={inputEl}
    on:keydown={onKeydown}
    on:blur={() => value.trim() && addFromInput()}
  />
</div>
