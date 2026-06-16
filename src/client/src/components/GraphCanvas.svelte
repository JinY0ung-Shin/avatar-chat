<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";

  // Reusable interactive knowledge-graph canvas (Obsidian-style). Renders a
  // `[[wikilink]]` {graph} with cytoscape, which is lazy-imported as its own
  // Vite chunk (kept out of the main bundle) and is CSP-safe — canvas rendering,
  // no eval/Function. Both GraphViewModal (settings) and BrainView (full page)
  // embed this; the parent owns fetching + the selected-note panel and listens
  // for the `select` event. Mirrors CanvasPanel's lazy-lib pattern.

  export let graph: KnowledgeGraph;
  // Id of the externally-selected node, so the parent can keep the highlight in
  // sync (e.g. when it clears the side panel). `null` = nothing selected.
  export let selectedId: string | null = null;

  const dispatch = createEventDispatcher<{ select: KnowledgeGraphNode | null }>();

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

  let containerEl: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cy: any = null;
  // The graph reference currently rendered, so a new non-empty `graph` re-inits
  // (rather than showing the stale one) even if the parent swaps it in place.
  let renderedGraph: KnowledgeGraph | undefined;

  $: presentSections = graph
    ? [...new Set(graph.nodes.map((n) => n.section))].filter((s) => s in SECTION_COLORS)
    : [];

  // (Re)init whenever the container is mounted and the non-empty graph changes.
  $: if (containerEl && graph && graph.nodes.length && graph !== renderedGraph) {
    cy?.destroy();
    cy = null;
    renderedGraph = graph;
    void initCy(graph, containerEl);
  }

  // Keep the cytoscape selection in sync with the parent's `selectedId` (e.g.
  // when the parent clears the panel or selects from outside the canvas).
  $: if (cy) syncSelection(selectedId);

  function syncSelection(id: string | null): void {
    if (!cy) return;
    cy.batch(() => {
      cy.elements(":selected").unselect();
      if (id) cy.getElementById(id).select();
    });
  }

  onDestroy(() => {
    cy?.destroy();
    cy = null;
  });

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
      dispatch("select", nodeById.get(evt.target.id()) ?? null);
    });
    cy.on("tap", (evt: { target: unknown }) => {
      if (evt.target === cy) dispatch("select", null);
    });

    syncSelection(selectedId);
  }
</script>

<div class="graph-canvas" bind:this={containerEl}></div>
<div class="graph-legend">
  {#each presentSections as s}
    <span class="legend-chip">
      <span class="legend-dot" style={`background:${SECTION_COLORS[s]}`}></span>{SECTION_LABELS[s] ?? s}
    </span>
  {/each}
</div>

<style>
  .graph-canvas {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--bg);
    overflow: hidden;
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
</style>
