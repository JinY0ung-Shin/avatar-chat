// Auto-split from chat.js — submodule: composer + transcript + messages + usage. Behavior-preserving relocation only.
import { copyText, el, enhanceCodeBlocks, icon, newId, notify, renderMarkdown, state, timeLabel } from "../core.js";
import { avatarNode } from "../avatar-image.js";
import { syncHash } from "../nav.js";
import { activePane, setActivePane, syncLegacyChatState } from "./panes.js";
import { enterSends, notePhysicalKeyboard } from "./capabilities.js";
import { handleSlashMenuKeydown, hideSlashMenu, renderSlashMenu } from "./slash.js";
import { renderAssistantInto, scrollToBottom, updateScrollButton } from "./assistant.js";
import { maybeGreet, setComposerState, streamChat, stopStreaming, submitMessage } from "./stream.js";
import { renderConversations } from "./conversations.js";

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
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) {
      notePhysicalKeyboard();
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

export {
  wireComposer,
  updateSendState,
  newChat,
  renderTranscript,
  attachLiveToTranscript,
  renderChatEmpty,
  buildMessageNode,
  buildMessageActions,
  setRegenerateBusy,
  regenerate,
  RUNTIME_BADGE_LABELS,
  formatTokenCount,
  formatUsageLabel,
  updateComposerUsage,
};
