// Auto-split from app.js — module: chat. Behavior-preserving relocation only.
import { avatarNode } from "./avatar-image.js";
import { api, copyText, dom, el, enhanceCodeBlocks, icon, newId, notify, renderMarkdown, setAbort, setFormBusy, state, timeLabel, triggerSessionExpired } from "./core.js";
import { loadAvatars } from "./loaders.js";
import { goView, renderView, syncDocumentTitle, syncHash } from "./nav.js";
import { advancePromptModal, closeRail, dismissRunPrompts, promptQueue, showPromptModal, viewHeader } from "./shell.js";


export function streamingPane() {
  return state.chatPanes.find((p) => p.streaming) || null;
}

// Replacing the active conversation while a run is streaming would orphan the
// local live state. Keep that narrow path explicit: stop first, then switch.
export function guardChatReplacement(targetConversationId = "") {
  const pane = streamingPane();
  if (!pane) return true;
  if (targetConversationId && pane.conversationId === targetConversationId) return true;
  notify("응답 생성 중인 대화가 있습니다. 다른 대화로 전환하려면 먼저 중지해 주세요.", "warn");
  return false;
}

/* ============================================================ Chat panes */
const MAX_CHAT_PANES = 4;

// A NEW conversation with the owner's OWN avatar seeds its group-knowledge
// selection from the saved per-user default (state.user.groupKnowledgeOffDefault).
// This is what makes the toggle meaningful for the auto-greeting, which fires
// before the user can touch the composer. Colleague chats and existing
// conversations (which pass their persisted value explicitly) ignore this.
function defaultGroupKnowledgeOff(avatar) {
  return avatar?.id && avatar.id === state.user?.id
    ? [...(state.user?.groupKnowledgeOffDefault || [])]
    : [];
}

// Persist the owner's group-knowledge OFF-set as the per-user default so future
// conversations/greetings start from it. Updates state.user optimistically and
// fires the PUT in the background. We do NOT overwrite from the response: rapid
// toggles can resolve out of order, and the optimistic value is always the latest
// the user picked. A failure only loses the cross-conversation default (the
// current conversation still gets the selection via its chat POST), so we just
// toast rather than block the toggle.
function saveGroupKnowledgeDefault(off) {
  if (!state.user) return;
  state.user.groupKnowledgeOffDefault = [...off];
  api("/api/me/group-knowledge-default", {
    method: "PUT",
    body: JSON.stringify({ off }),
  }).catch((e) => notify(`그룹 지식 기본값을 저장하지 못했습니다: ${e.message}`));
}

export function makeChatPane(avatar, { conversationId = newId(), messages = [], groupKnowledgeOff = defaultGroupKnowledgeOff(avatar) } = {}) {
  return {
    id: newId(),
    avatar,
    conversationId,
    messages,
    // Group ids whose shared knowledge is OFF for this conversation (owner-only
    // toggle). Empty = all groups ON. Loaded from /api/messages.
    groupKnowledgeOff,
    draft: "",
    streaming: false,
    abortController: null,
    dom: {},
    greetedConversationId: null,
    greetingStarted: false,
  };
}

// Owner-only, per-conversation toggle: which of the owner's group knowledge
// repos (skills + standing CLAUDE.md) are active in THIS conversation. Shown from
// the moment a chat starts when chatting with your OWN avatar and you belong to
// >=1 group that has a shared repo. The selection lives in pane.groupKnowledgeOff
// (group ids turned OFF) and is sent with each chat turn (see submitMessage); the
// server applies + persists it. Colleague chats always load all groups (no control).
function setupGroupKnowledgeToggle(pane, pdom) {
  const btn = el("button", { type: "button", class: "composer-gk-btn", hidden: "" });
  const panel = el("div", {
    class: "composer-gk-panel",
    hidden: "",
    role: "group",
    "aria-label": "이 대화에서 사용할 그룹 지식",
  });
  let open = false;
  const eligibleGroups = () =>
    pane.avatar?.id === state.user?.id
      ? (state.user?.groups || []).filter((g) => g.knowledgeRepoConfigured)
      : [];
  const closePanel = () => {
    open = false;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  // The selection applies to THIS conversation on the next turn (it rides the
  // chat POST — works on a brand-new chat with no row yet) AND is saved as the
  // owner's per-user default so it seeds future conversations + their greetings.
  const setGroup = (groupId, enabled) => {
    const off = new Set(pane.groupKnowledgeOff || []);
    if (enabled) off.delete(groupId);
    else off.add(groupId);
    pane.groupKnowledgeOff = [...off];
    renderBtn();
    const group = eligibleGroups().find((g) => g.id === groupId);
    const label = group?.name || "그룹";
    notify(`"${label}" 그룹 지식을 ${enabled ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    saveGroupKnowledgeDefault(pane.groupKnowledgeOff);
  };
  const renderPanel = () => {
    const groups = eligibleGroups();
    const off = new Set(pane.groupKnowledgeOff || []);
    panel.replaceChildren(
      el("div", { class: "composer-gk-title", text: "이 대화에서 사용할 그룹 지식" }),
      ...groups.map((g) => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = !off.has(g.id);
        cb.addEventListener("change", () => setGroup(g.id, cb.checked));
        return el("label", { class: "composer-gk-item" }, [cb, el("span", { text: g.name })]);
      }),
    );
  };
  const renderBtn = () => {
    const groups = eligibleGroups();
    const visible = groups.length > 0;
    btn.hidden = !visible;
    if (!visible) {
      closePanel();
      return;
    }
    const off = new Set(pane.groupKnowledgeOff || []);
    const onCount = groups.filter((g) => !off.has(g.id)).length;
    btn.textContent = `그룹 지식 ${onCount}/${groups.length}`;
    btn.title = "이 대화에서 다음 메시지부터 사용할 그룹 지식을 고릅니다";
    btn.setAttribute("aria-label", `이 대화에서 사용할 그룹 지식 ${onCount}/${groups.length}`);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    open = !open;
    panel.hidden = !open;
    if (open) renderPanel();
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  pdom.gkBtn = btn;
  pdom.gkPanel = panel;
  pdom.refreshGroupKnowledge = () => {
    renderBtn();
    if (open) renderPanel();
  };
  renderBtn();
}

function ensureChatPanes() {
  if (!state.chatPanes.length && state.currentAvatar) {
    state.chatPanes = [makeChatPane(state.currentAvatar, { conversationId: state.conversationId, messages: state.messages })];
    state.activePaneId = state.chatPanes[0].id;
  }
  if (state.chatPanes.length && !state.chatPanes.some((p) => p.id === state.activePaneId)) {
    state.activePaneId = state.chatPanes[0].id;
  }
  syncLegacyChatState(activePane());
  return state.chatPanes;
}

export function activePane() {
  return state.chatPanes.find((p) => p.id === state.activePaneId) || state.chatPanes[0] || null;
}

export function setActivePane(pane) {
  if (!pane) return;
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  dom.main?.querySelectorAll(".chat-pane").forEach((node) => {
    node.classList.toggle("active", node.dataset.pane === pane.id);
  });
}

export function syncLegacyChatState(pane = activePane()) {
  if (!pane) {
    state.currentAvatar = null;
    state.conversationId = newId();
    state.messages = [];
    refreshStreamingState();
    return;
  }
  state.currentAvatar = pane.avatar;
  state.conversationId = pane.conversationId;
  state.messages = pane.messages;
  refreshStreamingState();
}

function refreshStreamingState() {
  state.streaming = state.chatPanes.some((p) => p.streaming);
  setAbort(activePane()?.abortController || null);
  // Keep header "새 대화" buttons in sync with their pane's streaming state.
  dom.main?.querySelectorAll("[data-newchat]").forEach((btn) => {
    const paneEl = btn.closest(".chat-pane");
    const pane = paneEl ? state.chatPanes.find((p) => p.id === paneEl.dataset.pane) : activePane();
    btn.disabled = Boolean(pane?.streaming);
  });
}

export function anyChatStreaming() {
  return state.chatPanes.some((p) => p.streaming);
}

export function stopAllChatStreams() {
  for (const pane of state.chatPanes) {
    pane.abortController?.abort();
  }
  setAbort(null);
  state.streaming = false;
}

function splitEnabled() {
  return Boolean(state.user && state.chatPanes.length);
}

function splitLayoutClass() {
  if (state.chatPanes.length <= 1) return "single";
  if (state.chatLayout === "horizontal") return "horizontal";
  if (state.chatLayout === "grid") return "grid";
  return "vertical";
}

/* ============================================================ Chat view */
export function renderChat() {
  ensureChatPanes();
  if (!state.chatPanes.length || !state.currentAvatar) {
    const header = viewHeader("대화", "탐색에서 아바타를 골라 대화를 시작하세요");
    dom.main.append(
      header,
      el("div", { class: "view-body" }, [
        el("div", { class: "empty-state" }, [
          el("div", { class: "hero" }, [
            el("h3", { text: "아직 선택한 아바타가 없어요" }),
            el("p", { text: "탐색 탭에서 대화할 아바타를 골라 보세요." }),
          ]),
          el("button", { class: "primary", type: "button", text: "아바타 탐색", onclick: () => goView("explore") }),
        ]),
      ]),
    );
    return;
  }

  const panes = ensureChatPanes();
  const av = activePane()?.avatar || state.currentAvatar;
  const controls = splitEnabled() ? renderSplitControls() : null;
  if (panes.length > 1) {
    const header = viewHeader("분할 대화", "최대 4개의 대화를 동시에 진행할 수 있습니다.", controls);
    const grid = el("div", { class: `chat-workbench ${splitLayoutClass()}` }, panes.map((pane, index) => renderChatPane(pane, { compact: true, index })));
    dom.main.append(header, grid);
    panes.forEach((pane) => maybeGreet(pane));
    return;
  }

  const pane = panes[0];
  // Elevated viewers (owner or trusted user) run tools; everyone else is
  // read-only and gets the "읽기 전용" tag. `elevated` comes from the avatar
  // detail (GET /api/avatars/:id) so trusted users aren't mislabeled.
  const elevated = av.elevated || av.id === state.user?.id;
  const headerExtra = el("div", { class: "chat-avatar" }, [
    avatarNode(av, 36, { alt: "" }),
    el("div", {}, [
      el("h1", { class: "ca-name", text: av.alias || av.displayName }),
      el("div", { class: "ca-handle", text: `@${av.username}${elevated ? "" : " · 읽기 전용"}` }),
    ]),
  ]);
  const actions = el("div", { class: "chat-head-actions" }, [
    controls,
    el("button", {
      class: "ghost-sm",
      type: "button",
      text: "새 대화",
      dataset: { newchat: "1" },
      disabled: pane.streaming ? "" : null,
      onclick: () => newChat(pane),
    }),
  ]);
  const header = el("header", { class: "view-header chat-head" }, [
    el("div", { class: "header-left" }, [dom.railToggle, headerExtra]),
    actions,
  ]);

  // Chat content (header + transcript + composer) sits in its own column; the
  // capabilities panel sits beside it. `.main` stays a plain column (shared by
  // every view), so we fill it with a single row that holds both.
  const chatCol = renderChatPane(pane, { header });
  dom.main.append(el("div", { class: "chat-layout" }, [chatCol, renderCapabilitiesPanel(av)]));
  // Owner opening a fresh chat with their own avatar → the avatar greets first.
  maybeGreet(pane);
}

function renderSplitControls() {
  const atPaneLimit = state.chatPanes.length >= MAX_CHAT_PANES;
  let canAdd = splitEnabled() && !atPaneLimit;
  const wrap = el("div", { class: "split-controls", role: "group", "aria-label": "분할 대화" });
  if (!state.avatarsLoaded && !state.avatarsLoading) {
    loadAvatars()
      // Live bubbles are pane-owned and reattach during renderTranscript(), so
      // the avatar selector can update even while another pane is streaming.
      .then(() => { if (state.view === "chat") renderView(); })
      .catch(() => {});
  }
  const layoutBtn = (layout, ic, title) => {
    const active = state.chatLayout === layout;
    const btn = el("button", {
      class: `split-btn ${active ? "active" : ""}`,
      type: "button",
      title,
      "aria-label": title,
      "aria-pressed": active ? "true" : "false",
      onclick: () => {
        state.chatLayout = layout;
        renderView();
      },
    });
    btn.append(icon(ic));
    wrap.append(btn);
  };
  // Layout choice only matters with 2+ panes — hide it before that.
  if (state.chatPanes.length > 1) {
    layoutBtn("vertical", "columns", "좌우 분할");
    layoutBtn("horizontal", "rows", "상하 분할");
    layoutBtn("grid", "grid", "격자 분할");
  }
  const avatars = splitAvatarOptions();
  const activeAvatarId = activePane()?.avatar?.id || state.currentAvatar?.id || "";
  const openAvatarIds = new Set(state.chatPanes.map((pane) => pane.avatar?.id).filter(Boolean));
  const addableAvatars = avatars.filter((av) => av.id && !openAvatarIds.has(av.id));
  canAdd = canAdd && addableAvatars.length > 0;
  const unavailableLabel = atPaneLimit
    ? "분할 대화는 최대 4개까지 가능합니다"
    : state.avatarsLoaded
      ? "추가할 다른 아바타가 없습니다"
      : "아바타 목록 불러오는 중";
  const selectedAvatarId = addableAvatars.some((av) => av.id === state.splitAvatarId)
    ? state.splitAvatarId
    : addableAvatars[0]?.id || activeAvatarId;
  const avatarSelect = el("select", {
    class: "split-avatar-select",
    title: canAdd ? "분할로 추가할 아바타" : unavailableLabel,
    "aria-label": canAdd ? "분할로 추가할 아바타" : unavailableLabel,
    disabled: canAdd ? null : "",
    onchange: (event) => { state.splitAvatarId = event.currentTarget.value; },
  }, (canAdd ? addableAvatars : avatars).map((av) => el("option", { value: av.id, text: av.alias || av.displayName || av.username || "아바타" })));
  avatarSelect.value = selectedAvatarId;
  state.splitAvatarId = selectedAvatarId;
  wrap.append(avatarSelect);
  const addBtn = el("button", {
    class: "split-add",
    type: "button",
    title: canAdd ? "대화 추가 (분할)" : unavailableLabel,
    "aria-label": canAdd ? "대화 추가 (분할)" : unavailableLabel,
    disabled: canAdd ? null : "",
    onclick: () => addChatPane(avatarSelect.value),
  });
  addBtn.append(icon("plus"));
  wrap.append(addBtn);
  return wrap;
}

function splitAvatarOptions() {
  const byId = new Map();
  for (const pane of state.chatPanes) {
    if (pane.avatar?.id) byId.set(pane.avatar.id, pane.avatar);
  }
  if (state.currentAvatar?.id) byId.set(state.currentAvatar.id, state.currentAvatar);
  for (const av of state.avatars) {
    if (av?.id) byId.set(av.id, av);
  }
  return [...byId.values()];
}

// Spin up a fresh conversation with the owner's own avatar and drop `seedText`
// into the composer (not sent — the owner reviews/edits first).
export function chatAboutTopic(seedText) {
  const me = state.user;
  if (!me) return;
  if (streamingPane() && !guardChatReplacement()) return;
  state.currentAvatar = me;
  const pane = makeChatPane(me);
  pane.greetingStarted = true; // skip the auto-greeting; we already have a topic
  state.chatPanes = [pane];
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  state.view = "chat";
  syncHash();
  renderView();
  const ta = pane.dom?.textarea;
  if (ta) {
    ta.value = seedText;
    ta.dispatchEvent(new Event("input"));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    notify("입력창에 주제를 채웠습니다. 검토 후 보내기를 누르세요.", "info");
  }
  refreshConversations();
}

/* ============================================================ Slash commands */
const SLASH_COMMANDS = [
  {
    name: "new",
    title: "새 대화",
    description: "현재 아바타와 새 대화를 바로 시작합니다.",
    action: (pane) => newChat(pane),
  },
  {
    name: "summarize",
    title: "요약",
    description: "지금까지의 대화를 요약합니다.",
    prompt: () => "지금까지의 대화를 핵심 결정사항, 해야 할 일, 열린 질문으로 나눠 요약해줘.",
  },
  {
    name: "learn",
    title: "세션 학습",
    description: "이번 대화에서 재사용할 지식을 추려 저장하게 합니다.",
    ownerOnly: true,
    // Expanded on the SERVER (LEARN_SLASH_PROMPT in app.ts): the bubble shows the
    // literal "/learn" and the model receives the full instruction. No client
    // prompt() — the long instruction never appears in the user's message.
    serverExpand: true,
  },
  {
    name: "remember",
    title: "지식 저장",
    argsLabel: "내용",
    description: "뒤에 쓴 내용을 내 지식 저장소에 기록하게 합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) =>
      `다음 내용을 내 지식 저장소에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘.\n\n${args}`,
  },
  {
    name: "routine",
    title: "루틴 만들기",
    argsLabel: "작업",
    description: "작업 내용을 받아 매일 실행할 루틴 생성을 요청합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) =>
      `다음 작업을 정기적으로 실행하는 루틴을 만들어줘. 실행 시각(KST 기준)이 아래에 적혀 있으면 그대로 쓰고, 없으면 먼저 물어봐줘.\n\n${args}`,
  },
  {
    name: "find",
    title: "아바타 찾기",
    argsLabel: "요청",
    description: "요청에 맞는 팀원 아바타를 찾아 추천하게 합니다.",
    requiresArgs: true,
    prompt: (args) =>
      `이 요청에 더 적합한 팀원 아바타가 있는지 찾아보고 추천해줘.\n\n${args}`,
  },
];

function slashCommandsForPane(pane) {
  const ownsAvatar = pane?.avatar?.id && pane.avatar.id === state.user?.id;
  return SLASH_COMMANDS.filter((cmd) => !cmd.ownerOnly || ownsAvatar);
}

function slashQueryForText(text) {
  if (typeof text !== "string" || text.startsWith("//")) return null;
  const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function matchingSlashCommands(pane, query) {
  const q = (query || "").toLowerCase();
  return slashCommandsForPane(pane).filter((cmd) => {
    if (!q) return true;
    return [cmd.name, cmd.title, cmd.description, cmd.argsLabel || ""].some((value) => value.toLowerCase().includes(q));
  });
}

function resolveTypedSlashCommand(pane, message) {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match || message.startsWith("//")) return null;
  const name = match[1].toLowerCase();
  const command = slashCommandsForPane(pane).find((cmd) => cmd.name === name);
  if (!command) return null;
  return { command, args: (match[2] || "").trim() };
}

function slashPrompt(command, args = "") {
  return command.prompt ? command.prompt(args) : "";
}

function hideSlashMenu(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.slashMenu) return;
  pdom.slashMenu.hidden = true;
  pdom.slashMenu.replaceChildren();
  pdom.slashMatches = [];
  pdom.slashIndex = 0;
  pdom.textarea?.removeAttribute("aria-controls");
  pdom.textarea?.removeAttribute("aria-activedescendant");
  pdom.textarea?.setAttribute("aria-expanded", "false");
}

// Tab-completion: drop the command's canonical text into the box WITHOUT running
// it. Used by Tab and when a command still needs arguments.
function completeSlashCommand(pane, command) {
  const pdom = pane?.dom;
  if (!pdom?.textarea) return;
  pdom.textarea.value = `/${command.name}${command.requiresArgs ? " " : ""}`;
  pdom.textarea.dispatchEvent(new Event("input"));
  pdom.textarea.focus();
  const end = pdom.textarea.value.length;
  pdom.textarea.setSelectionRange(end, end);
}

// The user PICKED this command (click or Enter): run it if it's ready, or park
// the cursor in the argument slot if it still needs input. A bare no-arg command
// like /learn used to only refill the box here — and the resulting `input` event
// reopened the menu, so Enter could never send it. Now it submits.
function applySlashCommand(pane, command, args = "") {
  const pdom = pane?.dom;
  if (!pdom?.textarea) return;
  hideSlashMenu(pane);
  if (command.action) {
    pdom.textarea.value = "";
    pdom.textarea.dispatchEvent(new Event("input"));
    command.action(pane, args);
    return;
  }
  // Needs arguments the user hasn't typed yet: complete the name and wait.
  if (command.requiresArgs && !args) {
    completeSlashCommand(pane, command);
    return;
  }
  // Ready to run (no args needed, or args already supplied): normalize the box
  // to the canonical command and submit — submitMessage expands the prompt.
  pdom.textarea.value = `/${command.name}${args ? ` ${args}` : ""}`;
  pdom.textarea.dispatchEvent(new Event("input"));
  submitMessage(pane);
}

function renderSlashMenu(pane) {
  const pdom = pane?.dom;
  if (!pdom?.textarea || !pdom?.slashMenu) return;
  const query = slashQueryForText(pdom.textarea.value);
  if (query === null || pane.streaming) {
    hideSlashMenu(pane);
    return;
  }
  const matches = matchingSlashCommands(pane, query);
  if (!matches.length) {
    hideSlashMenu(pane);
    return;
  }
  pdom.slashMatches = matches;
  pdom.slashIndex = Math.min(pdom.slashIndex || 0, matches.length - 1);
  const activeId = `${pdom.slashMenu.id}-option-${pdom.slashIndex}`;
  pdom.textarea.setAttribute("aria-controls", pdom.slashMenu.id);
  pdom.textarea.setAttribute("aria-expanded", "true");
  pdom.textarea.setAttribute("aria-activedescendant", activeId);
  pdom.slashMenu.hidden = false;
  pdom.slashMenu.replaceChildren(
    el("div", { class: "slash-menu-head", text: "슬래시 명령" }),
    ...matches.map((cmd, i) => {
      const row = el("button", {
        id: `${pdom.slashMenu.id}-option-${i}`,
        class: `slash-option ${i === pdom.slashIndex ? "active" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": i === pdom.slashIndex ? "true" : "false",
        onclick: () => applySlashCommand(pane, cmd),
      }, [
        el("span", {
          class: "slash-option-command",
          text: `/${cmd.name}${cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}`,
        }),
        el("span", { class: "slash-option-main" }, [
          el("strong", { text: cmd.title }),
          el("span", { text: cmd.description }),
        ]),
      ]);
      row.addEventListener("mousedown", (event) => event.preventDefault());
      return row;
    }),
  );
  const activeOption = document.getElementById(activeId);
  if (activeOption) requestAnimationFrame(() => activeOption.scrollIntoView({ block: "nearest" }));
}

