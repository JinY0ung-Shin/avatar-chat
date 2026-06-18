<script lang="ts">
  import { onMount } from "svelte";
  import DOMPurify from "dompurify";
  import { renderMarkdown } from "../lib/format";
  import {
    closeCanvas,
    dismissCanvas,
    fetchCanvasVersions,
    rollbackCanvas,
    setActiveCanvas,
    submitCanvas,
    submitCanvasEdit,
  } from "../lib/chat";
  import { assertInlineOnlyVegaSpec, createInlineOnlyVegaLoader } from "../lib/vegaCanvas";
  import { copyText } from "../lib/dom";
  import { copyPng, downloadPng, downloadSvg } from "../lib/canvasExport";
  import { notify } from "../lib/state";
  import type { ChatPane, PaneCanvas } from "../lib/types";

  // Visual canvas side panel (experimental `canvas` feature, #50). Renders the
  // avatar-shown artifact (markdown/svg/html/mermaid/vega — all sanitized, never
  // executing avatar JS) plus real form controls that post back through
  // /api/chat/respond (blocking) or /api/chat/stream (async). Resizable +
  // collapse-persisted + mobile-stacked, mirroring CapabilitiesPanel.
  export let pane: ChatPane;

  let collapsed = false;
  const CANVAS_WIDTH_MIN = 300;
  const CANVAS_WIDTH_MAX = 760;
  const CANVAS_WIDTH_DEFAULT = 440;
  let panelWidth = CANVAS_WIDTH_DEFAULT;

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
  // Clamp so the panel can never squeeze the chat column out (rail 248 + ~380 readable).
  function clampWidth(width: number): number {
    const available = Math.max(CANVAS_WIDTH_MIN, window.innerWidth - 248 - 380);
    return Math.min(Math.min(CANVAS_WIDTH_MAX, available), Math.max(CANVAS_WIDTH_MIN, width));
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
      setPref("canvasPanelWidth", String(Math.round(panelWidth)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function setCollapsed(value: boolean) {
    collapsed = value;
    setPref("canvasPanelCollapsed", value ? "1" : "0");
  }

  onMount(() => {
    const mobile = window.matchMedia?.("(max-width: 860px)").matches ?? false;
    collapsed = pref("canvasPanelCollapsed", mobile ? "1" : "0") === "1";
    panelWidth = clampWidth(Number(pref("canvasPanelWidth", String(CANVAS_WIDTH_DEFAULT))) || CANVAS_WIDTH_DEFAULT);
  });

  $: canvases = pane.canvases || [];
  $: active = canvases.find((c) => c.id === pane.activeCanvasId) ?? canvases[canvases.length - 1] ?? null;

  // ---- per-canvas control + editor state, rebuilt when the active canvas changes ----
  let formCanvasId = "";
  let ctrlVals: Record<string, unknown> = {};
  let editDraft = "";
  let resubmitting = false;
  let showVersions = false;
  let versions: { version: number; createdAt: string }[] = [];
  $: if (active && active.id !== formCanvasId) {
    initForm(active);
  }
  function initForm(c: PaneCanvas): void {
    formCanvasId = c.id;
    const next: Record<string, unknown> = {};
    for (const ctrl of c.controls || []) {
      if (ctrl.type === "buttons") next[ctrl.id] = [];
      else if (ctrl.type === "slider") next[ctrl.id] = ctrl.defaultValue ?? ctrl.min ?? 0;
      else next[ctrl.id] = ctrl.defaultValue ?? ""; // text | select | number | date
    }
    ctrlVals = next;
    editDraft = c.content;
    resubmitting = false;
    showVersions = false;
    versions = [];
  }

  // ---- content rendering (CSP-safe: no avatar-authored JS ever runs) ----
  let renderedHtml = "";
  let renderError = "";
  let contentEl: HTMLElement; // bound, so export can read the rendered <svg>
  // Token guards async (mermaid/vega) renders so a stale result can't overwrite a newer one.
  let renderToken = 0;

  const VEGA_BASE_CONFIG = { background: "transparent", view: { stroke: "transparent" } };
  const VEGA_DARK_CONFIG = {
    ...VEGA_BASE_CONFIG,
    title: { color: "#e5e7eb", subtitleColor: "#cbd5e1" },
    axis: { domainColor: "#475569", gridColor: "#334155", tickColor: "#475569", labelColor: "#cbd5e1", titleColor: "#e5e7eb" },
    legend: { labelColor: "#cbd5e1", titleColor: "#e5e7eb" },
    style: { "guide-label": { fill: "#cbd5e1" }, "guide-title": { fill: "#e5e7eb" } },
  };

  $: void renderActive(active);

  async function renderActive(canvas: PaneCanvas | null): Promise<void> {
    const token = ++renderToken;
    renderError = "";
    if (!canvas) {
      renderedHtml = "";
      return;
    }
    if (canvas.contentType === "markdown") {
      renderedHtml = renderMarkdown(canvas.content);
      return;
    }
    if (canvas.contentType === "svg") {
      renderedHtml = DOMPurify.sanitize(canvas.content, { USE_PROFILES: { svg: true, svgFilters: true } });
      return;
    }
    if (canvas.contentType === "html") {
      renderedHtml = DOMPurify.sanitize(canvas.content);
      return;
    }
    if (canvas.contentType === "vega") {
      try {
        const [vega, vegaLite, interp] = await Promise.all([
          import("vega"),
          import("vega-lite"),
          import("vega-interpreter"),
        ]);
        const spec = JSON.parse(canvas.content);
        assertInlineOnlyVegaSpec(spec);
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        const config = dark ? VEGA_DARK_CONFIG : VEGA_BASE_CONFIG;
        const vgSpec = vegaLite.compile(spec, { config } as any).spec;
        const runtime = vega.parse(vgSpec as any, null as any, { ast: true } as any);
        const view = new vega.View(runtime, {
          expr: interp.expressionInterpreter,
          renderer: "svg",
          loader: createInlineOnlyVegaLoader(vega),
        } as any);
        const svg = await view.toSVG();
        view.finalize();
        if (token !== renderToken) return; // a newer render won
        renderedHtml = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      } catch (err) {
        if (token !== renderToken) return;
        renderError = (err as Error).message || "Vega 차트 렌더링에 실패했습니다.";
        const escaped = canvas.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
        renderedHtml = DOMPurify.sanitize(`<pre>${escaped}</pre>`);
      }
      return;
    }
    if (canvas.contentType === "mermaid") {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(`canvas-mmd-${canvas.id}-${token}`, canvas.content);
        if (token !== renderToken) return; // a newer render won
        renderedHtml = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      } catch (err) {
        if (token !== renderToken) return;
        renderError = (err as Error).message || "mermaid 렌더링에 실패했습니다.";
        const escaped = canvas.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
        renderedHtml = DOMPurify.sanitize(`<pre>${escaped}</pre>`);
      }
    }
  }

  // ---- form controls ----
  function toggleButton(ctrlId: string, value: string, multi: boolean): void {
    const current = Array.isArray(ctrlVals[ctrlId]) ? (ctrlVals[ctrlId] as string[]) : [];
    if (multi) {
      ctrlVals[ctrlId] = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    } else {
      ctrlVals[ctrlId] = [value];
    }
    ctrlVals = { ...ctrlVals };
  }
  function optValue(opt: { label: string; value?: string }): string {
    return opt.value ?? opt.label;
  }
  function isSelected(ctrlId: string, value: string): boolean {
    return Array.isArray(ctrlVals[ctrlId]) && (ctrlVals[ctrlId] as string[]).includes(value);
  }

  $: canSubmit = Boolean(active?.controls?.length) &&
    (active?.controls || []).every((ctrl) => {
      if (ctrl.required === false) return true;
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") return Array.isArray(v) && v.length > 0;
      if (ctrl.type === "slider") return true; // always carries a value
      if (ctrl.type === "number") {
        if (v === "" || v === null || v === undefined) return false;
        const n = Number(v);
        if (Number.isNaN(n)) return false;
        if (typeof ctrl.min === "number" && n < ctrl.min) return false;
        if (typeof ctrl.max === "number" && n > ctrl.max) return false;
        return true;
      }
      return String(v ?? "").trim().length > 0; // text | select | date
    });

  function onSubmit(): void {
    if (!active) return;
    const values: Record<string, unknown> = {};
    for (const ctrl of active.controls || []) {
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") {
        const sel = Array.isArray(v) ? (v as string[]) : [];
        values[ctrl.id] = ctrl.multiSelect ? sel : sel[0] ?? "";
      } else if (ctrl.type === "slider" || ctrl.type === "number") {
        values[ctrl.id] = v === "" || v === null || v === undefined ? "" : Number(v);
      } else {
        values[ctrl.id] = String(v ?? "").trim();
      }
    }
    resubmitting = false;
    void submitCanvas(pane.id, active.id, values);
  }

  // The controls form is shown for a blocking pending canvas, an async canvas, or a
  // re-submission of an already-answered async canvas.
  $: showForm = Boolean(
    active?.controls?.length &&
      (active.pending || (active.interaction === "async" && (!active.submittedValues || resubmitting))),
  );
  // The skip button only makes sense for a blocking, parked run.
  $: canSkip = Boolean(active?.pending && active?.requestId && active?.runId);

  function renderSubmitted(value: unknown): string {
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }

  // ---- export ----
  const isImageType = (c: PaneCanvas): boolean =>
    c.contentType === "svg" || c.contentType === "vega" || c.contentType === "mermaid";
  function getSvgEl(): SVGSVGElement | null {
    return (contentEl?.querySelector("svg") as SVGSVGElement | null) ?? null;
  }
  async function onCopy(event: MouseEvent): Promise<void> {
    if (!active) return;
    const btn = event.currentTarget as HTMLButtonElement;
    if (isImageType(active)) {
      const svg = getSvgEl();
      if (svg && (await copyPng(svg))) {
        notify("이미지를 클립보드에 복사했습니다.", "info");
        return;
      }
    }
    await copyText(active.content, btn); // source text (markdown/html, or image fallback)
  }
  function onDownloadPng(): void {
    const svg = getSvgEl();
    if (active && svg) void downloadPng(svg, active.title);
    else notify("이 캔버스는 PNG로 저장할 수 없습니다.", "warn");
  }
  function onDownloadSvg(): void {
    const svg = getSvgEl();
    if (active && svg) downloadSvg(svg, active.title);
  }

  // ---- version history ----
  async function toggleVersions(): Promise<void> {
    showVersions = !showVersions;
    if (showVersions && active) versions = await fetchCanvasVersions(active.id);
  }
  function doRollback(version: number): void {
    if (!active) return;
    showVersions = false;
    void rollbackCanvas(pane.id, active.id, version);
  }
  function versionTime(iso: string): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
    } catch {
      return "";
    }
  }

  // ---- fullscreen ----
  let fullscreen = false;
  let zoom = 1;
  function openFullscreen(): void {
    zoom = 1;
    fullscreen = true;
  }
  function onFsKey(event: KeyboardEvent): void {
    if (event.key === "Escape") fullscreen = false;
  }
  function onFsWheel(event: WheelEvent): void {
    event.preventDefault();
    zoom = Math.min(4, Math.max(0.4, zoom + (event.deltaY < 0 ? 0.15 : -0.15)));
  }
