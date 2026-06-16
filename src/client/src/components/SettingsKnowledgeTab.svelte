<script lang="ts">
  import Icon from "./Icon.svelte";
  import Toggle from "./Toggle.svelte";
  import SettingsPluginSelect from "./SettingsPluginSelect.svelte";
  import GraphViewModal from "./GraphViewModal.svelte";
  import { api } from "../lib/api";
  import { openSeededChat } from "../lib/chat";
  import { appState, notify, readState, replaceState, updateState } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import type { Plugin, RepoPluginContents, User } from "../lib/types";

  export let active = false;

  const u0 = readState().user;

  // knowledge repo form
  let knowledgeRepo = u0?.knowledgeRepo || "";
  let knowledgeBranch = u0?.knowledgeBranch || "";
  let krBusy = false;
  let krRefreshed = false;
  let krPickOpen = false;
  let krContents: RepoPluginContents | null = null;
  let krContentsErr = "";
  let krContentsLoading = false;
  let graphOpen = false;

  // plugin add form
  let pluginRepo = "";
  let pluginRef = "";
  let pluginLabel = "";
  let pluginAddBusy = false;
  // per-plugin expandable contents
  let openPluginId = "";
  let pluginContents: Record<string, RepoPluginContents> = {};
  let pluginContentsErr: Record<string, string> = {};
  let pluginRowBusy: Record<string, boolean> = {};

  $: user = $appState.user;
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: plugins = $appState.plugins;

  // ---- knowledge repo ----
  function repoToHref(repo: string | null): string | null {
    if (!repo) return null;
    const r = repo.trim();
    if (/^https?:\/\//.test(r)) return r.replace(/\.git$/, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
      const host = githubHost.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
      return `https://${host}/${r.replace(/\.git$/, "")}`;
    }
    return null;
  }

  async function saveKnowledge(): Promise<void> {
    const repo = knowledgeRepo.trim();
    const branch = knowledgeBranch.trim();
    if (!repo) {
      notify(user?.knowledgeRepo ? "저장소 연결을 해제하려면 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요." : "지식 저장소 주소를 입력해 주세요.", "warn");
      return;
    }
    krBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo, branch: branch || null }) });
      replaceState({ user: next });
      notify(`지식 저장소 "${repo}"을 연결했습니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      krBusy = false;
    }
  }
  async function refreshKnowledge(): Promise<void> {
    krBusy = true;
    try {
      await api("/api/me/knowledge-repo/refresh", { method: "POST" });
      krRefreshed = true;
      setTimeout(() => (krRefreshed = false), 1200);
      notify("지식 저장소를 최신 상태로 새로고침했습니다.", "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      krBusy = false;
    }
  }
  async function disconnectKnowledge(): Promise<void> {
    if (!window.confirm("지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 아바타가 더 이상 그 스킬을 불러오지 않습니다.")) return;
    krBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo: null }) });
      replaceState({ user: next });
      krPickOpen = false;
      krContents = null;
      notify("지식 저장소 연결을 해제했습니다.", "ok");
    } catch (err) {
      notify(`연결 해제 실패: ${(err as Error).message}`, "warn");
    } finally {
      krBusy = false;
    }
  }
  async function toggleKrPick(): Promise<void> {
    krPickOpen = !krPickOpen;
    if (krPickOpen && !krContents && !krContentsLoading) await loadKrContents();
  }
  async function loadKrContents(): Promise<void> {
    krContentsLoading = true;
    krContentsErr = "";
    try {
      const { contents } = await api<{ contents: RepoPluginContents }>("/api/me/knowledge-repo/contents");
      krContents = contents;
    } catch (err) {
      krContentsErr = (err as Error).message;
    } finally {
      krContentsLoading = false;
    }
  }
  async function saveKrSelection(next: string[] | null): Promise<void> {
    const { user: u } = await api<{ user: User }>("/api/me/knowledge-repo/selected", { method: "PUT", body: JSON.stringify({ selected: next }) });
    replaceState({ user: u });
  }
  function requestKnowledgeRepo(): void {
    void openSeededChat("내 지식 저장소를 만들어서 연결해줘. 사내 GitHub에 저장소를 만들고, 앞으로 쓸 기본 지식/스킬 구조까지 준비해줘.");
  }

  // ---- plugins ----
  function pluginSyncLabel(p: Plugin): string {
    if (!p.lastSyncedAt) return "아직 동기화되지 않음";
    const label = timeLabel(p.lastSyncedAt);
    return label ? `동기화: ${label}` : "";
  }
  function pluginSelSummary(p: Plugin): string {
    return !p.selected ? "모든 플러그인 사용" : `${p.selected.length}개 선택됨`;
  }

  async function addPlugin(): Promise<void> {
    const repo = pluginRepo.trim();
    if (!repo) return;
    pluginAddBusy = true;
    try {
      const { plugin } = await api<{ plugin: Plugin }>("/api/me/plugins", {
        method: "POST",
        body: JSON.stringify({ repo, ref: pluginRef.trim() || undefined, label: pluginLabel.trim() || undefined }),
      });
      replaceState({ plugins: [...readState().plugins, plugin] });
      pluginRepo = "";
      pluginRef = "";
      pluginLabel = "";
      notify(`플러그인 "${plugin.label || plugin.repo}"을 추가했습니다.`, "ok");
    } catch (err) {
      notify(`플러그인 추가 실패: ${(err as Error).message}`, "warn");
    } finally {
      pluginAddBusy = false;
    }
  }

  async function togglePlugin(p: Plugin, next: boolean): Promise<void> {
    try {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
      notify(`"${plugin.label || plugin.repo}" 플러그인을 ${next ? "사용" : "사용 중지"}했습니다.`, "ok");
    } catch (err) {
      // Surface the failure, then re-throw so Toggle keeps the previous visual state.
      notify(`변경 실패: ${(err as Error).message}`, "warn");
      throw err;
    }
  }

  async function refreshPlugin(p: Plugin): Promise<void> {
    pluginRowBusy = { ...pluginRowBusy, [p.id]: true };
    try {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
      notify(`"${plugin.label || plugin.repo}" 플러그인을 최신 버전으로 새로고침했습니다.`, "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      pluginRowBusy = { ...pluginRowBusy, [p.id]: false };
    }
  }

  async function deletePlugin(p: Plugin): Promise<void> {
    if (!window.confirm(`플러그인 "${p.label || p.repo}"을(를) 삭제할까요?`)) return;
    pluginRowBusy = { ...pluginRowBusy, [p.id]: true };
    try {
      await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      replaceState({ plugins: readState().plugins.filter((x) => x.id !== p.id) });
      notify(`"${p.label || p.repo}" 플러그인을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      pluginRowBusy = { ...pluginRowBusy, [p.id]: false };
    }
  }

  async function togglePluginPick(p: Plugin): Promise<void> {
    if (openPluginId === p.id) {
      openPluginId = "";
      return;
    }
    openPluginId = p.id;
    if (!pluginContents[p.id]) await loadPluginContents(p);
  }
  async function loadPluginContents(p: Plugin): Promise<void> {
    pluginContentsErr = { ...pluginContentsErr, [p.id]: "" };
    try {
      const { contents } = await api<{ contents: RepoPluginContents }>(`/api/me/plugins/${encodeURIComponent(p.id)}/contents`);
      pluginContents = { ...pluginContents, [p.id]: contents };
    } catch (err) {
      pluginContentsErr = { ...pluginContentsErr, [p.id]: (err as Error).message };
    }
  }
  function savePluginSelection(p: Plugin) {
    return async (next: string[] | null): Promise<void> => {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ selected: next }) });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
    };
  }