function handleSlashMenuKeydown(pane, event) {
  const pdom = pane?.dom;
  if (!pdom?.slashMenu || pdom.slashMenu.hidden) return false;
  const matches = pdom.slashMatches || [];
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (matches.length) {
      const current = pdom.slashIndex || 0;
      if (event.key === "Home") pdom.slashIndex = 0;
      else if (event.key === "End") pdom.slashIndex = matches.length - 1;
      else {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        pdom.slashIndex = (current + delta + matches.length) % matches.length;
      }
      renderSlashMenu(pane);
    }
    return true;
  }
  if (event.key === "Enter") {
    if (!matches.length) return false;
    event.preventDefault();
    applySlashCommand(pane, matches[pdom.slashIndex || 0]);
    return true;
  }
  if (event.key === "Tab") {
    if (!matches.length) return false;
    event.preventDefault();
    completeSlashCommand(pane, matches[pdom.slashIndex || 0]);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideSlashMenu(pane);
    return true;
  }
  return false;
}

function renderChatPane(pane, { compact = false, index = 0, header = null } = {}) {
  const av = pane.avatar;
  const pdom = {};
  pane.dom = pdom;

  pdom.transcriptInner = el("div", { class: "transcript-inner" });
  pdom.transcript = el("div", {
    class: "transcript scroll-thin",
    role: "log",
    "aria-live": "polite",
    "aria-relevant": "additions",
    "aria-label": "대화 내용",
    tabindex: "0",
  });
  pdom.transcript.append(pdom.transcriptInner);
  // Track whether the viewer is "stuck" to the bottom by INTENT (did they scroll
  // up?), not by re-deriving position on every flush. Deriving per-flush detaches
  // auto-follow whenever a single delta grows the bubble past the near-bottom
  // threshold (a big code block/table arriving at once) even though the user never
  // scrolled away. Updated here on user scroll; honored by scrollToBottom.
  pdom.transcript.addEventListener("scroll", () => {
    pane.stickBottom = isNearBottom(pane);
    updateScrollButton(pane);
  });

  pdom.scrollBtn = el("button", {
    class: "scroll-bottom",
    type: "button",
    "aria-label": "맨 아래로",
    title: "맨 아래로",
    hidden: "",
    onclick: () => scrollToBottom(pane, true),
  });
  pdom.scrollBtn.append(icon("arrow-down"));

  pdom.textarea = el("textarea", {
    name: "message",
    rows: "1",
    placeholder: `${av.displayName}에게 메시지…`,
    "aria-label": "메시지 입력",
  });
  pdom.textarea.value = pane.draft || "";
  pdom.sendButton = el("button", { class: "send-button", type: "submit", "aria-label": "보내기", title: "보내기" });
  pdom.sendButton.append(icon("send"));
  pdom.composerBox = el("div", { class: "composer-box" }, [pdom.textarea, pdom.sendButton]);
  pdom.slashMenu = el("div", {
    id: `slash-menu-${pane.id}`,
    class: "slash-menu",
    role: "listbox",
    "aria-label": "슬래시 명령",
    hidden: "",
  });
  pdom.composerState = el("span", { class: "composer-state", text: "" });
  // 현재 세션(직전 턴) 토큰 사용량 — 입력창 힌트 우측에 상주.
  pdom.usageBadge = el("span", { class: "composer-usage", text: "" });
  const composerForm = el("form", {
    class: "composer-form",
    onsubmit: (e) => {
      e.preventDefault();
      setActivePane(pane);
      if (pane.streaming) stopStreaming(pane);
      else submitMessage(pane);
    },
  }, [
    pdom.slashMenu,
    pdom.composerBox,
    (pdom.composerHint = el("div", { class: "composer-hint" }, [])),
  ]);
  // Owner-only group-knowledge toggle (button in the hint meta, dropdown panel
  // anchored to composer-inner). Created before renderHint so the meta can host it.
  setupGroupKnowledgeToggle(pane, pdom);
  // Rebuilt when a physical keyboard is detected mid-session (enterSends() flips).
  pdom.renderHint = () => {
    const lead = compact
      ? el("span", { text: `대화 ${index + 1}` })
      : enterSends()
        ? el("span", {}, [document.createTextNode("Enter 전송 · "), el("kbd", { text: "Shift+Enter" }), document.createTextNode(" 줄바꿈")])
        : el("span", { text: "보내기 버튼으로 전송" });
    pdom.composerHint.replaceChildren(lead, el("span", { class: "composer-meta" }, [pdom.gkBtn, pdom.usageBadge, pdom.composerState]));
  };
  pdom.renderHint();
  const composer = el("footer", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [composerForm, pdom.gkPanel]),
  ]);

  const paneHeader = header || renderCompactPaneHeader(pane, index);
  const chatCol = el("div", {
    class: `chat-col chat-pane ${compact ? "compact" : ""} ${pane.id === state.activePaneId ? "active" : ""}`,
    dataset: { pane: pane.id },
    onclick: () => setActivePane(pane),
  }, [
    paneHeader,
    el("div", { class: "chat-body" }, [pdom.transcript, pdom.scrollBtn]),
    composer,
  ]);

  wireComposer(pane);
  renderTranscript(pane);
  return chatCol;
}