</script>

<svelte:window on:keydown={fullscreen ? onFsKey : undefined} />

{#if canvases.length}
  <aside class="canvas-panel" class:collapsed aria-label="비주얼 캔버스" style={collapsed ? undefined : `width:${panelWidth}px`}>
    <div class="canvas-resize" role="separator" aria-orientation="vertical" aria-label="패널 너비 조절" on:pointerdown={startResize}></div>
    <button class="canvas-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} on:click={() => setCollapsed(true)}>›</button>

    <div class="canvas-body scroll-thin">
      <div class="canvas-head">
        <h3>캔버스 <span class="canvas-beta">실험</span></h3>
        {#if canvases.length > 1}
          <div class="canvas-tabs" role="tablist" aria-label="캔버스 목록">
            {#each canvases as c (c.id)}
              <div class="canvas-tab-wrap" class:active={active?.id === c.id}>
                <button
                  class="canvas-tab"
                  type="button"
                  role="tab"
                  aria-selected={active?.id === c.id}
                  on:click={() => setActiveCanvas(pane.id, c.id)}
                >{c.title}</button>
                <button class="canvas-tab-close" type="button" aria-label="캔버스 닫기" title="캔버스 닫기" on:click={() => closeCanvas(pane.id, c.id)}>×</button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if active}
        <div class="canvas-card">
          <div class="canvas-card-top">
            <div class="canvas-title">{active.title}</div>
            <div class="canvas-toolbar">
              {#if (active.versionCount || 1) > 1}
                <button class="canvas-tool-btn" type="button" title="버전 기록" aria-expanded={showVersions} on:click={toggleVersions}>v{active.currentVersion ?? 1} ▾</button>
              {/if}
              <button class="canvas-tool-btn" type="button" title="복사" on:click={onCopy}>복사</button>
              {#if isImageType(active)}
                <button class="canvas-tool-btn" type="button" title="PNG로 저장" on:click={onDownloadPng}>PNG</button>
                <button class="canvas-tool-btn" type="button" title="SVG로 저장" on:click={onDownloadSvg}>SVG</button>
              {/if}
              <button class="canvas-tool-btn" type="button" title="전체화면" aria-label="전체화면" on:click={openFullscreen}>⤢</button>
              {#if canvases.length === 1}
                <button class="canvas-tool-btn" type="button" title="캔버스 닫기" aria-label="캔버스 닫기" on:click={() => active && closeCanvas(pane.id, active.id)}>×</button>
              {/if}
            </div>
          </div>

          {#if showVersions}
            <div class="canvas-versions" role="listbox" aria-label="버전 기록">
              {#each versions as v (v.version)}
                <button
                  class="canvas-version-row"
                  class:current={v.version === active.currentVersion}
                  type="button"
                  on:click={() => doRollback(v.version)}
                >
                  <span>v{v.version}</span>
                  <span class="canvas-version-time">{versionTime(v.createdAt)}</span>
                  {#if v.version !== active.currentVersion}<span class="canvas-version-action">되돌리기</span>{/if}
                </button>
              {/each}
            </div>
          {/if}

          <div class="canvas-content md" bind:this={contentEl}>{@html renderedHtml}</div>
          {#if renderError}
            <p class="canvas-render-error">렌더링 실패: {renderError}</p>
          {/if}

          {#if active.editable}
            <div class="canvas-edit">
              <div class="canvas-control-label">내용 편집</div>
              <div class="field">
                <textarea rows="5" bind:value={editDraft} placeholder="내용을 수정해 아바타에게 보내세요"></textarea>
              </div>
              <div class="canvas-actions">
                <button class="btn btn-primary btn-sm" type="button" disabled={pane.streaming || !editDraft.trim()} on:click={() => active && submitCanvasEdit(pane.id, active.id, editDraft)}>수정해서 보내기</button>
              </div>
            </div>
          {/if}

          {#if active.controls?.length}
            {#if active.submittedValues && !resubmitting}
              <div class="canvas-answered" role="status">
                <span class="canvas-answered-badge">응답 완료</span>
                <ul>
                  {#each active.controls as ctrl (ctrl.id)}
                    <li><strong>{ctrl.label || ctrl.id}:</strong> {renderSubmitted(active.submittedValues[ctrl.id])}</li>
                  {/each}
                </ul>
                {#if active.interaction === "async"}
                  <button class="btn btn-ghost btn-sm" type="button" disabled={pane.streaming} on:click={() => (resubmitting = true)}>다시 보내기</button>
                {/if}
              </div>
            {:else if showForm}
              <form class="canvas-controls" on:submit|preventDefault={onSubmit}>
                {#each active.controls as ctrl (ctrl.id)}
                  <div class="canvas-control">
                    {#if ctrl.label}<div class="canvas-control-label">{ctrl.label}{#if ctrl.required === false}<span class="canvas-optional"> (선택)</span>{/if}</div>{/if}
                    {#if ctrl.type === "buttons"}
                      <div class="canvas-options" role="group" aria-label={ctrl.label || "선택"}>
                        {#each ctrl.options || [] as opt}
                          <button
                            type="button"
                            class="canvas-opt"
                            class:selected={isSelected(ctrl.id, optValue(opt))}
                            aria-pressed={isSelected(ctrl.id, optValue(opt))}
                            on:click={() => toggleButton(ctrl.id, optValue(opt), Boolean(ctrl.multiSelect))}
                          >
                            <span class="canvas-opt-label">{opt.label}</span>
                            {#if opt.description}<span class="canvas-opt-desc">{opt.description}</span>{/if}
                          </button>
                        {/each}
                      </div>
                    {:else if ctrl.type === "select"}
                      <div class="field">
                        <select bind:value={ctrlVals[ctrl.id]}>
                          <option value="" disabled>{ctrl.placeholder || "선택하세요"}</option>
                          {#each ctrl.options || [] as opt}
                            <option value={optValue(opt)}>{opt.label}</option>
                          {/each}
                        </select>
                      </div>
                    {:else if ctrl.type === "slider"}
                      <div class="canvas-slider">
                        <input type="range" min={ctrl.min ?? 0} max={ctrl.max ?? 100} step={ctrl.step ?? 1} bind:value={ctrlVals[ctrl.id]} />
                        <span class="canvas-slider-val">{ctrlVals[ctrl.id]}</span>
                      </div>
                    {:else if ctrl.type === "number"}
                      <div class="field">
                        <input type="number" min={ctrl.min} max={ctrl.max} step={ctrl.step ?? 1} placeholder={ctrl.placeholder || ""} bind:value={ctrlVals[ctrl.id]} />
                      </div>
                    {:else if ctrl.type === "date"}
                      <div class="field">
                        <input type="date" bind:value={ctrlVals[ctrl.id]} />
                      </div>
                    {:else}
                      <div class="field">
                        {#if ctrl.multiline}
                          <textarea rows="3" placeholder={ctrl.placeholder || ""} bind:value={ctrlVals[ctrl.id]}></textarea>
                        {:else}
                          <input type="text" placeholder={ctrl.placeholder || ""} bind:value={ctrlVals[ctrl.id]} />
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
                <div class="canvas-actions">
                  {#if canSkip}
                    <button class="btn btn-ghost btn-sm" type="button" disabled={active.submitting} on:click={() => active && dismissCanvas(pane.id, active.id)}>건너뛰기</button>
                  {:else if resubmitting}
                    <button class="btn btn-ghost btn-sm" type="button" on:click={() => (resubmitting = false)}>취소</button>
                  {/if}
                  <button class="btn btn-primary btn-sm" type="submit" disabled={!canSubmit || active.submitting || pane.streaming}>보내기</button>
                </div>
              </form>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <button class="canvas-expand" type="button" aria-label="캔버스 패널 펼치기" title="캔버스 패널 펼치기" aria-expanded={!collapsed} on:click={() => setCollapsed(false)}>
      <span aria-hidden="true">‹</span>
      <span class="canvas-expand-label">캔버스 보기</span>
    </button>
  </aside>
{/if}

{#if fullscreen && active}
  <div class="canvas-fs" role="dialog" aria-modal="true" aria-label="캔버스 전체화면" on:wheel|nonpassive={onFsWheel}>
    <div class="canvas-fs-bar">
      <span class="canvas-fs-title">{active.title}</span>
      <div class="canvas-fs-zoom">
        <button class="canvas-tool-btn" type="button" aria-label="축소" on:click={() => (zoom = Math.max(0.4, zoom - 0.2))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button class="canvas-tool-btn" type="button" aria-label="확대" on:click={() => (zoom = Math.min(4, zoom + 0.2))}>+</button>
        <button class="canvas-tool-btn" type="button" on:click={() => (fullscreen = false)}>닫기</button>
      </div>
    </div>
    <button class="canvas-fs-backdrop" type="button" aria-label="닫기" on:click={() => (fullscreen = false)}></button>
    <div class="canvas-fs-stage">
      <div class="canvas-fs-content md" style={`transform:scale(${zoom})`}>{@html renderedHtml}</div>
    </div>
  </div>
{/if}
