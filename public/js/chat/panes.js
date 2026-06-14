// Auto-split from chat.js — submodule: pane state + lifecycle. Behavior-preserving relocation only.
import { api, dom, el, newId, notify, setAbort, state } from "../core.js";

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
export const MAX_CHAT_PANES = 4;

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
export function setupGroupKnowledgeToggle(pane, pdom) {
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

export function ensureChatPanes() {
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

export function refreshStreamingState() {
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