function renderCompactPaneHeader(pane, index) {
  const av = pane.avatar;
  const closeBtn = el("button", {
    class: "msg-act",
    type: "button",
    "aria-label": pane.streaming ? "응답 중지하고 대화 창 닫기" : "대화 창 닫기",
    title: pane.streaming ? "응답 중지하고 대화 창 닫기" : "대화 창 닫기",
    disabled: state.chatPanes.length <= 1 ? "" : null,
    onclick: (event) => {
      event.stopPropagation();
      closeChatPane(pane);
    },
  });
  closeBtn.append(icon("close"));
  const newBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "새 대화",
    dataset: { newchat: "1" },
    disabled: pane.streaming ? "" : null,
    onclick: (event) => {
      event.stopPropagation();
      newChat(pane);
    },
  });
  return el("header", { class: "pane-head" }, [
    el("div", { class: "pane-title" }, [
      avatarNode(av, 30, { alt: "" }),
      el("div", {}, [
        el("strong", { text: `대화 ${index + 1}` }),
        el("span", { text: av.alias || av.displayName }),
      ]),
    ]),
    el("div", { class: "pane-actions" }, [newBtn, closeBtn]),
  ]);
}

function addChatPane(avatarId) {
  if (!splitEnabled()) return;
  if (state.chatPanes.length >= MAX_CHAT_PANES) {
    notify(`분할 대화는 최대 ${MAX_CHAT_PANES}개까지 가능합니다.`, "info");
    return;
  }
  if (state.chatPanes.some((pane) => pane.avatar?.id === avatarId)) {
    notify("이미 분할 대화에 열려 있는 아바타입니다.", "info");
    return;
  }
  const avatar = splitAvatarOptions().find((av) => av.id === avatarId) || activePane()?.avatar || state.currentAvatar || state.user;
  const pane = makeChatPane(avatar);
  state.chatPanes.push(pane);
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  renderView();
  notify(`${avatar.alias || avatar.displayName || avatar.username || "아바타"} 대화를 분할에 추가했습니다.`, "ok");
}

function closeChatPane(pane) {
  if (state.chatPanes.length <= 1) return;
  const avatar = pane.avatar || {};
  const label = avatar.alias || avatar.displayName || avatar.username || "아바타";
  const wasStreaming = Boolean(pane.streaming);
  if (pane.streaming) stopStreaming(pane);
  state.chatPanes = state.chatPanes.filter((p) => p.id !== pane.id);
  if (state.activePaneId === pane.id) state.activePaneId = state.chatPanes[0]?.id || null;
  syncLegacyChatState(activePane());
  renderView();
  notify(wasStreaming ? `${label} 응답을 중지하고 대화 창을 닫았습니다.` : `${label} 대화 창을 닫았습니다.`, "ok");
}

/**
 * Right-side panel showing what the avatar can do — its plugins (known
 * immediately from the avatar detail) and its skills (lazy-fetched from
 * `/api/avatars/:id/skills`, since resolving them may clone repos). Visible to
 * colleagues and the owner alike, so a teammate can see at a glance what the
 * avatar is equipped with before chatting.
 */
// Persisted UI prefs for the capabilities panel (width + collapsed). The app
// otherwise keeps state in memory, but panel size/visibility are preferences a
// user expects to survive a reload, so these two live in localStorage.
const CAP_WIDTH_MIN = 220;
const CAP_WIDTH_MAX = 720;
const CAP_WIDTH_DEFAULT = 480;
// Clamp so the panel can never squeeze the chat column out: leave room for the
// rail (248px) plus a readable transcript (~380px). Mirrors the CSS max-width.
function capWidthClamp(width) {
  const available = Math.max(CAP_WIDTH_MIN, window.innerWidth - 248 - 380);
  return Math.min(Math.min(CAP_WIDTH_MAX, available), Math.max(CAP_WIDTH_MIN, width));
}
// On phones the stacked panel starts collapsed — expanded it eats ~40% of the
// screen below the composer.
export function isFinePointer() {
  return window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
}
// Flipped once we observe a hardware keystroke (see the composer keydown handler).
// A tablet reports a coarse primary pointer even with a keyboard attached, so the
// pointer media query alone can't tell — we infer it from KeyboardEvent.code.
let physicalKeyboardSeen = false;
function enterSends() {
  return isFinePointer() || physicalKeyboardSeen;
}
function refreshComposerHints() {
  state.chatPanes.forEach((p) => p.dom?.renderHint?.());
}
function isMobileLayout() {
  return window.matchMedia ? window.matchMedia("(max-width: 860px)").matches : false;
}
export function capPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function setCapPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); prefs just won't persist */
  }
}

function openKnowledgeSettings() {
  state.settingsTab = "knowledge";
  goView("settings");
}

function renderCapabilitiesPanel(av) {
  const skillsBody = el("div", { class: "cap-section-body cap-skills" });
  const plugins = av.plugins || [];
  const canManageCapabilities = state.user?.id === av.id;
  const bodyId = `cap-body-${av.id || newId()}`;
  const pluginEmpty = canManageCapabilities
    ? el("div", { class: "cap-empty cap-empty-action" }, [
        el("span", { text: "연결된 플러그인이 없습니다." }),
        el("button", { class: "linkish small", type: "button", text: "지식·플러그인 설정", onclick: openKnowledgeSettings }),
      ])
    : el("p", { class: "cap-empty", text: "연결된 플러그인이 없습니다." });
  const pluginsBody = el("div", { class: "cap-section-body cap-plugins" },
    plugins.length
      ? plugins.map((p) => el("div", { class: "cap-plugin" }, [
          el("span", { class: "cap-plugin-name", text: p.label || p.repo }),
          p.label ? el("span", { class: "cap-plugin-repo", text: p.repo }) : null,
        ]))
      : [pluginEmpty],
  );

  const collapseBtn = el("button", {
    class: "cap-collapse",
    type: "button",
    title: "패널 접기",
    "aria-label": "패널 접기",
    "aria-controls": bodyId,
    "aria-expanded": "true",
    text: "›",
  });
  // The avatar's self-introduction (markdown), shown atop the panel when present.
  const introText = (av.intro || "").trim();
  const introBlock = introText
    ? el("div", { class: "cap-intro" }, [el("div", { class: "cap-intro-text md", html: renderMarkdown(introText) })])
    : null;
  // Capability hashtags as chips under the intro — a viewer sees at a glance
  // what the avatar is good for.
  const capTags = av.hashtags || [];
  const tagsBlock = capTags.length
    ? el("div", { class: "cap-tags" }, capTags.map((t) => el("span", { class: "tag accent", text: `#${t}` })))
    : null;
  const body = el("div", { id: bodyId, class: "cap-body scroll-thin" }, [
    el("div", { class: "cap-head" }, [
      el("h3", { text: "이 아바타의 역량" }),
      el("p", { class: "cap-sub", text: `${av.displayName}이(가) 사용할 수 있는 도구` }),
    ]),
    introBlock,
    tagsBlock,
    el("div", { class: "cap-section" }, [
      el("div", { class: "cap-section-title", text: "스킬" }),
      skillsBody,
    ]),
    el("div", { class: "cap-section" }, [
      el("div", { class: "cap-section-title", text: "플러그인" }),
      pluginsBody,
    ]),
  ]);
  // Slim strip shown when collapsed: just an expand button. The text label
  // only renders in the stacked mobile bar (hidden on the desktop strip).
  const expandBtn = el("button", {
    class: "cap-expand",
    type: "button",
    title: "역량 패널 펼치기",
    "aria-label": "역량 패널 펼치기",
    "aria-controls": bodyId,
    "aria-expanded": "false",
  }, [
    el("span", { "aria-hidden": "true", text: "‹" }),
    el("span", { class: "cap-expand-label", text: "아바타 역량 보기" }),
  ]);
  // Drag handle on the panel's left edge to resize its width.
  const resizer = el("div", { class: "cap-resize", "aria-hidden": "true" });

  const startWidth = Number(capPref("capPanelWidth", String(CAP_WIDTH_DEFAULT))) || CAP_WIDTH_DEFAULT;
  const panel = el("aside", {
    class: "cap-panel",
    "aria-label": "아바타 역량",
    style: `width:${capWidthClamp(startWidth)}px`,
  }, [resizer, collapseBtn, body, expandBtn]);

  const initialCollapsed = capPref("capPanelCollapsed", isMobileLayout() ? "1" : "0") === "1";
  const setCollapsed = (collapsed) => {
    panel.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    expandBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    setCapPref("capPanelCollapsed", collapsed ? "1" : "0");
  };
  setCollapsed(initialCollapsed);
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  expandBtn.addEventListener("click", () => setCollapsed(false));

  wireCapResize(resizer, panel);
  loadCapabilitySkills(av.id, skillsBody);
  return panel;
}

