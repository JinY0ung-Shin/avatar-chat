<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, refreshMe } from "../lib/api";
  import { loadSettingsData } from "../lib/loaders";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { normalizeTags } from "../lib/format";
  import type { AvatarVisibility, Plugin, RepoPluginContents, User } from "../lib/types";

  let loading = true;
  let error = "";
  let profile = {
    displayName: "",
    alias: "",
    bio: "",
    intro: "",
    persona: "",
    hashtags: "",
    visibility: "group" as AvatarVisibility,
  };
  let token = "";
  let externalToken = "";
  let secretName = "";
  let secretValue = "";
  let gitIdentityName = "";
  let gitIdentityEmail = "";
  let knowledgeRepo = "";
  let knowledgeBranch = "";
  let pluginRepo = "";
  let pluginRef = "";
  let groupRepo = "";
  let groupBranch = "";

  const tabs = [
    { id: "profile", label: "프로필" },
    { id: "access", label: "접근/비밀" },
    { id: "knowledge", label: "지식/플러그인" },
    { id: "groups", label: "그룹" },
  ] as const;

  onMount(load);

  $: user = $appState.user;
  $: if (user && !profile.displayName && !loading) fillProfile(user);

  async function load() {
    loading = true;
    error = "";
    try {
      await loadSettingsData();
      if ($appState.user) fillProfile($appState.user);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function fillProfile(u: User) {
    profile = {
      displayName: u.displayName || "",
      alias: u.alias || "",
      bio: u.bio || "",
      intro: u.intro || "",
      persona: u.persona || "",
      hashtags: (u.hashtags || []).map((tag) => `#${tag}`).join(" "),
      visibility: u.visibility || "group",
    };
    gitIdentityName = u.gitIdentityName || "";
    gitIdentityEmail = u.gitIdentityEmail || "";
    knowledgeRepo = u.knowledgeRepo || "";
    knowledgeBranch = u.knowledgeBranch || "";
  }

  async function saveProfile() {
    try {
      const { user } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: profile.displayName,
          alias: profile.alias,
          bio: profile.bio,
          intro: profile.intro,
          persona: profile.persona,
          hashtags: normalizeTags(profile.hashtags),
          visibility: profile.visibility,
        }),
      });
      replaceState({ user });
      notify("프로필을 저장했습니다.", "ok");
    } catch (err) {
      notify(`프로필 저장 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function generateIntro() {
    try {
      const { intro } = await api<{ intro: string }>("/api/me/intro/generate", { method: "POST" });
      profile.intro = intro;
      notify("자기소개 초안이 채워졌습니다.", "info");
    } catch (err) {
      notify(`자기소개 생성 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function generateTags() {
    try {
      const { hashtags } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" });
      profile.hashtags = hashtags.map((tag) => `#${tag}`).join(" ");
      notify("해시태그 초안이 채워졌습니다.", "info");
    } catch (err) {
      notify(`해시태그 생성 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function uploadImage(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const image = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image }) });
      await refreshMe();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
    } finally {
      input.value = "";
    }
  }

  async function deleteImage() {
    if (!window.confirm("아바타 사진을 삭제할까요?")) return;
    await api("/api/me/avatar-image", { method: "DELETE" });
    await refreshMe();
    notify("아바타 사진을 삭제했습니다.", "ok");
  }

  async function saveGitToken(clear = false) {
    try {
      const result = clear
        ? await api<{ user: User }>("/api/me/git-token", { method: "DELETE" })
        : await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: result.user });
      token = "";
      notify(clear ? "내부 Git 토큰을 삭제했습니다." : "내부 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`토큰 처리 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function saveSecret(name: string, value: string, clear = false) {
    if (!name.trim()) return;
    try {
      const result = clear
        ? await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" })
        : await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
            method: "PUT",
            body: JSON.stringify({ value }),
          });
      replaceState({ user: result.user });
      secretName = "";
      secretValue = "";
      externalToken = "";
      notify(clear ? `${name} 삭제 완료` : `${name} 저장 완료`, "ok");
    } catch (err) {
      notify(`비밀값 처리 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function saveGitIdentity() {
    const { user } = await api<{ user: User }>("/api/me/git-identity", {
      method: "PUT",
      body: JSON.stringify({ name: gitIdentityName, email: gitIdentityEmail }),
    });
    replaceState({ user });
    notify("Git 작성자 정보를 저장했습니다.", "ok");
  }

  async function generateSshKey() {
    const { user } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
    replaceState({ user });
    notify("SSH 키를 생성했습니다.", "ok");
  }

  async function saveKnowledge(clear = false) {
    const { user } = await api<{ user: User }>("/api/me/knowledge-repo", {
      method: "PUT",
      body: JSON.stringify(clear ? { repo: "", branch: "" } : { repo: knowledgeRepo, branch: knowledgeBranch }),
    });
    replaceState({ user });
    notify(clear ? "지식 저장소 연결을 해제했습니다." : "지식 저장소를 저장했습니다.", "ok");
  }

  async function refreshKnowledge() {
    await api("/api/me/knowledge-repo/refresh", { method: "POST" });
    notify("지식 저장소를 동기화했습니다.", "ok");
  }

  async function addPlugin() {
    const { plugin } = await api<{ plugin: Plugin }>("/api/me/plugins", {
      method: "POST",
      body: JSON.stringify({ repo: pluginRepo, ref: pluginRef }),
    });
    replaceState({ plugins: [...$appState.plugins, plugin] });
    pluginRepo = "";
    pluginRef = "";
    notify("플러그인을 추가했습니다.", "ok");
  }

  async function updatePlugin(plugin: Plugin, patch: Partial<Plugin>) {
    const { plugin: next } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(plugin.id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    replaceState({ plugins: $appState.plugins.map((item) => (item.id === next.id ? next : item)) });
  }

  async function refreshPlugin(plugin: Plugin) {
    const { plugin: next } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(plugin.id)}/refresh`, { method: "POST" });
    replaceState({ plugins: $appState.plugins.map((item) => (item.id === next.id ? next : item)) });
    notify("플러그인을 동기화했습니다.", "ok");
  }

  async function inspectPlugin(plugin: Plugin) {
    const { contents } = await api<{ contents: RepoPluginContents }>(`/api/me/plugins/${encodeURIComponent(plugin.id)}/contents`);
    notify(contents.kind === "marketplace" ? `플러그인 ${contents.plugins.length}개를 찾았습니다.` : `저장소 유형: ${contents.kind}`, "info");
  }

  async function deletePlugin(plugin: Plugin) {
    if (!window.confirm("플러그인을 삭제할까요?")) return;
    await api(`/api/me/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" });
    replaceState({ plugins: $appState.plugins.filter((item) => item.id !== plugin.id) });
  }

  async function loadGroups() {
    const { groups } = await api<{ groups: User["groups"] }>("/api/me/groups");
    if ($appState.user) replaceState({ user: { ...$appState.user, groups } });
  }

  async function saveGroupKnowledge(groupId: string, clear = false) {
    const { group } = await api<{ group: User["groups"][number] }>(`/api/me/groups/${encodeURIComponent(groupId)}/knowledge-repo`, {
      method: "PUT",
      body: JSON.stringify(clear ? { repo: "", branch: "" } : { repo: groupRepo, branch: groupBranch }),
    });
    void group;
    groupRepo = "";
    groupBranch = "";
    await loadGroups();
    notify("그룹 지식 저장소를 저장했습니다.", "ok");
  }

  function resizeImage(file: File, max: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png", 0.9));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
</script>

<header class="view-header">
  <div>
    <h1>내 아바타</h1>
    <p>프로필과 플러그인을 관리하고 공개하세요</p>
  </div>
</header>

<div class="view-body scroll-thin settings-body">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      설정 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else if user}
    <div class="tabbar" role="tablist">
      {#each tabs as tab}
        <button
          type="button"
          role="tab"
          class:active={$appState.settingsTab === tab.id}
          aria-selected={$appState.settingsTab === tab.id}
          on:click={() => updateState((state) => (state.settingsTab = tab.id))}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if $appState.settingsTab === "profile"}
      <section class="settings-card">
        <div class="settings-head">
          <div class="pic-edit">
            <AvatarImage user={user} size={96} alt="내 아바타 사진" />
            <label class="pic-cam" aria-label="사진 변경" title="사진 변경">
              <Icon name="camera" />
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden on:change={uploadImage} />
            </label>
          </div>
          <div class="settings-id">
            <h3>{user.displayName}</h3>
            <div class="muted">@{user.username}</div>
            {#if user.hasImage}
              <button class="linkish small" type="button" on:click={deleteImage}>사진 삭제</button>
            {/if}
          </div>
        </div>

        <form class="settings-form" on:submit|preventDefault={saveProfile}>
          <label class="field"><span>표시 이름</span><input bind:value={profile.displayName} required /></label>
          <label class="field"><span>별칭</span><input bind:value={profile.alias} placeholder="비우면 표시 이름을 사용합니다" /></label>
          <label class="field"><span>소개</span><input bind:value={profile.bio} placeholder="어떤 아바타인지 소개하세요" /></label>
          <div class="field">
            <div class="field-row"><span>자기소개</span><button class="ghost-sm" type="button" on:click={generateIntro}>아바타가 자동 생성</button></div>
            <textarea rows="4" bind:value={profile.intro}></textarea>
          </div>
          <div class="field">
            <div class="field-row"><span>역량 해시태그</span><button class="ghost-sm" type="button" on:click={generateTags}>아바타가 자동 생성</button></div>
            <input bind:value={profile.hashtags} placeholder="#코드리뷰 #문서작성" />
          </div>
          <label class="field"><span>페르소나</span><textarea rows="5" bind:value={profile.persona}></textarea></label>
          <div class="field">
            <span>공개 범위</span>
            <div class="segmented">
              {#each [
                { value: "public", label: "모두 공개" },
                { value: "group", label: "그룹 공개" },
                { value: "private", label: "비공개" },
              ] as item}
                <label><input type="radio" bind:group={profile.visibility} value={item.value} />{item.label}</label>
              {/each}
            </div>
          </div>
          <button class="primary" type="submit">프로필 저장</button>
        </form>
      </section>
    {:else if $appState.settingsTab === "access"}
      <section class="settings-card">
        <h3>Git 자격 증명</h3>
        <label class="field"><span>내부 Git 토큰 (GIT_TOKEN)</span><input type="password" bind:value={token} autocomplete="off" /></label>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveGitToken(false)} disabled={!token}>저장</button>
          <button class="ghost-sm" type="button" on:click={() => saveGitToken(true)} disabled={!user.gitTokenSet}>삭제</button>
        </div>
        <label class="field"><span>외부 GitHub 토큰 (GITHUB_TOKEN)</span><input type="password" bind:value={externalToken} autocomplete="off" /></label>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveSecret("GITHUB_TOKEN", externalToken)} disabled={!externalToken}>저장</button>
          <button class="ghost-sm" type="button" on:click={() => saveSecret("GITHUB_TOKEN", "", true)} disabled={!user.secretNames.includes("GITHUB_TOKEN")}>삭제</button>
        </div>
      </section>
      <section class="settings-card">
        <h3>SSH / 기타 비밀값</h3>
        {#if user.sshPublicKey}
          <label class="field"><span>SSH 공개키</span><textarea readonly rows="3" value={user.sshPublicKey}></textarea></label>
        {:else}
          <button class="primary" type="button" on:click={generateSshKey}>SSH 키 생성</button>
        {/if}
        <div class="grid-2">
          <label class="field"><span>비밀값 이름</span><input bind:value={secretName} placeholder="CONFLUENCE_PAT" /></label>
          <label class="field"><span>값</span><input type="password" bind:value={secretValue} autocomplete="off" /></label>
        </div>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveSecret(secretName, secretValue)} disabled={!secretName || !secretValue}>저장</button>
          <button class="ghost-sm" type="button" on:click={() => saveSecret(secretName, "", true)} disabled={!secretName}>삭제</button>
        </div>
        <div class="tag-list">
          {#each user.secretNames as name}
            <span class="tag">{name}</span>
          {/each}
        </div>
      </section>
      <section class="settings-card">
        <h3>Git 작성자 정보</h3>
        <div class="grid-2">
          <label class="field"><span>이름</span><input bind:value={gitIdentityName} /></label>
          <label class="field"><span>이메일</span><input bind:value={gitIdentityEmail} /></label>
        </div>
        <button class="primary" type="button" on:click={saveGitIdentity}>저장</button>
      </section>
    {:else if $appState.settingsTab === "knowledge"}
      <section class="settings-card">
        <h3>개인 지식 저장소</h3>
        <div class="grid-2">
          <label class="field"><span>저장소</span><input bind:value={knowledgeRepo} placeholder="owner/repo 또는 git URL" /></label>
          <label class="field"><span>브랜치</span><input bind:value={knowledgeBranch} placeholder="비우면 기본 브랜치" /></label>
        </div>
        <div class="button-row">
          <button class="primary" type="button" on:click={() => saveKnowledge(false)}>저장</button>
          <button class="ghost-sm" type="button" on:click={refreshKnowledge} disabled={!user.knowledgeRepo}>동기화</button>
          <button class="ghost-sm" type="button" on:click={() => saveKnowledge(true)} disabled={!user.knowledgeRepo}>연결 해제</button>
        </div>
      </section>
      <section class="settings-card">
        <h3>플러그인</h3>
        <div class="grid-2">
          <label class="field"><span>저장소</span><input bind:value={pluginRepo} placeholder="owner/repo 또는 git URL" /></label>
          <label class="field"><span>ref</span><input bind:value={pluginRef} placeholder="브랜치/태그/SHA" /></label>
        </div>
        <button class="primary" type="button" on:click={addPlugin} disabled={!pluginRepo}>플러그인 추가</button>
        <div class="plugin-list">
          {#each $appState.plugins as plugin (plugin.id)}
            <div class="plugin-row">
              <div>
                <strong>{plugin.label || plugin.repo}</strong>
                <div class="muted">{plugin.ref || "default"} · {plugin.enabled ? "활성" : "비활성"}</div>
              </div>
              <div class="button-row">
                <button class="ghost-sm" type="button" on:click={() => updatePlugin(plugin, { enabled: !plugin.enabled })}>{plugin.enabled ? "끄기" : "켜기"}</button>
                <button class="ghost-sm" type="button" on:click={() => inspectPlugin(plugin)}>검사</button>
                <button class="ghost-sm" type="button" on:click={() => refreshPlugin(plugin)}>동기화</button>
                <button class="danger small" type="button" on:click={() => deletePlugin(plugin)}>삭제</button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {:else if $appState.settingsTab === "groups"}
      <section class="settings-card">
        <h3>내 그룹</h3>
        {#if !user.groups.length}
          <div class="empty-note">소속 그룹이 없습니다.</div>
        {:else}
          {#each user.groups as group}
            <div class="group-card">
              <div>
                <strong>{group.name}</strong>
                <span class="tag">{group.role}</span>
                {#if group.knowledgeRepoConfigured}<span class="tag accent">지식 저장소 연결됨</span>{/if}
              </div>
              {#if group.role === "admin"}
                <div class="grid-2">
                  <label class="field"><span>그룹 지식 저장소</span><input bind:value={groupRepo} /></label>
                  <label class="field"><span>브랜치</span><input bind:value={groupBranch} /></label>
                </div>
                <div class="button-row">
                  <button class="primary small" type="button" on:click={() => saveGroupKnowledge(group.id)}>저장</button>
                  <button class="ghost-sm" type="button" on:click={() => saveGroupKnowledge(group.id, true)}>해제</button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </section>
    {/if}
  {/if}
</div>
