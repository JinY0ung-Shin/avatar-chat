// Auto-split from chat.js — submodule: chat view + panes UI + split. Behavior-preserving relocation only.
import { dom, el, icon, notify, state } from "../core.js";
import { avatarNode } from "../avatar-image.js";
import { loadAvatars } from "../loaders.js";
import { goView, renderView, syncHash } from "../nav.js";
import { viewHeader } from "../shell.js";
import {
  activePane,
  ensureChatPanes,
  guardChatReplacement,
  makeChatPane,
  MAX_CHAT_PANES,
  setActivePane,
  setupGroupKnowledgeToggle,
  streamingPane,
  syncLegacyChatState,
} from "./panes.js";
import { isNearBottom, scrollToBottom, updateScrollButton } from "./assistant.js";
import { enterSends, renderCapabilitiesPanel } from "./capabilities.js";
import { newChat, renderTranscript, wireComposer } from "./composer.js";
import { maybeGreet, stopStreaming, submitMessage } from "./stream.js";
import { refreshConversations } from "./conversations.js";

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
