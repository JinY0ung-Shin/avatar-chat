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

  onMount(async () => {
    loading = true;
    error = "";
    try {
      await loadAvatars();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  });

  $: query = ($appState.exploreQuery || "").trim().toLowerCase();
  $: tokens = query ? query.split(/\s+/).map((item) => item.replace(/^#+/, "")).filter(Boolean) : [];
  $: sorted = [...$appState.avatars].sort((a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""));
  $: avatars = tokens.length ? sorted.filter((av) => matches(av, tokens)) : sorted;

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
    Boolean($appState.user && !$appState.user.gitTokenSet && !$appState.user.knowledgeRepo) &&
    (() => {
      try {
        return sessionStorage.getItem("setupBannerDismissed") !== "1";
      } catch {
        return true;
      }
    })();

  async function openChat(av: AvatarSummary) {
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

<div class="view-body scroll-thin">
  {#if showSetupBanner}
    <div class="setup-banner">
      <div class="sb-copy">
        <strong>지식 저장소를 연결하면 대화가 누적됩니다</strong>
        <span>아바타가 배운 내용과 스킬을 파일로 정리해 다음 대화에서 다시 사용할 수 있어요.</span>
      </div>
      <div class="sb-actions">
        <button class="primary small" type="button" on:click={() => goView("settings", "knowledge")}>설정하기</button>
        <button class="linkish small" type="button" on:click={dismissSetupBanner}>닫기</button>
      </div>
    </div>
  {/if}

  <div class="explore-search-bar">
    <Icon name="compass" />
    <input
      class="explore-search"
      type="search"
      placeholder="이름·해시태그로 검색 (예: #코드리뷰)"
      aria-label="아바타 검색"
      bind:this={searchInput}
      value={$appState.exploreQuery}
      on:input={(event) => updateState((state) => (state.exploreQuery = event.currentTarget.value))}
    />
  </div>

  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      아바타 목록을 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={() => loadAvatars(true)}>다시 시도</button>
    </div>
  {:else if !$appState.avatars.length}
    <div class="empty-note">
      공개된 아바타가 아직 없습니다.
      <button class="linkish small" type="button" on:click={() => goView("settings", "profile")}>내 아바타 공개 설정</button>
    </div>
  {:else if !avatars.length}
    <div class="empty-note">
      "{query}"에 맞는 아바타가 없습니다.
      <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
    </div>
  {:else}
    <div class="avatar-grid">
      {#each avatars as av (av.id)}
        <button
          class="avatar-card"
          type="button"
          aria-label={`${av.alias || av.displayName} 아바타와 대화`}
          title={`${av.alias || av.displayName} 아바타와 대화`}
          aria-busy={loadingAvatarId === av.id}
          disabled={loadingAvatarId === av.id}
          on:click={() => openChat(av)}
        >
          <AvatarImage user={av} size={56} alt="" />
          <div class="ac-body">
            <div class="ac-name">
              <strong>{av.displayName}</strong>
              {#if av.id === $appState.user?.id}
                <span class="tag accent">나</span>
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
              {#if av.pluginCount != null}
                <span class="tag">플러그인 {av.pluginCount}개</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
