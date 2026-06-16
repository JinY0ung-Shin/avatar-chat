<script lang="ts">
  import DOMPurify from "dompurify";
  import Icon from "./Icon.svelte";
  import { renderMarkdown } from "../lib/format";
  import { dismissCanvas, setActiveCanvas, submitCanvas } from "../lib/chat";
  import { assertInlineOnlyVegaSpec, createInlineOnlyVegaLoader } from "../lib/vegaCanvas";
  import type { ChatPane, PaneCanvas } from "../lib/types";

  // Visual canvas side panel (experimental `canvas` feature, #50). Renders the
  // avatar-shown artifact (markdown/svg/html/mermaid — all sanitized, never
  // executing avatar JS) plus real form controls that post back through
  // /api/chat/respond. Mirrors CapabilitiesPanel's collapsible-aside shape.
  export let pane: ChatPane;

  let collapsed = false;

  $: canvases = pane.canvases || [];
  $: active = canvases.find((c) => c.id === pane.activeCanvasId) ?? canvases[canvases.length - 1] ?? null;

  // Per-canvas control state, rebuilt when the active canvas changes.
  let formCanvasId = "";
  let buttonSel: Record<string, string[]> = {};
  let textVals: Record<string, string> = {};
  $: if (active && active.id !== formCanvasId) {
    formCanvasId = active.id;
    buttonSel = {};
    textVals = {};
    for (const ctrl of active.controls || []) {
      if (ctrl.type === "buttons") buttonSel[ctrl.id] = [];
      else textVals[ctrl.id] = "";
    }
  }

  // ---- content rendering (CSP-safe: no avatar-authored JS ever runs) ----
  let renderedHtml = "";
  let renderError = "";
  // Token guards async (mermaid/vega) renders so a stale result can't overwrite a newer one.
  let renderToken = 0;

  // Vega-Lite theming: transparent background so the chart sits on the card, with
  // axis/label/legend colors that read on the active theme. Used as the Vega-Lite
  // compile `config` (see the `vega` branch below).
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
        // Lazy-load vega only when a chart is shown (separate chunk). Render the
        // Vega-Lite spec to an SVG STRING via the CSP-safe expression interpreter
        // (AST evaluation — no `Function` constructor, so `script-src 'self'`
        // stays intact), with a loader that rejects avatar-controlled URL fetches,
        // then sanitize like any other SVG.
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
        // Fall back to the spec source so nothing is lost on a bad spec/parse error.
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
        // Fall back to showing the diagram source so nothing is lost if mermaid
        // can't render (e.g. a syntax error).
        renderError = (err as Error).message || "mermaid 렌더링에 실패했습니다.";
        const escaped = canvas.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
        renderedHtml = DOMPurify.sanitize(`<pre>${escaped}</pre>`);
      }
    }
  }

  function toggleButton(ctrlId: string, value: string, multi: boolean): void {
    const current = buttonSel[ctrlId] || [];
    if (multi) {
      buttonSel[ctrlId] = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    } else {
      buttonSel[ctrlId] = [value];
    }
    buttonSel = { ...buttonSel };
  }

  function optValue(opt: { label: string; value?: string }): string {
    return opt.value ?? opt.label;
  }

  $: canSubmit = Boolean(
    active?.controls?.length &&
      active.controls.every((ctrl) =>
        ctrl.type === "buttons" ? (buttonSel[ctrl.id]?.length ?? 0) > 0 : (textVals[ctrl.id]?.trim().length ?? 0) > 0,
      ),
  );

  function onSubmit(): void {
    if (!active) return;
    const values: Record<string, unknown> = {};
    for (const ctrl of active.controls || []) {
      if (ctrl.type === "buttons") {
        const sel = buttonSel[ctrl.id] || [];
        values[ctrl.id] = ctrl.multiSelect ? sel : sel[0] ?? "";
      } else {
        values[ctrl.id] = (textVals[ctrl.id] || "").trim();
      }
    }
    void submitCanvas(pane.id, active.id, values);
  }
</script>

