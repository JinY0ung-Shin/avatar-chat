<script lang="ts">
  import Icon from "./Icon.svelte";
  import AdminExternalAgentModal from "./AdminExternalAgentModal.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { loadAvatars } from "../lib/loaders";
  import { notify } from "../lib/state";
  import type {
    AdminExternalAgent,
    AdminExternalAgentInput,
    AdminGroupSummary,
  } from "../lib/types";

  export let active = false;
  export let groups: AdminGroupSummary[] = [];
  export let reloadGroups: () => Promise<void> = async () => {};

  let agents: AdminExternalAgent[] = [];
  let loading = false;
  let refreshBusy = false;
  let initialized = false;
  let error = "";
  let configError: "decrypt_failed" | "invalid" | null = null;
  let shadowedManagedIds: string[] = [];
  let query = "";
  let editorOpen = false;
  let editing: AdminExternalAgent | null = null;
  let rowBusy: Record<string, boolean> = {};
  let rowStatus: Record<string, string> = {};

  $: if (active && !initialized && !loading) void load();
  $: shownAgents = (() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [
        agent.id,
        agent.displayName,
        agent.alias,
        agent.bio,
        agent.endpoint,
        agent.model || "",
        ...agent.hashtags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  })();

  function agentInput(
    agent: AdminExternalAgent,
  ): AdminExternalAgentInput {
    return {
      id: agent.id,
      displayName: agent.displayName,
      alias: agent.alias,
      bio: agent.bio,
      persona: agent.persona,
      intro: agent.intro,
      hashtags: [...agent.hashtags],
      endpoint: agent.endpoint,
      agent: "claude",
      enabled: agent.enabled,
      model: agent.model || "",
      system: agent.system || "",
      ...(agent.visibleToGroupIds
        ? { visibleToGroupIds: [...agent.visibleToGroupIds] }
        : {}),
      ...(agent.connectTimeoutSeconds
        ? { connectTimeoutSeconds: agent.connectTimeoutSeconds }
        : {}),
      ...(agent.idleTimeoutSeconds
        ? { idleTimeoutSeconds: agent.idleTimeoutSeconds }
        : {}),
      ...(agent.totalTimeoutSeconds
        ? { totalTimeoutSeconds: agent.totalTimeoutSeconds }
        : {}),
      apiKeyMode: "keep",
    };
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const result = await api<{
        agents: AdminExternalAgent[];
        configError: "decrypt_failed" | "invalid" | null;
        shadowedManagedIds: string[];
      }>("/api/admin/external-agents");
      agents = result.agents;
      configError = result.configError;
      shadowedManagedIds = result.shadowedManagedIds || [];
      initialized = true;
    } catch (err) {
      error = (err as Error).message;
      initialized = true;
    } finally {
      loading = false;
    }
  }

  async function refresh(): Promise<void> {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      await Promise.all([load(), reloadGroups()]);
    } catch (err) {
      notify(`그룹 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      refreshBusy = false;
    }
  }

  async function refreshRuntimeAvatars(): Promise<void> {
    try {
      await loadAvatars(true);
    } catch (err) {
      notify(
        `설정은 반영됐지만 탐색 목록 새로고침에 실패했습니다: ${(err as Error).message}`,
        "warn",
      );
    }
  }

  function openCreate(): void {
    if (configError) return;
    editing = null;
    editorOpen = true;
  }

  function openEdit(agent: AdminExternalAgent): void {
    if (agent.source !== "managed") return;
    editing = agent;
    editorOpen = true;
  }

  async function saved(): Promise<void> {
    initialized = false;
    await Promise.all([load(), refreshRuntimeAvatars()]);
  }

  async function testSaved(agent: AdminExternalAgent): Promise<void> {
    if (rowBusy[agent.id]) return;
    rowBusy = { ...rowBusy, [agent.id]: true };
    rowStatus = { ...rowStatus, [agent.id]: "Gateway 인증과 모델 목록을 확인하는 중…" };
    try {
      const result = await api<{
        latencyMs: number;
        modelsCount: number;
        modelAvailable: boolean | null;
      }>("/api/admin/external-agents/test", {
        method: "POST",
        body: JSON.stringify({ storedId: agent.id }),
      });
      rowStatus = {
        ...rowStatus,
        [agent.id]:
          result.modelAvailable === false
            ? `연결됨 · 모델 목록에서 설정 모델을 찾지 못함 · ${result.latencyMs}ms`
            : `연결됨 · Claude 모델 ${result.modelsCount}개 · ${result.latencyMs}ms`,
      };
    } catch (err) {
      rowStatus = {
        ...rowStatus,
        [agent.id]: `연결 확인 실패: ${(err as Error).message}`,
      };
    } finally {
      rowBusy = { ...rowBusy, [agent.id]: false };
    }
  }

  async function toggleEnabled(agent: AdminExternalAgent): Promise<void> {
    if (agent.source !== "managed" || rowBusy[agent.id]) return;
    const nextEnabled = !agent.enabled;
    if (
      !nextEnabled &&
      !(await confirmAction(
        `"${agent.displayName}" 외부 아바타를 비활성화할까요?\n탐색과 새 대화 턴에서는 사라지지만 기존 대화 기록은 유지됩니다.`,
      ))
    ) {
      return;
    }
    rowBusy = { ...rowBusy, [agent.id]: true };
    rowStatus = {
      ...rowStatus,
      [agent.id]: nextEnabled ? "활성화하는 중…" : "비활성화하는 중…",
    };
    try {
      await api(`/api/admin/external-agents/${encodeURIComponent(agent.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          agent: { ...agentInput(agent), enabled: nextEnabled },
        }),
      });
      notify(
        `외부 아바타 "${agent.displayName}"을 ${nextEnabled ? "활성화" : "비활성화"}했습니다.`,
        "ok",
      );
      await saved();
    } catch (err) {
      rowStatus = {
        ...rowStatus,
        [agent.id]: `상태 변경 실패: ${(err as Error).message}`,
      };
    } finally {
      rowBusy = { ...rowBusy, [agent.id]: false };
    }
  }

  async function remove(agent: AdminExternalAgent): Promise<void> {
    if (agent.source !== "managed" || rowBusy[agent.id]) return;
    if (agent.conversationCount > 0) {
      notify("기존 대화 기록이 있는 외부 아바타는 비활성화만 할 수 있습니다.", "info");
      return;
    }
    if (
      !(await confirmAction(
        `"${agent.displayName}" 외부 아바타 설정을 완전히 삭제할까요?`,
      ))
    ) {
      return;
    }
    rowBusy = { ...rowBusy, [agent.id]: true };
    rowStatus = { ...rowStatus, [agent.id]: "삭제하는 중…" };
    try {
      await api(`/api/admin/external-agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      notify(`외부 아바타 "${agent.displayName}"을 삭제했습니다.`, "ok");
      await saved();
    } catch (err) {
      rowStatus = {
        ...rowStatus,
        [agent.id]: `삭제 실패: ${(err as Error).message}`,
      };
    } finally {
      rowBusy = { ...rowBusy, [agent.id]: false };
    }
  }
</script>

{#if active}
  <div class="admin-users external-agents-panel">
    <section class="settings-card">
      <div class="panel-section-head external-agents-head">
        <div>
          <h3>외부 아바타</h3>
          <p class="muted">
            oh-my-gateway 호환 stateless Agent를 Noah 아바타로 노출합니다. 공개 범위는 Noah가,
            시스템 지침과 도구 권한은 Gateway가 관리합니다.
          </p>
        </div>
        <div class="ar-actions">
          <button class="ghost-sm" type="button" disabled={loading || refreshBusy} on:click={refresh}>
            {loading || refreshBusy ? "새로고침 중…" : "새로고침"}
          </button>
          <button class="primary small" type="button" disabled={Boolean(configError)} on:click={openCreate}>
            <Icon name="plus" size={16} /> 추가
          </button>
        </div>
      </div>

      {#if configError}
        <div class="warn-box" role="alert">
          {configError === "decrypt_failed"
            ? "저장된 설정을 복호화할 수 없습니다. SESSION_SECRET 변경 여부를 확인해 주세요. 안전을 위해 UI 관리 아바타를 노출하지 않습니다."
            : "저장된 설정 형식이 손상되었습니다. 안전을 위해 UI 관리 아바타를 노출하지 않습니다."}
        </div>
      {/if}
      {#if shadowedManagedIds.length}
        <div class="warn-box" role="status">
          환경 변수 항목과 ID가 겹쳐 숨겨진 UI 설정: {shadowedManagedIds.join(", ")}
        </div>
      {/if}
      {#if error}
        <div class="warn-box" role="alert">
          외부 아바타 설정을 불러오지 못했습니다: {error}
          <button class="linkish" type="button" disabled={loading} on:click={load}>다시 시도</button>
        </div>
      {:else}
        <div class="admin-users-head">
          <input
            type="search"
            class="admin-search"
            bind:value={query}
            placeholder="이름·ID·endpoint·태그 검색"
            aria-label="외부 아바타 검색"
            disabled={!agents.length}
          />
          <span class="muted nowrap">
            {#if shownAgents.length === agents.length}총 {agents.length}개{:else}표시 {shownAgents.length}개 / 전체 {agents.length}개{/if}
          </span>
        </div>

        <div class="admin-list external-agent-list" aria-busy={loading}>
          {#if loading && !initialized}
            <div class="muted pad" role="status">외부 아바타 설정을 불러오는 중…</div>
          {:else if configError && !agents.length}
            <div class="empty-note external-agent-empty" role="status">
              <strong>저장된 설정을 복구해야 합니다.</strong>
              <span class="muted">SESSION_SECRET과 암호화된 registry를 확인한 뒤 새로고침해 주세요. 복구 전에는 설정을 덮어쓰지 않습니다.</span>
            </div>
          {:else if !agents.length}
            <div class="empty-note external-agent-empty">
              <strong>등록된 외부 아바타가 없습니다.</strong>
              <span class="muted">Gateway endpoint와 공개 그룹을 설정해 첫 외부 아바타를 추가하세요.</span>
              <button class="primary small" type="button" disabled={Boolean(configError)} on:click={openCreate}>외부 아바타 추가</button>
            </div>
          {:else if !shownAgents.length}
            <div class="muted pad">
              "{query.trim()}"에 맞는 외부 아바타가 없습니다.
              <button class="linkish small" type="button" on:click={() => (query = "")}>검색어 지우기</button>
            </div>
          {:else}
            {#each shownAgents as agent (agent.source + agent.id)}
              <article class="admin-user external-agent-row" class:is-disabled={!agent.enabled}>
                <div class="admin-row">
                  <div class="external-agent-mark" aria-hidden="true"><Icon name="globe" size={18} /></div>
                  <div class="ar-main">
                    <strong>{agent.displayName}</strong>
                    <div class="muted external-agent-id">external:{agent.id}</div>
                    <div class="muted external-agent-endpoint">{agent.endpoint}</div>
                  </div>
                  <div class="ar-tags">
                    <span class="tag {agent.source === 'environment' ? 'mono' : 'accent'}">
                      {agent.source === "environment" ? "환경 변수" : "UI 관리"}
                    </span>
                    <span class="tag {agent.enabled ? 'read' : 'danger'}">{agent.enabled ? "활성" : "비활성"}</span>
                    <span class="tag">{agent.visibleToGroupIds?.length ? `그룹 ${agent.visibleToGroupIds.length}개` : "모든 사용자"}</span>
                    {#if agent.apiKeySet}<span class="tag write">API 키 설정됨</span>{/if}
                    {#if agent.model}<span class="tag mono">{agent.model}</span>{/if}
                    {#if agent.conversationCount}<span class="tag">대화 {agent.conversationCount}</span>{/if}
                  </div>
                  <div class="ar-actions">
                    <button class="ghost-sm" type="button" disabled={rowBusy[agent.id]} on:click={() => testSaved(agent)}>
                      {rowBusy[agent.id] ? "확인 중…" : "인증·모델 확인"}
                    </button>
                    {#if agent.source === "managed"}
                      <button class="ghost-sm" type="button" disabled={rowBusy[agent.id]} on:click={() => openEdit(agent)}>편집</button>
                      <button class="ghost-sm" type="button" disabled={rowBusy[agent.id]} on:click={() => toggleEnabled(agent)}>
                        {agent.enabled ? "비활성화" : "활성화"}
                      </button>
                      <button
                        class="ghost-sm danger"
                        type="button"
                        disabled={rowBusy[agent.id] || agent.conversationCount > 0}
                        aria-describedby={agent.conversationCount > 0 ? `external-agent-status-${agent.id}` : undefined}
                        on:click={() => remove(agent)}
                      >삭제</button>
                    {/if}
                  </div>
                </div>
                {#if agent.source === "environment" || rowStatus[agent.id] || agent.conversationCount > 0}
                  <div class="external-agent-row-note muted" id={`external-agent-status-${agent.id}`} role="status" aria-live="polite">
                    {#if rowStatus[agent.id]}<span>{rowStatus[agent.id]}</span>{/if}
                    {#if agent.source === "environment"}<span>이 항목은 EXTERNAL_AGENTS_JSON에서 관리되어 연결 확인만 할 수 있습니다.</span>{/if}
                    {#if agent.conversationCount > 0 && agent.source === "managed"}<span>기존 대화 기록이 있어 완전 삭제 대신 비활성화할 수 있습니다.</span>{/if}
                  </div>
                {/if}
              </article>
            {/each}
          {/if}
        </div>
      {/if}
    </section>
  </div>
{/if}

{#if editorOpen}
  <AdminExternalAgentModal
    agent={editing}
    {groups}
    on:close={() => (editorOpen = false)}
    on:saved={saved}
  />
{/if}
