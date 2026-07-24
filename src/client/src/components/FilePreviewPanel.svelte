<script lang="ts">
  import Icon from "./Icon.svelte";
  import { updateState } from "../lib/state";
  import type { ChatPane, MessageAttachment } from "../lib/types";

  // Right-side preview for a shared file attachment (msg-file-card click).
  // Slides are the hidden image attachments published on the SAME assistant
  // message (the pptx skill's rendered slide PNGs); formats without slides
  // still get the panel with the download button. Reuses the .canvas-panel
  // frame classes so it occupies the same slot as the visual canvas.
  export let pane: ChatPane;

  $: preview = pane.filePreview ?? null;
  $: slides = preview?.slides ?? [];

  function close(): void {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === pane.id);
      if (target) target.filePreview = null;
    });
  }

  function slideSrc(att: MessageAttachment): string {
    return `/api/conversations/${encodeURIComponent(pane.conversationId)}/images/${encodeURIComponent(att.id)}`;
  }

  function downloadHref(att: MessageAttachment): string {
    const base = `/api/conversations/${encodeURIComponent(pane.conversationId)}/files/${encodeURIComponent(att.id)}`;
    return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
  }

  function formatFileSize(size: number | undefined): string {
    if (!size || size <= 0) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#if preview}
  <aside class="canvas-panel file-preview-panel" aria-label="파일 미리보기">
    <div class="file-preview-head">
      <div class="file-preview-title">
        <strong class="file-preview-name" title={preview.attachment.name || "파일"}>{preview.attachment.name || "파일"}</strong>
        {#if formatFileSize(preview.attachment.size)}
          <span class="muted">{formatFileSize(preview.attachment.size)}</span>
        {/if}
      </div>
      <div class="file-preview-actions">
        <a
          class="btn btn-primary btn-sm"
          href={downloadHref(preview.attachment)}
          download={preview.attachment.name || undefined}
        >다운로드</a>
        <button class="msg-act" type="button" aria-label="미리보기 닫기" title="닫기" on:click={close}>
          <Icon name="close" />
        </button>
      </div>
    </div>
    <div class="canvas-body file-preview-body">
      {#if slides.length}
        {#each slides as slide, index (slide.id)}
          <figure class="file-preview-slide">
            <img src={slideSrc(slide)} alt={`슬라이드 ${index + 1}`} loading="lazy" />
            <figcaption class="muted">슬라이드 {index + 1} / {slides.length}</figcaption>
          </figure>
        {/each}
      {:else}
        <p class="muted">이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.</p>
      {/if}
    </div>
  </aside>
{/if}
