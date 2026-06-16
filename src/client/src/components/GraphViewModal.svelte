<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../lib/api";
  import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";

  const dispatch = createEventDispatcher<{ close: void }>();

  // API path to fetch the {graph} from — personal repo by default, or a group's.
  export let endpoint = "/api/me/knowledge-repo/graph";
  // Heading; group views pass the group name.
  export let title = "지식 그래프";

  // Interactive second-brain graph (Obsidian-style). Fetches the `[[wikilink]]`
  // graph from /api/me/knowledge-repo/graph and renders it with cytoscape, which
  // is lazy-imported as its own Vite chunk (kept out of the main bundle) and is
  // CSP-safe — canvas rendering, no eval/Function. Mirrors CanvasPanel's lazy-lib
  // pattern.

  // Vault-section colors (chosen to read on both light and dark themes).
  const SECTION_COLORS: Record<string, string> = {
    raw: "#f59e0b",
    sources: "#3b82f6",
    entities: "#10b981",
    concepts: "#8b5cf6",
    synthesis: "#ef4444",
    wiki: "#64748b",
    other: "#94a3b8",
    unresolved: "#cbd5e1",
  };
  const SECTION_LABELS: Record<string, string> = {
    raw: "raw (캡처)",
    sources: "sources",
    entities: "entities",
    concepts: "concepts",
    synthesis: "synthesis",
    wiki: "wiki",
    other: "기타",
    unresolved: "미연결 링크",
  };

  let loading = true;
  let error = "";
  let graph: KnowledgeGraph | null = null;
  let containerEl: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cy: any = null;
  let selected: KnowledgeGraphNode | null = null;

  $: presentSections = graph
    ? [...new Set(graph.nodes.map((n) => n.section))].filter((s) => s in SECTION_COLORS)
    : [];

  onMount(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ graph: KnowledgeGraph }>(endpoint);
        if (!cancelled) graph = res.graph;
      } catch (err) {
        if (!cancelled) error = (err as Error).message;
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => {
      cancelled = true;
      cy?.destroy();
      cy = null;
    };
  });

  // Init once the container is mounted and we have a non-empty graph.
  $: if (containerEl && graph && graph.nodes.length && !cy) void initCy(graph, containerEl);

  async function initCy(g: KnowledgeGraph, container: HTMLDivElement): Promise<void> {
    const cytoscape = (await import("cytoscape")).default;
    if (!containerEl) return; // unmounted while the chunk loaded
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const labelColor = dark ? "#e5e7eb" : "#1e293b";
    const edgeColor = dark ? "#475569" : "#cbd5e1";

    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
    const elements = [
      ...g.nodes.map((n) => ({ data: { id: n.id, label: n.label, section: n.section } })),
      ...g.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target } })),
    ];

    const sectionStyles = Object.entries(SECTION_COLORS).map(([section, color]) => ({
      selector: `node[section = "${section}"]`,
      style: { "background-color": color },
    }));

    cy = cytoscape({
      container,
      elements,
      layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 80 },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 9,
            color: labelColor,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 3,
            "min-zoomed-font-size": 7,
            width: 14,
            height: 14,
            "border-width": 0,
          },
        },
        ...sectionStyles,
        {
          selector: 'node[section = "unresolved"]',
          style: { "background-opacity": 0.25, "border-width": 1, "border-color": edgeColor, "border-style": "dashed" },
        },
        {
          selector: "edge",
          style: { width: 1, "line-color": edgeColor, "curve-style": "haystack", opacity: 0.6 },
        },
        { selector: "node:selected", style: { "border-width": 3, "border-color": "#0ea5e9" } },
      ],
    });

    cy.on("tap", "node", (evt: { target: { id(): string } }) => {
      selected = nodeById.get(evt.target.id()) ?? null;
    });
    cy.on("tap", (evt: { target: unknown }) => {
      if (evt.target === cy) selected = null;
    });
  }
</script>

<Modal cardClass="graph-modal-card" ariaLabelledby="graph-title" on:close={() => dispatch("close")}>
  <div class="graph-head">
    <div>
      <h2 id="graph-title">{title}</h2>
      <p class="muted">노트 사이의 <code>[[링크]]</code> 연결을 시각화합니다. 드래그·휠 줌·노드 클릭이 가능합니다.</p>
    </div>
    <button class="linkish small" type="button" on:click={() => dispatch("close")}>닫기</button>
  </div>

  {#if loading}
    <div class="graph-state muted">그래프를 불러오는 중…</div>
  {:else if error}
    <div class="graph-state error-note">불러오기 실패: {error}</div>
  {:else if graph?.noVault}
    <div class="graph-state muted">
      이 저장소는 아직 vault 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게
      <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.
    </div>
  {:else if !graph?.nodes.length}
    <div class="graph-state muted">아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다.</div>
  {:else}
    <div class="graph-canvas" bind:this={containerEl}></div>
    <div class="graph-footer">
      <div class="graph-legend">
        {#each presentSections as s}
          <span class="legend-chip">
            <span class="legend-dot" style={`background:${SECTION_COLORS[s]}`}></span>{SECTION_LABELS[s] ?? s}
          </span>
        {/each}
      </div>
      {#if selected}
        <div class="graph-info">
          <strong>{selected.label}</strong>
          {#if !selected.dangling}<code class="muted">{selected.id}</code>{:else}<span class="muted">미연결 링크 — 아직 노트 없음</span>{/if}
          {#if selected.tags.length}<span class="muted">#{selected.tags.join(" #")}</span>{/if}
        </div>
      {:else}
        <div class="graph-info muted">{graph.nodes.length}개 노트 · {graph.edges.length}개 연결</div>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .graph-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .graph-head p {
    margin: var(--s-1) 0 0;
    font-size: var(--t-sm);
  }
  .graph-state {
    padding: var(--s-6) var(--s-2);
    text-align: center;
    line-height: 1.6;
  }
  .graph-canvas {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--bg);
    overflow: hidden;
  }
  .graph-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .graph-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-3);
  }
  .legend-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .legend-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }
  .graph-info {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--t-sm);
    min-width: 0;
  }
  .graph-info code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
