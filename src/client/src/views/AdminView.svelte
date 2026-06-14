<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import { api } from "../lib/api";
  import { loadAdminGroups, loadAdminOverview } from "../lib/loaders";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { formatDate } from "../lib/format";
  import type { AdminGroupSummary, AdminTab, AdminUserSummary, AvatarVisibility, SignupMode } from "../lib/types";

  let loading = true;
  let error = "";
  let userSearch = "";
  let groupName = "";
  let groupDescription = "";
  let model = "";
  let claudeToken = "";
  let signupMode: SignupMode = "open";

  const tabs: { id: AdminTab; label: string }[] = [
    { id: "overview", label: "개요" },
    { id: "users", label: "사용자" },
    { id: "groups", label: "그룹" },
    { id: "access", label: "가입/권한" },
    { id: "system", label: "시스템" },
    { id: "audit", label: "감사" },
  ];

  onMount(load);

  $: users = $appState.adminUsers.filter((user) => {
    const q = userSearch.trim().toLowerCase();
    return !q || [user.username, user.displayName, user.roles.join(" ")].join(" ").toLowerCase().includes(q);
  });
  $: signupMode = (($appState.adminSystem?.signupMode as SignupMode) || $appState.bootstrap?.signupMode || "open") as SignupMode;

  async function load() {
    loading = true;
    error = "";
    try {
      await Promise.all([loadAdminOverview(), loadAdminGroups()]);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function mutateUser(user: AdminUserSummary, action: string, body: unknown = {}) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
        method: action === "visibility" ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      await loadAdminOverview();
      notify("사용자 정보를 변경했습니다.", "ok");
    } catch (err) {
      notify(`사용자 변경 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function deleteUser(user: AdminUserSummary) {
    if (!window.confirm(`${user.username} 계정을 삭제할까요?`)) return;
    await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    await loadAdminOverview();
  }

  async function setUserVisibility(user: AdminUserSummary, visibility: AvatarVisibility) {
    await mutateUser(user, "visibility", { visibility });
  }

  async function createGroup() {
    const { group } = await api<{ group: AdminGroupSummary }>("/api/admin/groups", {
      method: "POST",
      body: JSON.stringify({ name: groupName, description: groupDescription }),
    });
    replaceState({ adminGroups: [group, ...$appState.adminGroups] });
    groupName = "";
    groupDescription = "";
    notify("그룹을 만들었습니다.", "ok");
  }

  async function deleteGroup(group: AdminGroupSummary) {
    if (!window.confirm(`${group.name} 그룹을 삭제할까요?`)) return;
    await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
    await loadAdminGroups();
  }

  async function saveSignupMode() {
    await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode: signupMode }) });
    if ($appState.bootstrap) replaceState({ bootstrap: { ...$appState.bootstrap, signupMode } });
    notify("가입 정책을 저장했습니다.", "ok");
  }

  async function saveModel(clear = false) {
    if (clear) await api("/api/admin/model", { method: "DELETE" });
    else await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model }) });
    model = "";
    await loadAdminOverview();
    notify("모델 설정을 저장했습니다.", "ok");
  }

  async function saveClaudeToken(clear = false) {
    if (clear) await api("/api/admin/claude-token", { method: "DELETE" });
    else await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token: claudeToken }) });
    claudeToken = "";
    await loadAdminOverview();
    notify("Claude 토큰 설정을 저장했습니다.", "ok");
  }
</script>

<header class="view-header">
  <div>
    <h1>관리자</h1>
    <p>사용자, 그룹, 시스템 설정을 관리합니다</p>
  </div>
  <button class="ghost-sm" type="button" on:click={load}>새로고침</button>
</header>

<div class="view-body scroll-thin settings-body">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      관리자 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    <div class="tabbar" role="tablist">
      {#each tabs as tab}
        <button type="button" class:active={$appState.adminTab === tab.id} on:click={() => updateState((state) => (state.adminTab = tab.id))}>{tab.label}</button>
      {/each}
    </div>

    {#if $appState.adminTab === "overview"}
      <section class="admin-stats">
        {#each Object.entries($appState.adminStats || {}) as [key, value]}
          <div class="stat-card">
            <span>{key}</span>
            <strong>{value}</strong>
          </div>
        {/each}
      </section>
    {:else if $appState.adminTab === "users"}
      <section class="settings-card">
        <div class="field-row">
          <h3>사용자</h3>
          <input class="explore-search" type="search" placeholder="사용자 검색" bind:value={userSearch} />
        </div>
        <div class="admin-user-list">
          {#each users as user (user.id)}
            <article class="admin-user-row">
              <AvatarImage user={user} size={40} />
              <div>
                <strong>{user.displayName}</strong>
                <div class="muted">@{user.username} · {user.roles.join(", ") || "user"} · {user.visibility}</div>
                <div class="muted">세션 {user.activeSessions} · 마지막 접속 {formatDate(user.lastSeenAt)}</div>
              </div>
              <div class="button-row">
                <button class="ghost-sm" type="button" on:click={() => mutateUser(user, "roles", { roles: user.roles.includes("admin") ? [] : ["admin"] })}>{user.roles.includes("admin") ? "관리자 해제" : "관리자 지정"}</button>
                <select value={user.visibility} on:change={(event) => setUserVisibility(user, event.currentTarget.value as AvatarVisibility)}>
                  <option value="public">공개</option>
                  <option value="group">그룹</option>
                  <option value="private">비공개</option>
                </select>
                <button class="ghost-sm" type="button" on:click={() => mutateUser(user, "suspend", { suspended: !user.suspended })}>{user.suspended ? "활성화" : "정지"}</button>
                <button class="ghost-sm" type="button" on:click={() => mutateUser(user, "logout")}>세션 종료</button>
                <button class="danger small" type="button" on:click={() => deleteUser(user)}>삭제</button>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {:else if $appState.adminTab === "groups"}
      <section class="settings-card">
        <h3>그룹 생성</h3>
        <div class="grid-2">
          <label class="field"><span>이름</span><input bind:value={groupName} /></label>
          <label class="field"><span>설명</span><input bind:value={groupDescription} /></label>
        </div>
        <button class="primary" type="button" on:click={createGroup} disabled={!groupName}>그룹 만들기</button>
      </section>
      <section class="settings-card">
        <h3>그룹 목록</h3>
        <div class="group-list">
          {#each $appState.adminGroups as group (group.id)}
            <article class="group-card">
              <div>
                <strong>{group.name}</strong>
                <p>{group.description}</p>
                <div class="muted">멤버 {group.memberCount} · 관리자 {group.adminCount}</div>
              </div>
              <button class="danger small" type="button" on:click={() => deleteGroup(group)}>삭제</button>
            </article>
          {/each}
        </div>
      </section>
    {:else if $appState.adminTab === "access"}
      <section class="settings-card">
        <h3>가입 정책</h3>
        <label class="field">
          <span>신규 가입</span>
          <select bind:value={signupMode}>
            <option value="open">즉시 허용</option>
            <option value="approval">관리자 승인</option>
            <option value="closed">비활성화</option>
          </select>
        </label>
        <button class="primary" type="button" on:click={saveSignupMode}>저장</button>
      </section>
    {:else if $appState.adminTab === "system"}
      <section class="settings-card">
        <h3>시스템</h3>
        <pre class="code-lite">{JSON.stringify($appState.adminSystem, null, 2)}</pre>
      </section>
      <section class="settings-card">
        <h3>모델 / 토큰</h3>
        <label class="field"><span>Claude 모델</span><input bind:value={model} placeholder="예: claude-sonnet-4-5" /></label>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveModel(false)} disabled={!model}>저장</button>
          <button class="ghost-sm" type="button" on:click={() => saveModel(true)}>환경 기본값 사용</button>
        </div>
        <label class="field"><span>Claude 토큰</span><input type="password" bind:value={claudeToken} autocomplete="off" /></label>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveClaudeToken(false)} disabled={!claudeToken}>저장</button>
          <button class="ghost-sm" type="button" on:click={() => saveClaudeToken(true)}>삭제</button>
        </div>
      </section>
    {:else if $appState.adminTab === "audit"}
      <section class="settings-card">
        <h3>감사 로그</h3>
        <div class="audit-list">
          {#each $appState.audit as event (event.id)}
            <article class="audit-row">
              <strong>{event.action}</strong>
              <span>{event.actorName || "system"} · {event.status} · {formatDate(event.createdAt)}</span>
              <p>{event.detail}</p>
            </article>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>