{#if canvases.length}
  <aside class="canvas-panel" class:collapsed aria-label="비주얼 캔버스">
    <button class="canvas-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} on:click={() => (collapsed = true)}>›</button>

    <div class="canvas-body scroll-thin">
      <div class="canvas-head">
        <h3>캔버스 <span class="canvas-beta">실험</span></h3>
        {#if canvases.length > 1}
          <div class="canvas-tabs" role="tablist" aria-label="캔버스 목록">
            {#each canvases as c (c.id)}
              <button
                class="canvas-tab"
                class:active={active?.id === c.id}
                type="button"
                role="tab"
                aria-selected={active?.id === c.id}
                on:click={() => setActiveCanvas(pane.id, c.id)}
              >{c.title}</button>
            {/each}
          </div>
        {/if}
      </div>

      {#if active}
        <div class="canvas-card">
          <div class="canvas-title">{active.title}</div>
          <div class="canvas-content md">{@html renderedHtml}</div>
          {#if renderError}
            <p class="canvas-render-error">렌더링 실패: {renderError}</p>
          {/if}

          {#if active.controls?.length}
            {#if active.submittedValues}
              <div class="canvas-answered" role="status">
                <span class="canvas-answered-badge">응답 완료</span>
                <ul>
                  {#each active.controls as ctrl (ctrl.id)}
                    <li><strong>{ctrl.label || ctrl.id}:</strong> {Array.isArray(active.submittedValues[ctrl.id]) ? (active.submittedValues[ctrl.id] as string[]).join(", ") : String(active.submittedValues[ctrl.id] ?? "")}</li>
                  {/each}
                </ul>
              </div>
            {:else if active.pending}
              <form class="canvas-controls" on:submit|preventDefault={onSubmit}>
                {#each active.controls as ctrl (ctrl.id)}
                  <div class="canvas-control">
                    {#if ctrl.label}<div class="canvas-control-label">{ctrl.label}</div>{/if}
                    {#if ctrl.type === "buttons"}
                      <div class="canvas-options" role="group" aria-label={ctrl.label || "선택"}>
                        {#each ctrl.options || [] as opt}
                          <button
                            type="button"
                            class="canvas-opt"
                            class:selected={(buttonSel[ctrl.id] || []).includes(optValue(opt))}
                            aria-pressed={(buttonSel[ctrl.id] || []).includes(optValue(opt))}
                            on:click={() => toggleButton(ctrl.id, optValue(opt), Boolean(ctrl.multiSelect))}
                          >
                            <span class="canvas-opt-label">{opt.label}</span>
                            {#if opt.description}<span class="canvas-opt-desc">{opt.description}</span>{/if}
                          </button>
                        {/each}
                      </div>
                    {:else}
                      <div class="field">
                        {#if ctrl.multiline}
                          <textarea rows="3" placeholder={ctrl.placeholder || ""} bind:value={textVals[ctrl.id]}></textarea>
                        {:else}
                          <input type="text" placeholder={ctrl.placeholder || ""} bind:value={textVals[ctrl.id]} />
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
                <div class="canvas-actions">
                  <button class="btn btn-ghost btn-sm" type="button" disabled={active.submitting} on:click={() => active && dismissCanvas(pane.id, active.id)}>건너뛰기</button>
                  <button class="btn btn-primary btn-sm" type="submit" disabled={!canSubmit || active.submitting}>보내기</button>
                </div>
              </form>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <button class="canvas-expand" type="button" aria-label="캔버스 패널 펼치기" title="캔버스 패널 펼치기" aria-expanded={!collapsed} on:click={() => (collapsed = false)}>
      <span aria-hidden="true">‹</span>
      <span class="canvas-expand-label">캔버스 보기</span>
    </button>
  </aside>
{/if}

<style>
  .canvas-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 440px;
    flex: 0 0 auto;
    border-left: 1px solid var(--line);
    background: var(--panel);
    overflow: hidden;
  }
  .canvas-panel.collapsed {
    width: 0;
    border-left: none;
  }
  .canvas-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .canvas-panel.collapsed .canvas-body {
    display: none;
  }
  .canvas-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .canvas-head h3 {
    margin: 0;
    font-size: var(--t-md);
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .canvas-beta {
    font-size: var(--t-2xs);
    padding: 1px 6px;
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .canvas-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .canvas-tab {
    font-size: var(--t-xs);
    padding: 2px 8px;
    border-radius: var(--r-xs);
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .canvas-tab.active {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--accent);
  }
  .canvas-card {
    border: 1px solid var(--line);
    border-radius: var(--r-xl);
    background: var(--bg);
    padding: var(--s-3);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .canvas-title {
    font-weight: 600;
    font-size: var(--t-base);
  }
  .canvas-content {
    overflow-x: auto;
  }
  .canvas-content :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .canvas-render-error {
    color: var(--danger);
    font-size: var(--t-xs);
    margin: 0;
  }
  .canvas-controls,
  .canvas-control,
  .canvas-options {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .canvas-control-label {
    font-size: var(--t-sm);
    font-weight: 600;
  }
  .canvas-opt {
    text-align: left;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--panel);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .canvas-opt.selected {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .canvas-opt-label {
    font-weight: 500;
  }
  .canvas-opt-desc {
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .canvas-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }
  .canvas-answered {
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-sm);
  }
  .canvas-answered-badge {
    display: inline-block;
    font-size: var(--t-2xs);
    font-weight: 600;
    color: var(--ok);
    margin-bottom: var(--s-1);
  }
  .canvas-answered ul {
    margin: 0;
    padding-left: 1.1em;
  }
  .canvas-collapse {
    position: absolute;
    top: var(--s-2);
    left: var(--s-2);
    z-index: 2;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .canvas-panel.collapsed .canvas-collapse {
    display: none;
  }
  .canvas-expand {
    display: none;
  }
  .canvas-panel.collapsed .canvas-expand {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    writing-mode: vertical-rl;
    height: 100%;
    border: none;
    border-left: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    cursor: pointer;
    padding: var(--s-3) var(--s-1);
    font-size: var(--t-sm);
  }
  .canvas-expand-label {
    writing-mode: vertical-rl;
  }
</style>
