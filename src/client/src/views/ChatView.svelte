<script lang="ts">
  import { afterUpdate, onMount, tick } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import CapabilitiesPanel from "../components/CapabilitiesPanel.svelte";
  import Icon from "../components/Icon.svelte";
  import { activePane, appState, notify, updateState } from "../lib/state";
  import { attachActiveRun, closePane, maybeGreet, newChat, selectConversation, sendMessage, startChatWith, stopPane } from "../lib/chat";
  import { loadAvatars, loadConversations } from "../lib/loaders";
  import { routeFromHash } from "../lib/nav";
  import { renderMarkdown } from "../lib/format";
  import type { ChatPane, StoredMessage } from "../lib/types";

  let transcriptEl: HTMLDivElement | null = null;
  let splitAvatarId = "";

  onMount(async () => {
    try {
      const route = routeFromHash();
      await loadConversations();
      await loadAvatars();
      if (route.view === "chat" && route.arg && activePane()?.conversationId !== route.arg) {
        await selectConversation(route.arg);
        return;
      }
      const pane = activePane();
      if (pane) {
        await attachActiveRun(pane.id);
        await maybeGreet(pane.id);
      }
    } catch (err) {
      notify(`대화 목록을 불러오지 못했습니다: ${(err as Error).message}`, "warn");
    }
  });

  afterUpdate(() => {
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });

  $: panes = $appState.chatPanes;
  $: pane = panes.find((item) => item.id === $appState.activePaneId) ?? panes[0] ?? null;
  $: splitClass = panes.length <= 1 ? "single" : $appState.chatLayout;
  $: openAvatarIds = new Set(panes.map((item) => item.avatar.id));
  $: addableAvatars = $appState.avatars.filter((avatar) => !openAvatarIds.has(avatar.id));
  $: if (addableAvatars.length && !addableAvatars.some((avatar) => avatar.id === splitAvatarId)) {
    splitAvatarId = addableAvatars[0].id;
  } else if (!addableAvatars.length && splitAvatarId) {
    splitAvatarId = "";
  }

  async function submit(pane: ChatPane) {
    const message = pane.draft;
    await sendMessage(pane.id, message);
    await tick();
  }

  function onComposerKeydown(event: KeyboardEvent, pane: ChatPane) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit(pane);
    }
  }

  function setDraft(paneId: string, value: string) {
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.draft = value;
    });
  }

  function setActive(paneId: string) {
    updateState((state) => {
      state.activePaneId = paneId;
      state.currentAvatar = state.chatPanes.find((item) => item.id === paneId)?.avatar || state.currentAvatar;
    });
  }

  async function addSplitPane() {
    const avatar = addableAvatars.find((item) => item.id === splitAvatarId);
    if (!avatar) return;
    if (panes.length >= 4) {
      notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
      return;
    }
    await startChatWith(avatar, true);
  }

  function messageText(message: StoredMessage) {
    return message.response?.text || message.response?.summary || message.content;
  }
</script>

