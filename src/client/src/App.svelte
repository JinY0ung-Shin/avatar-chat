<script lang="ts">
  import { onMount } from "svelte";
  import AuthView from "./components/AuthView.svelte";
  import Shell from "./components/Shell.svelte";
  import Toasts from "./components/Toasts.svelte";
  import AdminView from "./views/AdminView.svelte";
  import BrainView from "./views/BrainView.svelte";
  import ChatView from "./views/ChatView.svelte";
  import ExploreView from "./views/ExploreView.svelte";
  import InboxView from "./views/InboxView.svelte";
  import OnboardingModal from "./components/OnboardingModal.svelte";
  import PromptModal from "./components/PromptModal.svelte";
  import RoutinesView from "./views/RoutinesView.svelte";
  import SettingsView from "./views/SettingsView.svelte";
  import { api, setSessionExpiredHandler } from "./lib/api";
  import { selectConversation } from "./lib/chat";
  import { loadInboxData, startKnowledgeWatch, stopKnowledgeWatch } from "./lib/loaders";
  import { applyInitialRoute, installRouteListener, syncHash } from "./lib/nav";
  import { appState, notify, readState, replaceState, updateState } from "./lib/state";
  import { applyTheme, getThemePref, watchSystemTheme } from "./lib/theme";
  import type { BootstrapInfo, User } from "./lib/types";

  let showOnboarding = false;
  let themeWatcherInstalled = false;

  async function boot() {
    const themePref = applyTheme();
    if (!themeWatcherInstalled) {
      watchSystemTheme();
      themeWatcherInstalled = true;
    }
    replaceState({ booted: false, bootError: "", themePref });
    try {
      const bootstrap = await api<BootstrapInfo>("/api/bootstrap");
      const { user } = await api<{ user: User | null }>("/api/me");
      replaceState({ bootstrap, user, booted: true, themePref, view: "explore" });
      // enterApp() runs via the reactive init guard below once user is set.
    } catch (err) {
      replaceState({ booted: true, bootError: (err as Error).message, themePref: getThemePref() });
    }
  }

  // Full post-login initialization: restore route, load the inbox (badges +
  // pending requests), start the knowledge/notification watcher, and show
  // first-run onboarding. Shared by boot() and post-login (Shell remount).
  function enterApp(user: User) {
    applyInitialRoute();
    if (!location.hash) syncHash(true);
    void loadInboxData();
    startKnowledgeWatch();
    // First-run welcome shows only while the account has never been onboarded
    // (server-persisted onboardedAt). Set once on signup, so a returning login
    // — even on a new browser — never re-fires it.
    if (!user.onboardedAt) showOnboarding = true;
  }

  function dismissOnboarding() {
    showOnboarding = false;
    // Persist server-side so it never re-appears; optimistically reflect it in
    // state. Fire-and-forget — a failed mark just means it may show once more.
    api<{ user: User }>("/api/me/onboarded", { method: "POST" })
      .then(({ user }) => replaceState({ user }))
      .catch(() => {});
  }

  function handleSessionExpired() {
    stopKnowledgeWatch();
    updateState((state) => {
      state.user = null;
      state.currentAvatar = null;
      state.chatPanes = [];
      state.activePaneId = null;
      state.conversations = [];
      state.notifications = [];
      state.knowledgeRequests = [];
      state.routineConversations = [];
      state.routineConversationId = "";
      state.routineMessages = [];
      state.promptQueue = [];
    });
    showOnboarding = false;
    notify("세션이 만료되었습니다. 다시 로그인해 주세요.", "warn");
    history.replaceState(null, "", location.pathname);
  }

  // When a user logs in from the auth screen (AuthView sets state.user), run the
  // same post-login initialization once.
  let initializedFor: string | null = null;
  $: if ($appState.booted && $appState.user && initializedFor !== $appState.user.id) {
    initializedFor = $appState.user.id;
    enterApp($appState.user);
  }
  $: if (!$appState.user) initializedFor = null;

  onMount(() => {
    setSessionExpiredHandler(handleSessionExpired);
    const cleanup = installRouteListener((conversationId) => {
      const state = readState();
      const activeConversationId =
        state.chatPanes.find((pane) => pane.id === state.activePaneId)?.conversationId ?? state.chatPanes[0]?.conversationId;
      if (activeConversationId === conversationId) return;
      void selectConversation(conversationId).catch((err) =>
        notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn"),
      );
    });
    void boot();
    return () => {
      cleanup();
      stopKnowledgeWatch();
    };
  });

  $: unreadCount =
    $appState.knowledgeRequests.filter((request) => request.status === "open").length +
    $appState.notifications.filter((notification) => !notification.readAt).length;
</script>

{#if !$appState.booted}
  <div class="svelte-fallback-pad muted">불러오는 중…</div>
{:else if $appState.bootError}
  <div class="svelte-fallback-pad warn-box">
    앱을 시작하지 못했습니다: {$appState.bootError}
    <button class="linkish" type="button" on:click={boot}>다시 시도</button>
  </div>
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
      {:else if $appState.view === "brain"}
        <BrainView />
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

{#if showOnboarding && $appState.user}
  <OnboardingModal
    user={$appState.user}
    confluenceConfigured={$appState.bootstrap?.confluenceConfigured ?? false}
    githubHost={$appState.bootstrap?.githubHost ?? "github.com"}
    on:close={dismissOnboarding}
  />
{/if}

<!-- Mounted at the app root (not inside ChatView) so input-needed prompts surface
     on ANY view — otherwise a question raised while the owner is on explore/inbox/
     settings would queue invisibly. -->
{#if $appState.user}
  <PromptModal />
{/if}

<Toasts />
