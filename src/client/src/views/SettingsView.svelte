<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import Toggle from "../components/Toggle.svelte";
  import RevealableInput from "../components/RevealableInput.svelte";
  import HashtagChipEditor from "../components/HashtagChipEditor.svelte";
  import SettingsPluginSelect from "../components/SettingsPluginSelect.svelte";
  import SettingsGroupCard from "../components/SettingsGroupCard.svelte";
  import type { SettingsGroup } from "../components/SettingsGroupCard.svelte";
  import { api, refreshMe } from "../lib/api";
  import { loadSettingsData } from "../lib/loaders";
  import { openSeededChat } from "../lib/chat";
  import { appState, notify, readState, replaceState, updateState } from "../lib/state";
  import { copyText } from "../lib/dom";
  import { timeLabel } from "../lib/format";
  import type { AvatarVisibility, Plugin, RepoPluginContents, User } from "../lib/types";

  const INTERNAL_GIT_TOKEN = "GIT_TOKEN";
  const EXTERNAL_GIT_TOKEN = "GITHUB_TOKEN";

  const SECRET_PRESETS = [
    {
      name: "SSH_PRIVATE_KEY",
      label: "SSH 개인키",
      description: "원격 SSH 도구가 사용할 OpenSSH/PEM 개인키입니다. 앱에서 키를 생성하면 자동으로 채워집니다.",
      placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
      rows: 4,
    },
    {
      name: "CONFLUENCE_PAT",
      label: "Confluence PAT",
      description: "사내 Confluence 공용 도구가 Bearer 인증에 사용할 Personal Access Token입니다.",
      placeholder: "Confluence personal access token",
      rows: 2,
    },
  ];

  const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
    { value: "public", label: "모두 공개", desc: "모든 사용자가 탐색에서 찾아 대화할 수 있어요." },
    { value: "group", label: "그룹 공개", desc: "같은 그룹 멤버만 탐색에서 찾아 대화할 수 있어요." },
    { value: "private", label: "비공개", desc: "나만 볼 수 있어요." },
  ];

  const tabs = [
    { id: "profile", label: "프로필" },
    { id: "access", label: "권한·연결" },
    { id: "knowledge", label: "지식·플러그인" },
    { id: "groups", label: "그룹" },
  ] as const;

  let loading = true;
  let error = "";

  // profile form
  let displayName = "";
  let alias = "";
  let bio = "";
  let intro = "";
  let persona = "";
  let hashtags: string[] = [];
  let profileSaving = false;
  let introGenBusy = false;
  let tagGenBusy = false;
  let picBusy = false;
  let fileInput: HTMLInputElement;

  // visibility
  let visibility: AvatarVisibility = "group";
  let visSaving = false;

  // git identity
  let gitIdentityName = "";
  let gitIdentityEmail = "";
  let identitySaving = false;

  // git token forms
  let internalToken = "";
  let externalToken = "";
  let internalBusy = false;
  let externalBusy = false;

  // preset secrets value inputs (keyed by name)
  let presetValues: Record<string, string> = {};
  let presetBusy: Record<string, boolean> = {};

  // arbitrary secret form
  let extraName = "";
  let extraValue = "";
  let extraBusy = false;

  let sshBusy = false;

  // knowledge repo form
  let knowledgeRepo = "";
  let knowledgeBranch = "";
  let krBusy = false;
  let krRefreshed = false;
  let krPickOpen = false;
  let krContents: RepoPluginContents | null = null;
  let krContentsErr = "";
  let krContentsLoading = false;

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

  // groups
  let groups: SettingsGroup[] = [];
  let groupsLoading = false;
  let groupsError = "";

  $: user = $appState.user;
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: settingsTab = $appState.settingsTab;
  $: plugins = $appState.plugins;
  $: internalSet = Boolean(user?.gitTokenSet);
  $: externalSet = Boolean(user?.secretNames.includes(EXTERNAL_GIT_TOKEN));
  $: presetNames = new Set(SECRET_PRESETS.map((p) => p.name));
  $: extraSecretNames = (user?.secretNames || []).filter((n) => !presetNames.has(n));

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
      const u = readState().user;
      if (u) fillProfile(u);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function fillProfile(u: User): void {
    displayName = u.displayName || "";
    alias = u.alias || "";
    bio = u.bio || "";
    intro = u.intro || "";
    persona = u.persona || "";
    hashtags = [...(u.hashtags || [])];
    visibility = u.visibility || "group";
    gitIdentityName = u.gitIdentityName || "";
    gitIdentityEmail = u.gitIdentityEmail || "";
    knowledgeRepo = u.knowledgeRepo || "";
    knowledgeBranch = u.knowledgeBranch || "";
  }

  async function saveProfile(): Promise<void> {
    profileSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName, alias, bio, intro, persona, hashtags }),
      });
      replaceState({ user: next });
      notify("프로필을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      profileSaving = false;
    }
  }

  async function generateIntro(): Promise<void> {
    introGenBusy = true;
    try {
      const { intro: next } = await api<{ intro: string }>("/api/me/intro/generate", { method: "POST" });
      if (next) {
        intro = next;
        notify("자기소개 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
      } else {
        notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      notify(`자기소개 생성 실패: ${(err as Error).message}`, "warn");
    } finally {
      introGenBusy = false;
    }
  }

  async function generateTags(): Promise<void> {
    tagGenBusy = true;
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" });
      if (next?.length) {
        hashtags = [...next];
        notify("해시태그 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
      } else {
        notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
      }
    } catch (err) {
      notify(`해시태그 생성 실패: ${(err as Error).message}`, "warn");
    } finally {
      tagGenBusy = false;
    }
  }

  // ---- visibility ----
  async function chooseVisibility(val: AvatarVisibility): Promise<void> {
    if (visSaving || val === visibility) return;
    const prev = visibility;
    visibility = val;
    visSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
      replaceState({ user: next });
      if (next.visibility !== val) {
        visibility = next.visibility;
        const label = VISIBILITY_OPTIONS.find((o) => o.value === next.visibility)?.label || next.visibility;
        notify(`공개 범위가 서버에서 ${label}(으)로 저장되었습니다.`, "warn");
      } else {
        const label = VISIBILITY_OPTIONS.find((o) => o.value === val)?.label || val;
        notify(`공개 범위를 ${label}(으)로 변경했습니다.`, "ok");
      }
    } catch (err) {
      visibility = prev;
      notify(`공개 범위 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      visSaving = false;
    }
  }

  // ---- avatar image ----
  async function uploadImage(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    picBusy = true;
    try {
      const image = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image }) });
      await refreshMe();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
    } finally {
      input.value = "";
      picBusy = false;
    }
  }

  async function deleteImage(): Promise<void> {
    if (!window.confirm("아바타 사진을 삭제할까요?")) return;
    picBusy = true;
    try {
      await api("/api/me/avatar-image", { method: "DELETE" });
      await refreshMe();
      notify("아바타 사진을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`사진 삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }

  // ---- git tokens ----
  async function saveInternalToken(): Promise<void> {
    const token = internalToken.trim();
    if (!token) return;
    internalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: next });
      internalToken = "";
      notify("사내 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function clearInternalToken(): Promise<void> {
    if (!window.confirm("사내 Git 토큰을 삭제할까요?")) return;
    internalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "DELETE" });
      replaceState({ user: next });
      notify("사내 Git 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function saveExternalToken(): Promise<void> {
    const token = externalToken.trim();
    if (!token) return;
    externalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "PUT", body: JSON.stringify({ value: token }) });
      replaceState({ user: next });
      externalToken = "";
      notify("외부 GitHub 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      externalBusy = false;
    }
  }
  async function clearExternalToken(): Promise<void> {
    if (!window.confirm("외부 GitHub 토큰을 삭제할까요?")) return;
    externalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "DELETE" });
      replaceState({ user: next });
      notify("외부 GitHub 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      externalBusy = false;
    }
  }

  async function saveGitIdentity(): Promise<void> {
    identitySaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name: gitIdentityName || null, email: gitIdentityEmail || null }),
      });
      replaceState({ user: next });
      notify("커밋 정보를 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      identitySaving = false;
    }
  }

  // ---- secrets ----
  async function savePresetSecret(name: string, label: string): Promise<void> {
    const value = presetValues[name] || "";
    if (!value) {
      notify(`${label} 값을 입력해 주세요.`, "warn");
      return;
    }
    presetBusy = { ...presetBusy, [name]: true };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      presetValues = { ...presetValues, [name]: "" };
      notify(`${label} 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }
  async function clearPresetSecret(name: string, label: string): Promise<void> {
    if (!window.confirm(`${label} 시크릿을 삭제할까요?`)) return;
    presetBusy = { ...presetBusy, [name]: true };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`${label} 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }

  async function saveExtraSecret(): Promise<void> {
    const name = extraName.trim();
    const value = extraValue;
    if (!name || !value) {
      notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
      return;
    }
    extraBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      extraName = "";
      extraValue = "";
      notify(`시크릿 "${name}"을(를) 저장했습니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      extraBusy = false;
    }
  }
  async function deleteExtraSecret(name: string): Promise<void> {
    if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function generateSshKey(): Promise<void> {
    sshBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      notify("SSH 키를 생성했습니다.", "ok");
    } catch (err) {
      notify(`SSH 키 생성 실패: ${(err as Error).message}`, "warn");
    } finally {
      sshBusy = false;
    }
  }

  function copySshKey(event: MouseEvent): void {
    const btn = event.currentTarget as HTMLButtonElement;
    void copyText(user?.sshPublicKey || "", btn);
  }

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

  // ---- groups ----
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

<div class="view-body scroll-thin settings-body" class:settings-body-access={settingsTab === "access"}>
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
          class:active={settingsTab === tab.id}
          aria-selected={settingsTab === tab.id}
          on:click={() => updateState((state) => (state.settingsTab = tab.id))}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <div class="settings-panel" class:settings-panel-access={settingsTab === "access"} role="tabpanel">
      {#if settingsTab === "profile"}
        <section class="settings-card">
          <div class="settings-head">
            <div class="pic-edit">
              <AvatarImage {user} size={96} alt="내 아바타 사진" />
              <button class="pic-cam" type="button" aria-label="사진 변경" title="사진 변경" disabled={picBusy} on:click={() => fileInput?.click()}>
                <Icon name="camera" />
              </button>
              <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden on:change={uploadImage} />
              {#if user.hasImage}
                <button class="linkish small" type="button" disabled={picBusy} on:click={deleteImage}>사진 삭제</button>
              {/if}
            </div>
            <div class="settings-id">
              <h3>{user.displayName}</h3>
              <div class="muted">@{user.username}</div>
            </div>
          </div>

          <form class="settings-form" on:submit|preventDefault={saveProfile}>
            <label class="field"><span>표시 이름</span><input bind:value={displayName} required /></label>
            <label class="field"><span>별칭 (아바타가 스스로를 부르는 이름)</span><input bind:value={alias} placeholder="비우면 표시 이름을 사용합니다" /></label>
            <label class="field"><span>소개 (한 줄)</span><input bind:value={bio} placeholder="어떤 아바타인지 소개하세요" /></label>
            <div class="field">
              <div class="field-row">
                <span>자기소개 (대화 패널 상단에 표시)</span>
                <button class="ghost-sm" type="button" disabled={introGenBusy} on:click={generateIntro}>{introGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
              </div>
              <textarea rows="4" bind:value={intro} placeholder="대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 '아바타가 자동 생성' 버튼으로 만들 수 있어요."></textarea>
            </div>
            <div class="field">
              <div class="field-row">
                <span>역량 해시태그 (탐색에서 검색됨)</span>
                <button class="ghost-sm" type="button" disabled={tagGenBusy} on:click={generateTags}>{tagGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
              </div>
              <HashtagChipEditor bind:tags={hashtags} />
            </div>
            <label class="field"><span>페르소나 (행동 지침)</span><textarea rows="4" bind:value={persona} placeholder="이 아바타가 어떻게 행동해야 하는지 (선택)"></textarea></label>
            <button class="primary" type="submit" disabled={profileSaving}>{profileSaving ? "저장 중…" : "프로필 저장"}</button>
          </form>
        </section>

        <section class="settings-card">
          <h3>공개 설정</h3>
          <div class="visibility-row">
            <div class="seg-control" role="radiogroup" aria-label="아바타 공개 범위" aria-busy={visSaving}>
              {#each VISIBILITY_OPTIONS as opt}
                <button
                  type="button"
                  class="seg-btn"
                  class:active={visibility === opt.value}
                  role="radio"
                  aria-checked={visibility === opt.value}
                  tabindex={visibility === opt.value ? 0 : -1}
                  disabled={visSaving}
                  on:click={() => chooseVisibility(opt.value)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
            <p class="muted">
              {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.desc || ""}{visSaving ? " 저장 중…" : ""}
            </p>
          </div>
        </section>
      {:else if settingsTab === "access"}
        <!-- Git 자격증명 -->
        <section class="settings-card">
          <div class="panel-section-head">
            <div>
              <h3>Git 자격증명</h3>
              <p class="muted">사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
            </div>
          </div>
          <div class="git-token-status muted">
            {#if internalSet}<span class="token-set">● 사내 Git (GIT_TOKEN) 설정됨</span>{:else}<span>사내 Git (GIT_TOKEN) 미설정</span>{/if}
            ·
            {#if externalSet}<span class="token-set">외부 GitHub (GITHUB_TOKEN) 설정됨</span>{:else}<span>외부 GitHub (GITHUB_TOKEN) 미설정</span>{/if}
          </div>

          <form class="secret-preset-row" on:submit|preventDefault={saveInternalToken}>
            <div class="secret-preset-meta">
              <div class="secret-preset-title">
                <strong>사내 Git 토큰</strong>
                <code>{INTERNAL_GIT_TOKEN}</code>
                <span class={internalSet ? "muted token-set" : "muted"}>{internalSet ? "● 설정됨" : "미설정"}</span>
              </div>
              <p class="muted">사내 GitHub({githubHost}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.</p>
            </div>
            <RevealableInput bind:value={internalToken} name="internalToken" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" revealLabel="토큰" />
            <div class="secret-preset-actions">
              <button class="primary" type="submit" disabled={internalBusy || !internalToken.trim()}>{internalSet ? "교체" : "저장"}</button>
              <button class="linkish small" type="button" disabled={!internalSet || internalBusy} on:click={clearInternalToken}>삭제</button>
            </div>
          </form>

          <form class="secret-preset-row" on:submit|preventDefault={saveExternalToken}>
            <div class="secret-preset-meta">
              <div class="secret-preset-title">
                <strong>외부 GitHub 토큰</strong>
                <code>{EXTERNAL_GIT_TOKEN}</code>
                <span class={externalSet ? "muted token-set" : "muted"}>{externalSet ? "● 설정됨" : "미설정"}</span>
              </div>
              <p class="muted">github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.</p>
            </div>
            <RevealableInput bind:value={externalToken} name="externalToken" placeholder="github.com PAT (GITHUB_TOKEN)" ariaLabel="외부 GitHub 토큰 GITHUB_TOKEN" revealLabel="토큰" />
            <div class="secret-preset-actions">
              <button class="primary" type="submit" disabled={externalBusy || !externalToken.trim()}>{externalSet ? "교체" : "저장"}</button>
              <button class="linkish small" type="button" disabled={!externalSet || externalBusy} on:click={clearExternalToken}>삭제</button>
            </div>
          </form>

          <form class="settings-form" on:submit|preventDefault={saveGitIdentity}>
            <div class="field-row-2col">
              <label class="field"><span>커밋 이름</span><input bind:value={gitIdentityName} placeholder={user.alias || user.displayName || ""} /></label>
              <label class="field"><span>커밋 이메일</span><input type="email" bind:value={gitIdentityEmail} placeholder={`${user.username}@example.com`} /></label>
            </div>
            <button class="primary" type="submit" disabled={identitySaving}>{identitySaving ? "저장 중…" : "커밋 정보 저장"}</button>
          </form>
        </section>

        <!-- 시크릿 -->
        <section class="settings-card">
          <div class="panel-section-head">
            <div>
              <h3>시크릿</h3>
              <p class="muted">내 아바타가 도구를 쓸 때만 주입되는 비밀값입니다. 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다.</p>
            </div>
          </div>

          <div class="secret-preset-list">
            {#each SECRET_PRESETS as preset}
              {@const isSet = user.secretNames.includes(preset.name)}
              <form class="secret-preset-row" on:submit|preventDefault={() => savePresetSecret(preset.name, preset.label)}>
                <div class="secret-preset-meta">
                  <div class="secret-preset-title">
                    <strong>{preset.label}</strong>
                    <code>{preset.name}</code>
                    {#if isSet}<span class="muted token-set">● 설정됨</span>{:else}<span class="muted">미설정</span>{/if}
                  </div>
                  <p class="muted">{preset.description}</p>
                </div>
                <textarea rows={preset.rows} placeholder={preset.placeholder} autocomplete="off" bind:value={presetValues[preset.name]}></textarea>
                <div class="secret-preset-actions">
                  <button class="primary" type="submit" disabled={presetBusy[preset.name] || !presetValues[preset.name]}>{isSet ? "교체" : "저장"}</button>
                  <button class="linkish small" type="button" disabled={!isSet || presetBusy[preset.name]} on:click={() => clearPresetSecret(preset.name, preset.label)}>삭제</button>
                </div>
              </form>
            {/each}
          </div>

          {#if user.sshPublicKey}
            <div class="ssh-public-key-box">
              <label class="field ssh-public-key-field">
                <span>SSH 공개키</span>
                <div class="ssh-public-key-row">
                  <textarea rows="3" readonly value={user.sshPublicKey}></textarea>
                  <button class="msg-act" type="button" aria-label="SSH 공개키 복사" title="SSH 공개키 복사" on:click={copySshKey}><Icon name="copy" /></button>
                </div>
              </label>
            </div>
          {:else}
            <button class="primary" type="button" disabled={sshBusy} on:click={generateSshKey}>{sshBusy ? "생성 중…" : "SSH 키 생성"}</button>
          {/if}

          <div class="secret-extra-head">
            <strong>기타 시크릿</strong>
            <p class="muted">도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요.</p>
          </div>
          <div class="secret-list">
            {#if !extraSecretNames.length}
              <div class="empty-note">추가 시크릿이 없습니다.</div>
            {:else}
              {#each extraSecretNames as name (name)}
                <div class="secret-row">
                  <code>{name}</code>
                  <span class="muted token-set">● 설정됨</span>
                  <button class="linkish small" type="button" aria-label={`시크릿 삭제: ${name}`} on:click={() => deleteExtraSecret(name)}>삭제</button>
                </div>
              {/each}
            {/if}
          </div>
          <form class="settings-form" on:submit|preventDefault={saveExtraSecret}>
            <label class="field"><span>이름</span><input bind:value={extraName} placeholder="SSH_PRIVATE_KEY" autocomplete="off" /></label>
            <label class="field"><span>값</span><textarea rows="4" bind:value={extraValue} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…" autocomplete="off"></textarea></label>
            <button class="primary" type="submit" disabled={extraBusy}>{extraBusy ? "저장 중…" : "추가 시크릿 저장"}</button>
          </form>
        </section>
      {:else if settingsTab === "knowledge"}
        <!-- 지식 저장소 -->
        <section class="settings-card">
          <div class="panel-section-head">
            <div>
              <h3>지식 저장소</h3>
              <p class="muted">내 아바타가 일하며 쌓는 지식·스킬을 담는 사내 GitHub({githubHost}) 저장소입니다.</p>
            </div>
            {#if user.knowledgeRepo}
              <div class="head-actions">
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
      {:else if settingsTab === "groups"}
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
