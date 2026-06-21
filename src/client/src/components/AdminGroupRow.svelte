<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { notify } from "../lib/state";
  import type { AdminGroupSummary, GroupMember } from "../lib/types";

  export let group: AdminGroupSummary;
  export let reload: () => Promise<void>;

  let expanded = false;
  let loading = false;
  let loadError = "";
  let members: GroupMember[] = [];
  let busy = false;

  // edit form
  let editName = group.name;
  let editDescription = group.description || "";

  // member search/filter
  let memberSearch = "";

  // add-member typeahead
  let addQuery = "";
  let addAsAdmin = false;
  let searchResults: { id: string; username: string; displayName: string; hasImage?: boolean }[] = [];
  let searchSeq = 0;
  let searchTimer: number | null = null;
  let adding = false;

  $: shownMembers = (() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.displayName || "", m.username || "", m.role === "admin" ? "관리자" : "그룹원"].join(" ").toLowerCase().includes(q),
    );
  })();

  async function toggle() {
    if (expanded) {
      expanded = false;
      return;
    }
    expanded = true;
    await loadDetail();
  }

  async function loadDetail() {
    loading = true;
    loadError = "";
    try {
      const d = await api<{ group: AdminGroupSummary; members: GroupMember[] }>(`/api/admin/groups/${encodeURIComponent(group.id)}`);
      members = d.members;
      editName = group.name;
      editDescription = group.description || "";
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function reloadMembers() {
    const d = await api<{ members: GroupMember[] }>(`/api/admin/groups/${encodeURIComponent(group.id)}`);
    members = d.members;
    reload().catch(() => {});
  }

  async function saveEdit() {
    const nextName = editName.trim();
    busy = true;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, description: editDescription }),
      });
    } catch (err) {
      busy = false;
      notify(`수정 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${nextName || group.name}" 정보를 수정했습니다.`, "ok");
    } catch (err) {
      notify(`그룹 정보는 수정했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      busy = false;
    }
  }

  function runSearch() {
    const q = addQuery.trim().replace(/^@/, "");
    if (searchTimer != null) window.clearTimeout(searchTimer);
    if (!q) {
      searchSeq++;
      searchResults = [];
      return;
    }
    searchTimer = window.setTimeout(async () => {
      const s = ++searchSeq;
      try {
        const { users } = await api<{ users: typeof searchResults }>(`/api/me/users/search?q=${encodeURIComponent(q)}`);
        if (s !== searchSeq) return;
        const existing = new Set(members.map((m) => (m.username || "").toLowerCase()));
        searchResults = users.filter((u) => !existing.has((u.username || "").toLowerCase()));
      } catch {
        if (s === searchSeq) searchResults = [];
      }
    }, 200);
  }

  async function addMember(username: string) {
    const clean = username.trim().replace(/^@/, "");
    if (!clean) return;
    if (members.some((m) => (m.username || "").toLowerCase() === clean.toLowerCase())) {
      notify("이미 그룹에 있는 사용자입니다.", "info");
      addQuery = "";
      searchResults = [];
      return;
    }
    adding = true;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members`, {
        method: "POST",
        body: JSON.stringify({ username: clean, role: addAsAdmin ? "admin" : "member" }),
      });
      addQuery = "";
      searchResults = [];
      addAsAdmin = false;
      await reloadMembers();
      notify(`${clean}님을 그룹에 추가했습니다.`, "ok");
    } catch (err) {
      notify(`그룹원 추가 실패: @${clean}: ${(err as Error).message}`, "warn");
    } finally {
      adding = false;
    }
  }

  async function toggleMemberRole(m: GroupMember) {
    const isAdmin = m.role === "admin";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: isAdmin ? "member" : "admin" }),
      });
    } catch (err) {
      notify(`역할 변경 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await reloadMembers();
      notify(`${m.displayName}님의 그룹 관리자 역할을 ${isAdmin ? "해제" : "부여"}했습니다.`, "ok");
    } catch (err) {
      notify(`역할은 변경됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }

  async function removeMember(m: GroupMember) {
    if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (err) {
      notify(`제거 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await reloadMembers();
      notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
    } catch (err) {
      notify(`그룹원은 제거됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }

  async function deleteGroup() {
    if (!window.confirm(`'${group.name}' 그룹을 삭제할까요?\n그룹 소속이 모두 해제되고 그룹원 간 자동 신뢰가 사라집니다. (공용 저장소 자체는 GitHub에 남습니다.)`)) return;
    busy = true;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
    } catch (err) {
      busy = false;
      notify(`삭제 실패: ${(err as Error).message}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${group.name}"을 삭제했습니다.`, "ok");
    } catch (err) {
      busy = false;
      notify(`그룹은 삭제했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    }
  }
</script>

<div class="admin-user">
  <div class="admin-row">
    <div class="ar-main">
      <strong>{group.name}</strong>
      <div class="muted">{group.description || "(설명 없음)"}</div>
    </div>
    <div class="ar-tags">
      <span class="tag">그룹원 {group.memberCount}</span>
      <span class="tag write">관리자 {group.adminCount}</span>
      {#if group.knowledgeRepo}<span class="tag accent">공용 저장소</span>{/if}
    </div>
    <div class="ar-actions">
      <button
        class="ghost-sm"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
        title={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
        on:click={toggle}
      >{expanded ? "접기" : "관리"}</button>
    </div>
  </div>

  {#if expanded}
    <div class="ar-detail">
      {#if loading}
        <div class="muted">불러오는 중…</div>
      {:else if loadError}
        <div class="warn-box">
          불러오기 실패: {loadError}
          <button class="linkish" type="button" on:click={loadDetail}>다시 시도</button>
        </div>
      {:else}
        <div class="ar-detail-inner">
          <h4 class="knowledge-sub">그룹 정보</h4>
          <form class="plugin-add rows-2" on:submit|preventDefault={saveEdit}>
            <input bind:value={editName} aria-label="그룹 이름" />
            <input bind:value={editDescription} placeholder="설명" aria-label="그룹 설명" />
            <button class="ghost-sm" type="submit" disabled={busy}>수정</button>
          </form>

          <h4 class="knowledge-sub">그룹원</h4>
          <div class="admin-users-head">
            <input
              type="search"
              class="admin-search"
              placeholder="그룹원 이름·아이디 검색"
              aria-label="그룹원 검색"
              bind:value={memberSearch}
              disabled={!members.length}
            />
            <span class="muted nowrap">
              {#if shownMembers.length === members.length}그룹원 {members.length}명{:else}표시 {shownMembers.length}명 / 전체 {members.length}명{/if}
            </span>
          </div>
          <div class="plugin-rows">
            {#if !members.length}
              <div class="empty-note">그룹원이 없습니다.</div>
            {:else if !shownMembers.length}
              <div class="empty-note">
                "{memberSearch.trim()}"에 맞는 그룹원이 없습니다.
                <button class="linkish small" type="button" on:click={() => (memberSearch = "")}>검색어 지우기</button>
              </div>
            {:else}
              {#each shownMembers as m (m.userId)}
                <div class="plugin-row">
                  <AvatarImage user={{ id: m.userId, username: m.username, displayName: m.displayName, hasImage: m.hasImage }} size={32} alt="" />
                  <div class="pr-main">
                    <strong>{m.displayName}</strong>
                    <div class="pr-sub">@{m.username}</div>
                  </div>
                  {#if m.role === "admin"}<span class="tag write">관리자</span>{:else}<span class="tag read">그룹원</span>{/if}
                  <div class="pr-actions">
                    <button class="ghost-sm" type="button" title={m.role === "admin" ? "그룹 관리자 해제" : "그룹 관리자 지정"} on:click={() => toggleMemberRole(m)}>
                      {m.role === "admin" ? "관리자 해제" : "관리자 지정"}
                    </button>
                    <button class="msg-act danger" type="button" title="그룹원 제거" aria-label={`${m.displayName} 제거`} on:click={() => removeMember(m)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <div class="group-add-panel">
            <div class="group-add">
              <div class="trusted-search">
                <input
                  type="search"
                  placeholder="추가할 사용자 아이디(@) 또는 이름"
                  aria-label="그룹원 추가"
                  bind:value={addQuery}
                  on:input={runSearch}
                  on:keydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMember(addQuery); } }}
                />
                {#if searchResults.length}
                  <div class="trusted-results" role="listbox">
                    {#each searchResults as u (u.id)}
                      <button type="button" class="trusted-result" role="option" aria-selected="false" on:click={() => addMember(u.username)}>
                        <div class="pr-main">
                          <strong>{u.displayName}</strong>
                          <div class="pr-sub">@{u.username}</div>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <button class="icon-button group-add-pick" type="button" title="입력한 사용자를 추가" aria-label="입력한 사용자를 추가" disabled={adding} on:click={() => addMember(addQuery)}>
                <Icon name="plus" />
              </button>
              <label class="group-add-admin"><input type="checkbox" bind:checked={addAsAdmin} /><span>그룹 관리자로</span></label>
            </div>
          </div>

          <div class="ud-actions">
            <button class="ghost-sm danger" type="button" disabled={busy} on:click={deleteGroup}>그룹 삭제</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