// Pointer-drag resize for the capabilities panel. The panel sits at the right
// edge, so dragging the handle left widens it (width grows as clientX shrinks).
function wireCapResize(handle, panel) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev) => {
      panel.style.width = `${capWidthClamp(startW + (startX - ev.clientX))}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setCapPref("capPanelWidth", String(Math.round(panel.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    // A cancelled pointer (touch interruption, gesture, context menu) would
    // otherwise never fire pointerup, leaving body stuck in .col-resizing.
    handle.addEventListener("pointercancel", onUp);
  });
}

/** Lazy-load and render an avatar's skills into the panel's skills section. */
async function loadCapabilitySkills(avatarId, body) {
  const renderState = (st) => {
    if (st.loading) {
      body.replaceChildren(el("p", { class: "cap-loading", text: "불러오는 중…" }));
    } else if (st.error) {
      body.replaceChildren(
        el("div", { class: "cap-empty cap-error" }, [
          el("span", { text: st.error }),
          el("button", {
            class: "linkish small",
            type: "button",
            text: "다시 시도",
            onclick: () => {
              delete state.skillsByAvatar[avatarId];
              loadCapabilitySkills(avatarId, body);
            },
          }),
        ]),
      );
    } else if (!st.skills.length) {
      const canManageCapabilities = state.user?.id === avatarId;
      body.replaceChildren(
        canManageCapabilities
          ? el("div", { class: "cap-empty cap-empty-action" }, [
              el("span", { text: "사용 가능한 스킬이 없습니다." }),
              el("button", { class: "linkish small", type: "button", text: "지식·플러그인 설정", onclick: openKnowledgeSettings }),
            ])
          : el("p", { class: "cap-empty", text: "사용 가능한 스킬이 없습니다." }),
      );
    } else {
      // Each skill is a collapsed accordion: name only by default, click to
      // reveal its (often long) description. The "default" source is implicit
      // and noisy, so only plugin-provided sources get a badge.
      body.replaceChildren(...st.skills.map((s) => {
        const hasDesc = Boolean(s.description);
        const fromPlugin = s.source && s.source !== "default";
        const head = el("button", {
          class: "cap-skill-head",
          type: "button",
          "aria-expanded": "false",
          disabled: hasDesc ? null : "",
        }, [
          hasDesc ? el("span", { class: "cap-skill-caret", text: "▸", "aria-hidden": "true" }) : null,
          el("span", { class: "cap-skill-name", text: s.name }),
          fromPlugin ? el("span", { class: "cap-skill-src", text: s.source }) : null,
        ]);
        const item = el("div", { class: "cap-skill" }, [head]);
        if (hasDesc) {
          const desc = el("p", { class: "cap-skill-desc", text: s.description });
          item.append(desc);
          head.addEventListener("click", () => {
            const open = item.classList.toggle("open");
            head.setAttribute("aria-expanded", open ? "true" : "false");
          });
        }
        return item;
      }));
    }
  };

  // Reuse a cached result (skills don't change within a session unless plugins
  // do). A still-loading entry means a fetch is already in flight — render its
  // state and bail rather than starting a duplicate request.
  const cached = state.skillsByAvatar[avatarId];
  if (cached && !cached.error) {
    renderState(cached);
    return;
  }
  const loadingState = { loading: true, error: "", skills: [] };
  state.skillsByAvatar[avatarId] = loadingState;
  renderState(loadingState);
  // Capture a generation token so the async completion can detect a stale panel
  // (e.g. the user navigated to a different avatar while the fetch was in flight).
  const targetBody = body;
  try {
    const { skills } = await api(`/api/avatars/${avatarId}/skills`);
    const done = { loading: false, error: "", skills: skills || [] };
    state.skillsByAvatar[avatarId] = done;
    // Bail if the panel element was replaced/detached or the avatar changed.
    if (state.currentAvatar?.id === avatarId && targetBody.isConnected) renderState(done);
  } catch (err) {
    const failed = { loading: false, error: "스킬을 불러오지 못했습니다.", skills: [] };
    state.skillsByAvatar[avatarId] = failed;
    if (state.currentAvatar?.id === avatarId && targetBody.isConnected) renderState(failed);
  }
}

/**
 * Drop the cached skills for an avatar so the capabilities panel re-fetches
 * next time it opens. Called whenever the owner mutates their own plugins —
 * the skill set is derived from those plugins, so the cache would go stale.
 */
export function invalidateSkillsCache(avatarId) {
  if (avatarId) delete state.skillsByAvatar[avatarId];
}

function wireComposer(pane) {
  const pdom = pane.dom;
  const ta = pdom.textarea;
  const autoGrow = () => {
    ta.style.height = "auto";
    // Mirror the CSS cap: never let a long draft eat the transcript.
    const cap = Math.min(200, Math.round(window.innerHeight * 0.3));
    ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
  };
  ta.addEventListener("input", () => {
    pane.draft = ta.value;
    autoGrow();
    updateSendState(pane);
    renderSlashMenu(pane);
  });
  ta.addEventListener("keydown", (event) => {
    // Detect a hardware keyboard: physical character keys carry a real
    // KeyboardEvent.code ("KeyR", "Digit1" — even mid-IME composition), while
    // on-screen keyboards send an empty code + keyCode 229. A non-empty message
    // always types a character before Enter, so this fires in time. Once seen,
    // Enter sends like on a PC (e.g. a tablet with a keyboard attached).
    if (!physicalKeyboardSeen && /^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) {
      physicalKeyboardSeen = true;
      refreshComposerHints();
    }
    if (handleSlashMenuKeydown(pane, event)) return;
    // Virtual keyboards have no Shift+Enter — there, Enter inserts a newline
    // and sending is button-only.
    if (!enterSends()) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      setActivePane(pane);
      if (!pane.streaming) submitMessage(pane);
    }
  });
  pdom.composerBox.addEventListener("focusin", () => {
    setActivePane(pane);
    pdom.composerBox.classList.add("focused");
    renderSlashMenu(pane);
  });
  pdom.composerBox.addEventListener("focusout", () => {
    pdom.composerBox.classList.remove("focused");
    setTimeout(() => {
      if (!pdom.composerBox.contains(document.activeElement)) hideSlashMenu(pane);
    }, 0);
  });
  autoGrow();
  updateSendState(pane);
}

function updateSendState(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.textarea || !pdom?.sendButton) return;
  const hasText = pdom.textarea.value.trim().length > 0;
  // The same button sends or stops — its accessible name must follow.
  const label = pane.streaming ? "응답 중지" : "보내기";
  pdom.sendButton.setAttribute("aria-label", label);
  pdom.sendButton.title = label;
  if (pane.streaming) {
    pdom.sendButton.disabled = false;
    pdom.sendButton.classList.add("is-stop");
    pdom.sendButton.replaceChildren(icon("stop"));
  } else {
    pdom.sendButton.disabled = !hasText;
    pdom.sendButton.classList.remove("is-stop");
    pdom.sendButton.replaceChildren(icon("send"));
  }
}

function newChat(pane = activePane()) {
  if (!pane || pane.streaming) return;
  pane.conversationId = newId();
  pane.messages = [];
  pane.draft = "";
  pane.greetedConversationId = null;
  pane.greetingStarted = false;
  setActivePane(pane);
  syncHash(true);
  renderTranscript(pane);
  renderConversations();
  if (pane.dom.textarea) {
    pane.dom.textarea.value = "";
    pane.dom.textarea.style.height = "auto";
    pane.dom.textarea.dispatchEvent(new Event("input"));
  }
  pane.dom.textarea?.focus();
  // Owner's own avatar greets first in the new empty conversation.
  maybeGreet(pane);
}

/* ---------- transcript ---------- */
function renderTranscript(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.transcriptInner) return;
  updateComposerUsage(pane);
  pdom.transcriptInner.replaceChildren();
  pane.messages.forEach((m, i) => pdom.transcriptInner.append(buildMessageNode(pane, m, i === pane.messages.length - 1 && !pane.live)));
  if (attachLiveToTranscript(pane)) {
    scrollToBottom(pane, true);
    return;
  }
  if (!pane.messages.length) {
    pdom.transcriptInner.append(renderChatEmpty(pane));
    updateScrollButton(pane);
    return;
  }
  scrollToBottom(pane, true);
}

function attachLiveToTranscript(pane = activePane()) {
  const live = pane?.live;
  const pdom = pane?.dom;
  if (!live || live.done || !pdom?.transcriptInner) return false;
  if (live.wrap.parentElement !== pdom.transcriptInner) {
    pdom.transcriptInner.append(live.wrap);
  }
  pdom.transcript?.setAttribute("aria-busy", "true");
  setComposerState(pane, live.statusLabel?.textContent || "응답 생성 중…");
  updateSendState(pane);
  return true;
}

function renderChatEmpty(pane = activePane()) {
  const av = pane?.avatar || state.currentAvatar;
  const elevated = av.elevated || av.id === state.user?.id;
  const promptOptions = elevated
    ? [
        "내가 지금 맡길 수 있는 일을 3가지로 제안해줘.",
        "이 대화에서 필요한 배경 정보를 먼저 물어봐줘.",
        "반복 업무로 만들 만한 루틴을 같이 설계해줘.",
      ]
    : [
        "이 아바타가 잘 아는 분야를 요약해줘.",
        "내 질문에 답하기 전에 필요한 맥락을 물어봐줘.",
        "관련된 지식을 바탕으로 핵심만 정리해줘.",
      ];
  const useStarterPrompt = (text) => {
    setActivePane(pane);
    const ta = pane?.dom?.textarea;
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  return el("div", { class: "empty-state" }, [
    avatarNode(av, 72, { alt: "" }),
    el("div", { class: "hero" }, [
      el("h3", { text: `${av.displayName}와(과) 대화` }),
      el("p", { text: av.bio || (elevated ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.") }),
    ]),
    el("div", { class: "starter-prompts", role: "group", "aria-label": "시작 프롬프트" },
      promptOptions.map((text) =>
        el("button", {
          class: "starter-prompt",
          type: "button",
          text,
          onclick: () => useStarterPrompt(text),
        }),
      ),
    ),
  ]);
}

function buildMessageNode(pane, message, isLast) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "나" : pane.avatar?.displayName || "아바타" }),
      message.createdAt ? el("time", { class: "msg-time", datetime: message.createdAt, text: timeLabel(message.createdAt) }) : null,
    ]),
  );
  const bubble = el("div", { class: "bubble" });
  if (isUser) bubble.textContent = message.content;
  else renderAssistantInto(bubble, message);
  wrap.append(bubble, buildMessageActions(pane, message, isUser, isLast));
  return wrap;
}

function buildMessageActions(pane, message, isUser, isLast) {
  const row = el("div", { class: "msg-actions" });
  const copyBtn = el("button", { class: "msg-act", type: "button", "aria-label": "복사", title: "복사" });
  copyBtn.append(icon("copy"));
  copyBtn.addEventListener("click", () => copyText(message.content || message.response?.text || "", copyBtn));
  row.append(copyBtn);
  if (isUser) {
    const editBtn = el("button", { class: "msg-act", type: "button", "aria-label": "편집", title: "편집 후 다시 보내기" });
    editBtn.append(icon("edit"));
    editBtn.addEventListener("click", () => {
      setActivePane(pane);
      const textarea = pane.dom?.textarea;
      if (!textarea) return;
      const text = message.content || "";
      textarea.value = text;
      textarea.dispatchEvent(new Event("input"));
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
      notify("메시지를 입력창에 불러왔습니다. 수정 후 보내기를 누르세요.", "info");
    });
    row.append(editBtn);
  } else if (isLast) {
    const regenBtn = el("button", { class: "msg-act regen", type: "button", "aria-label": "다시 생성", title: "다시 생성" });
    regenBtn.append(icon("refresh"));
    regenBtn.addEventListener("click", () => regenerate(pane, regenBtn));
    row.append(regenBtn);
  }
  return row;
}

function setRegenerateBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (!btn._regenOriginal) {
      btn._regenOriginal = {
        label: btn.getAttribute("aria-label"),
        title: btn.title,
      };
    }
    btn.disabled = true;
    btn.classList.add("spinning");
    btn.setAttribute("aria-label", "다시 생성 중");
    btn.title = "다시 생성 중…";
    return;
  }
  btn.disabled = false;
  btn.classList.remove("spinning");
  const original = btn._regenOriginal || {};
  if (original.label) btn.setAttribute("aria-label", original.label);
  else btn.setAttribute("aria-label", "다시 생성");
  btn.title = original.title || "다시 생성";
}

function regenerate(pane = activePane(), triggerBtn = null) {
  if (!pane || pane.streaming) return;
  setActivePane(pane);
  const roles = pane.messages.map((m) => m.role);
  const lastUser = roles.lastIndexOf("user");
  if (lastUser < 0) return;
  const text = pane.messages[lastUser].content;
  setRegenerateBusy(triggerBtn, true);
  // Stash the discarded tail: if the re-run errors before producing anything,
  // the original answer is restored instead of being lost.
  const removed = pane.messages.slice(lastUser + 1);
  pane.messages = pane.messages.slice(0, lastUser + 1);
  syncLegacyChatState(pane);
  renderTranscript(pane);
  streamChat(pane, text, { regenerate: true, restoreOnError: removed }).catch(() => setRegenerateBusy(triggerBtn, false));
}

// Internal runtime identifiers → user-facing badge labels. `claude` is the
// normal case and renders no badge at all; raw identifiers never surface.
const RUNTIME_BADGE_LABELS = { claude: null, local: "로컬", blocked: "차단됨", error: "오류" };

// Compact token count: 950 → "950", 17500 → "17.5K", 184000 → "184K".
function formatTokenCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return (k < 100 ? k.toFixed(1) : Math.round(k)) + "K";
}

// "이번 턴" 토큰 사용량 배지 라벨: 컨텍스트 점유(입력 토큰/윈도우) + 출력 토큰.
function formatUsageLabel(usage) {
  if (!usage) return "";
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const ctx = Number(usage.contextWindow) || 0;
  if (!input && !output) return "";
  const parts = [];
  if (ctx) {
    const pct = Math.round((input / ctx) * 100);
    parts.push(`컨텍스트 ${formatTokenCount(input)}/${formatTokenCount(ctx)} (${pct}%)`);
  } else {
    parts.push(`입력 ${formatTokenCount(input)}`);
  }
  parts.push(`출력 ${formatTokenCount(output)}`);
  return parts.join(" · ");
}

// 입력창 힌트 우측의 토큰 배지를 현재 세션(usage가 있는 가장 최근 어시스턴트 턴) 기준으로 갱신.
// 직전 턴의 inputTokens는 그 턴이 본 전체 컨텍스트(캐시 포함)라 현재 세션 점유의 근사치.
function updateComposerUsage(pane = activePane()) {
  const badge = pane?.dom?.usageBadge;
  if (!badge) return;
  let usage = null;
  const msgs = pane.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const u = msgs[i]?.response?.usage;
    if (u && (Number(u.inputTokens) || Number(u.outputTokens))) { usage = u; break; }
  }
  const label = formatUsageLabel(usage);
  badge.textContent = label;
  if (label) {
    badge.title = `입력 ${usage.inputTokens.toLocaleString()} · 출력 ${usage.outputTokens.toLocaleString()}${usage.contextWindow ? ` · 컨텍스트 윈도우 ${usage.contextWindow.toLocaleString()}` : ""}`;
  } else {
    badge.removeAttribute("title");
  }
}

export function renderAssistantInto(bubble, message) {
  const response = message.response;
  bubble.classList.toggle("blocked", response?.runtime === "blocked");
  bubble.classList.toggle("errored", response?.runtime === "error" || message.errored === true);
  if (response) {
    const meta = [];
    if (response.runtime && RUNTIME_BADGE_LABELS[response.runtime] !== null) {
      meta.push(["runtime", RUNTIME_BADGE_LABELS[response.runtime] || response.runtime, response.runtime]);
    }
    if (response.skillName) meta.push(["skill", response.skillName, ""]);
    if (meta.length) {
      const metaRow = el("div", { class: "response-meta" });
      for (const [kind, label, raw] of meta) metaRow.append(el("span", { class: `meta-badge ${kind === "runtime" ? `runtime-${raw}` : ""}`, text: label }));
      bubble.append(metaRow);
    }
    if (response.kind === "table" && response.table) {
      bubble.append(buildTable(response));
      if (response.text) {
        const md = el("div", { class: "md", html: renderMarkdown(response.text) });
        enhanceCodeBlocks(md);
        bubble.append(md);
      }
      return;
    }
    const md = el("div", { class: "md", html: renderMarkdown(response.text || response.summary) });
    enhanceCodeBlocks(md);
    bubble.append(md);
    return;
  }
  const md = el("div", { class: "md", html: renderMarkdown(message.content) });
  enhanceCodeBlocks(md);
  bubble.append(md);
}

function buildTable(response) {
  const columns = response.table.columns || [];
  const rows = response.table.rows || [];
  const wrap = el("div", {});
  if (response.title || response.summary) wrap.append(el("div", { class: "response-title", text: response.title || response.summary }));
  const tableWrap = el("div", { class: "table-wrap" });
  const table = el("table");
  const thead = el("tr");
  for (const c of columns) thead.append(el("th", { scope: "col", text: c }));
  table.append(el("thead", {}, [thead]));
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const c of columns) tr.append(el("td", { text: row[c] == null ? "" : String(row[c]) }));
    tbody.append(tr);
  }
  table.append(tbody);
  tableWrap.append(table);
  wrap.append(tableWrap);
  return wrap;
}

function isNearBottom(pane = activePane()) {
  const t = pane?.dom?.transcript;
  if (!t) return true;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(pane = activePane(), force) {
  const t = pane?.dom?.transcript;
  if (!t) return;
  // Called from renderTranscript before the pane is appended to the document
  // (e.g. a full re-render when splitting or switching layout). A detached node
  // has scrollHeight 0, so setting scrollTop is a no-op and the transcript would
  // land at the top — defer to after attach so the latest messages stay in view.
  if (!t.isConnected) {
    requestAnimationFrame(() => scrollToBottom(pane, force));
    return;
  }
  // Follow the bottom when forced, or while the viewer hasn't scrolled away.
  // stickBottom is intent-based (set on user scroll); undefined defaults to true
  // for a fresh pane. force also re-pins (e.g. the "맨 아래로" button, send).
  if (force) pane.stickBottom = true;
  if (force || pane.stickBottom !== false) t.scrollTop = t.scrollHeight;
  updateScrollButton(pane);
}
function updateScrollButton(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.scrollBtn || !pdom?.transcript) return;
  const t = pdom.transcript;
  const scrollable = t.scrollHeight - t.clientHeight > 40;
  pdom.scrollBtn.hidden = !(scrollable && !isNearBottom(pane));
}

/* ---------- sending / streaming ---------- */
async function submitMessage(pane = activePane()) {
  if (!pane) return;
  setActivePane(pane);
  const pdom = pane.dom;
  let message = pdom.textarea.value.trim();
  if (!message || pane.streaming || !pane.avatar) return;
  const slash = resolveTypedSlashCommand(pane, message);
  if (slash) {
    if (slash.command.action) {
      applySlashCommand(pane, slash.command, slash.args);
      return;
    }
    if (slash.command.requiresArgs && !slash.args) {
      pdom.textarea.value = `/${slash.command.name} `;
      pdom.textarea.dispatchEvent(new Event("input"));
      pdom.textarea.focus();
      const end = pdom.textarea.value.length;
      pdom.textarea.setSelectionRange(end, end);
      notify(`/${slash.command.name} 뒤에 ${slash.command.argsLabel || "내용"}을 입력해 주세요.`, "warn");
      return;
    }
    // serverExpand commands (e.g. /learn) are sent verbatim so the bubble shows
    // the literal command; the server swaps in the full prompt for the model.
    // Others expand here so their (user-facing, Korean) prompt shows in the bubble.
    message = slash.command.serverExpand
      ? `/${slash.command.name}${slash.args ? ` ${slash.args}` : ""}`
      : slashPrompt(slash.command, slash.args).trim();
    if (!message) return;
  }
  hideSlashMenu(pane);
  if (!pane.messages.length) pdom.transcriptInner.replaceChildren();
  pdom.transcriptInner.querySelectorAll(".msg-act.regen").forEach((b) => b.remove());
  const userMsg = { role: "user", content: message, createdAt: new Date().toISOString() };
  pane.messages.push(userMsg);
  syncLegacyChatState(pane);
  pdom.transcriptInner.append(buildMessageNode(pane, userMsg, false));
  pdom.textarea.value = "";
  pane.draft = "";
  pdom.textarea.style.height = "auto";
  scrollToBottom(pane, true);
  await streamChat(pane, message, { isNewConversation: pane.messages.length === 1 });
}

// When the owner opens a fresh chat with their OWN avatar, let the avatar speak
// first: it greets and reports any pending info requests. Only fires on an empty
// brand-new conversation (no typed message yet), and never while streaming.
async function maybeGreet(pane = activePane()) {
  if (!pane || pane.streaming || pane.greetingStarted) return;
  if (state.chatPanes.length > 1) return;
  if (!pane.avatar || !state.user) return;
  if (pane.avatar.id !== state.user.id) return;
  if (pane.messages.length) return;
  if (pane.greetedConversationId === pane.conversationId) return;
  pane.greetingStarted = true;
  pane.greetedConversationId = pane.conversationId;
  pane.dom.transcriptInner.replaceChildren();
  await streamChat(pane, "", { isNewConversation: true, greeting: true });
  pane.greetingStarted = false;
}

function beginLiveStream(pane, { isNewConversation = false, restoreOnError = null } = {}) {
  pane.streaming = true;
  setActivePane(pane);
  refreshStreamingState();
  updateSendState(pane);
  setComposerState(pane, "응답 준비 중…");
  pane.dom.transcript.setAttribute("aria-busy", "true");
  syncDocumentTitle();

  const bubble = el("div", { class: "bubble" });
  const mdNode = el("div", { class: "md" });
  const caret = el("span", { class: "stream-caret", "aria-hidden": "true" });
  const statusRow = el("div", { class: "stream-status" }, [el("span", { class: "spinner" }), el("span", { class: "label", text: "응답 준비 중…" })]);
  const pluginChips = el("div", { class: "plugin-chips" });
  // Interactive prompts (permission / AskUserQuestion) pop up in a standalone
  // modal, not in the bubble; the activity tree shows which agent calls which tool.
  // The tree lives inside a <details open> so a long run's tool list can be
  // collapsed mid-stream — without this it grows unbounded and crowds the bubble.
  const activityEl = el("div", { class: "agent-activity", tabindex: "0", role: "group", "aria-label": "작업 내역" });
  const activitySummaryEl = el("span", { class: "activity-summary-text", text: "작업 중…" });
  const activityDetails = el("details", { class: "activity-live", open: "", hidden: "" }, [
    el("summary", {}, [activitySummaryEl]),
    activityEl,
  ]);
  // Order matches execution: tool activity → answer text → status. The answer
  // streams in BELOW the activity that produced it, so the tool rows don't get
  // buried under a long reply. The caret stays hidden until the first text
  // delta, so a tools-only phase doesn't render a tall empty bubble.
  caret.hidden = true;
  bubble.append(activityDetails, mdNode, caret, statusRow, pluginChips);
  // aria-live=off while streaming: every rAF flush replaces the whole answer,
  // and a polite region would re-announce it wholesale dozens of times. The
  // finished message is announced once via dom.srStatus instead.
  const wrap = el("div", { class: "message assistant", "aria-live": "off" }, [
    el("div", { class: "msg-role" }, [el("span", { class: "role-dot" }), el("span", { text: pane.avatar?.displayName || "아바타" })]),
    bubble,
  ]);
  pane.dom.transcriptInner.append(wrap);
  scrollToBottom(pane, true);

  const live = {
    pane,
    wrap, bubble, mdNode, caret, statusRow, statusLabel: statusRow.querySelector(".label"),
    pluginChips, activityEl, activityDetails, activitySummaryEl,
    runId: null,
    agents: new Map(), // agentId -> { node, toolsEl, childrenEl }
    tools: new Map(), // toolUseId -> { row }
    tasks: new Map(), // taskId -> { row }
    // requestIds for permission/question prompts that have already been resolved
    // server-side — used to skip re-rendering them during replay and to dismiss
    // them immediately if a prompt_resolved event arrives while the card is up.
    resolvedRequestIds: new Set(),
    text: "", rafPending: false, done: false, aborted: false, isNewConversation,
    restoreOnError: Array.isArray(restoreOnError) && restoreOnError.length ? restoreOnError : null,
  };
  pane.live = live;
  const flush = () => {
    live.rafPending = false;
    live.mdNode.innerHTML = renderMarkdown(live.text);
    scrollToBottom(pane);
  };
  const scheduleFlush = () => {
    if (live.rafPending) return;
    live.rafPending = true;
    requestAnimationFrame(flush);
  };

  return { live, scheduleFlush };
}

async function streamChat(pane, message, { isNewConversation = false, regenerate = false, greeting = false, restoreOnError = null } = {}) {
  const { live, scheduleFlush } = beginLiveStream(pane, { isNewConversation, restoreOnError });

  pane.abortController = new AbortController();
  if (activePane()?.id === pane.id) setAbort(pane.abortController);
  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: pane.abortController.signal,
      body: JSON.stringify({
        avatarId: pane.avatar.id,
        message,
        conversationId: pane.conversationId,
        regenerate,
        greeting,
        multiSession: state.chatPanes.length > 1,
        // Owner-only group-knowledge selection for this conversation (group ids
        // turned OFF). Server applies + persists it; ignored for colleague chats.
        groupKnowledgeOff: pane.groupKnowledgeOff || [],
      }),
    });
    if (response.status === 401) {
      triggerSessionExpired();
      return;
    }
    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }
    await consumeSse(response.body, (e, d) => handleSseEvent(e, d, live, scheduleFlush));
  } catch (error) {
    if (error.name === "AbortError" || live.aborted) finalizeStopped(live);
    else if (!live.text && !greeting && !regenerate && message) {
      // Nothing arrived for a normal send: undo it cleanly — remove the live
      // bubble AND the pending user message (it was delivered at most once;
      // leaving it would render a duplicate on retry), put the text back in
      // the composer, and surface the error as a toast.
      live.done = true;
      cleanupLive(live);
      live.wrap.remove();
      const last = pane.messages[pane.messages.length - 1];
      if (last?.role === "user" && last.content === message) pane.messages.pop();
      if (activePane()?.id === pane.id) syncLegacyChatState(pane);
      renderTranscript(pane);
      if (pane.dom.textarea && !pane.dom.textarea.value) {
        pane.dom.textarea.value = message;
        pane.dom.textarea.dispatchEvent(new Event("input"));
      }
      notify(`메시지를 보내지 못했습니다: ${error.message}`);
    } else {
      finalizeError(live, error.message || "응답을 받는 중 연결 오류가 발생했습니다. 다시 시도해 주세요.");
    }
  } finally {
    finishLiveRequest(live, pane);
  }
}

function finishLiveRequest(live, pane) {
  if (!live.done) {
    if (live.aborted) finalizeStopped(live);
    else if (!live.text) finalizeError(live, "응답을 받지 못한 채 연결이 끊어졌습니다. 다시 시도해 주세요.");
    // Connection dropped server-side mid-answer — NOT a user stop; label it honestly.
    else finalizeInterrupted(live);
  }
  pane.streaming = false;
  pane.abortController = null;
  refreshStreamingState();
  updateSendState(pane);
  setComposerState(pane, "");
  pane.dom.transcript?.setAttribute("aria-busy", "false");
  syncDocumentTitle();
  // Don't yank focus from a composer the user is typing in (split panes).
  const focused = document.activeElement;
  const typingElsewhere = focused && focused.tagName === "TEXTAREA" && focused !== pane.dom.textarea;
  if (activePane()?.id === pane.id && !typingElsewhere) pane.dom.textarea?.focus();
}

async function attachActiveRun(pane = activePane()) {
  if (!pane || pane.streaming || !pane.conversationId) return;
  try {
    const result = await api(`/api/chat/runs?conversationId=${encodeURIComponent(pane.conversationId)}`);
    if (result.run?.runId && !pane.streaming) {
      attachChatRun(pane, result.run.runId);
    } else if (!pane.streaming && pane.messages[pane.messages.length - 1]?.role === "user") {
      // No active run, but the loaded history ends on an unanswered user turn — the
      // run likely finished in the gap between loading history and this check, with
      // its answer streaming into a now-orphaned pane. Re-pull so the just-persisted
      // reply isn't missed. Skipped when history already ends with the assistant.
      await refreshConversationMessages(pane);
    }
  } catch {
    /* best effort: a missing/finished run just means normal persisted history */
  }
}

async function attachChatRun(pane, runId) {
  const { live, scheduleFlush } = beginLiveStream(pane, { isNewConversation: false });
  live.runId = runId;
  pane.abortController = new AbortController();
  if (activePane()?.id === pane.id) setAbort(pane.abortController);
  let sawEvent = false;
  try {
    const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      credentials: "same-origin",
      signal: pane.abortController.signal,
    });
    if (response.status === 401) {
      triggerSessionExpired();
      return;
    }
    if (response.status === 404) {
      live.done = true;
      cleanupLive(live);
      live.wrap.remove();
      pane.streaming = false;
      pane.abortController = null;
      refreshStreamingState();
      await refreshConversationMessages(pane);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await consumeSse(response.body, (e, d) => {
      sawEvent = true;
      handleSseEvent(e, d, live, scheduleFlush);
    });
    if (!live.done && !sawEvent) {
      live.done = true;
      cleanupLive(live);
      live.wrap.remove();
      await refreshConversationMessages(pane);
    }
  } catch (error) {
    if (error.name === "AbortError" || live.aborted) finalizeStopped(live);
    else finalizeInterrupted(live);
  } finally {
    finishLiveRequest(live, pane);
  }
}

async function refreshConversationMessages(pane) {
  if (!pane?.conversationId) return;
  try {
    const msgRes = await api(`/api/messages?conversationId=${encodeURIComponent(pane.conversationId)}`);
    pane.messages = msgRes.messages || [];
    pane.groupKnowledgeOff = msgRes.groupKnowledgeOff || [];
    if (activePane()?.id === pane.id) syncLegacyChatState(pane);
    renderTranscript(pane);
    pane.dom?.refreshGroupKnowledge?.();
  } catch {
    /* keep the current transcript if refresh fails */
  }
}

export async function consumeSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseFrame(raw);
      if (frame) onEvent(frame.event, frame.data);
    }
  }
  // Flush the streaming TextDecoder and process any final buffered frame that
  // arrived without a trailing delimiter (e.g. connection dropped cleanly).
  buffer += decoder.decode();
  if (buffer.trim()) {
    const frame = parseFrame(buffer);
    if (frame) onEvent(frame.event, frame.data);
  }
}

function parseFrame(raw) {
  let event = "message";
  let id = "";
  const dataLines = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  try {
    return { id, event, data: JSON.parse(dataStr) };
  } catch {
    return { id, event, data: { text: dataStr } };
  }
}

function handleSseEvent(event, data, live, scheduleFlush) {
  switch (event) {
    case "open":
      if (data?.conversationId) {
        live.pane.conversationId = data.conversationId;
        if (activePane()?.id === live.pane.id) {
          syncLegacyChatState(live.pane);
          syncHash(true);
        }
        if (live.isNewConversation) refreshConversations();
      }
      if (data?.runId) live.runId = data.runId;
      setStatus(live, "응답 준비 중…");
      break;
    case "status":
      if (data?.label) setStatus(live, data.label);
      break;
    case "plugin":
      handlePluginEvent(live, data);
      break;
    case "agent":
      handleAgentStart(live, data);
      break;
    case "agent_end":
      handleAgentEnd(live, data);
      break;
    case "tool":
      handleToolStart(live, data);
      break;
    case "tool_end":
      handleToolEnd(live, data);
      break;
    case "task":
      handleTaskStart(live, data);
      break;
    case "task_update":
      handleTaskUpdate(live, data);
      break;
    case "task_end":
      handleTaskEnd(live, data);
      break;
    case "blocked":
      handleBlocked(live, data);
      break;
    case "permission":
      if (!live.resolvedRequestIds.has(data?.requestId)) renderPermissionCard(live, data);
      break;
    case "question":
      if (!live.resolvedRequestIds.has(data?.requestId)) renderQuestionCard(live, data);
      break;
    case "prompt_resolved":
      handlePromptResolved(live, data);
      break;
    case "delta":
      if (typeof data?.text === "string") {
        if (!live.text && live.caret) live.caret.hidden = false; // first token → show caret
        live.text += data.text;
        scheduleFlush();
      }
      break;
    case "done":
      finalizeDone(live, data);
      break;
    case "cancelled":
      finalizeStopped(live);
      break;
    case "error":
      finalizeError(live, data?.error || "오류가 발생했습니다.");
      break;
    default:
      break;
  }
}

/* ---- Multi-agent activity tree ------------------------------------- */

// Lazily create (or fetch) the DOM node for an agent. `main` is the root.
function ensureAgentNode(live, agentId, info) {
  if (live.agents.has(agentId)) {
    const existing = live.agents.get(agentId);
    if (info && info.pending) {
      // Upgrade a placeholder created by an early tool event into a real node.
      const head = existing.node.querySelector(".agent-head .agent-label");
      if (head && info.label) head.textContent = info.label;
      existing.node.dataset.status = info.status || existing.node.dataset.status || "running";
      existing.pending = false;
    }
    return existing;
  }
  const isMain = agentId === "main";
  const toolsEl = el("div", { class: "agent-tools" });
  const childrenEl = el("div", { class: "agent-children" });
  let node;
  if (isMain) {
    // NB: avoid the bare `main` class here — it collides with the app layout's
    // `.main { height: 100dvh }` rule and stretched the activity box to fill the
    // whole viewport. `is-main` carries the same "root node" intent, unstyled.
    node = el("div", { class: "agent-node is-main", dataset: { agent: agentId, status: "running" } }, [toolsEl, childrenEl]);
    live.activityEl.append(node);
  } else {
    const label = (info && info.label) || "하위 작업";
    node = el("div", { class: "agent-node sub", dataset: { agent: agentId, status: (info && info.status) || "running" } }, [
      el("div", { class: "agent-head" }, [
        el("span", { class: "agent-spinner" }),
        el("span", { class: "agent-badge", text: "에이전트" }),
        el("span", { class: "agent-label", text: label }),
      ]),
      toolsEl,
      childrenEl,
    ]);
    const parentId = (info && info.parentId) || "main";
    const parent = ensureAgentNode(live, parentId);
    parent.childrenEl.append(node);
  }
  const record = { node, toolsEl, childrenEl, pending: Boolean(info && info.pending) };
  live.agents.set(agentId, record);
  return record;
}

function handleAgentStart(live, data) {
  if (!data?.agentId) return;
  const label = [data.subagentType, data.description].filter(Boolean).join(" · ") || "하위 작업";
  ensureAgentNode(live, data.agentId, { parentId: data.parentId, label, status: "running", pending: false });
  refreshLiveActivity(live);
  setStatus(live, `에이전트 작업 중: ${label}`);
}

function handleAgentEnd(live, data) {
  const rec = data?.agentId && live.agents.get(data.agentId);
  if (!rec) return;
  rec.node.dataset.status = data.ok === false ? "failed" : "done";
}

// Friendly, human-readable labels for tools shown in the activity tree. Raw
// names (e.g. `mcp__knowledge__request_info`) are an implementation detail
// the chat viewer shouldn't see.
const TOOL_LABELS = {
  mcp__knowledge__request_info: "정보 요청 기록",
  mcp__knowledge__pending_requests: "대기 요청 확인",
  mcp__knowledge__resolve_request: "요청 처리 완료",
  mcp__confluence__describe_config: "Confluence 설정 확인",
  mcp__confluence__list_spaces: "Confluence 스페이스 조회",
  mcp__confluence__search: "Confluence 검색",
  mcp__confluence__get_page: "Confluence 페이지 조회",
  mcp__confluence__list_attachments: "Confluence 첨부 조회",
  mcp__confluence__get_attachment: "Confluence 첨부 가져오기",
  mcp__confluence__extract_page_assets: "Confluence 자산 추출",
  mcp__confluence__create_page: "Confluence 페이지 생성",
  mcp__confluence__update_page: "Confluence 페이지 수정",
  mcp__system__notify_user: "사용자 알림",
  Read: "파일 읽기",
  Glob: "파일 찾기",
  Grep: "내용 검색",
  Bash: "명령 실행",
  Write: "파일 쓰기",
  Edit: "파일 편집",
  WebFetch: "웹 페이지 읽기",
  WebSearch: "웹 검색",
  Skill: "스킬 실행",
};

// Internal orchestration tools the viewer shouldn't see as activity rows.
const HIDDEN_TOOLS = new Set(["ToolSearch", "TodoWrite", "SlashCommand"]);

function toolLabel(name) {
  if (!name) return "도구";
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // Generic MCP tool: drop the `mcp__server__` prefix, humanize the rest.
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  const base = mcp ? mcp[1] : name;
  return base.replace(/_/g, " ");
}

function handleToolStart(live, data) {
  if (!data?.toolUseId || !data?.name) return;
  if (HIDDEN_TOOLS.has(data.name)) return; // internal mechanism — not user-facing
  const label = toolLabel(data.name);
  const agent = ensureAgentNode(live, data.agentId || "main", { pending: true });
  const row = el("div", { class: "tool-row", dataset: { tool: data.toolUseId, status: "running" } }, [
    el("span", { class: "tool-spinner" }),
    el("span", { class: "tool-name", text: label }),
    data.inputSummary ? el("span", { class: "tool-arg", text: data.inputSummary }) : null,
  ]);
  agent.toolsEl.append(row);
  live.tools.set(data.toolUseId, { row });
  refreshLiveActivity(live);
  setStatus(live, `${label}${data.inputSummary ? ` · ${data.inputSummary}` : ""}`, { sticky: true });
}

function handleToolEnd(live, data) {
  const rec = data?.toolUseId && live.tools.get(data.toolUseId);
  if (!rec) return;
  if (rec.row.dataset.status === "blocked") return; // keep the "blocked" label
  rec.row.dataset.status = data.ok === false ? "failed" : "done";
}

function taskLabel(data) {
  if (data?.workflowName) return `워크플로 ${data.workflowName}`;
  if (data?.subagentType) return data.subagentType;
  if (data?.taskType) return String(data.taskType).replace(/_/g, " ");
  return "태스크";
}

function taskDetail(data) {
  return data?.summary || data?.description || data?.prompt || data?.lastToolName || data?.error || data?.status || "";
}

function ensureTaskRow(live, data) {
  const taskId = data?.taskId;
  if (!taskId) return null;
  if (live.tasks.has(taskId)) return live.tasks.get(taskId);
  const label = taskLabel(data);
  const detail = taskDetail(data);
  const agent = ensureAgentNode(live, "main", { pending: true });
  const row = el("div", { class: "tool-row task-row", dataset: { task: taskId, status: "running" } }, [
    el("span", { class: "tool-spinner" }),
    el("span", { class: "tool-name", text: label }),
    detail ? el("span", { class: "tool-arg", text: detail }) : null,
  ]);
  agent.toolsEl.append(row);
  const rec = { row };
  live.tasks.set(taskId, rec);
  refreshLiveActivity(live);
  return rec;
}

function updateTaskDetail(rec, text) {
  if (!rec || !text) return;
  let arg = rec.row.querySelector(".tool-arg");
  if (!arg) {
    arg = el("span", { class: "tool-arg" });
    rec.row.append(arg);
  }
  arg.textContent = text;
}

function handleTaskStart(live, data) {
  const rec = ensureTaskRow(live, data);
  if (!rec) return;
  const detail = taskDetail(data);
  updateTaskDetail(rec, detail);
  setStatus(live, `${taskLabel(data)}${detail ? ` · ${detail}` : ""}`, { sticky: true });
}

function handleTaskUpdate(live, data) {
  const rec = ensureTaskRow(live, data);
  if (!rec) return;
  const detail = taskDetail(data);
  updateTaskDetail(rec, detail);
  if (data?.status && data.status !== "running") rec.row.dataset.taskStatus = data.status;
  if (detail) setStatus(live, `태스크 진행 중: ${detail}`, { sticky: true });
}

function handleTaskEnd(live, data) {
  const rec = ensureTaskRow(live, data);
  if (!rec) return;
  rec.row.dataset.status = data.ok === false ? "failed" : "done";
  const detail = taskDetail(data);
  updateTaskDetail(rec, detail);
  setStatus(live, data.ok === false ? "태스크가 완료되지 못했습니다." : "태스크 완료", { sticky: true });
}

function handleBlocked(live, data) {
  if (!data?.toolName) return;
  // If the owner already resolved a permission prompt for this tool, don't double-report.
  if (data.toolUseId && live.resolvedPermissions?.has(data.toolUseId)) return;
  const reasonText = data.reason ? `차단됨 · ${data.reason}` : "읽기 전용이라 차단됨";
  // Prefer to convert the existing "running" row for this tool into a blocked row.
  const existing = data.toolUseId && live.tools.get(data.toolUseId);
  if (existing) {
    existing.row.dataset.status = "blocked";
    existing.row.classList.add("blocked");
    let arg = existing.row.querySelector(".tool-arg");
    if (!arg) { arg = el("span", { class: "tool-arg" }); existing.row.append(arg); }
    arg.textContent = reasonText;
    return;
  }
  const agent = ensureAgentNode(live, data.agentId || "main", { pending: true });
  const row = el("div", { class: "tool-row blocked", dataset: { status: "blocked" } }, [
    el("span", { class: "tool-dot" }),
    el("span", { class: "tool-name", text: toolLabel(data.toolName) }),
    el("span", { class: "tool-arg", text: reasonText }),
  ]);
  agent.toolsEl.append(row);
  refreshLiveActivity(live);
}

/* ---- Interactive prompts (permission / question) ------------------- */

// Dismiss a prompt card by requestId without posting to the server (the run
// already resolved it). If the card is currently visible it is removed and the
// queue is advanced; if it is still queued it is spliced out. Called when we
// receive a `prompt_resolved` SSE event, or proactively during replay.
function dismissPromptById(live, requestId) {
  if (!requestId || !dom.promptModal) return;
  live.resolvedRequestIds.add(requestId);
  // Remove from the queue first.
  for (let i = promptQueue.length - 1; i >= 0; i--) {
    const queued = promptQueue[i];
    if (queued.dataset.request === requestId && (queued.dataset.run || "") === (live.runId || "")) {
      promptQueue.splice(i, 1);
    }
  }
  // Dismiss the currently visible card if it belongs to this request.
  const current = dom.promptModal?.firstChild;
  if (current && current.dataset.request === requestId) {
    advancePromptModal();
  }
}

function handlePromptResolved(live, data) {
  if (!data?.requestId) return;
  dismissPromptById(live, data.requestId);
}

// Submit the owner's response to a prompt. The card stays up until the POST
// succeeds — hiding first meant a transient failure dismissed the prompt while
// the run kept waiting forever on an answer the UI could no longer deliver.
// The tool id (if any) is remembered so a later "blocked" event for the same
// tool isn't double-reported in the activity tree.
async function submitPromptResponse(live, data, value, card, triggerBtn = null, busyText = "처리 중…") {
  if (data.toolUseId) {
    (live.resolvedPermissions || (live.resolvedPermissions = new Set())).add(data.toolUseId);
  }
  const buttons = card ? [...card.querySelectorAll("button")] : [];
  const disabledBefore = buttons.map((b) => b.disabled);
  const triggerLabel = triggerBtn?.textContent || "";
  card?.querySelector(".prompt-error")?.remove();
  buttons.forEach((b) => (b.disabled = true));
  if (triggerBtn) triggerBtn.textContent = busyText;
  try {
    await api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId: live.runId, requestId: data.requestId, value }) });
    advancePromptModal();
  } catch (err) {
    if (!live.done && live.pane?.streaming) {
      // Run still alive — keep the card so the user can retry.
      buttons.forEach((b, i) => (b.disabled = disabledBefore[i]));
      if (triggerBtn) triggerBtn.textContent = triggerLabel;
      let note = card?.querySelector(".prompt-error");
      if (card) {
        if (!note) {
          note = el("div", { class: "error-note prompt-error", role: "alert" });
          card.append(note);
        }
        note.textContent = `응답을 전송하지 못했습니다: ${err.message} — 다시 시도해 주세요.`;
      }
      return;
    }
    // Run already ended; nothing actionable left to show.
    advancePromptModal();
  }
}

// Header for a prompt card: icon + label + a ✕ that triggers the card's own
// cancel/skip action (same effect as Esc or a scrim click), so the owner always
// has a visible way to dismiss a prompt without answering.
function promptHead(label, iconName) {
  const closeBtn = el("button", {
    class: "msg-act prompt-close",
    type: "button",
    "aria-label": "닫기",
    title: "닫기",
    onclick: (event) => {
      event.preventDefault();
      event.currentTarget.closest(".prompt-card")?.querySelector("[data-prompt-cancel]")?.click();
    },
  });
  closeBtn.append(icon("close"));
  return el("div", { class: "prompt-head" }, [
    el("span", { class: "prompt-icon" }, [icon(iconName)]),
    el("span", { class: "prompt-head-label", text: label }),
    closeBtn,
  ]);
}

function renderPermissionCard(live, data) {
  if (!data?.requestId || !dom.promptModal) return;
  const toolName = data.toolName || "도구";
  const title = data.title || `이 아바타가 "${toolLabel(toolName)}" 작업을 실행하려고 합니다.`;
  const argSummary = summarizeInputForCard(data.input);

  const card = el("div", { class: "prompt-card permission", dataset: { request: data.requestId, tooluse: data.toolUseId || "" } }, [
    promptHead("권한 요청", "lock"),
    el("div", { class: "prompt-title", text: title }),
    el("div", { class: "prompt-tool" }, [el("code", { text: toolName }), argSummary ? el("span", { class: "prompt-arg", text: argSummary }) : null]),
    data.description ? el("div", { class: "prompt-desc", text: data.description }) : null,
  ]);
  card.append(
    el("div", { class: "prompt-actions" }, [
      el("button", { class: "btn btn-ghost btn-sm", text: "거부", "data-prompt-cancel": "", onclick: (event) => submitPromptResponse(live, data, { behavior: "deny" }, card, event.currentTarget, "거부 중…") }),
      el("button", { class: "btn btn-primary btn-sm", text: "승인", onclick: (event) => submitPromptResponse(live, data, { behavior: "allow" }, card, event.currentTarget, "승인 중…") }),
    ]),
  );
  showPromptModal(card, live.runId || "");
  setStatus(live, "권한 승인을 기다리는 중…", { sticky: true });
}

function renderQuestionCard(live, data) {
  if (!data?.requestId || !dom.promptModal) return;
  const payload = data.payload || {};
  const questions = Array.isArray(payload.questions) ? payload.questions : null;
  const card = el("div", { class: "prompt-card question", dataset: { request: data.requestId } }, [
    promptHead("질문", "chat"),
  ]);

  if (!questions) {
    // Unknown dialog kind: show raw payload + confirm/cancel.
    card.append(el("pre", { class: "prompt-input", text: JSON.stringify(payload, null, 2) }));
    card.append(el("div", { class: "prompt-actions" }, [
      el("button", { class: "btn btn-ghost btn-sm", text: "취소", "data-prompt-cancel": "", onclick: (event) => submitPromptResponse(live, data, { cancelled: true }, card, event.currentTarget, "취소 중…") }),
      el("button", { class: "btn btn-primary btn-sm", text: "확인", onclick: (event) => submitPromptResponse(live, data, { result: {} }, card, event.currentTarget, "확인 중…") }),
    ]));
    showPromptModal(card, live.runId || "");
    setStatus(live, "질문에 답해 주세요…", { sticky: true });
    return;
  }

  // Per-question state: selections[i] = chosen option labels; customOn[i] +
  // customText[i] = the "직접 입력" free-text branch (AskUserQuestion always lets
  // the user answer with their own text instead of a preset option).
  const selections = questions.map(() => []);
  const customOn = questions.map(() => false);
  const customText = questions.map(() => "");
  const submitBtn = el("button", { class: "btn btn-primary btn-sm", text: "보내기", disabled: true });

  const answeredFor = (qi) => selections[qi].length > 0 || (customOn[qi] && customText[qi].trim().length > 0);
  const refreshSubmit = () => {
    submitBtn.disabled = !questions.every((_, qi) => answeredFor(qi));
  };
  const setSelected = (btn, on) => {
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  };

  questions.forEach((q, qi) => {
    const multi = q.multiSelect === true;
    const block = el("div", { class: "q-block" }, [
      q.header ? el("span", { class: "q-chip", text: q.header }) : null,
      el("div", { class: "q-text", text: q.question || "" }),
    ]);
    const opts = Array.isArray(q.options) ? q.options : [];
    const optsEl = el("div", { class: "q-options", role: "group", "aria-label": multi ? "여러 개 선택 가능" : "하나 선택" });

    // Free-text input, revealed when "직접 입력" is active.
    const customInput = el("textarea", {
      class: "q-custom-input",
      rows: "2",
      placeholder: "직접 답변을 입력하세요…",
      hidden: true,
    });
    customInput.addEventListener("input", () => { customText[qi] = customInput.value; refreshSubmit(); });

    opts.forEach((opt) => {
      const optBtn = el("button", { class: "q-option", type: "button", "aria-pressed": "false" }, [
        el("span", { class: "q-opt-label", text: opt.label || "" }),
        opt.description ? el("span", { class: "q-opt-desc", text: opt.description }) : null,
      ]);
      optBtn.addEventListener("click", () => {
        if (multi) {
          const idx = selections[qi].indexOf(opt.label);
          if (idx >= 0) { selections[qi].splice(idx, 1); setSelected(optBtn, false); }
          else { selections[qi].push(opt.label); setSelected(optBtn, true); }
        } else {
          selections[qi] = [opt.label];
          optsEl.querySelectorAll(".q-option").forEach((b) => setSelected(b, false));
          setSelected(optBtn, true);
          // Single-select: picking a preset cancels the free-text branch.
          customOn[qi] = false;
          customInput.hidden = true;
          customBtn.classList.remove("selected");
          customBtn.setAttribute("aria-pressed", "false");
        }
        refreshSubmit();
      });
      optsEl.append(optBtn);
    });

    // "직접 입력" toggle — reveals the textarea and (single-select) clears presets.
    const customBtn = el("button", { class: "q-option q-option-custom", type: "button", "aria-pressed": "false" }, [
      el("span", { class: "q-opt-label", text: "✎ 직접 입력" }),
    ]);
    customBtn.addEventListener("click", () => {
      customOn[qi] = !customOn[qi];
      setSelected(customBtn, customOn[qi]);
      customInput.hidden = !customOn[qi];
      if (customOn[qi]) {
        if (!multi) {
          selections[qi] = [];
          optsEl.querySelectorAll(".q-option:not(.q-option-custom)").forEach((b) => setSelected(b, false));
        }
        customInput.focus();
      }
      refreshSubmit();
    });
    optsEl.append(customBtn);

    block.append(optsEl);
    block.append(customInput);
    card.append(block);
  });

  submitBtn.addEventListener("click", () => {
    // Shape the result like AskUserQuestionOutput: an answers map keyed by the
    // question text (multi-select answers comma-joined), echoing the questions.
    // A "직접 입력" value is appended as just another answer string.
    const answers = {};
    questions.forEach((q, qi) => {
      const vals = selections[qi].slice();
      if (customOn[qi] && customText[qi].trim()) vals.push(customText[qi].trim());
      answers[q.question || `q${qi}`] = vals.join(", ");
    });
    submitPromptResponse(live, data, { result: { questions, answers } }, card, submitBtn, "보내는 중…");
  });

  // Always offer an exit: without 건너뛰기 the disabled submit + full-screen
  // backdrop could hard-stick a user who doesn't want to answer.
  card.append(el("div", { class: "prompt-actions" }, [
    el("button", { class: "btn btn-ghost btn-sm", text: "건너뛰기", "data-prompt-cancel": "", onclick: (event) => submitPromptResponse(live, data, { cancelled: true }, card, event.currentTarget, "건너뛰는 중…") }),
    submitBtn,
  ]));
  showPromptModal(card, live.runId || "");
  setStatus(live, "질문에 답해 주세요…", { sticky: true });
}

function summarizeInputForCard(input) {
  if (!input || typeof input !== "object") return "";
  const keys = ["command", "file_path", "path", "pattern", "url", "query"];
  for (const k of keys) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  const firstStr = Object.values(input).find((v) => typeof v === "string" && v);
  return typeof firstStr === "string" ? firstStr : "";
}

// Freeze the activity tree: stop spinners, keep the record visible in the final bubble.
function freezeActivity(live) {
  live.activityEl.querySelectorAll('.tool-row[data-status="running"]').forEach((r) => (r.dataset.status = "done"));
  live.activityEl.querySelectorAll('.agent-node[data-status="running"]').forEach((n) => (n.dataset.status = "done"));
  live.activityEl.classList.add("collapsed");
}

// Status text. A `sticky` update (e.g. an active tool's label) holds the line
// for a short window so the SDK's generic "응답 생성 중…" can't immediately clobber
// it — that overwrite-race is what made the status flicker between tool calls.
function setStatus(live, label, { sticky = false } = {}) {
  if (!live.statusLabel) return;
  const now = Date.now();
  if (!sticky && live.statusStickyUntil && now < live.statusStickyUntil) return;
  live.statusLabel.textContent = label;
  live.statusStickyUntil = sticky ? now + 1500 : 0;
}
function handlePluginEvent(live, data) {
  if (!data?.name) return;
  let chip = live.pluginChips.querySelector(`[data-plugin="${cssEscape(data.name)}"]`);
  if (!chip) {
    chip = el("span", { class: "plugin-chip", dataset: { plugin: data.name } }, [el("span", { class: "pc-dot" }), el("span", { class: "pc-text", text: data.name })]);
    live.pluginChips.append(chip);
  }
  chip.dataset.status = data.status || "started";
  const m = { started: "불러오는 중", installed: "설치됨", completed: "사용 준비됨", failed: "불러오기 실패" };
  chip.querySelector(".pc-text").textContent = `${data.name} · ${m[data.status] || data.status || ""}`;
}
function cssEscape(v) {
  return String(v).replace(/["\\]/g, "\\$&");
}
function setComposerState(pane, text) {
  const n = pane?.dom?.composerState;
  if (n) n.textContent = text;
}
function cleanupLive(live) {
  if (live.pane?.live === live) live.pane.live = null;
  live.caret.remove();
  live.statusRow.remove();
  // Dismiss THIS run's unanswered prompts only — in split view another pane's
  // pending card must survive its neighbor finishing.
  dismissRunPrompts(live.runId || "");
  if (live.activityEl) freezeActivity(live);
  if (!live.pluginChips.children.length) live.pluginChips.remove();
  // No tool/agent rows ran: drop the (still-hidden) live disclosure wrapper.
  if (live.activityEl && !live.activityEl.children.length) live.activityDetails.remove();
  // Announce completion once (streaming announcements are suppressed).
  if (dom.srStatus) dom.srStatus.textContent = "아바타 응답이 끝났습니다.";
}
// Wrap a finished activity tree in a collapsed <details> disclosure so a long
// conversation isn't cluttered by every expanded tool log. Returns null when
// there was no activity to show.
// Summarize an activity tree as "도구 N개 · 에이전트 M개 사용". `suffix` overrides
// the trailing word (e.g. "진행 중" while streaming instead of "사용").
function activitySummaryText(activityEl, suffix = "사용") {
  const toolCount = activityEl.querySelectorAll(".tool-row:not(.task-row)").length;
  const taskCount = activityEl.querySelectorAll(".task-row").length;
  const agentCount = activityEl.querySelectorAll(".agent-node.sub").length;
  const parts = [];
  if (toolCount) parts.push(`도구 ${toolCount}개`);
  if (taskCount) parts.push(`태스크 ${taskCount}개`);
  if (agentCount) parts.push(`에이전트 ${agentCount}개`);
  return parts.length ? `${parts.join(" · ")} ${suffix}` : "작업 내역";
}

// Keep the live disclosure's summary in sync as tool/agent rows stream in, and
// hide the whole thing until the first row appears so a tools-less reply shows
// no empty box.
function refreshLiveActivity(live) {
  if (!live.activityDetails || !live.activitySummaryEl) return;
  const hasRows = live.activityEl.children.length > 0;
  live.activityDetails.hidden = !hasRows;
  if (!hasRows) return;
  live.activitySummaryEl.textContent = activitySummaryText(live.activityEl, "진행 중");
  // Keep the newest row visible within the height-capped, scrollable tree —
  // but only when the viewer is already at the bottom. Otherwise a burst of new
  // rows would yank the box away while they're reading earlier activity.
  const box = live.activityEl;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function collapseActivity(activityEl) {
  if (!activityEl || !activityEl.children.length) return null;
  const summaryText = activitySummaryText(activityEl, "사용");
  const details = el("details", { class: "activity-done" }, [
    el("summary", {}, [el("span", { class: "activity-summary-text", text: summaryText })]),
  ]);
  activityEl.classList.remove("collapsed");
  details.append(activityEl);
  return details;
}

// Collapse the live activity tree into its <details> disclosure IN PLACE,
// keeping its position in the bubble. Used by the stop/error finalizers, which
// (unlike finalizeDone) don't rebuild the bubble from scratch — without this
// the frozen tree stays fully expanded as a tall, empty-looking block.
function collapseActivityInPlace(live) {
  const wrapper = live.activityDetails;
  const activityEl = live.activityEl;
  if (!wrapper || !wrapper.isConnected || !activityEl || !activityEl.children.length) return;
  const parent = wrapper.parentNode;
  const details = collapseActivity(activityEl); // detaches activityEl into a fresh <details>
  if (details && parent) parent.replaceChild(details, wrapper);
}

function finalizeDone(live, data) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  const message = data?.message || { role: "assistant", content: data?.response?.text || data?.response?.summary || live.text, response: data?.response, createdAt: new Date().toISOString() };
  live.pane.messages.push(message);
  updateComposerUsage(live.pane);
  if (activePane()?.id === live.pane.id) syncLegacyChatState(live.pane);
  // The live bubble may have been detached by a mid-stream re-render — the
  // message is already in pane.messages, so rebuild the transcript from it.
  if (!live.wrap.isConnected) {
    renderTranscript(live.pane);
    refreshConversations();
    return;
  }
  live.wrap.removeAttribute("aria-live");
  // Re-render the bubble with the persisted record ABOVE the answer (matching
  // the live order): collapsed activity log → answer text.
  const collapsedActivity = collapseActivity(live.activityEl);
  live.bubble.replaceChildren();
  live.bubble.className = "bubble";
  if (collapsedActivity) live.bubble.append(collapsedActivity);
  renderAssistantInto(live.bubble, message);
  live.wrap.append(buildMessageActions(live.pane, message, false, true));
  scrollToBottom(live.pane);
  refreshConversations();
}
function finalizeError(live, msg) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  // A failed regenerate that produced nothing: restore the discarded answer.
  const restored = !live.text && live.restoreOnError ? live.restoreOnError : null;
  if (restored) live.pane.messages.push(...restored);
  live.pane.messages.push({ role: "assistant", content: live.text ? `${live.text}\n\n${msg}` : msg, errored: true, response: { kind: "text", runtime: "error", summary: "오류", text: live.text || msg } });
  if (activePane()?.id === live.pane.id) syncLegacyChatState(live.pane);
  if (dom.srStatus) dom.srStatus.textContent = "응답 중 오류가 발생했습니다.";
  if (!live.wrap.isConnected || restored) {
    renderTranscript(live.pane);
    return;
  }
  live.wrap.removeAttribute("aria-live");
  collapseActivityInPlace(live);
  live.bubble.classList.add("errored");
  if (live.text) {
    live.mdNode.innerHTML = renderMarkdown(live.text);
    enhanceCodeBlocks(live.mdNode);
  } else live.mdNode.remove();
  live.bubble.append(el("div", { class: "response-meta" }, [el("span", { class: "meta-badge runtime-error", text: "오류" })]));
  live.bubble.append(el("div", { class: "md", text: msg }));
}
function finalizeStopped(live) {
  if (live.done) return;
  live.done = true;
  live.aborted = true;
  cleanupLive(live);
  live.pane.messages.push({ role: "assistant", content: live.text || "(중지됨)", response: { kind: "text", runtime: "claude", summary: "중지됨", text: live.text } });
  if (activePane()?.id === live.pane.id) syncLegacyChatState(live.pane);
  if (!live.wrap.isConnected) {
    renderTranscript(live.pane);
    return;
  }
  live.wrap.removeAttribute("aria-live");
  collapseActivityInPlace(live);
  live.mdNode.innerHTML = renderMarkdown(live.text);
  enhanceCodeBlocks(live.mdNode);
  live.bubble.append(el("div", { class: "stream-status" }, [el("span", { class: "label", text: "사용자가 중지했습니다" })]));
}
// Connection dropped server-side with partial text — distinct from a user stop.
function finalizeInterrupted(live) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  live.pane.messages.push({ role: "assistant", content: live.text, response: { kind: "text", runtime: "claude", summary: "중단됨", text: live.text } });
  if (activePane()?.id === live.pane.id) syncLegacyChatState(live.pane);
  if (!live.wrap.isConnected) {
    renderTranscript(live.pane);
    return;
  }
  live.wrap.removeAttribute("aria-live");
  collapseActivityInPlace(live);
  live.mdNode.innerHTML = renderMarkdown(live.text);
  enhanceCodeBlocks(live.mdNode);
  live.bubble.append(el("div", { class: "stream-status" }, [el("span", { class: "label", text: "연결이 끊겨 응답이 중단되었습니다 — 다시 생성으로 이어서 받을 수 있어요" })]));
}
function stopStreaming(pane = activePane()) {
  const runId = pane?.live?.runId;
  const abortLocal = () => pane?.abortController?.abort();
  if (!runId) {
    abortLocal();
    return;
  }
  api(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })
    .catch((err) => notify(`중지 요청 실패: ${err.message}`, "warn"))
    .finally(abortLocal);
}

/* ============================================================ Conversations (rail) */
async function loadConversations() {
  const result = await api("/api/conversations");
  state.conversations = result.conversations || [];
}
export async function refreshConversations() {
  try {
    await loadConversations();
    renderConversations();
  } catch {
    if (dom.convList && !state.conversations.length) {
      if (dom.convSearch) {
        dom.convSearch.disabled = true;
        dom.convSearch.placeholder = "대화 목록 오류";
        dom.convSearch.value = "";
      }
      dom.convList.replaceChildren(
        el("div", { class: "conv-empty" }, [
          "대화 목록을 불러오지 못했습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => refreshConversations() }),
        ]),
      );
    }
  }
}
export function renderConversations() {
  if (!dom.convList) return;
  // Don't rebuild while a rename is being typed (e.g. a finishing stream calls
  // refreshConversations) — that would wipe the input mid-edit.
  if (dom.convList.querySelector(".conv-item.editing")) return;
  if (dom.convSearch) {
    const hasConversations = state.conversations.length > 0;
    dom.convSearch.disabled = !hasConversations;
    dom.convSearch.placeholder = hasConversations ? "대화 검색" : "검색할 대화 없음";
    if (!hasConversations) dom.convSearch.value = "";
  }
  dom.convList.replaceChildren();
  if (!state.conversations.length) {
    dom.convList.append(
      el("div", { class: "conv-empty" }, [
        "아직 대화가 없습니다.\n",
        el("button", { class: "linkish small", type: "button", text: "탐색에서 시작하기", onclick: () => goView("explore") }),
      ]),
    );
    return;
  }
  const query = (dom.convSearch?.value || "").trim().toLowerCase();
  const visible = query
    ? state.conversations.filter(
        (c) => (c.title || "").toLowerCase().includes(query) || (c.avatarDisplayName || "").toLowerCase().includes(query),
      )
    : state.conversations;
  if (!visible.length) {
    dom.convList.append(
      el("div", { class: "conv-empty" }, [
        `"${dom.convSearch.value.trim()}"에 맞는 대화가 없습니다.\n`,
        el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearConversationSearch }),
      ]),
    );
    return;
  }
  for (const conv of visible) {
    const active = state.chatPanes.some((pane) => pane.conversationId === conv.id);
    const item = el("div", { class: `conv-item ${active ? "active" : ""}`, dataset: { id: conv.id } });
    const title = conv.title || "새 대화";
    const openLabel = active ? `열려 있는 대화로 이동: ${title}` : `대화 열기: ${title}`;
    const openBtn = el("button", {
      class: "conv-open",
      type: "button",
      title: openLabel,
      "aria-label": openLabel,
      onclick: () => selectConversation(conv, openBtn, item),
    }, [
      el("span", { class: "conv-name", text: conv.title || "새 대화" }),
      el("span", { class: "conv-time", text: [conv.avatarDisplayName, timeLabel(conv.updatedAt)].filter(Boolean).join(" · ") }),
    ]);
    const renameBtn = el("button", { class: "conv-act", type: "button", "aria-label": "대화 이름 바꾸기", title: "이름 바꾸기", onclick: (e) => { e.stopPropagation(); startRenameConversation(item, conv); } });
    renameBtn.append(icon("edit"));
    const delBtn = el("button", { class: "conv-act danger", type: "button", "aria-label": "대화 삭제", title: "삭제", onclick: (e) => { e.stopPropagation(); deleteConversation(conv, delBtn, item); } });
    delBtn.append(icon("trash"));
    item.append(openBtn, el("div", { class: "conv-acts" }, [renameBtn, delBtn]));
    dom.convList.append(item);
  }
}

function clearConversationSearch() {
  if (!dom.convSearch) return;
  dom.convSearch.value = "";
  renderConversations();
  dom.convSearch.focus();
}

// Inline rename: swaps the row content for an input; Enter/blur saves, Escape cancels.
function startRenameConversation(item, conv) {
  if (item.classList.contains("editing")) return;
  item.classList.add("editing");
  const open = item.querySelector(".conv-open");
  item.querySelectorAll(".conv-act").forEach((btn) => (btn.disabled = true));
  const input = el("input", { class: "conv-rename", value: conv.title || "", placeholder: "대화 이름", "aria-label": "대화 이름", title: "Enter 저장 · Esc 취소" });
  open.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    if (save && title && title !== conv.title) {
      setFormBusy(item, true);
      input.title = "저장 중…";
      api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "PATCH", body: JSON.stringify({ title }) })
        .then(({ conversation }) => {
          conv.title = conversation?.title || title;
          renderConversations();
          notify("대화 이름을 변경했습니다.", "ok");
        })
        .catch((e) => {
          notify(`이름 변경 실패: ${e.message}`);
          renderConversations();
        });
      return;
    }
    renderConversations();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

export async function selectConversation(conv, triggerBtn = null, row = null) {
  if (!guardChatReplacement(conv.id)) return;
  // Already open in a pane → focus it instead of rebuilding from server history.
  // Essential when that pane is mid-stream: re-fetching history (which lacks the
  // not-yet-persisted in-flight answer) and rebuilding the pane would drop the live
  // streaming bubble. guardChatReplacement deliberately lets the same-id case
  // through, so this short-circuit is what protects the streaming pane.
  const openPane = state.chatPanes.find((p) => p.conversationId === conv.id);
  if (openPane && (openPane.streaming || state.chatPanes.length > 1)) {
    setActivePane(openPane);
    closeRail();
    state.view = "chat";
    syncHash();
    renderView();
    renderConversations();
    notify(`"${conv.title || "새 대화"}" 대화로 이동했습니다.`, "info");
    return;
  }
  if (state.chatPanes.length > 1) {
    // Opening a not-yet-open conversation replaces the whole split — ask first.
    if (!window.confirm("분할 대화를 닫고 이 대화를 열까요?")) return;
  }
  const meta = triggerBtn?.querySelector(".conv-time");
  const previousMeta = meta?.textContent || "";
  if (triggerBtn) {
    setFormBusy(row || triggerBtn, true);
    triggerBtn.title = "대화 불러오는 중…";
    if (meta) meta.textContent = "불러오는 중…";
  }
  closeRail();
  let pane;
  try {
    const [msgRes, avRes] = await Promise.all([
      api(`/api/messages?conversationId=${encodeURIComponent(conv.id)}`),
      api(`/api/avatars/${encodeURIComponent(conv.avatarUserId)}`).catch(() => null),
    ]);
    const avatar = avRes?.avatar || { id: conv.avatarUserId, displayName: conv.avatarDisplayName, username: "", hasImage: true };
    pane = makeChatPane(avatar, {
      conversationId: conv.id,
      messages: msgRes.messages || [],
      groupKnowledgeOff: msgRes.groupKnowledgeOff || [],
    });
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    syncLegacyChatState(pane);
  } catch (e) {
    if (triggerBtn) {
      setFormBusy(row || triggerBtn, false);
      triggerBtn.title = conv.title || "새 대화";
      if (meta) meta.textContent = previousMeta;
    }
    // Don't render an empty transcript that looks like wiped history — stay
    // where we are and say what happened.
    notify(`대화를 불러오지 못했습니다: ${e.message}`);
    return;
  }
  state.view = "chat";
  syncHash();
  renderView();
  renderConversations();
  attachActiveRun(pane);
}
async function deleteConversation(conv, triggerBtn = null, row = null) {
  const streamingPane = state.chatPanes.find((p) => p.conversationId === conv.id && p.streaming);
  if (streamingPane) {
    notify("응답 중인 대화는 삭제할 수 없습니다. 먼저 응답을 중지해 주세요.", "warn");
    return;
  }
  const title = conv.title || "새 대화";
  if (!window.confirm(`"${title}" 대화를 삭제할까요? 삭제하면 되돌릴 수 없습니다.`)) return;
  if (triggerBtn) {
    setFormBusy(row || triggerBtn, true);
    triggerBtn.title = "삭제 중…";
    triggerBtn.setAttribute("aria-label", "대화 삭제 중");
  }
  try {
    await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "DELETE" });
  } catch (e) {
    if (triggerBtn) {
      setFormBusy(row || triggerBtn, false);
      triggerBtn.title = "삭제";
      triggerBtn.setAttribute("aria-label", "대화 삭제");
    }
    notify(`삭제 실패: ${e.message}`);
    return;
  }
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  const pane = state.chatPanes.find((p) => p.conversationId === conv.id);
  if (pane) newChat(pane);
  else renderConversations();
  notify(`"${title}" 대화를 삭제했습니다.`, "ok");
}
