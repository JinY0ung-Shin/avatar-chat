<script lang="ts">
  import Self from "./ActivityTree.svelte";
  import type { LiveAgentNode, LiveToolRow } from "../lib/types";

  export let agentId = "main";
  export let agents: LiveAgentNode[];
  export let tools: LiveToolRow[];

  $: node = agents.find((a) => a.id === agentId);
  $: ownTools = tools.filter((t) => t.agentId === agentId);
  $: children = agents.filter((a) => a.parentId === agentId && !a.isMain);
</script>

{#if node}
  <div class={`agent-node ${node.isMain ? "is-main" : "sub"}`} data-status={node.status}>
    {#if !node.isMain}
      <div class="agent-head">
        <span class="agent-spinner"></span>
        <span class="agent-badge">에이전트</span>
        <span class="agent-label">{node.label}</span>
      </div>
    {/if}
    {#if ownTools.length}
      <div class="agent-tools">
        {#each ownTools as row (row.id)}
          <div class={`tool-row ${row.kind === "blocked" ? "blocked" : ""} ${row.kind === "task" ? "task-row" : ""}`} data-status={row.status}>
            {#if row.status === "blocked"}
              <span class="tool-dot"></span>
            {:else}
              <span class="tool-spinner"></span>
            {/if}
            <span class="tool-name">{row.label}</span>
            {#if row.detail}<span class="tool-arg">{row.detail}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if children.length}
      <div class="agent-children">
        {#each children as child (child.id)}
          <Self agentId={child.id} {agents} {tools} />
        {/each}
      </div>
    {/if}
  </div>
{/if}