</script>

{#if active && user}
  <!-- 지식 저장소 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>지식 저장소</h3>
        <p class="muted">내 아바타가 일하며 쌓는 지식·스킬을 담는 사내 GitHub({githubHost}) 저장소입니다.</p>
      </div>
      {#if user.knowledgeRepo}
        <div class="head-actions">
          <button class="linkish small" type="button" title="노트 사이의 [[링크]] 연결을 그래프로 봅니다" on:click={() => (graphOpen = true)}>그래프 보기</button>
          <button class="linkish small" type="button" title="저장소를 원격에서 다시 가져옵니다" disabled={krBusy} on:click={refreshKnowledge}>{krRefreshed ? "새로고침됨 ✓" : "새로고침"}</button>
          <button class="linkish small danger" type="button" title="이 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)" disabled={krBusy} on:click={disconnectKnowledge}>연결 해제</button>
        </div>
      {/if}
    </div>

    <form class="plugin-add rows-2" on:submit|preventDefault={saveKnowledge}>
      <input bind:value={knowledgeRepo} placeholder="owner/repo 또는 사내 git URL" aria-label="지식 저장소 (owner/repo 또는 사내 git URL)" />
      <input bind:value={knowledgeBranch} class="narrow" placeholder="브랜치 (선택)" aria-label="브랜치 (선택)" />
      <button class="primary" type="submit" disabled={krBusy}>{krBusy ? "저장 중…" : "저장"}</button>
    </form>

    {#if !user.knowledgeRepo}
      <div class="empty-note">
        지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요.
        <button class="linkish small" type="button" on:click={requestKnowledgeRepo}>아바타에게 저장소 만들기 요청</button>
      </div>
    {:else}
      {@const href = repoToHref(user.knowledgeRepo)}
      {@const linkText = user.knowledgeRepo + (user.knowledgeBranch ? ` @ ${user.knowledgeBranch}` : "")}
      <div class="kr-link">
        <Icon name="globe" />
        {#if href}<a {href} target="_blank" rel="noreferrer noopener">{linkText}</a>{:else}<code>{linkText}</code>{/if}
      </div>
      <div class="git-token-status muted">
        {#if user.gitTokenSet}
          <span class="token-set">● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요</span>
        {:else}
          <span>
            GIT_TOKEN이 없어 읽기만 가능합니다.
            <button class="linkish" type="button" on:click={() => updateState((s) => (s.settingsTab = "access"))}>권한·연결 탭의 Git 자격증명</button>
            에서 사내 Git 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.
          </span>
        {/if}
      </div>
      <div class="kr-plugins">
        <span class="muted">{!user.knowledgeSelected ? "저장소의 모든 플러그인을 사용 중" : `${user.knowledgeSelected.length}개 플러그인만 사용 중`}</span>
        <button class="linkish small" type="button" aria-expanded={krPickOpen} on:click={toggleKrPick}>사용할 플러그인 선택</button>
      </div>
      {#if krPickOpen}
        <div class="plugin-contents">
          {#if krContentsLoading}
            <div class="muted">불러오는 중…</div>
          {:else if krContentsErr}
            <div class="error-note">조회 실패: {krContentsErr} <button class="linkish small" type="button" on:click={loadKrContents}>다시 시도</button></div>
          {:else if krContents}
            <SettingsPluginSelect
              info={krContents}
              selected={user.knowledgeSelected}
              headText="아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
              onSave={saveKrSelection}
            />
          {/if}
        </div>
      {/if}
    {/if}
  </section>

  <!-- 플러그인 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>GitHub 플러그인</h3>
        <p class="muted">내 아바타가 사용할 플러그인. 다른 사용자와의 대화에서는 읽기 전용으로 실행됩니다.</p>
      </div>
    </div>

    <div class="plugin-rows">
      {#if !plugins.length}
        <div class="empty-note">추가한 플러그인이 없습니다.</div>
      {:else}
        {#each plugins as p (p.id)}
          <div class="plugin-row" class:busy={pluginRowBusy[p.id]}>
            <div class="pr-main">
              <strong>{p.label || p.repo}</strong>
              <div class="pr-sub">{p.ref ? `${p.repo} @ ${p.ref}` : p.repo}</div>
              <div class="pr-meta muted">{pluginSyncLabel(p)} · {pluginSelSummary(p)}</div>
            </div>
            <Toggle on={p.enabled} label={`플러그인 사용: ${p.label || p.repo}`} onChange={(v) => togglePlugin(p, v)} />
            <button class="msg-act" type="button" aria-label="저장소 내 플러그인 선택" title="저장소 내 플러그인 선택" aria-expanded={openPluginId === p.id} on:click={() => togglePluginPick(p)}><Icon name="menu" /></button>
            <button class="msg-act" type="button" aria-label="최신 버전으로 새로고침" title="최신 버전으로 새로고침" class:spinning={pluginRowBusy[p.id]} disabled={pluginRowBusy[p.id]} on:click={() => refreshPlugin(p)}><Icon name="refresh" /></button>
            <button class="msg-act danger" type="button" aria-label={`플러그인 삭제: ${p.label || p.repo}`} title="삭제" disabled={pluginRowBusy[p.id]} on:click={() => deletePlugin(p)}><Icon name="trash" /></button>
          </div>
          {#if openPluginId === p.id}
            <div class="plugin-contents">
              {#if pluginContentsErr[p.id]}
                <div class="error-note">조회 실패: {pluginContentsErr[p.id]} <button class="linkish small" type="button" on:click={() => loadPluginContents(p)}>다시 시도</button></div>
              {:else if pluginContents[p.id]}
                <SettingsPluginSelect
                  info={pluginContents[p.id]}
                  selected={p.selected}
                  headText="사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
                  onSave={savePluginSelection(p)}
                />
              {:else}
                <div class="muted">불러오는 중…</div>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>

    <form class="plugin-add rows-3" on:submit|preventDefault={addPlugin}>
      <input bind:value={pluginRepo} placeholder="owner/repo 또는 git URL" aria-label="플러그인 저장소 (owner/repo 또는 git URL)" required />
      <input bind:value={pluginRef} class="narrow" placeholder="브랜치/태그 (선택)" aria-label="브랜치/태그 (선택)" />
      <input bind:value={pluginLabel} class="narrow" placeholder="라벨 (선택)" aria-label="라벨 (선택)" />
      <button class="primary" type="submit" disabled={pluginAddBusy || !pluginRepo.trim()}>{pluginAddBusy ? "추가 중…" : "추가"}</button>
    </form>
  </section>

  {#if graphOpen}
    <GraphViewModal on:close={() => (graphOpen = false)} />
  {/if}
{/if}