{#snippet transcript(item: ChatPane)}
  <div class="chat-body">
    <div class="transcript scroll-thin" bind:this={transcriptEl} role="log" aria-live="polite" aria-relevant="additions" aria-busy={item.streaming ? "true" : "false"}>
      <div class="transcript-inner">
        {#if !item.messages.length && !item.streaming}
          <div class="empty-note">메시지를 입력해 대화를 시작하세요.</div>
        {/if}

        {#each item.messages as message (message.id || `${message.role}-${message.createdAt}-${message.content}`)}
          <div class={`message ${message.role}`}>
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{message.role === "user" ? "나" : item.avatar.displayName}</span>
            </div>
            <div class="bubble">
              {#if message.role === "assistant"}
                <div class="md">{@html renderMarkdown(messageText(message))}</div>
              {:else}
                <p>{message.content}</p>
              {/if}
            </div>
          </div>
        {/each}

        {#if item.streaming}
          <div class="message assistant" aria-live="off">
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{item.avatar.displayName}</span>
            </div>
            <div class="bubble">
              {#if item.liveEvents.length}
                <details class="activity-live" open>
                  <summary>작업 중…</summary>
                  <div class="agent-activity">
                    {#each item.liveEvents as activity (activity.id)}
                      <div class="tool-row" data-status={activity.status || activity.kind}>
                        <span class="tool-name">{activity.label}</span>
                        {#if activity.detail}<span class="tool-arg">{activity.detail}</span>{/if}
                      </div>
                    {/each}
                  </div>
                </details>
              {/if}
              {#if item.liveText}
                <div class="md">{@html renderMarkdown(item.liveText)}</div>
              {/if}
              <div class="stream-status">
                <span class="spinner"></span>
                <span class="label">{item.liveStatus || "응답 생성 중…"}</span>
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/snippet}

{#snippet composer(item: ChatPane)}
  <footer class="composer">
    <div class="composer-inner">
      <form class="composer-form" on:submit|preventDefault={() => submit(item)}>
        <div class="composer-box">
          <textarea
            rows="1"
            placeholder={item.streaming ? "응답을 기다리는 중…" : `${item.avatar.displayName}에게 메시지…`}
            value={item.draft}
            disabled={item.streaming}
            on:input={(event) => setDraft(item.id, event.currentTarget.value)}
            on:keydown={(event) => onComposerKeydown(event, item)}
          ></textarea>
          <button
            class="send-button"
            class:is-stop={item.streaming}
            type="button"
            aria-label={item.streaming ? "응답 중지" : "전송"}
            title={item.streaming ? "응답 중지" : "전송"}
            on:click={() => (item.streaming ? stopPane(item.id) : submit(item))}
          >
            <Icon name={item.streaming ? "stop" : "send"} />
          </button>
        </div>
      </form>
    </div>
  </footer>
{/snippet}

{#if !pane}
  <header class="view-header">
    <div>
      <h1>대화</h1>
      <p>탐색에서 아바타를 골라 대화를 시작하세요</p>
    </div>
  </header>
  <div class="view-body">
    <div class="empty-state">
      <div class="hero">
        <h3>아직 선택한 아바타가 없어요</h3>
        <p>탐색 탭에서 대화할 아바타를 골라 보세요.</p>
      </div>
    </div>
  </div>
{:else if panes.length > 1}
  <header class="view-header chat-head">
    <div class="header-left">
      <div class="title">
        <h1>분할 대화</h1>
        <p>최대 4개의 대화를 동시에 진행할 수 있습니다.</p>
      </div>
    </div>
    <div class="chat-head-actions">
      <div class="split-controls" role="group" aria-label="분할 대화">
        {#if panes.length > 1}
          {#each ["vertical", "horizontal", "grid"] as layout}
            <button
              type="button"
              class:active={$appState.chatLayout === layout}
              aria-label={layout === "vertical" ? "좌우 분할" : layout === "horizontal" ? "상하 분할" : "격자 분할"}
              on:click={() => updateState((state) => (state.chatLayout = layout as any))}
            >
              <Icon name={layout === "vertical" ? "columns" : layout === "horizontal" ? "rows" : "grid"} />
            </button>
          {/each}
        {/if}
        <select class="split-avatar-select" bind:value={splitAvatarId} disabled={!addableAvatars.length || panes.length >= 4} aria-label="분할로 추가할 아바타">
          {#if addableAvatars.length}
            {#each addableAvatars as av}
              <option value={av.id}>{av.alias || av.displayName || av.username}</option>
            {/each}
          {:else}
            <option value="">추가할 아바타 없음</option>
          {/if}
        </select>
        <button class="split-add" type="button" title="대화 추가 (분할)" aria-label="대화 추가 (분할)" disabled={!addableAvatars.length || panes.length >= 4} on:click={addSplitPane}>
          <Icon name="plus" />
        </button>
      </div>
      <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
    </div>
  </header>

  <div class={`chat-workbench ${splitClass}`}>
    {#each panes as item, index (item.id)}
      <section
        class="chat-col chat-pane compact"
        class:active={item.id === pane.id}
        data-pane={item.id}
        role="button"
        tabindex="0"
        on:click={() => setActive(item.id)}
        on:keydown={(event) => {
          if (event.key === "Enter" || event.key === " ") setActive(item.id);
        }}
      >
        <div class="pane-head">
          <div class="pane-title">
            <AvatarImage user={item.avatar} size={30} />
            <div>
              <strong>대화 {index + 1}</strong>
              <span>{item.avatar.alias || item.avatar.displayName}</span>
            </div>
          </div>
          <button class="msg-act" type="button" aria-label="대화 창 닫기" disabled={panes.length <= 1} on:click|stopPropagation={() => closePane(item.id)}>
            <Icon name="close" />
          </button>
        </div>
        {@render transcript(item)}
        {@render composer(item)}
      </section>
    {/each}
  </div>
{:else}
  <div class="chat-layout">
    <section class="chat-col chat-pane active" data-pane={pane.id}>
      <header class="view-header chat-head">
        <div class="header-left">
          <div class="chat-avatar">
            <AvatarImage user={pane.avatar} size={36} />
            <div>
              <h1 class="ca-name">{pane.avatar.alias || pane.avatar.displayName}</h1>
              <div class="ca-handle">@{pane.avatar.username}{pane.avatar.elevated ? "" : " · 읽기 전용"}</div>
            </div>
          </div>
        </div>
        <div class="chat-head-actions">
          <div class="split-controls" role="group" aria-label="분할 대화">
            <select class="split-avatar-select" bind:value={splitAvatarId} disabled={!addableAvatars.length || panes.length >= 4} aria-label="분할로 추가할 아바타">
              {#if addableAvatars.length}
                {#each addableAvatars as av}
                  <option value={av.id}>{av.alias || av.displayName || av.username}</option>
                {/each}
              {:else}
                <option value="">추가할 아바타 없음</option>
              {/if}
            </select>
            <button class="split-add" type="button" title="대화 추가 (분할)" aria-label="대화 추가 (분할)" disabled={!addableAvatars.length || panes.length >= 4} on:click={addSplitPane}>
              <Icon name="plus" />
            </button>
          </div>
          <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
        </div>
      </header>
      {@render transcript(pane)}
      {@render composer(pane)}
    </section>
    <CapabilitiesPanel avatar={pane.avatar} />
  </div>
{/if}
