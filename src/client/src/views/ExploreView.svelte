<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import { startChatWith } from "../lib/chat";
  import { loadAvatars } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import { appState, notify, updateState } from "../lib/state";
  import type { AvatarSummary } from "../lib/types";

  let loading = true;
  let error = "";
  let loadingAvatarId: string | null = null;
  let searchInput: HTMLInputElement | null = null;

  onMount(() => {
    void load();
  });

  async function load(force = false): Promise<void> {
    loading = true;
    error = "";
    try {
      await loadAvatars(force);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  $: displayQuery = ($appState.exploreQuery || "").trim();
  $: query = displayQuery.toLowerCase();
  $: tokens = query ? query.split(/\s+/).map((item) => item.replace(/^#+/, "")).filter(Boolean) : [];
  $: sorted = [...$appState.avatars].sort((a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""));
  $: avatars = tokens.length ? sorted.filter((av) => matches(av, tokens)) : sorted;
  $: profileReady = Boolean($appState.user?.alias || $appState.user?.bio || $appState.user?.intro || $appState.user?.hashtags?.length);
  $: knowledgeReady = Boolean($appState.user?.knowledgeRepo);
  $: accessReady = Boolean($appState.user?.gitTokenSet || $appState.user?.sshPublicKey || $appState.user?.secretNames?.includes("SSH_PRIVATE_KEY"));

  function rank(av: AvatarSummary) {
    if (av.id === $appState.user?.id) return 0;
    if (av.sharesGroup) return 1;
    return 2;
  }

  function matches(av: AvatarSummary, parts: string[]) {
    const hay = [av.displayName, av.alias, av.username, av.bio, ...(av.hashtags || [])].filter(Boolean).join(" ").toLowerCase();
    return parts.every((part) => hay.includes(part));
  }

  let setupBannerDismissed = false;

  function dismissSetupBanner() {
    try {
      sessionStorage.setItem("setupBannerDismissed", "1");
    } catch {
      /* ignore */
    }
    setupBannerDismissed = true;
  }

  $: showSetupBanner =
    !setupBannerDismissed &&
    Boolean($appState.user && (!profileReady || !knowledgeReady)) &&
    (() => {
      try {
        return sessionStorage.getItem("setupBannerDismissed") !== "1";
      } catch {
        return true;
      }
    })();
  $: resultStatus = loading
    ? "아바타 목록을 불러오는 중입니다."
    : error
      ? `아바타 목록을 불러오지 못했습니다: ${error}`
      : !$appState.avatars.length
        ? "공개된 아바타가 아직 없습니다."
        : !avatars.length
          ? `${displayQuery} 검색 결과가 없습니다.`
          : displayQuery
            ? `${displayQuery} 검색 결과 ${avatars.length}개가 있습니다.`
            : `아바타 ${avatars.length}개가 있습니다.`;

  async function openChat(av: AvatarSummary) {
    if (loadingAvatarId) return;
    loadingAvatarId = av.id;
    try {
      await startChatWith(av);
    } catch (err) {
      notify(`대화를 시작하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      loadingAvatarId = null;
    }
  }

  function clearSearch() {
    updateState((state) => (state.exploreQuery = ""));
    searchInput?.focus();
  }
</script>

<header class="view-header">
  <div>
    <h1>탐색</h1>
    <p>공개된 아바타와 대화를 시작하세요</p>
  </div>
</header>

<div class="view-body scroll-thin" aria-busy={loading}>
  {#if showSetupBanner}
    <div class="setup-banner">
      <div class="sb-copy">
        <strong>아바타 준비가 아직 남아 있습니다</strong>
        <span>프로필과 지식 저장소를 먼저 잡아두면 탐색 카드와 대화 맥락이 바로 좋아집니다.</span>
      </div>
      <div class="setup-steps" aria-label="아바타 준비 상태">
        <button class="setup-step" class:done={profileReady} type="button" aria-label={`프로필 설정 ${profileReady ? "완료" : "필요"}`} on:click={() => goView("settings", "profile")}>
          <Icon name={profileReady ? "check" : "user"} />
          <span>프로필</span>
        </button>
        <button class="setup-step" class:done={knowledgeReady} type="button" aria-label={`지식 저장소 설정 ${knowledgeReady ? "완료" : "필요"}`} on:click={() => goView("settings", "knowledge")}>
          <Icon name={knowledgeReady ? "check" : "book"} />
          <span>지식 저장소</span>
        </button>
        <button class="setup-step" class:done={accessReady} type="button" aria-label={`권한 연결 설정 ${accessReady ? "완료" : "필요"}`} on:click={() => goView("settings", "access")}>
          <Icon name={accessReady ? "check" : "key"} />
          <span>권한 연결</span>
        </button>
      </div>
      <div class="sb-actions">
        <button class="primary small" type="button" on:click={() => goView("settings", profileReady ? "knowledge" : "profile")}>이어서 설정</button>
        <button class="linkish small" type="button" on:click={dismissSetupBanner}>닫기</button>
      </div>
    </div>
  {/if}

  <div class="explore-search-bar">
    <Icon name="compass" />
    <input
      id="explore-search"
      class="explore-search"
      type="search"
      placeholder="이름·해시태그로 검색 (예: #코드리뷰)"
      aria-label="아바타 검색"
      aria-describedby="explore-results-status"
      bind:this={searchInput}
      value={$appState.exploreQuery}
      on:input={(event) => updateState((state) => (state.exploreQuery = event.currentTarget.value))}
    />
    {#if displayQuery}
      <button class="msg-act explore-search-clear" type="button" aria-label="검색어 지우기" title="검색어 지우기" on:click={clearSearch}>
        <Icon name="close" />
      </button>
    {/if}
  </div>
  <div class="sr-only" id="explore-results-status" role="status" aria-live="polite">{resultStatus}</div>

  {#if loading}
    <div class="muted pad" role="status">불러오는 중…</div>
  {:else if error}
    <div class="warn-box" role="alert">
      아바타 목록을 불러오지 못했습니다: {error}
      <button class="linkish" type="button" disabled={loading} on:click={() => load(true)}>다시 시도</button>
    </div>
  {:else if !$appState.avatars.length}
    <div class="empty-note">
      공개된 아바타가 아직 없습니다.
      <button class="linkish small" type="button" on:click={() => goView("settings", "profile")}>내 아바타 공개 설정</button>
    </div>
  {:else if !avatars.length}
    <div class="empty-note">
      "{displayQuery}"에 맞는 아바타가 없습니다.
      <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
    </div>
  {:else}
    <div class="avatar-grid" aria-label={displayQuery ? `${displayQuery} 검색 결과` : "아바타 목록"}>
      {#each avatars as av (av.id)}
        <button
          class="avatar-card"
          class:opening={loadingAvatarId === av.id}
          type="button"
          aria-label={`${av.alias || av.displayName} 아바타와 대화${loadingAvatarId === av.id ? ", 여는 중" : ""}`}
          title={`${av.alias || av.displayName} 아바타와 대화`}
          aria-busy={loadingAvatarId === av.id}
          disabled={Boolean(loadingAvatarId)}
          on:click={() => openChat(av)}
        >
          <AvatarImage user={av} size={56} alt="" />
          <div class="ac-body">
            <div class="ac-name">
              <strong>{av.displayName}</strong>
              {#if av.id === $appState.user?.id}
                <span class="tag accent">나</span>
              {:else if av.runtime === "external"}
                <span class="tag accent">외부 Agent</span>
              {:else if av.sharesGroup}
                <span class="tag write">같은 그룹</span>
              {/if}
              {#if av.visibility === "group"}
                <span class="tag">그룹 공개</span>
              {/if}
              {#if av.visibility === "private"}
                <span class="tag">비공개</span>
              {/if}
            </div>
            <div class="ac-handle">{loadingAvatarId === av.id ? "대화 여는 중…" : `@${av.username}`}</div>
            {#if av.alias}<div class="ac-alias">"{av.alias}"</div>{/if}
            {#if av.bio}<p class="ac-bio">{av.bio}</p>{/if}
            <div class="ac-tags">
              {#each (av.hashtags || []).slice(0, 6) as tag}
                <span class="tag accent">#{tag}</span>
              {/each}
              {#if av.runtime !== "external" && av.pluginCount != null}
                <span class="tag">플러그인 {av.pluginCount}개</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
