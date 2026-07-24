<script lang="ts">
  import Icon from "./Icon.svelte";
  import { updateState } from "../lib/state";
  import type { ChatPane, MessageAttachment } from "../lib/types";

  // Right-side preview for a shared file attachment (msg-file-card click).
  // Slides are the hidden image attachments on the SAME assistant message
  // (server-auto-rendered on share_file, or skill-published); formats without
  // slides still get the panel with the download button. Reuses the
  // .canvas-panel frame classes + the same resize interaction so it behaves
  // exactly like the visual canvas in the same slot.
  export let pane: ChatPane;

  $: preview = pane.filePreview ?? null;
  $: slides = preview?.slides ?? [];

  const WIDTH_MIN = 300;
  const WIDTH_MAX = 760;
  const WIDTH_DEFAULT = 440;
  let panelWidth = WIDTH_DEFAULT;

  function pref(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function setPref(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: prefs just won't persist */
    }
  }
  panelWidth = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(pref("filePanelWidth", String(WIDTH_DEFAULT))) || WIDTH_DEFAULT));

  function clampWidth(width: number): number {
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width));
  }
  function savePanelWidth(width: number): void {
    panelWidth = clampWidth(width);
    setPref("filePanelWidth", String(Math.round(panelWidth)));
  }
  function startResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // Panel sits at the right edge → dragging left (smaller clientX) widens it.
      panelWidth = clampWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setPref("filePanelWidth", String(Math.round(panelWidth)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function onResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      savePanelWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      savePanelWidth(panelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      savePanelWidth(WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(WIDTH_MAX);
    }
  }

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
  <aside class="canvas-panel file-preview-panel" aria-label="파일 미리보기" style={`width:${panelWidth}px`}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      class="canvas-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="미리보기 패널 너비 조절"
      aria-valuenow={Math.round(panelWidth)}
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuetext={`${Math.round(panelWidth)}px`}
      tabindex="0"
      on:pointerdown={startResize}
      on:keydown={onResizeKeydown}
    ></div>
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
    <div class="canvas-body file-preview-body scroll-thin">
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
