<script lang="ts" context="module">
  import type { GroupMember } from "../lib/types";

  // The richer per-group shape returned by GET /api/me/groups (members + repo),
  // vs. the lighter UserGroupMembership on User.groups.
  export interface SettingsGroup {
    id: string;
    name: string;
    role: "admin" | "member";
    knowledgeRepo: string | null;
    knowledgeBranch: string | null;
    knowledgeSelected: string[] | null;
    members: GroupMember[];
  }
</script>

<script lang="ts">
  // One group block in the 그룹 tab: teammate roster (searchable, chat shortcut),
  // and for group admins, member management (role toggle / remove) + a member-add
  // typeahead, plus the shared knowledge-repo card. Ports buildGroupBlock /
  // buildGroupRosterRow / buildGroupRepoCard / buildGroupMemberAddForm from
  // settings/groups.js. The user-search typeahead is inlined here (per the task
  // rule: no shared UserSearch component).
  import { api } from "../lib/api";
  import { startChatWith, openSeededChat } from "../lib/chat";
  import { notify, readState, newId } from "../lib/state";
  import type { AvatarSummary, RepoPluginContents } from "../lib/types";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import SettingsPluginSelect from "./SettingsPluginSelect.svelte";

  export let group: SettingsGroup;
  export let githubHost = "github.com";
  /** Reload the whole group list from the server (after member/repo mutations). */
  export let reload: () => Promise<void>;

  $: amAdmin = group.role === "admin";
  $: meId = readState().user?.id;

  // ---- roster search ----
  let rosterQuery = "";
  $: shownMembers = rosterQuery.trim()
    ? group.members.filter((m) =>
        [m.displayName || "", m.username || "", m.role === "admin" ? "관리자" : "멤버"]
          .join(" ")
          .toLowerCase()
          .includes(rosterQuery.trim().toLowerCase()),
      )
    : group.members;
  $: memberCountLabel =
    shownMembers.length === group.members.length
      ? `멤버 ${group.members.length}명`
      : `표시 ${shownMembers.length}명 / 전체 ${group.members.length}명`;

  let rowBusy: Record<string, boolean> = {};

  function chatWith(m: GroupMember): void {
    const av: AvatarSummary =
      readState().avatars.find((a) => a.id === m.userId) || {
        id: m.userId,
        username: m.username,
        displayName: m.displayName,
        alias: "",
        bio: "",
        hashtags: [],
        hasImage: m.hasImage,
        pluginCount: 0,
        visibility: m.visibility,
        updatedAt: null,
      };
    void startChatWith(av);
  }

  async function toggleRole(m: GroupMember): Promise<void> {
    if (rowBusy[m.userId]) return;
    rowBusy = { ...rowBusy, [m.userId]: true };
    const nextRole = m.role === "admin" ? "member" : "admin";
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      await reload();
      notify(`${m.displayName}님의 그룹 관리자 역할을 ${m.role === "admin" ? "해제" : "부여"}했습니다.`, "ok");
    } catch (err) {
      notify(`역할 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      rowBusy = { ...rowBusy, [m.userId]: false };
    }
  }

  async function removeMember(m: GroupMember): Promise<void> {
    if (rowBusy[m.userId]) return;
    if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
    rowBusy = { ...rowBusy, [m.userId]: true };
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
      await reload();
      notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
    } catch (err) {
      notify(`제거 실패: ${(err as Error).message}`, "warn");
    } finally {
      rowBusy = { ...rowBusy, [m.userId]: false };
    }
  }

  // ---- member-add typeahead (inlined) ----
  interface SearchUser {
    id: string;
    username: string;
    displayName: string;
  }
  let addQuery = "";
  let addAsAdmin = false;
  let searchResults: SearchUser[] = [];
  let showResults = false;
  let activeIndex = -1;
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  // Queued selections keyed by lowercased username.
  let selected = new Map<string, SearchUser>();
  let selectedArr: SearchUser[] = [];
  let adding = false;

  $: existingNames = new Set(group.members.map((m) => (m.username || "").toLowerCase()));
  $: existingIds = new Set(group.members.map((m) => m.userId));

  function refreshSelectedArr(): void {
    selectedArr = [...selected.values()];
  }

  async function runSearch(q: string): Promise<void> {
    const s = ++searchSeq;
    try {
      const { users } = await api<{ users: SearchUser[] }>(`/api/me/users/search?q=${encodeURIComponent(q)}`);
      if (s !== searchSeq) return;
      const selectedKeys = new Set(selected.keys());
      searchResults = users.filter(
        (u) => !existingIds.has(u.id) && !existingNames.has((u.username || "").toLowerCase()) && !selectedKeys.has((u.username || "").toLowerCase()),
      );
      showResults = true;
      activeIndex = searchResults.length ? 0 : -1;
    } catch {
      if (s === searchSeq) showResults = false;
    }
  }

  function onAddInput(): void {
    const q = addQuery.trim().replace(/^@/, "");
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      searchSeq++;
      searchResults = [];
      showResults = false;
      return;
    }
    searchTimer = setTimeout(() => void runSearch(q), 200);
  }

  function selectUser(user: SearchUser): boolean {
    const username = (user.username || "").trim().replace(/^@/, "");
    const key = username.toLowerCase();
    if (!username) return false;
    if (existingNames.has(key) || (user.id && existingIds.has(user.id))) {
      notify("이미 그룹에 있는 사용자입니다.", "info");
      addQuery = "";
      return false;
    }
    if (selected.has(key)) {
      notify("이미 선택한 사용자입니다.", "info");
      addQuery = "";
      return false;
    }
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    refreshSelectedArr();
    addQuery = "";
    showResults = false;
    searchResults = [];
    return true;
  }

  function addTyped(): boolean {
    const username = addQuery.trim().replace(/^@/, "");
    if (!username) return false;
    return selectUser({ id: "", username, displayName: username });
  }

  function removeSelected(key: string): void {
    if (adding) return;
    selected.delete(key);
    refreshSelectedArr();
  }

  function onAddKeydown(e: KeyboardEvent): void {
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

  async function submitMembers(): Promise<void> {
    if (adding) return;
    if (!selected.size && addQuery.trim()) addTyped();
    if (!selected.size) return;
    const queued = [...selected.entries()];
    const role = addAsAdmin ? "admin" : "member";
    adding = true;
    const failures: string[] = [];
    let successes = 0;
    try {
      for (const [key, user] of queued) {
        try {
          await api(`/api/me/groups/${encodeURIComponent(group.id)}/members`, {
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
        addAsAdmin = false;
        addQuery = "";
        await reload();
      }
      if (failures.length) {
        const added = successes ? `${successes}명은 추가했습니다. ` : "";
        notify(`${added}일부 멤버를 추가하지 못했습니다. ${failures.join(" / ")}`, "warn");
      } else {
        notify(`${successes}명을 그룹에 추가했습니다.`, "ok");
      }
    } finally {
      adding = false;
    }
  }

  // ---- group knowledge repo ----
  function repoToHref(repo: string | null): string | null {
    if (!repo) return null;
    const r = repo.trim();
    if (/^https?:\/\//.test(r)) return r.replace(/\.git$/, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
      const host = (githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
      return `https://${host}/${r.replace(/\.git$/, "")}`;
    }
    return null;
  }

  let repoInput = "";
  let branchInput = "";
  $: {
    repoInput = group.knowledgeRepo || "";
    branchInput = group.knowledgeBranch || "";
  }
  let repoBusy = false;
  let repoRefreshed = false;

  async function saveRepo(): Promise<void> {
    const repo = repoInput.trim();
    const branch = branchInput.trim();
    if (!repo) {
      notify(group.knowledgeRepo ? "공용 저장소 연결을 해제하려면 ‘연결 해제’ 버튼을 사용해 주세요." : "공용 지식 저장소 주소를 입력해 주세요.", "warn");
      return;
    }
    repoBusy = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo`, {
        method: "PUT",
        body: JSON.stringify({ repo, branch: branch || null }),
      });
      await reload();
      notify(`"${group.name}" 공용 지식 저장소 "${repo}"을 연결했습니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  async function refreshRepo(): Promise<void> {
    repoBusy = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/refresh`, { method: "POST" });
      repoRefreshed = true;
      setTimeout(() => (repoRefreshed = false), 1200);
      notify(`"${group.name}" 공용 지식 저장소를 최신 상태로 새로고침했습니다.`, "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  async function disconnectRepo(): Promise<void> {
    if (!window.confirm("이 그룹의 공용 지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 멤버 아바타들이 더 이상 그 스킬을 불러오지 않습니다.")) return;
    repoBusy = true;
    try {
      await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo`, { method: "PUT", body: JSON.stringify({ repo: null }) });
      await reload();
      notify(`"${group.name}" 공용 지식 저장소 연결을 해제했습니다.`, "ok");
    } catch (err) {
      notify(`연결 해제 실패: ${(err as Error).message}`, "warn");
    } finally {
      repoBusy = false;
    }
  }

  function requestGroupRepo(): void {
    void openSeededChat(`"${group.name}" 그룹의 공용 지식 저장소를 만들어서 연결해줘. 그룹 멤버들이 함께 사용할 기본 지식/스킬 구조까지 준비해줘.`);
  }

  // plugin selection (expandable)
  let pickOpen = false;
  let contents: RepoPluginContents | null = null;
  let contentsErr = "";
  let contentsLoading = false;
  $: selSummary = !group.knowledgeSelected ? "저장소의 모든 플러그인을 사용 중" : `${group.knowledgeSelected.length}개 플러그인만 사용 중`;

  async function togglePick(): Promise<void> {
    pickOpen = !pickOpen;
    if (pickOpen && !contents && !contentsLoading) await loadContents();
  }
  async function loadContents(): Promise<void> {
    contentsLoading = true;
    contentsErr = "";
    try {
      const { contents: info } = await api<{ contents: RepoPluginContents }>(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/contents`);
      contents = info;
    } catch (err) {
      contentsErr = (err as Error).message;
    } finally {
      contentsLoading = false;
    }
  }
  async function saveSelection(next: string[] | null): Promise<void> {
    await api(`/api/me/groups/${encodeURIComponent(group.id)}/knowledge-repo/selected`, { method: "PUT", body: JSON.stringify({ selected: next }) });
    await reload();
  }

  const listboxId = `group-search-${newId()}`;
</script>

<div class="group-block">
  <div class="group-block-head">
    <strong>{group.name}</strong>
    {#if amAdmin}
      <span class="tag write">내가 관리자</span>
    {:else}
      <span class="tag read">멤버</span>
    {/if}
  </div>

  {#if group.members.length}
    <div class="admin-users-head group-roster-head">
      <input type="search" class="admin-search" placeholder="멤버 이름·아이디 검색" aria-label={`${group.name} 멤버 검색`} bind:value={rosterQuery} />
      <span class="muted nowrap">{memberCountLabel}</span>
    </div>
  {/if}

  <div class="plugin-rows">
    {#if !group.members.length}
      <div class="empty-note">멤버가 없습니다.</div>
    {:else if !shownMembers.length}
      <div class="empty-note">
        "{rosterQuery.trim()}"에 맞는 멤버가 없습니다.
        <button class="linkish small" type="button" on:click={() => (rosterQuery = "")}>검색어 지우기</button>
      </div>
    {:else}
      {#each shownMembers as m (m.userId)}
        <div class="plugin-row" class:busy={rowBusy[m.userId]}>
          <AvatarImage user={{ ...m, id: m.userId }} size={32} alt="" />
          <div class="pr-main">
            <strong>{m.displayName}{m.userId === meId ? " (나)" : ""}</strong>
            <div class="pr-sub">@{m.username}{m.role === "admin" ? " · 관리자" : ""}</div>
          </div>
          <div class="pr-actions">
            {#if m.userId !== meId}
              <button class="ghost-sm" type="button" title={`${m.displayName}의 아바타와 대화`} on:click={() => chatWith(m)}>대화</button>
            {/if}
            {#if amAdmin && m.userId !== meId}
              <button class="ghost-sm" type="button" disabled={rowBusy[m.userId]} on:click={() => toggleRole(m)}>
                {m.role === "admin" ? "관리자 해제" : "관리자 지정"}
              </button>
              <button class="ghost-sm danger" type="button" disabled={rowBusy[m.userId]} on:click={() => removeMember(m)}>제거</button>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if amAdmin}
    <div class="group-add-panel" aria-busy={adding}>
      <div class="group-add">
        <div class="trusted-search">
          <input
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={showResults}
            placeholder="추가할 동료 아이디(@) 또는 이름"
            aria-label="멤버 추가"
            disabled={adding}
            bind:value={addQuery}
            on:input={onAddInput}
            on:keydown={onAddKeydown}
            on:blur={() => setTimeout(() => (showResults = false), 150)}
          />
          <div id={listboxId} class="trusted-results" role="listbox" hidden={!showResults}>
            {#if !searchResults.length}
              <div class="empty-note">일치하는 사용자가 없습니다.</div>
            {:else}
              {#each searchResults as u, idx (u.id || u.username)}
                <button type="button" class="trusted-result" class:active={idx === activeIndex} role="option" aria-selected={idx === activeIndex} on:click={() => selectUser(u)}>
                  <div class="pr-main">
                    <strong>{u.displayName}</strong>
                    <div class="pr-sub">@{u.username}</div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
        <button class="icon-button group-add-pick" type="button" title="입력한 사용자를 선택 목록에 추가" aria-label="입력한 사용자를 선택 목록에 추가" disabled={adding} on:click={addTyped}>
          <Icon name="plus" />
        </button>
        <label class="group-add-admin"><input type="checkbox" bind:checked={addAsAdmin} disabled={adding} /><span>그룹 관리자로</span></label>
        <button class="primary small" type="button" disabled={adding} on:click={submitMembers}>
          {adding ? "추가 중…" : selectedArr.length ? `${selectedArr.length}명 추가` : "선택한 멤버 추가"}
        </button>
      </div>
      {#if selectedArr.length}
        <div class="group-add-selected">
          {#each selectedArr as u (u.username.toLowerCase())}
            <span class="group-add-chip">
              <span>{u.displayName || u.username} · @{u.username}</span>
              <button class="msg-act" type="button" title="선택 해제" aria-label={`${u.displayName || u.username} 선택 해제`} disabled={adding} on:click={() => removeSelected(u.username.toLowerCase())}>
                <Icon name="close" />
              </button>
            </span>
          {/each}
        </div>
      {/if}
    </div>

    <div class="group-repo">
      <h4 class="knowledge-sub">공용 지식 저장소</h4>
      {#if group.knowledgeRepo}
        <div class="head-actions">
          <button class="linkish small" type="button" disabled={repoBusy} on:click={refreshRepo}>{repoRefreshed ? "새로고침됨 ✓" : "새로고침"}</button>
          <button class="linkish small danger" type="button" disabled={repoBusy} title="이 그룹의 공용 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)" on:click={disconnectRepo}>연결 해제</button>
        </div>
      {/if}
      <form class="plugin-add rows-2" on:submit|preventDefault={saveRepo}>
        <input bind:value={repoInput} placeholder="owner/repo 또는 사내 git URL" aria-label="그룹 지식 저장소" />
        <input bind:value={branchInput} class="narrow" placeholder="브랜치 (선택)" aria-label="브랜치" />
        <button class="primary" type="submit" disabled={repoBusy}>{repoBusy ? "저장 중…" : "저장"}</button>
      </form>
      {#if !group.knowledgeRepo}
        <div class="empty-note">
          공용 저장소를 연결하면 그룹 멤버 전원의 아바타가 그 저장소의 스킬을 사용합니다.
          <button class="linkish small" type="button" on:click={requestGroupRepo}>아바타에게 공용 저장소 만들기 요청</button>
        </div>
      {:else}
        {@const href = repoToHref(group.knowledgeRepo)}
        {@const linkText = group.knowledgeRepo + (group.knowledgeBranch ? ` @ ${group.knowledgeBranch}` : "")}
        <div class="kr-link">
          <Icon name="globe" />
          {#if href}
            <a {href} target="_blank" rel="noreferrer noopener">{linkText}</a>
          {:else}
            <code>{linkText}</code>
          {/if}
        </div>
        <div class="kr-plugins">
          <span class="muted">{selSummary}</span>
          <button class="linkish small" type="button" aria-expanded={pickOpen} on:click={togglePick}>사용할 플러그인 선택</button>
        </div>
        {#if pickOpen}
          <div class="plugin-contents">
            {#if contentsLoading}
              <div class="muted">불러오는 중…</div>
            {:else if contentsErr}
              <div class="error-note">조회 실패: {contentsErr} <button class="linkish small" type="button" on:click={loadContents}>다시 시도</button></div>
            {:else if contents}
              <SettingsPluginSelect
                info={contents}
                selected={group.knowledgeSelected}
                headText="그룹 멤버 아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
                onSave={saveSelection}
              />
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {:else}
    <p class="muted small">
      {group.knowledgeRepo ? "이 그룹에는 공용 지식 저장소가 연결되어 동료들의 아바타와 공유됩니다." : "이 그룹에는 아직 공용 지식 저장소가 없습니다."}
    </p>
  {/if}
</div>
