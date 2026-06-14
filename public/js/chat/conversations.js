// Auto-split from chat.js — submodule: conversations rail. Behavior-preserving relocation only.
import { api, dom, el, icon, notify, setFormBusy, state, timeLabel } from "../core.js";
import { goView, renderView, syncHash } from "../nav.js";
import { closeRail } from "../shell.js";
import { guardChatReplacement, makeChatPane, setActivePane, syncLegacyChatState } from "./panes.js";
import { newChat } from "./composer.js";
import { attachActiveRun } from "./stream.js";

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
