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
  let memberBusy: Record<string, boolean> = {};
  let editError = "";
  let addError = "";
  let memberStatus = "";

  // edit form
  let editName = group.name;
  let editDescription = group.description || "";

  // member search/filter
  let memberSearch = "";

  // add-member typeahead
  interface SearchUser {
    id: string;
    username: string;
    displayName: string;
    hasImage?: boolean;
  }
  let addQuery = "";
  let addAsAdmin = false;
  let searchResults: SearchUser[] = [];
  let showResults = false;
  let activeIndex = -1;
  let searchSeq = 0;
  let searchTimer: number | null = null;
  let selected = new Map<string, SearchUser>();
  let selectedArr: SearchUser[] = [];
  let adding = false;
  let addResult = "";

  $: shownMembers = (() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.displayName || "", m.username || "", m.role === "admin" ? "관리자" : "그룹원"].join(" ").toLowerCase().includes(q),
    );
  })();
  $: editNameTrimmed = editName.trim();
  $: editDescriptionTrimmed = editDescription.trim();
  $: editDirty = editNameTrimmed !== group.name || editDescriptionTrimmed !== (group.description || "");
  $: editCanSave = Boolean(!busy && editNameTrimmed && editDirty);
  $: editStatus = busy
    ? "저장 중…"
    : editError
      ? `수정 실패: ${editError}`
      : !editNameTrimmed
        ? "그룹 이름을 입력해 주세요."
        : editDirty
          ? "저장하지 않은 그룹 정보 변경 사항이 있습니다."
          : "저장됨";
  $: addQueryTrimmed = addQuery.trim().replace(/^@/, "");
  $: canPickTyped = Boolean(!adding && addQueryTrimmed);
  $: canSubmitMembers = Boolean(!adding && (selectedArr.length || addQueryTrimmed));
  $: addRoleHint = addAsAdmin ? "관리자 권한으로 추가됩니다." : "그룹원으로 추가됩니다.";
  $: detailId = `admin-group-detail-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: addListboxId = `admin-group-add-results-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: editStatusId = `admin-group-edit-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: addStatusId = `admin-group-add-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: memberStatusId = `admin-group-member-status-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  $: addStatus = adding
    ? "그룹원을 추가하는 중입니다."
    : addError
      ? addError
      : selectedArr.length
        ? `${selectedArr.length}명이 선택 목록에 있습니다. ${addRoleHint}`
        : addResult
          ? addResult
          : addQueryTrimmed
            ? `입력한 사용자를 선택 목록에 추가하거나 바로 추가할 수 있습니다. ${addRoleHint}`
            : "추가할 사용자를 검색해 주세요.";
  $: existingNames = new Set(members.map((m) => (m.username || "").toLowerCase()));
  $: existingIds = new Set(members.map((m) => m.userId));

  async function toggle() {
    if (expanded) {
      expanded = false;
      return;
    }
    expanded = true;
    await loadDetail();
  }

  async function loadDetail() {
    if (loading) return;
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
    const nextName = editNameTrimmed;
    if (busy || !nextName || !editDirty) return;
    busy = true;
    editError = "";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, description: editDescriptionTrimmed }),
      });
    } catch (err) {
      busy = false;
      editError = (err as Error).message;
      notify(`수정 실패: ${editError}`);
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

  function refreshSelectedArr() {
    selectedArr = [...selected.values()];
  }

  function runSearch(q: string) {
    if (searchTimer != null) window.clearTimeout(searchTimer);
    if (!q) {
      searchSeq++;
      searchResults = [];
      showResults = false;
      return;
    }
    searchTimer = window.setTimeout(async () => {
      const s = ++searchSeq;
      try {
        const { users } = await api<{ users: SearchUser[] }>(`/api/me/users/search?q=${encodeURIComponent(q)}`);
        if (s !== searchSeq) return;
        const selectedKeys = new Set(selected.keys());
        searchResults = users.filter(
          (u) =>
            !existingIds.has(u.id) &&
            !existingNames.has((u.username || "").toLowerCase()) &&
            !selectedKeys.has((u.username || "").toLowerCase()),
        );
        showResults = true;
        activeIndex = searchResults.length ? 0 : -1;
      } catch {
        if (s === searchSeq) {
          searchResults = [];
          showResults = false;
          addError = "사용자 검색에 실패했습니다.";
        }
      }
    }, 200);
  }

  function onAddInput() {
    addError = "";
    addResult = "";
    runSearch(addQueryTrimmed);
  }

  function selectUser(user: SearchUser): boolean {
    if (adding) return false;
    const username = (user.username || "").trim().replace(/^@/, "");
    const key = username.toLowerCase();
    if (!username) return false;
    if (existingNames.has(key) || (user.id && existingIds.has(user.id))) {
      addError = "이미 그룹에 있는 사용자입니다.";
      notify("이미 그룹에 있는 사용자입니다.", "info");
      addQuery = "";
      searchResults = [];
      showResults = false;
      return false;
    }
    if (selected.has(key)) {
      addError = "이미 선택한 사용자입니다.";
      notify("이미 선택한 사용자입니다.", "info");
      addQuery = "";
      showResults = false;
      return false;
    }
    addError = "";
    addResult = "";
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    refreshSelectedArr();
    addQuery = "";
    searchResults = [];
    showResults = false;
    return true;
  }

  function addTyped(): boolean {
    if (adding) return false;
    const username = addQueryTrimmed;
    if (!username) return false;
    return selectUser({ id: "", username, displayName: username });
  }

  function removeSelected(key: string) {
    if (adding) return;
    selected.delete(key);
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function clearSelected() {
    if (adding) return;
    selected.clear();
    refreshSelectedArr();
    addError = "";
    addResult = "";
  }

  function onAddKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && showResults) {
      e.preventDefault();
      showResults = false;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showResults && activeIndex >= 0 && searchResults[activeIndex]) {
        selectUser(searchResults[activeIndex]);
      } else {
        addTyped();
      }
      return;
    }
    if (!showResults || !searchResults.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + searchResults.length) % searchResults.length;
    }
  }

  async function submitMembers() {
    if (adding) return;
    if (!selected.size && addQueryTrimmed) addTyped();
    if (!selected.size) return;
    const queued = [...selected.entries()];
    const role = addAsAdmin ? "admin" : "member";
    adding = true;
    addError = "";
    addResult = "";
    const failures: string[] = [];
    let successes = 0;
    let refreshError: Error | null = null;
    try {
      for (const [key, user] of queued) {
        try {
          await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members`, {
            method: "POST",
            body: JSON.stringify({ username: user.username, role }),
          });
          selected.delete(key);
          successes++;
        } catch (err) {
          failures.push(`@${user.username}: ${(err as Error).message}`);
        }
      }
      refreshSelectedArr();
      if (successes) {
        if (!selected.size) addAsAdmin = false;
        addQuery = "";
        showResults = false;
        try {
          await reloadMembers();
        } catch (err) {
          refreshError = err as Error;
        }
      }
      if (failures.length) {
        const added = successes ? `${successes}명은 추가했습니다. ` : "";
        addError = `${added}일부 그룹원을 추가하지 못했습니다. ${failures.join(" / ")}`;
        notify(addError, "warn");
      } else if (refreshError) {
        addError = `${successes}명을 추가했지만 목록 새로고침에 실패했습니다: ${refreshError.message}`;
        notify(addError, "warn");
      } else {
        addResult = `${successes}명을 그룹에 추가했습니다.`;
        notify(addResult, "ok");
      }
    } finally {
      adding = false;
    }
  }

  async function toggleMemberRole(m: GroupMember) {
    if (memberBusy[m.userId]) return;
    const isAdmin = m.role === "admin";
    memberBusy = { ...memberBusy, [m.userId]: true };
    memberStatus = `${m.displayName}님의 역할을 변경하는 중입니다.`;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: isAdmin ? "member" : "admin" }),
      });
    } catch (err) {
      memberStatus = `역할 변경 실패: ${(err as Error).message}`;
      notify(memberStatus);
      memberBusy = { ...memberBusy, [m.userId]: false };
      return;
    }
    try {
      await reloadMembers();
      memberStatus = `${m.displayName}님의 그룹 관리자 역할을 ${isAdmin ? "해제" : "부여"}했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `역할은 변경됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      memberBusy = { ...memberBusy, [m.userId]: false };
    }
  }

  async function removeMember(m: GroupMember) {
    if (memberBusy[m.userId]) return;
    if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
    memberBusy = { ...memberBusy, [m.userId]: true };
    memberStatus = `${m.displayName}님을 제거하는 중입니다.`;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (err) {
      memberStatus = `제거 실패: ${(err as Error).message}`;
      notify(memberStatus);
      memberBusy = { ...memberBusy, [m.userId]: false };
      return;
    }
    try {
      await reloadMembers();
      memberStatus = `${m.displayName}님을 그룹에서 제거했습니다.`;
      notify(memberStatus, "ok");
    } catch (err) {
      memberStatus = `그룹원은 제거됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`;
      notify(memberStatus, "warn");
    } finally {
      memberBusy = { ...memberBusy, [m.userId]: false };
    }
  }

  async function deleteGroup() {
    if (busy) return;
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
        aria-controls={detailId}
        aria-label={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
        title={expanded ? `${group.name} 그룹 관리 접기` : `${group.name} 그룹 관리 열기`}
        on:click={toggle}
      >{expanded ? "접기" : "관리"}</button>
    </div>
  </div>

  {#if expanded}
    <div id={detailId} class="ar-detail">
      {#if loading}
        <div class="muted" role="status">불러오는 중…</div>
      {:else if loadError}
        <div class="warn-box" role="alert">
          불러오기 실패: {loadError}
          <button class="linkish" type="button" disabled={loading} on:click={loadDetail}>다시 시도</button>
        </div>
      {:else}
        <div class="ar-detail-inner">
          <h4 class="knowledge-sub">그룹 정보</h4>
          <form class="plugin-add rows-2" on:submit|preventDefault={saveEdit}>
            <input bind:value={editName} aria-label="그룹 이름" aria-describedby={editStatusId} aria-invalid={editError || !editNameTrimmed ? "true" : undefined} disabled={busy} on:input={() => (editError = "")} />
            <input bind:value={editDescription} placeholder="설명" aria-label="그룹 설명" aria-describedby={editStatusId} disabled={busy} on:input={() => (editError = "")} />
            <button class="primary small" type="submit" disabled={!editCanSave}>{busy ? "저장 중…" : "수정"}</button>
          </form>
          <div class="settings-save-row compact">
            <span id={editStatusId} class="settings-save-status" class:dirty={Boolean(editDirty && !busy && editNameTrimmed && !editError)} class:pending={busy} class:invalid={Boolean(editError || !editNameTrimmed)} role="status" aria-live="polite">{editStatus}</span>
          </div>

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
                <div class="plugin-row" class:busy={memberBusy[m.userId]}>
                  <AvatarImage user={{ id: m.userId, username: m.username, displayName: m.displayName, hasImage: m.hasImage }} size={32} alt="" />
                  <div class="pr-main">
                    <strong>{m.displayName}</strong>
                    <div class="pr-sub">@{m.username}</div>
                  </div>
                  {#if m.role === "admin"}<span class="tag write">관리자</span>{:else}<span class="tag read">그룹원</span>{/if}
                  <div class="pr-actions">
                    <button class="ghost-sm" type="button" title={m.role === "admin" ? "그룹 관리자 해제" : "그룹 관리자 지정"} aria-describedby={memberStatus ? memberStatusId : undefined} disabled={memberBusy[m.userId]} on:click={() => toggleMemberRole(m)}>
                      {m.role === "admin" ? "관리자 해제" : "관리자 지정"}
                    </button>
                    <button class="msg-act danger" type="button" title="그룹원 제거" aria-label={`${m.displayName} 제거`} aria-describedby={memberStatus ? memberStatusId : undefined} disabled={memberBusy[m.userId]} on:click={() => removeMember(m)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
          {#if memberStatus}
            <div
              id={memberStatusId}
              class="settings-save-status"
              class:pending={memberStatus.includes("중입니다")}
              class:success={memberStatus.includes("했습니다")}
              class:invalid={memberStatus.includes("실패") || memberStatus.includes("못했습니다")}
              role="status"
              aria-live="polite"
            >{memberStatus}</div>
          {/if}

          <div class="group-add-panel" aria-describedby={addStatusId} aria-busy={adding}>
            <div class="group-add">
              <div class="trusted-search">
                <input
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls={addListboxId}
                  aria-expanded={showResults ? "true" : "false"}
                  aria-activedescendant={showResults && activeIndex >= 0 ? `${addListboxId}-option-${activeIndex}` : undefined}
                  aria-describedby={addStatusId}
                  aria-invalid={addError ? "true" : undefined}
                  placeholder="추가할 사용자 아이디(@) 또는 이름"
                  aria-label="그룹원 추가"
                  disabled={adding}
                  bind:value={addQuery}
                  on:input={onAddInput}
                  on:keydown={onAddKeydown}
                  on:blur={() => setTimeout(() => (showResults = false), 150)}
                />
                <div id={addListboxId} class="trusted-results" role="listbox" hidden={!showResults}>
                  {#if !searchResults.length}
                    <div class="empty-note">일치하는 사용자가 없습니다.</div>
                  {:else}
                    {#each searchResults as u, idx (u.id || u.username)}
                      <button
                        id={`${addListboxId}-option-${idx}`}
                        type="button"
                        class="trusted-result"
                        class:active={idx === activeIndex}
                        role="option"
                        aria-selected={idx === activeIndex}
                        disabled={adding}
                        on:click={() => selectUser(u)}
                      >
                        <div class="pr-main">
                          <strong>{u.displayName}</strong>
                          <div class="pr-sub">@{u.username}</div>
                        </div>
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>
              <button class="icon-button group-add-pick" type="button" title="입력한 사용자를 선택 목록에 추가" aria-label="입력한 사용자를 선택 목록에 추가" aria-describedby={addStatusId} disabled={!canPickTyped} on:click={addTyped}>
                <Icon name="plus" />
              </button>
              <label class="group-add-admin"><input type="checkbox" bind:checked={addAsAdmin} aria-describedby={addStatusId} disabled={adding} /><span>그룹 관리자로</span></label>
              <button class="primary small" type="button" aria-describedby={addStatusId} disabled={!canSubmitMembers} on:click={submitMembers}>
                {adding ? "추가 중…" : selectedArr.length ? `${selectedArr.length}명 추가` : addQueryTrimmed ? "입력한 사용자 추가" : "선택한 그룹원 추가"}
              </button>
            </div>
          </div>
          <div class="settings-save-row compact">
            <span
              id={addStatusId}
              class="settings-save-status"
              class:dirty={Boolean(!adding && !addError && !addResult && (selectedArr.length || addQueryTrimmed))}
              class:pending={adding}
              class:success={Boolean(addResult)}
              class:invalid={Boolean(addError)}
              role="status"
              aria-live="polite"
            >{addStatus}</span>
          </div>
          {#if selectedArr.length}
            <div class="group-add-selected">
              <div class="group-add-chip-list" role="list" aria-label="추가할 그룹원 선택 목록">
                {#each selectedArr as u (u.username.toLowerCase())}
                  <span class="group-add-chip" role="listitem">
                    <span>{u.displayName || u.username} · @{u.username}</span>
                    <button class="msg-act" type="button" title="선택 해제" aria-label={`${u.displayName || u.username} 선택 해제`} disabled={adding} on:click={() => removeSelected(u.username.toLowerCase())}>
                      <Icon name="close" />
                    </button>
                  </span>
                {/each}
              </div>
              <button class="linkish small group-add-clear" type="button" disabled={adding} on:click={clearSelected}>선택 모두 해제</button>
            </div>
          {/if}

          <div class="ud-actions">
            <button class="ghost-sm danger" type="button" disabled={busy} on:click={deleteGroup}>그룹 삭제</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
