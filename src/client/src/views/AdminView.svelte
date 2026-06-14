<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import RevealableInput from "../components/RevealableInput.svelte";
  import AdminUserRow from "../components/AdminUserRow.svelte";
  import AdminGroupRow from "../components/AdminGroupRow.svelte";
  import { api } from "../lib/api";
  import { loadAdminGroups, loadAdminOverview } from "../lib/loaders";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import type { AdminGroupSummary, AdminTab, AdminUserSummary, SignupMode } from "../lib/types";

  let loading = true;
  let error = "";

  // group create form
  let newGroupName = "";
  let newGroupDescription = "";
  let creatingGroup = false;

  // system tab field state
  let modelInput = "";
  let claudeToken = "";
  let subBusy = false;
  let modelBusy = false;
  let hexBusy = false;
  // hex-ssh policy local checkbox matrix: policy[role][toolName] = boolean
  let hexPolicy: Record<string, Record<string, boolean>> = {};

  // audit action filter
  let auditAction = "";

  type AdminTabDef = { id: AdminTab; label: string; icon: string };
  const tabs: AdminTabDef[] = [
    { id: "overview", label: "개요", icon: "activity" },
    { id: "users", label: "사용자", icon: "users" },
    { id: "groups", label: "그룹", icon: "users" },
    { id: "access", label: "가입·접근", icon: "key" },
    { id: "system", label: "시스템", icon: "server" },
    { id: "audit", label: "감사 로그", icon: "list" },
  ];

  const userFilters: { id: typeof $appState.adminUserFilter; label: string; match: (u: AdminUserSummary) => boolean }[] = [
    { id: "all", label: "전체", match: () => true },
    { id: "admins", label: "관리자", match: (u) => u.roles?.includes("admin") },
    { id: "suspended", label: "정지", match: (u) => u.suspended },
    { id: "public", label: "공개", match: (u) => u.visibility === "public" },
    { id: "sessions", label: "활성 세션", match: (u) => (u.activeSessions || 0) > 0 },
  ];

  const roleDefs = [
    { key: "owner", label: "소유자" },
    { key: "trusted", label: "신뢰 동료" },
    { key: "colleague", label: "일반 동료" },
  ];
  const categoryLabels: Record<string, string> = { read: "조회", execute: "실행", write: "수정·전송", session: "세션" };

  const signupModes = [
    { id: "open" as SignupMode, label: "개방", desc: "누구나 즉시 가입하고 바로 사용할 수 있습니다." },
    { id: "approval" as SignupMode, label: "승인 후 사용", desc: "가입은 가능하지만 관리자가 활성화해야 로그인됩니다. 대기 중인 계정은 사용자 탭에 ‘정지’ 상태로 표시됩니다." },
    { id: "closed" as SignupMode, label: "차단", desc: "신규 가입을 받지 않습니다." },
  ];

  onMount(load);

  // ---- derived ----
  // loadAdminOverview stores the raw GET /api/admin/system response, which is
  // shaped { system: {...} } — unwrap it (the old loadAdminSystem did r.system).
  function unwrapSystem(raw: Record<string, unknown> | null): Record<string, any> {
    if (!raw) return {};
    const inner = (raw as Record<string, any>).system;
    return (inner && typeof inner === "object" ? inner : raw) as Record<string, any>;
  }
  $: sys = unwrapSystem($appState.adminSystem);
  $: filterLabel = (id: string) => userFilters.find((f) => f.id === id)?.label || "전체";
  $: currentUserFilter = userFilters.find((f) => f.id === $appState.adminUserFilter) || userFilters[0];
  $: filteredUsers = (() => {
    const q = $appState.adminUserSearch.trim().toLowerCase();
    return $appState.adminUsers.filter(
      (u) =>
        currentUserFilter.match(u) &&
        (!q || (u.displayName || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q)),
    );
  })();
  $: groupQuery = $appState.adminGroupSearch.trim().toLowerCase();
  $: shownGroups = groupQuery
    ? $appState.adminGroups.filter((g) =>
        [g.name, g.description || "", g.knowledgeRepo ? "공용 저장소" : "", `멤버 ${g.memberCount}`, `관리자 ${g.adminCount}`]
          .join(" ")
          .toLowerCase()
          .includes(groupQuery),
      )
    : $appState.adminGroups;
  $: auditActions = [...new Set(($appState.audit || []).map((r) => r.action))].sort();
  $: shownAudit = auditAction ? ($appState.audit || []).filter((r) => r.action === auditAction) : $appState.audit || [];
  $: stats = $appState.adminStats;

  // overview stat cards
  $: statCards = [
    { label: "전체 사용자", value: stats?.users, sub: stats?.suspended ? `정지 ${stats.suspended}명 포함` : "", target: "users", filter: "all" },
    { label: "관리자", value: stats?.admins, sub: "", target: "users", filter: "admins" },
    { label: "공개 아바타", value: stats?.publicAvatars, sub: "", target: "users", filter: "public" },
    { label: "대화", value: stats?.conversations, sub: "", target: "", filter: "all" },
    { label: "메시지", value: stats?.messages, sub: "", target: "", filter: "all" },
    { label: "활성 루틴", value: stats?.activeRoutines, sub: "", target: "", filter: "all" },
    { label: "미응답 질문", value: stats?.openRequests, sub: "", target: "", filter: "all" },
    { label: "활성 세션", value: stats?.activeSessions, sub: "", target: "users", filter: "sessions" },
    { label: "그룹", value: stats?.groups, sub: "", target: "groups", filter: "all" },
  ] as { label: string; value: number | undefined; sub: string; target: string; filter: typeof $appState.adminUserFilter }[];

  async function load() {
    loading = true;
    error = "";
    try {
      await Promise.all([loadAdminOverview(), loadAdminGroups()]);
      syncHexPolicyFromSys();
      modelInput = String(unwrapSystem($appState.adminSystem).modelOverride || "");
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function setTab(id: AdminTab) {
    updateState((state) => (state.adminTab = id));
  }

  function goOverviewTarget(target: string, filter: typeof $appState.adminUserFilter) {
    if (!target) return;
    updateState((state) => {
      state.adminTab = target as AdminTab;
      if (target === "users") state.adminUserFilter = filter;
    });
  }

  function setUserFilter(id: typeof $appState.adminUserFilter) {
    updateState((state) => (state.adminUserFilter = id));
  }

  function userFilterCount(f: (u: AdminUserSummary) => boolean): number {
    return $appState.adminUsers.filter(f).length;
  }

  // ---- groups ----
  async function createGroup() {
    const name = newGroupName.trim();
    if (!name) {
      notify("그룹 이름을 입력하세요.", "warn");
      return;
    }
    creatingGroup = true;
    try {
      await api("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({ name, description: newGroupDescription.trim() }),
      });
    } catch (err) {
      creatingGroup = false;
      notify(`그룹 생성 실패: ${(err as Error).message}`);
      return;
    }
    newGroupName = "";
    newGroupDescription = "";
    updateState((state) => (state.adminGroupSearch = ""));
    try {
      await loadAdminGroups();
      notify(`그룹 "${name}"을 만들었습니다.`, "ok");
    } catch (err) {
      notify(`그룹은 만들었지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      creatingGroup = false;
    }
  }

  // ---- access ----
  async function saveSignupMode(mode: SignupMode) {
    try {
      await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode }) });
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await loadAdminOverview();
      if ($appState.bootstrap) replaceState({ bootstrap: { ...$appState.bootstrap, signupMode: mode } });
      notify("회원가입 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`회원가입 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }

  // ---- system: model ----
  async function saveModel() {
    const value = modelInput.trim();
    const successMessage = value ? "모델을 저장했습니다." : "모델 지정을 해제했습니다. SDK 기본값을 사용합니다.";
    modelBusy = true;
    try {
      if (value) await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model: value }) });
      else await api("/api/admin/model", { method: "DELETE" });
    } catch (err) {
      modelBusy = false;
      notify(`저장 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await loadAdminOverview();
      modelInput = String(unwrapSystem($appState.adminSystem).modelOverride || "");
      notify(successMessage, "ok");
    } catch (err) {
      notify(`모델 설정은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      modelBusy = false;
    }
  }

  // ---- system: subscription ----
  async function saveToken() {
    const token = claudeToken.trim();
    if (!token) {
      notify("토큰을 붙여넣어 주세요.", "warn");
      return;
    }
    subBusy = true;
    try {
      await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
    } catch (err) {
      subBusy = false;
      notify(`저장 실패: ${(err as Error).message}`);
      return;
    }
    claudeToken = "";
    try {
      await loadAdminOverview();
      notify("구독 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`구독 토큰은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      subBusy = false;
    }
  }

  async function disconnectToken() {
    if (!window.confirm("저장된 구독 토큰을 삭제할까요?")) return;
    subBusy = true;
    try {
      await api("/api/admin/claude-token", { method: "DELETE" });
    } catch (err) {
      subBusy = false;
      notify(`해제 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await loadAdminOverview();
      notify("구독 토큰 연결을 해제했습니다.", "ok");
    } catch (err) {
      notify(`구독 토큰은 삭제했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      subBusy = false;
    }
  }

  // ---- system: hex-ssh policy ----
  function syncHexPolicyFromSys() {
    const cur = unwrapSystem($appState.adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const policy = cur.hexSshToolPolicy || {};
    const next: Record<string, Record<string, boolean>> = {};
    for (const role of roleDefs) {
      next[role.key] = {};
      for (const tool of tools) {
        next[role.key][tool.name] = Array.isArray(policy[role.key]) && policy[role.key].includes(tool.name);
      }
    }
    hexPolicy = next;
  }

  async function saveHexPolicy() {
    const cur = unwrapSystem($appState.adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const nextPolicy: Record<string, string[]> = {};
    for (const role of roleDefs) {
      nextPolicy[role.key] = tools.filter((t: any) => hexPolicy[role.key]?.[t.name]).map((t: any) => t.name);
    }
    hexBusy = true;
    try {
      await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
    } catch (err) {
      hexBusy = false;
      notify(`저장 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncHexPolicyFromSys();
      notify("SSH 도구 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`SSH 도구 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      hexBusy = false;
    }
  }

  async function reloadUsers() {
    await loadAdminOverview();
  }
  async function reloadGroups() {
    await loadAdminGroups();
  }
</script>

<header class="view-header">
  <div>
    <h1>관리자</h1>
    <p>사용자·접근·시스템을 관리하세요</p>
  </div>
  <button class="ghost-sm" type="button" on:click={load}>새로고침</button>
</header>

<div class="view-body scroll-thin">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      관리자 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    <div class="settings-tabs" role="tablist" aria-label="관리자 분류">
      {#each tabs as tab}
        <button
          class="settings-tab"
          type="button"
          class:active={$appState.adminTab === tab.id}
          role="tab"
          aria-selected={$appState.adminTab === tab.id}
          tabindex={$appState.adminTab === tab.id ? 0 : -1}
          on:click={() => setTab(tab.id)}
        >
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <div class="admin-panel" role="tabpanel" id="admin-panel">
      {#if $appState.adminTab === "overview"}
        <div class="admin-list">
          <section class="settings-card">
            <h3>현황</h3>
            <p class="muted">이 인스턴스의 전체 사용 현황입니다.</p>
            <div class="stat-grid">
              {#each statCards as c}
                {#if c.target}
                  <button
                    class="stat-card stat-clickable"
                    type="button"
                    aria-label={`${c.label} ${c.target === "groups" ? "그룹 관리" : "사용자 관리"}로 이동`}
                    on:click={() => goOverviewTarget(c.target, c.filter)}
                  >
                    <div class="stat-value">{c.value ?? 0}</div>
                    <div class="stat-label">{c.label}</div>
                    {#if c.sub}<div class="stat-sub muted">{c.sub}</div>{/if}
                    <div class="stat-link muted">{c.target === "groups" ? "그룹 관리" : "사용자 관리"}</div>
                  </button>
                {:else}
                  <div class="stat-card">
                    <div class="stat-value">{c.value ?? 0}</div>
                    <div class="stat-label">{c.label}</div>
                    {#if c.sub}<div class="stat-sub muted">{c.sub}</div>{/if}
                  </div>
                {/if}
              {/each}
            </div>
          </section>
        </div>
      {:else if $appState.adminTab === "users"}
        <div class="admin-users">
          <div class="admin-users-head">
            <input
              type="search"
              class="admin-search"
              placeholder="이름 또는 아이디로 검색"
              aria-label="사용자 검색"
              value={$appState.adminUserSearch}
              on:input={(e) => updateState((s) => (s.adminUserSearch = e.currentTarget.value))}
            />
            <span class="muted nowrap">표시 {filteredUsers.length}명 / 전체 {$appState.adminUsers.length}명</span>
          </div>
          <div class="admin-filter seg-control" role="radiogroup" aria-label="사용자 필터">
            {#each userFilters as f}
              <button
                class="seg-btn"
                class:active={$appState.adminUserFilter === f.id}
                type="button"
                role="radio"
                aria-checked={$appState.adminUserFilter === f.id}
                on:click={() => setUserFilter(f.id)}
              >{f.label} {userFilterCount(f.match)}</button>
            {/each}
          </div>
          <div class="admin-list">
            {#if !filteredUsers.length}
              <div class="muted pad">
                {#if $appState.adminUserSearch.trim()}
                  "{$appState.adminUserSearch.trim()}"에 맞는 {$appState.adminUserFilter === "all" ? "사용자" : `${filterLabel($appState.adminUserFilter)} 사용자`}가 없습니다.
                  <button class="linkish small" type="button" on:click={() => updateState((s) => (s.adminUserSearch = ""))}>검색어 지우기</button>
                  {#if $appState.adminUserFilter !== "all"}
                    <button class="linkish small" type="button" on:click={() => setUserFilter("all")}>전체 사용자 보기</button>
                  {/if}
                {:else if $appState.adminUserFilter !== "all"}
                  {filterLabel($appState.adminUserFilter)} 사용자가 없습니다.
                  <button class="linkish small" type="button" on:click={() => setUserFilter("all")}>전체 사용자 보기</button>
                {:else}
                  사용자가 없습니다.
                {/if}
              </div>
            {:else}
              {#each filteredUsers as user (user.id)}
                <AdminUserRow {user} reload={reloadUsers} />
              {/each}
            {/if}
          </div>
        </div>
      {:else if $appState.adminTab === "groups"}
        <div class="admin-list">
          <section class="settings-card">
            <div class="panel-section-head">
              <div>
                <h3>그룹</h3>
                <p class="muted">같은 그룹 멤버끼리는 자동으로 서로 신뢰해 권한을 얻고, 그룹 공용 지식 저장소를 공유합니다. 그룹 생성·삭제와 그룹 관리자 지정은 시스템 관리자만 합니다. 공용 저장소 편집은 각 그룹 관리자가 ‘내 아바타 ▸ 그룹’에서 합니다.</p>
              </div>
            </div>
            <form class="plugin-add rows-2" on:submit|preventDefault={createGroup}>
              <input bind:value={newGroupName} name="name" placeholder="그룹 이름" aria-label="그룹 이름" required />
              <input bind:value={newGroupDescription} name="description" placeholder="설명 (선택)" aria-label="그룹 설명" />
              <button class="primary" type="submit" disabled={creatingGroup}>그룹 만들기</button>
            </form>
            <div class="admin-users-head">
              <input
                type="search"
                class="admin-search"
                placeholder="그룹 이름·설명 검색"
                aria-label="그룹 검색"
                value={$appState.adminGroupSearch}
                disabled={!$appState.adminGroups.length}
                on:input={(e) => updateState((s) => (s.adminGroupSearch = e.currentTarget.value))}
              />
              <span class="muted nowrap">
                {#if shownGroups.length === $appState.adminGroups.length}총 {$appState.adminGroups.length}개{:else}표시 {shownGroups.length}개 / 전체 {$appState.adminGroups.length}개{/if}
              </span>
            </div>
            <div class="admin-list">
              {#if !$appState.adminGroups.length}
                <div class="muted pad">아직 그룹이 없습니다.</div>
              {:else if !shownGroups.length}
                <div class="muted pad">
                  "{$appState.adminGroupSearch.trim()}"에 맞는 그룹이 없습니다.
                  <button class="linkish small" type="button" on:click={() => updateState((s) => (s.adminGroupSearch = ""))}>검색어 지우기</button>
                </div>
              {:else}
                {#each shownGroups as group (group.id)}
                  <AdminGroupRow {group} reload={reloadGroups} />
                {/each}
              {/if}
            </div>
          </section>
        </div>
      {:else if $appState.adminTab === "access"}
        <div class="admin-list">
          <section class="settings-card">
            <div class="panel-section-head">
              <div>
                <h3>회원가입 정책</h3>
                <p class="muted">새 사용자가 스스로 가입하는 방식을 정합니다. 첫 관리자 계정은 정책과 무관하게 항상 허용됩니다.</p>
              </div>
            </div>
            <div class="radio-cards">
              {#each signupModes as m}
                <label class="radio-card" for={`sm-${m.id}`}>
                  <input
                    type="radio"
                    name="signup-mode"
                    id={`sm-${m.id}`}
                    value={m.id}
                    checked={(sys.signupMode || "open") === m.id}
                    on:change={() => saveSignupMode(m.id)}
                  />
                  <div class="radio-card-body">
                    <strong>{m.label}</strong>
                    <div class="muted">{m.desc}</div>
                  </div>
                </label>
              {/each}
            </div>
          </section>
        </div>
      {:else if $appState.adminTab === "system"}
        {#if !$appState.adminSystem}
          <div class="warn-box">
            시스템 정보를 불러올 수 없습니다.
            <button class="linkish" type="button" on:click={load}>다시 시도</button>
          </div>
        {:else}
          <div class="admin-list">
            <!-- system info -->
            <div class="settings-card sys-card">
              <h3>시스템 정보</h3>
              <div class="sys-grid">
                <div class="sys-row">
                  <span class="sys-key muted">런타임</span>
                  <span class="sys-val"><span class="tag mono">{sys.agentRuntime === "claude" ? "Claude Agent SDK" : "로컬 스텁"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">설정된 모델</span>
                  <span class="sys-val">
                    {#if sys.configuredModel}<span class="tag mono">{sys.configuredModel}</span>{:else}<span class="muted">미설정 (SDK 기본값)</span>{/if}
                  </span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">실제 사용 모델</span>
                  <span class="sys-val">
                    {#if sys.observedModel}<span class="tag mono accent">{sys.observedModel}</span>{:else}<span class="muted">아직 확인되지 않음 (첫 대화 후 표시)</span>{/if}
                  </span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">인증 방식</span>
                  <span class="sys-val"><span class="tag">{sys.authMode === "api_key" ? "API 키" : "구독 로그인"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">읽기 전용 도구</span>
                  <span class="sys-val"><span class="muted">{(sys.readOnlyTools || []).join(", ") || "없음"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">Confluence</span>
                  <span class="sys-val">
                    {#if sys.confluenceConfigured}<span class="tag">host 설정됨</span>{:else}<span class="muted">CONFLUENCE_URL 미설정</span>{/if}
                  </span>
                </div>
              </div>
            </div>

            <!-- subscription -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>구독 로그인</h3>
                  <p class="muted">Claude 구독으로 에이전트를 구동합니다. ① 내 PC에서 claude setup-token 실행 → ② 출력된 sk-ant-oat… 토큰을 아래에 붙여넣고 저장하세요. 토큰은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
                </div>
              </div>
              <div class="sys-grid">
                <div class="sys-row">
                  <span class="sys-key muted">구독 연결</span>
                  <span class="sys-val">
                    <span class={sys.subscriptionConnected ? "tag accent" : "muted"}>{sys.subscriptionConnected ? "● 연결됨" : "○ 미연결"}</span>
                  </span>
                </div>
              </div>
              {#if sys.apiKeyOverride}
                <p class="muted">.env의 ANTHROPIC_API_KEY가 설정되어 있어 API 키가 구독 토큰보다 우선합니다. 구독 토큰을 사용하려면 API 키를 비우세요.</p>
              {/if}
              {#if sys.subscriptionConnected}
                <div class="ar-actions">
                  <button class="ghost-sm danger" type="button" disabled={subBusy} on:click={disconnectToken}>연결 해제</button>
                </div>
              {/if}
              <form class="settings-form" on:submit|preventDefault={saveToken}>
                <label class="field">
                  <span>{sys.subscriptionConnected ? "토큰 교체" : "Claude 구독 토큰"}</span>
                  <RevealableInput bind:value={claudeToken} name="token" placeholder="sk-ant-oat01-..." ariaLabel={sys.subscriptionConnected ? "Claude 구독 토큰 교체" : "Claude 구독 토큰"} revealLabel="토큰" />
                </label>
                <button class="primary" type="submit" disabled={subBusy}>저장</button>
              </form>
            </section>

            <!-- model override -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>에이전트 모델</h3>
                  <p class="muted">아바타 대화에 사용할 모델을 지정합니다. 비워 두면 SDK 기본값을 사용합니다. 예: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001.</p>
                </div>
              </div>
              {#if sys.modelEnvLocked}
                <p class="muted">.env의 ANTHROPIC_MODEL이 설정되어 있어 환경 변수가 우선합니다. 아래 설정은 환경 변수가 없을 때만 적용됩니다.</p>
              {/if}
              <form class="settings-form" on:submit|preventDefault={saveModel}>
                <label class="field">
                  <span>모델 이름</span>
                  <input name="model" bind:value={modelInput} placeholder="claude-opus-4-8 (비우면 기본값)" autocomplete="off" />
                </label>
                <button class="primary" type="submit" disabled={modelBusy}>저장</button>
              </form>
            </section>

            <!-- hex-ssh policy -->
            {#if Array.isArray(sys.hexSshTools) && sys.hexSshTools.length}
              <section class="settings-card">
                <div class="panel-section-head">
                  <div>
                    <h3>SSH 도구 정책</h3>
                    <p class="muted">역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다.</p>
                  </div>
                </div>
                <form class="hex-policy-form" on:submit|preventDefault={saveHexPolicy}>
                  <div class="hex-policy-grid">
                    <div class="hex-policy-head muted">도구</div>
                    {#each roleDefs as role}
                      <div class="hex-policy-head">{role.label}</div>
                    {/each}
                    {#each sys.hexSshTools as tool}
                      <div class="hex-policy-tool">
                        <strong>{tool.label || tool.name}</strong>
                        <span class="muted mono">{tool.name}</span>
                        <span class="tag {tool.category === 'read' ? 'read' : 'write'}">{categoryLabels[tool.category] || tool.category}</span>
                      </div>
                      {#each roleDefs as role}
                        <label class="hex-policy-check">
                          <input type="checkbox" bind:checked={hexPolicy[role.key][tool.name]} aria-label={`${role.label} ${tool.label || tool.name}`} />
                        </label>
                      {/each}
                    {/each}
                  </div>
                  <div class="form-actions">
                    <button class="primary" type="submit" disabled={hexBusy}>정책 저장</button>
                  </div>
                </form>
              </section>
            {:else}
              <section class="settings-card">
                <div class="panel-section-head">
                  <div>
                    <h3>SSH 도구 정책</h3>
                    <p class="muted">역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다.</p>
                  </div>
                </div>
                <div class="empty-note">현재 설정할 SSH 도구가 없습니다. hex-ssh 도구 목록이 서버에서 제공되면 역할별 정책 표가 여기에 표시됩니다.</div>
              </section>
            {/if}
          </div>
        {/if}
      {:else if $appState.adminTab === "audit"}
        <div class="admin-list">
          <section class="settings-card">
            <div class="panel-section-head">
              <div>
                <h3>감사 로그</h3>
                <p class="muted">최근 활동 {($appState.audit || []).length}건 (로그인·권한 변경·관리 작업 등).</p>
              </div>
            </div>
            <div class="admin-users-head">
              <select class="admin-search" aria-label="액션 필터" bind:value={auditAction} disabled={!auditActions.length}>
                <option value="">{auditActions.length ? "전체 액션" : "필터할 액션 없음"}</option>
                {#each auditActions as a}
                  <option value={a}>{a}</option>
                {/each}
              </select>
            </div>
            <div class="audit-table-wrap">
              {#if !shownAudit.length}
                {#if auditAction}
                  <div class="muted pad">
                    "{auditAction}" 액션 기록이 없습니다.
                    <button class="linkish small" type="button" on:click={() => (auditAction = "")}>전체 액션 보기</button>
                  </div>
                {:else}
                  <div class="muted pad">기록이 없습니다.</div>
                {/if}
              {:else}
                <div class="audit-table">
                  {#each shownAudit as r (r.id)}
                    <div class="audit-row">
                      <span class="audit-time muted">{timeLabel(r.createdAt)}</span>
                      <span class="audit-actor">{r.actorName || "—"}</span>
                      <span class="tag mono">{r.action}</span>
                      <span class="tag {r.status === 'success' ? 'read' : 'danger'}">{r.status}</span>
                      <span class="audit-detail muted">{r.detail || ""}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </section>
        </div>
      {/if}
    </div>
  {/if}
</div>
