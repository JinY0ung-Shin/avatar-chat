<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { selectConversation } from "../lib/chat";
  import { formatDate } from "../lib/format";
  import { loadConversations } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { setThemePref } from "../lib/theme";
  import type { ThemePref } from "../lib/theme";
  import type { ConversationSummary, User, ViewName } from "../lib/types";

  export let user: User;
  export let view: ViewName;
  export let streaming = false;
  export let unreadCount = 0;
  export let themePref: ThemePref = "system";

  let railOpen = false;
  let conversationQuery = "";
  let conversationsLoading = false;
  let conversationsError = "";

  const nav = [
    { view: "explore", label: "탐색", icon: "compass" },
    { view: "chat", label: "대화", icon: "chat" },
    { view: "inbox", label: "알림", icon: "bell" },
    { view: "routines", label: "루틴", icon: "clock" },
    { view: "settings", label: "내 아바타", icon: "user" },
  ] as const;

  const themeLabels: Record<ThemePref, string> = { system: "시스템", light: "라이트", dark: "다크" };
  const themeIcons: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };
  const themeOrder: ThemePref[] = ["system", "light", "dark"];

  $: themeLabel = `테마: ${themeLabels[themePref]}`;
  $: themeIcon = themeIcons[themePref];
  $: activeConversationId =
    $appState.chatPanes.find((pane) => pane.id === $appState.activePaneId)?.conversationId ?? null;
  $: conversationTokens = conversationQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  $: railConversations = $appState.conversations
    .filter((conversation) => !conversation.isRoutine)
    .filter((conversation) => {
      if (!conversationTokens.length) return true;
      const hay = [conversation.title, conversation.avatarDisplayName].filter(Boolean).join(" ").toLowerCase();
      return conversationTokens.every((token) => hay.includes(token));
    });

  onMount(async () => {
    conversationsLoading = true;
    conversationsError = "";
    try {
      await loadConversations();
    } catch (err) {
      conversationsError = (err as Error).message;
    } finally {
      conversationsLoading = false;
    }
  });

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    updateState((state) => {
      state.user = null;
      state.currentAvatar = null;
      state.chatPanes = [];
      state.activePaneId = null;
      state.conversations = [];
      state.notifications = [];
      state.knowledgeRequests = [];
    });
    history.replaceState(null, "", location.pathname);
  }

  function closeRail() {
    railOpen = false;
  }

  function openRail() {
    railOpen = true;
  }

  function navigate(viewName: ViewName) {
    goView(viewName);
    closeRail();
  }

  async function openConversation(conversation: ConversationSummary) {
    try {
      await selectConversation(conversation.id);
      closeRail();
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    }
  }

  function conversationTitle(conversation: ConversationSummary) {
    return conversation.title || conversation.avatarDisplayName || "제목 없는 대화";
  }

  function pickTheme(value: ThemePref) {
    setThemePref(value);
    replaceState({ themePref: value });
    notify(`테마: ${themeLabels[value]}`, "info");
  }

  function cycleTheme() {
    const next = themeOrder[(themeOrder.indexOf(themePref) + 1) % themeOrder.length];
    pickTheme(next);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") closeRail();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<button class="icon-button rail-toggle svelte-rail-toggle" type="button" aria-label="메뉴 열기" title="메뉴" on:click={openRail}>
  <Icon name="menu" />
</button>

<aside class="rail" class:open={railOpen} id="rail" aria-label="대화 목록">
  <div class="rail-head">
    <div class="rail-brand">
      <img class="mark" src="/icon-192.png" alt="" aria-hidden="true" width="34" height="34" />
      <div>
        <div class="name">Noah Almighty</div>
        <div class="sub">아바타 플랫폼</div>
      </div>
    </div>

    <nav class="rail-nav" aria-label="주 메뉴">
      {#each nav as item}
        <button
          class="nav-item"
          type="button"
          class:active={view === item.view}
          aria-current={view === item.view ? "page" : undefined}
          on:click={() => navigate(item.view)}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
          {#if item.view === "inbox" && unreadCount > 0}
            <span class="nav-badge">{unreadCount}</span>
          {/if}
        </button>
      {/each}

      {#if user.roles?.includes("admin")}
        <button class="nav-item" type="button" class:active={view === "admin"} aria-current={view === "admin" ? "page" : undefined} on:click={() => navigate("admin")}>
          <Icon name="shield" />
          <span>관리자</span>
        </button>
      {/if}
    </nav>

    <button class="new-chat" type="button" on:click={() => navigate("explore")}>
      <Icon name="plus" />
      <span>새 대화</span>
    </button>
  </div>

  <div class="rail-history">
    <div class="rail-section-label">내 대화</div>
    <div class="conv-list-wrap">
      <input
        class="conv-search"
        type="search"
        placeholder={conversationsLoading ? "대화 불러오는 중" : "대화 검색"}
        aria-label="대화 검색"
        disabled={conversationsLoading}
        bind:value={conversationQuery}
      />
      <div class="conv-list scroll-thin">
        {#if conversationsLoading}
          <div class="conv-empty">불러오는 중…</div>
        {:else if conversationsError}
          <div class="conv-empty">대화를 불러오지 못했습니다.</div>
        {:else if !railConversations.length}
          <div class="conv-empty">{conversationQuery ? "검색 결과가 없습니다." : "아직 저장된 대화가 없습니다."}</div>
        {:else}
          {#each railConversations as conversation (conversation.id)}
            <button
              class="conv-item"
              class:active={conversation.id === activeConversationId}
              type="button"
              on:click={() => openConversation(conversation)}
            >
              <span class="conv-open">
                <span class="conv-name">{conversationTitle(conversation)}</span>
                <span class="conv-time">{conversation.avatarDisplayName} · {formatDate(conversation.updatedAt)}</span>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>

  <div class="rail-footer">
    {#if streaming}
      <div class="svelte-rail-streaming"><span class="spinner"></span><span>응답 중</span></div>
    {/if}
    <div class="rail-user-row">
      <button class="rail-me" type="button" title="내 아바타 설정" on:click={() => navigate("settings")}>
        <AvatarImage user={user} size={34} />
        <span class="meta">
          <b>{user.alias || user.displayName}</b>
          <span>@{user.username}</span>
        </span>
      </button>
      <button class="icon-button" type="button" aria-label={themeLabel} title={`${themeLabel} (클릭하여 변경)`} on:click={cycleTheme}>
        <Icon name={themeIcon} />
      </button>
      <button class="icon-button" type="button" aria-label="로그아웃" title="로그아웃" on:click={logout}>
      <Icon name="logout" />
      </button>
    </div>
  </div>
</aside>

<button class="rail-backdrop" class:open={railOpen} type="button" aria-label="메뉴 닫기" on:click={closeRail}></button>
