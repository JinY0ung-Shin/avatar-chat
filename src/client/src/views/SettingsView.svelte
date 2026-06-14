<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import SettingsProfileTab from "../components/SettingsProfileTab.svelte";
  import SettingsAccessTab from "../components/SettingsAccessTab.svelte";
  import SettingsKnowledgeTab from "../components/SettingsKnowledgeTab.svelte";
  import SettingsGroupCard from "../components/SettingsGroupCard.svelte";
  import type { SettingsGroup } from "../components/SettingsGroupCard.svelte";
  import { api } from "../lib/api";
  import { loadSettingsData } from "../lib/loaders";
  import { appState, updateState } from "../lib/state";

  const tabs = [
    { id: "profile", label: "프로필", icon: "user" },
    { id: "access", label: "권한·연결", icon: "shield" },
    { id: "knowledge", label: "지식·플러그인", icon: "book" },
    { id: "groups", label: "그룹", icon: "users" },
  ] as const;

  let loading = true;
  let error = "";

  // groups
  let groups: SettingsGroup[] = [];
  let groupsLoading = false;
  let groupsError = "";

  $: user = $appState.user;
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: settingsTab = $appState.settingsTab;

  onMount(load);

  // Load groups when the groups tab is first opened.
  $: if (settingsTab === "groups" && !loading && user && !groupsLoading && !groups.length && !groupsError) {
    void loadGroups();
  }

  async function load(): Promise<void> {
    loading = true;
    error = "";
    try {
      await loadSettingsData();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function loadGroups(): Promise<void> {
    groupsLoading = true;
    groupsError = "";
    try {
      const { groups: next } = await api<{ groups: SettingsGroup[] }>("/api/me/groups");
      groups = next;
    } catch (err) {
      groupsError = (err as Error).message;
    } finally {
      groupsLoading = false;
    }
  }
</script>

<header class="view-header">
  <div>
    <h1>내 아바타</h1>
    <p>프로필과 플러그인을 관리하고 공개하세요</p>
  </div>
</header>

<div class="view-body scroll-thin settings-body" class:settings-body-access={settingsTab === "access"}>
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      설정 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else if user}
    <div class="settings-tabs" role="tablist" aria-label="설정 분류">
      {#each tabs as tab}
        <button
          class="settings-tab"
          type="button"
          role="tab"
          class:active={settingsTab === tab.id}
          aria-selected={settingsTab === tab.id}
          tabindex={settingsTab === tab.id ? 0 : -1}
          on:click={() => updateState((state) => (state.settingsTab = tab.id))}
        >
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <div class="settings-panel" class:settings-panel-access={settingsTab === "access"} role="tabpanel">
      <SettingsProfileTab active={settingsTab === "profile"} />
      <SettingsAccessTab active={settingsTab === "access"} />
      <SettingsKnowledgeTab active={settingsTab === "knowledge"} />
      {#if settingsTab === "groups"}
        <section class="settings-card">
          <div class="panel-section-head">
            <div>
              <h3>그룹</h3>
              <p class="muted">
                내가 속한 그룹과 동료입니다. 같은 그룹 동료끼리는 자동으로 서로 신뢰해 아바타에 권한이 부여됩니다. 그룹 관리자는 멤버와 공용 지식 저장소를 관리할 수
                있어요. 그룹 생성·삭제는 시스템 관리자가 합니다.
              </p>
            </div>
          </div>
          <div class="groups-body">
            {#if groupsLoading}
              <div class="muted">불러오는 중…</div>
            {:else if groupsError}
              <div class="warn-box">그룹을 불러오지 못했습니다: {groupsError} <button class="linkish" type="button" on:click={loadGroups}>다시 시도</button></div>
            {:else if !groups.length}
              <div class="empty-note">아직 속한 그룹이 없습니다. 그룹은 시스템 관리자가 만들고 멤버를 추가합니다.</div>
            {:else}
              {#each groups as group (group.id)}
                <SettingsGroupCard {group} {githubHost} reload={loadGroups} />
              {/each}
            {/if}
          </div>
        </section>
      {/if}
    </div>
  {/if}
</div>
