<script lang="ts">
  import Self from "./ActivityTree.svelte";
  import type { LiveAgentNode, LiveTaskRow, LiveToolRow } from "../lib/types";

  export let agentId = "main";
  export let agents: LiveAgentNode[];
  export let tools: LiveToolRow[];
  export let tasks: LiveTaskRow[] = [];

  $: node = agents.find((a) => a.id === agentId);
  $: ownTools = tools.filter((t) => t.agentId === agentId && t.kind !== "task");
  $: ownTasks = [
    ...tasks.filter((t) => t.agentId === agentId),
    ...tools
      .filter((t) => t.agentId === agentId && t.kind === "task")
      .map((t) => ({
        id: t.id,
        agentId: t.agentId,
        label: t.label,
        detail: t.detail,
        status: t.status === "failed" ? "failed" : t.status === "running" ? "running" : "done",
      } satisfies LiveTaskRow)),
  ];
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
    {#if ownTasks.length}
      <div class="agent-tasks">
        {#each ownTasks as row (row.id)}
          <div class="task-row" data-status={row.status}>
            <span class="task-spinner"></span>
            <span class="task-badge">태스크</span>
            {#if row.label}<span class="task-name">{row.label}</span>{/if}
            {#if row.detail}<span class="task-detail">{row.detail}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if ownTools.length}
      <div class="agent-tools">
        {#each ownTools as row (row.id)}
          <div class={`tool-row ${row.kind === "blocked" ? "blocked" : ""}`} data-status={row.status}>
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
          <Self agentId={child.id} {agents} {tools} {tasks} />
        {/each}
      </div>
    {/if}
  </div>
{/if}
