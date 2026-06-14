<script lang="ts">
  import { afterUpdate, onMount, tick } from "svelte";
  import ActivityTree from "../components/ActivityTree.svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import CapabilitiesPanel from "../components/CapabilitiesPanel.svelte";
  import Icon from "../components/Icon.svelte";
  import PromptModal from "../components/PromptModal.svelte";
  import { activePane, appState, notify, updateState } from "../lib/state";
  import {
    PLUGIN_STATUS_LABELS,
    attachActiveRun,
    closePane,
    maybeGreet,
    newChat,
    regenerate,
    selectConversation,
    sendMessage,
    startChatWith,
    stopPane,
  } from "../lib/chat";
  import { api } from "../lib/api";
  import { autosize, copyText, enhanceMarkdown } from "../lib/dom";
  import { loadAvatars, loadConversations } from "../lib/loaders";
  import { routeFromHash } from "../lib/nav";
  import { formatUsageLabel, renderMarkdown, timeLabel } from "../lib/format";
  import { commandsForPane, type SlashCommand } from "../lib/slash";
  import type { AvatarSummary, ChatPane, StoredMessage } from "../lib/types";

  let transcriptEls: Record<string, HTMLDivElement> = {};
  let splitAvatarId = "";
  // Slash autocomplete: which pane it's open for + the selected index.
  let slashPaneId = "";
  let slashIndex = 0;
  let physicalKeyboard = false;
  // Per-pane group-knowledge dropdown open state.
  let gkOpenPaneId = "";

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
    for (const item of panes) {
      const el = transcriptEls[item.id];
      if (el && item.stickBottom !== false) el.scrollTop = el.scrollHeight;
    }
  });

  $: panes = $appState.chatPanes;
  $: pane = panes.find((item) => item.id === $appState.activePaneId) ?? panes[0] ?? null;
  $: splitClass = panes.length <= 1 ? "single" : $appState.chatLayout;
  // Split-add options: ALL visible avatars (duplicates allowed — you can run
  // several parallel conversations with the same avatar, incl. your own), with
  // the open panes' avatars unioned in as a fallback so your own avatar is always
  // selectable even before discovery loads.
  $: splitOptions = (() => {
    const byId = new Map<string, { id: string; alias?: string; displayName?: string; username?: string }>();
    for (const item of panes) if (item.avatar?.id) byId.set(item.avatar.id, item.avatar);
    for (const avatar of $appState.avatars) if (avatar?.id) byId.set(avatar.id, avatar);
    return [...byId.values()];
  })();
  $: if (splitOptions.length && !splitOptions.some((avatar) => avatar.id === splitAvatarId)) {
    splitAvatarId = splitOptions[0].id;
  } else if (!splitOptions.length && splitAvatarId) {
    splitAvatarId = "";
  }

  $: user = $appState.user;
  // Desktop / physical keyboard → Enter sends; touch-only → button sends.
  $: finePointer = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
  $: enterSends = finePointer || physicalKeyboard;

  function isOwnPane(item: ChatPane): boolean {
    return Boolean(item.avatar.isOwn || item.avatar.id === user?.id);
  }

  function eligibleGroups(item: ChatPane) {
    return isOwnPane(item) ? (user?.groups || []).filter((g) => g.knowledgeRepoConfigured) : [];
  }

  async function submit(item: ChatPane) {
    closeSlash();
    const message = item.draft;
    await sendMessage(item.id, message);
    await tick();
  }

  /* ---- slash autocomplete ---- */
  function slashQuery(text: string): string | null {
    if (typeof text !== "string" || text.startsWith("//")) return null;
    const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }
  function slashMatches(item: ChatPane): SlashCommand[] {
    const query = slashQuery(item.draft);
    if (query === null || item.streaming) return [];
    return commandsForPane(item).filter((cmd) => {
      if (!query) return true;
      return [cmd.name, cmd.title, cmd.description, cmd.argsLabel || ""].some((v) => v.toLowerCase().includes(query));
    });
  }
  function closeSlash() {
    slashPaneId = "";
    slashIndex = 0;
  }
  function applySlash(item: ChatPane, cmd: SlashCommand) {
    closeSlash();
    if (cmd.action === "new") {
      setDraft(item.id, "");
      newChat(item.id);
      return;
    }
    if (cmd.requiresArgs) {
      setDraft(item.id, `/${cmd.name} `);
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}`);
    void submit(item);
  }
  function completeSlash(item: ChatPane, cmd: SlashCommand) {
    setDraft(item.id, `/${cmd.name}${cmd.requiresArgs ? " " : ""}`);
    focusComposer(item.id);
  }

  function onComposerKeydown(event: KeyboardEvent, item: ChatPane) {
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) physicalKeyboard = true;
    const matches = slashPaneId === item.id ? slashMatches(item) : [];
    if (matches.length) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Home") slashIndex = 0;
        else if (event.key === "End") slashIndex = matches.length - 1;
        else slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applySlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        completeSlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    if (!enterSends) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!item.streaming) void submit(item);
    }
  }

  function onComposerInput(event: Event, item: ChatPane) {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    setDraft(item.id, value);
    if (slashQuery(value) !== null && !item.streaming) {
      slashPaneId = item.id;
      slashIndex = 0;
    } else if (slashPaneId === item.id) {
      closeSlash();
    }
  }

  function focusComposer(paneId: string) {
    void tick().then(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] textarea`);
      el?.focus();
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function setDraft(paneId: string, value: string) {
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.draft = value;
    });
  }

  function useStarter(item: ChatPane, text: string) {
    setActive(item.id);
    setDraft(item.id, text);
    focusComposer(item.id);
  }

  function copyMessage(message: StoredMessage, event: MouseEvent) {
    void copyText(message.content || message.response?.text || "", event.currentTarget as HTMLButtonElement);
  }

  function editMessage(item: ChatPane, message: StoredMessage) {
    setActive(item.id);
    setDraft(item.id, message.content || "");
    focusComposer(item.id);
    notify("메시지를 입력창에 불러왔습니다. 수정 후 보내기를 누르세요.", "info");
  }

  function setActive(paneId: string) {
    updateState((state) => {
      state.activePaneId = paneId;
      state.currentAvatar = state.chatPanes.find((item) => item.id === paneId)?.avatar || state.currentAvatar;
    });
  }

  function onTranscriptScroll(event: Event, item: ChatPane) {
    const el = event.currentTarget as HTMLDivElement;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.stickBottom = nearBottom;
    });
  }

  function scrollToBottom(item: ChatPane) {
    const el = transcriptEls[item.id];
    if (el) el.scrollTop = el.scrollHeight;
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.stickBottom = true;
    });
  }

  async function addSplitPane() {
    const avatar = splitOptions.find((item) => item.id === splitAvatarId);
    if (!avatar) return;
    if (panes.length >= 4) {
      notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
      return;
    }
    await startChatWith(avatar as AvatarSummary, true);
  }

  async function setGroupKnowledge(item: ChatPane, groupId: string, on: boolean) {
    const off = new Set(item.groupKnowledgeOff || []);
    if (on) off.delete(groupId);
    else off.add(groupId);
    const next = [...off];
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.groupKnowledgeOff = next;
      if (state.user) state.user.groupKnowledgeOffDefault = [...next];
    });
    const label = eligibleGroups(item).find((g) => g.id === groupId)?.name || "그룹";
    notify(`"${label}" 그룹 지식을 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/group-knowledge-default", { method: "PUT", body: JSON.stringify({ off: next }) }).catch((err) =>
      notify(`그룹 지식 기본값을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function messageText(message: StoredMessage) {
    return message.response?.text || message.response?.summary || message.content;
  }
  function runtimeBadge(message: StoredMessage): string | null {
    const runtime = message.response?.runtime;
    if (runtime === "local") return "로컬";
    if (message.response?.summary === "오류" || message.response?.summary === "중지됨") return message.response.summary;
    return null;
  }
  function activitySummary(item: ChatPane): string {
    const toolCount = item.liveTools.filter((t) => t.kind === "tool").length;
    const taskCount = item.liveTools.filter((t) => t.kind === "task").length;
    const agentCount = item.liveAgents.filter((a) => !a.isMain).length;
    const parts: string[] = [];
    if (toolCount) parts.push(`도구 ${toolCount}개`);
    if (taskCount) parts.push(`태스크 ${taskCount}개`);
    if (agentCount) parts.push(`에이전트 ${agentCount}개`);
    return parts.length ? `${parts.join(" · ")} 진행 중` : "작업 중…";
  }
</script>

{#snippet transcript(item: ChatPane)}
  <div class="chat-body">
    <div
      class="transcript scroll-thin"
      bind:this={transcriptEls[item.id]}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={item.streaming ? "true" : "false"}
      on:scroll={(event) => onTranscriptScroll(event, item)}
    >
      <div class="transcript-inner">
        {#if !item.messages.length && !item.streaming}
          {@const own = isOwnPane(item)}
          <div class="empty-state">
            <AvatarImage user={item.avatar} size={72} alt="" />
            <div class="hero">
              <h3>{item.avatar.displayName}와(과) 대화</h3>
              <p>{item.avatar.bio || (item.avatar.elevated || own ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.")}</p>
            </div>
            <div class="starter-prompts" role="group" aria-label="시작 프롬프트">
              {#each (item.avatar.elevated || own ? ["내가 지금 맡길 수 있는 일을 3가지로 제안해줘.", "이 대화에서 필요한 배경 정보를 먼저 물어봐줘.", "반복 업무로 만들 만한 루틴을 같이 설계해줘."] : ["이 아바타가 잘 아는 분야를 요약해줘.", "내 질문에 답하기 전에 필요한 맥락을 물어봐줘.", "관련된 지식을 바탕으로 핵심만 정리해줘."]) as text}
                <button class="starter-prompt" type="button" on:click={() => useStarter(item, text)}>{text}</button>
              {/each}
            </div>
          </div>
        {/if}

        {#each item.messages as message, index (message.id || `${message.role}-${message.createdAt}-${index}`)}
          <div class={`message ${message.role}`}>
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{message.role === "user" ? "나" : item.avatar.displayName}</span>
              {#if message.createdAt}<time class="msg-time" datetime={message.createdAt}>{timeLabel(message.createdAt)}</time>{/if}
            </div>
            <div class={`bubble ${message.response?.summary === "오류" ? "errored" : ""}`}>
              {#if message.role === "assistant"}
                {#if runtimeBadge(message)}
                  <div class="response-meta"><span class="meta-badge">{runtimeBadge(message)}</span></div>
                {/if}
                <div class="md" use:enhanceMarkdown={messageText(message)}>{@html renderMarkdown(messageText(message))}</div>
              {:else}
                {message.content}
              {/if}
            </div>
            <div class="msg-actions">
              <button class="msg-act" type="button" aria-label="복사" title="복사" on:click={(event) => copyMessage(message, event)}><Icon name="copy" /></button>
              {#if message.role === "user"}
                <button class="msg-act" type="button" aria-label="편집" title="편집 후 다시 보내기" on:click={() => editMessage(item, message)}><Icon name="edit" /></button>
              {:else if index === item.messages.length - 1 && !item.streaming}
                <button class="msg-act regen" type="button" aria-label="다시 생성" title="다시 생성" on:click={() => regenerate(item.id)}><Icon name="refresh" /></button>
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
              {#if item.liveAgents.length}
                <details class="activity-live" open>
                  <summary><span class="activity-summary-text">{activitySummary(item)}</span></summary>
                  <div class="agent-activity">
                    <ActivityTree agentId="main" agents={item.liveAgents} tools={item.liveTools} />
                  </div>
                </details>
              {/if}
              {#if item.liveText}
                <div class="md" use:enhanceMarkdown={item.liveText}>{@html renderMarkdown(item.liveText)}<span class="stream-caret" aria-hidden="true"></span></div>
              {/if}
              <div class="stream-status">
                <span class="spinner"></span>
                <span class="label">{item.liveStatus || "응답 생성 중…"}</span>
              </div>
              {#if item.livePlugins.length}
                <div class="plugin-chips">
                  {#each item.livePlugins as chip (chip.name)}
                    <span class="plugin-chip" data-status={chip.status}>
                      <span class="pc-dot"></span>
                      <span class="pc-text">{chip.name} · {PLUGIN_STATUS_LABELS[chip.status] || chip.status}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
    {#if item.stickBottom === false}
      <button class="scroll-bottom" type="button" aria-label="맨 아래로" title="맨 아래로" on:click={() => scrollToBottom(item)}><Icon name="arrow-down" /></button>
    {/if}
  </div>
{/snippet}

{#snippet composer(item: ChatPane, compact: boolean, index: number)}
  <footer class="composer">
    <div class="composer-inner">
      <form class="composer-form" on:submit|preventDefault={() => submit(item)}>
        {#if slashPaneId === item.id}
          {@const matches = slashMatches(item)}
          {#if matches.length}
            <div class="slash-menu" role="listbox" aria-label="슬래시 명령">
              <div class="slash-menu-head">슬래시 명령</div>
              {#each matches as cmd, i}
                <button
                  class="slash-option"
                  class:active={i === Math.min(slashIndex, matches.length - 1)}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex ? "true" : "false"}
                  on:mousedown|preventDefault={() => {}}
                  on:click={() => applySlash(item, cmd)}
                >
                  <span class="slash-option-command">/{cmd.name}{cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}</span>
                  <span class="slash-option-main"><strong>{cmd.title}</strong><span>{cmd.description}</span></span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
        <div class="composer-box">
          <textarea
            rows="1"
            placeholder={item.streaming ? "응답을 기다리는 중…" : `${item.avatar.displayName}에게 메시지…`}
            value={item.draft}
            disabled={item.streaming}
            use:autosize
            on:input={(event) => onComposerInput(event, item)}
            on:keydown={(event) => onComposerKeydown(event, item)}
          ></textarea>
          <button
            class="send-button"
            class:is-stop={item.streaming}
            type="button"
            aria-label={item.streaming ? "응답 중지" : "보내기"}
            title={item.streaming ? "응답 중지" : "보내기"}
            on:click={() => (item.streaming ? stopPane(item.id) : submit(item))}
          >
            <Icon name={item.streaming ? "stop" : "send"} />
          </button>
        </div>
        <div class="composer-hint">
          {#if compact}
            <span>대화 {index + 1}</span>
          {:else if enterSends}
            <span>Enter 전송 · <kbd>Shift+Enter</kbd> 줄바꿈</span>
          {:else}
            <span>보내기 버튼으로 전송</span>
          {/if}
          <span class="composer-meta">
            {#if eligibleGroups(item).length}
              {@const groups = eligibleGroups(item)}
              {@const onCount = groups.filter((g) => !(item.groupKnowledgeOff || []).includes(g.id)).length}
              <button
                class="composer-gk-btn"
                type="button"
                aria-expanded={gkOpenPaneId === item.id ? "true" : "false"}
                title="이 대화에서 다음 메시지부터 사용할 그룹 지식을 고릅니다"
                on:click={() => (gkOpenPaneId = gkOpenPaneId === item.id ? "" : item.id)}
              >그룹 지식 {onCount}/{groups.length}</button>
            {/if}
            {#if formatUsageLabel(item.usage)}
              <span class="composer-usage">{formatUsageLabel(item.usage)}</span>
            {/if}
          </span>
        </div>
      </form>
      {#if gkOpenPaneId === item.id && eligibleGroups(item).length}
        <div class="composer-gk-panel" role="group" aria-label="이 대화에서 사용할 그룹 지식">
          <div class="composer-gk-title">이 대화에서 사용할 그룹 지식</div>
          {#each eligibleGroups(item) as group (group.id)}
            <label class="composer-gk-item">
              <input
                type="checkbox"
                checked={!(item.groupKnowledgeOff || []).includes(group.id)}
                on:change={(event) => setGroupKnowledge(item, group.id, event.currentTarget.checked)}
              />
              <span>{group.name}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  </footer>
{/snippet}

{#snippet splitControls()}
  <div class="split-controls" role="group" aria-label="분할 대화">
    {#if panes.length > 1}
      {#each ["vertical", "horizontal", "grid"] as layout}
        <button
          type="button"
          class="split-btn"
          class:active={$appState.chatLayout === layout}
          aria-label={layout === "vertical" ? "좌우 분할" : layout === "horizontal" ? "상하 분할" : "격자 분할"}
          aria-pressed={$appState.chatLayout === layout ? "true" : "false"}
          on:click={() => updateState((state) => (state.chatLayout = layout as typeof state.chatLayout))}
        >
          <Icon name={layout === "vertical" ? "columns" : layout === "horizontal" ? "rows" : "grid"} />
        </button>
      {/each}
    {/if}
    <select class="split-avatar-select" bind:value={splitAvatarId} disabled={!splitOptions.length || panes.length >= 4} aria-label="분할로 추가할 아바타">
      {#if splitOptions.length}
        {#each splitOptions as av}
          <option value={av.id}>{av.alias || av.displayName || av.username}</option>
        {/each}
      {:else}
        <option value="">추가할 아바타 없음</option>
      {/if}
    </select>
    <button class="split-add" type="button" title="대화 추가 (분할)" aria-label="대화 추가 (분할)" disabled={!splitOptions.length || panes.length >= 4} on:click={addSplitPane}>
      <Icon name="plus" />
    </button>
  </div>
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
      {@render splitControls()}
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
            <AvatarImage user={item.avatar} size={30} alt="" />
            <div>
              <strong>대화 {index + 1}</strong>
              <span>{item.avatar.alias || item.avatar.displayName}</span>
            </div>
          </div>
          <div class="pane-actions">
            <button class="ghost-sm" type="button" disabled={item.streaming} on:click|stopPropagation={() => newChat(item.id)}>새 대화</button>
            <button class="msg-act" type="button" aria-label="대화 창 닫기" disabled={panes.length <= 1} on:click|stopPropagation={() => closePane(item.id)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        {@render transcript(item)}
        {@render composer(item, true, index)}
      </section>
    {/each}
  </div>
{:else}
  <div class="chat-layout">
    <section class="chat-col chat-pane active" data-pane={pane.id}>
      <header class="view-header chat-head">
        <div class="header-left">
          <div class="chat-avatar">
            <AvatarImage user={pane.avatar} size={36} alt="" />
            <div>
              <h1 class="ca-name">{pane.avatar.alias || pane.avatar.displayName}</h1>
              <div class="ca-handle">@{pane.avatar.username}{pane.avatar.elevated ? "" : " · 읽기 전용"}</div>
            </div>
          </div>
        </div>
        <div class="chat-head-actions">
          {@render splitControls()}
          <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
        </div>
      </header>
      {@render transcript(pane)}
      {@render composer(pane, false, 0)}
    </section>
    <CapabilitiesPanel avatar={pane.avatar} />
  </div>
{/if}

<PromptModal />
