<script lang="ts">
  import { onMount } from "svelte";
  import AuthView from "./components/AuthView.svelte";
  import Shell from "./components/Shell.svelte";
  import Toasts from "./components/Toasts.svelte";
  import AdminView from "./views/AdminView.svelte";
  import ChatView from "./views/ChatView.svelte";
  import ExploreView from "./views/ExploreView.svelte";
  import InboxView from "./views/InboxView.svelte";
  import RoutinesView from "./views/RoutinesView.svelte";
  import SettingsView from "./views/SettingsView.svelte";
  import { api, setSessionExpiredHandler } from "./lib/api";
  import { applyInitialRoute, installRouteListener, syncHash } from "./lib/nav";
  import { appState, notify, replaceState, updateState } from "./lib/state";
  import { applyTheme, getThemePref, watchSystemTheme } from "./lib/theme";
  import type { BootstrapInfo, User } from "./lib/types";

  async function boot() {
    try {
      const themePref = applyTheme();
      watchSystemTheme();
      const bootstrap = await api<BootstrapInfo>("/api/bootstrap");
      const { user } = await api<{ user: User | null }>("/api/me");
      replaceState({ bootstrap, user, booted: true, themePref, view: user ? "explore" : "explore" });
      if (user) {
        applyInitialRoute();
        if (!location.hash) syncHash(true);
      }
    } catch (err) {
      replaceState({ booted: true, bootError: (err as Error).message, themePref: getThemePref() });
    }
  }

  function handleSessionExpired() {
    updateState((state) => {
      state.user = null;
      state.currentAvatar = null;
      state.chatPanes = [];
      state.activePaneId = null;
      state.conversations = [];
      state.notifications = [];
      state.knowledgeRequests = [];
    });
    notify("세션이 만료되었습니다. 다시 로그인해 주세요.", "warn");
    history.replaceState(null, "", location.pathname);
  }

  onMount(() => {
    setSessionExpiredHandler(handleSessionExpired);
    const cleanup = installRouteListener();
    void boot();
    return cleanup;
  });

  $: unreadCount =
    $appState.knowledgeRequests.filter((request) => request.status === "open").length +
    $appState.notifications.filter((notification) => !notification.readAt).length;
</script>

{#if !$appState.booted}
  <div class="svelte-fallback-pad muted">불러오는 중…</div>
{:else if $appState.bootError}
  <div class="svelte-fallback-pad warn-box">앱을 시작하지 못했습니다: {$appState.bootError}</div>
{:else if !$appState.user}
  <AuthView bootstrap={$appState.bootstrap} />
{:else}
  <section class="workspace">
    <Shell user={$appState.user} view={$appState.view} streaming={$appState.streaming} {unreadCount} themePref={$appState.themePref} />
    <main id="main" class="main" tabindex="-1">
      {#if $appState.view === "explore"}
        <ExploreView />
      {:else if $appState.view === "chat"}
        <ChatView />
      {:else if $appState.view === "inbox"}
        <InboxView />
      {:else if $appState.view === "routines"}
        <RoutinesView />
      {:else if $appState.view === "settings"}
        <SettingsView />
      {:else if $appState.view === "admin"}
        <AdminView />
      {/if}
    </main>
  </section>
{/if}

<Toasts />
