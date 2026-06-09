import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

// Open links in new tab safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const app = document.querySelector("#app");

function newId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

const state = {
  user: null,
  bootstrap: null,
  skills: null,
  marketplace: null,
  audit: [],
  invites: [],
  conversations: [],
  messages: [],
  mode: "colleague",
  conversationId: newId(),
  error: "",
  streaming: false,
};

// Live references into the rendered shell (set by mountWorkspace).
const dom = {};
let abortController = null;
let sessionExpired = false;

/* ============================================================
   Networking
   ============================================================ */
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
  });
  if (response.status === 401) {
    handleSessionExpired();
    throw new Error("세션이 만료되었습니다.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

// A mid-session 401 (revoked/expired session) bounces back to the login view.
function handleSessionExpired() {
  if (sessionExpired) return;
  sessionExpired = true;
  abortController?.abort();
  state.user = null;
  state.messages = [];
  state.conversations = [];
  state.error = "세션이 만료되었습니다. 다시 로그인해 주세요.";
  renderLogin();
}

/* ============================================================
   Helpers
   ============================================================ */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const paths = {
    gear:
      '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    edit:
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
    trash:
      '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    copy:
      '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths[name] || "";
  return svg;
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

// Add a one-click copy button to each code block inside a rendered markdown node.
// The button lives on a non-scrolling wrapper so it stays pinned to the corner
// even when the <pre> scrolls horizontally.
function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    const wrapper = el("div", { class: "code-block" });
    pre.replaceWith(wrapper);
    wrapper.append(pre);
    const btn = el("button", { class: "code-copy", type: "button", "aria-label": "코드 복사", title: "복사" });
    btn.append(icon("copy"));
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      copyText(pre.querySelector("code")?.innerText ?? pre.innerText, btn);
    });
    wrapper.append(btn);
  });
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    flashCopied(btn);
  } catch {
    /* ignore copy failures */
  }
}

function flashCopied(btn) {
  if (!btn) return;
  // Capture the real original content once (not the transient check icon), and
  // clear any in-flight restore so rapid double-clicks can't strand the icon.
  if (!btn._copyOriginal) btn._copyOriginal = [...btn.childNodes];
  clearTimeout(btn._copyTimer);
  btn.classList.add("copied");
  btn.replaceChildren(icon("check"));
  btn._copyTimer = setTimeout(() => {
    btn.classList.remove("copied");
    btn.replaceChildren(...btn._copyOriginal);
  }, 1200);
}

function timeLabel(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const modeCopy = {
  owner: {
    title: "업무 지시 모드",
    sub: "소유자 지시를 marketplace skill로 처리하고 결과를 보고합니다.",
  },
  colleague: {
    title: "동료 조회 모드",
    sub: "초대된 프로젝트 범위 안에서 읽기 전용 상태 확인만 처리합니다.",
  },
};

function updateDocTitle() {
  const base = "Avatar Chat";
  if (state.streaming) {
    document.title = `● 응답 중 · ${base}`;
    return;
  }
  const conv = state.conversations.find((c) => c.id === state.conversationId);
  document.title = conv?.title ? `${conv.title} · ${base}` : base;
}

/* ============================================================
   Boot skeleton (avoid blank flash on cold load)
   ============================================================ */
function renderBootSkeleton() {
  app.replaceChildren(
    el("div", { class: "boot" }, [
      el("div", { class: "boot-mark", text: "A" }),
      el("div", { class: "boot-spinner" }),
      el("div", { class: "boot-label", text: "불러오는 중…" }),
    ]),
  );
}

/* ============================================================
   Login view (separate render path)
   ============================================================ */
function renderLogin() {
  abortController?.abort();
  abortController = null;
  state.streaming = false;
  document.title = "Avatar Chat";
  app.replaceChildren(
    el("section", { class: "login-view" }, [
      el("div", { class: "login-panel" }, [
        el("div", { class: "login-mark", text: "A" }),
        el("h1", { text: "Avatar Chat" }),
        el("p", { text: "사내 프로젝트 팀을 위한 초대 기반 업무 채팅입니다." }),
        state.error ? el("div", { class: "error", text: state.error }) : null,
        el(
          "form",
          {
            class: "form-stack",
            id: "login-form",
            onsubmit: async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const submitBtn = event.currentTarget.querySelector("button[type=submit]");
              if (submitBtn) submitBtn.disabled = true; // guard against double-submit
              try {
                const result = await api("/api/session", {
                  method: "POST",
                  body: JSON.stringify({ name: form.get("name"), code: form.get("code") }),
                });
                sessionExpired = false;
                state.user = result.user;
                state.mode = state.user.role === "owner" ? "owner" : "colleague";
                state.error = "";
                await hydrate();
              } catch (error) {
                state.error = error.message;
                renderLogin();
              }
            },
          },
          [
            el("label", { class: "field" }, [
              el("span", { text: "이름" }),
              el("input", { name: "name", autocomplete: "name", placeholder: "홍길동", required: "" }),
            ]),
            el("label", { class: "field" }, [
              el("span", { text: "초대 코드" }),
              el("input", {
                name: "code",
                autocomplete: "one-time-code",
                placeholder: "초대 코드 입력",
                required: "",
              }),
            ]),
            el("button", { class: "primary", type: "submit", text: "접속" }),
          ],
        ),
        el("div", {
          class: "hint",
          text: "초대 코드는 앱 소유자가 발급합니다. 초기 소유자 설정 코드는 배포 환경 변수에서 관리합니다.",
        }),
      ]),
    ]),
  );
  app.querySelector('input[name="name"]')?.focus();
}

/* ============================================================
   Workspace shell — built ONCE, updated surgically
   ============================================================ */
function mountWorkspace() {
  const owner = state.user?.role === "owner";
  const initial = (state.user?.name || "?").trim().charAt(0).toUpperCase();

  // --- New chat ---
  const newChatBtn = el("button", { class: "new-chat", type: "button", onclick: () => newChat() }, []);
  newChatBtn.append(icon("plus"), el("span", { text: "새 채팅" }));

  // --- Conversation list ---
  dom.convList = el("div", { class: "conv-list scroll-thin" });

  // --- Mode segmented (footer) ---
  const modeSeg = el("div", { class: "mode-seg", role: "group", "aria-label": "모드 전환" }, [
    el("button", { type: "button", dataset: { mode: "colleague" }, text: "동료 조회", onclick: () => switchMode("colleague") }),
    el("button", {
      type: "button",
      dataset: { mode: "owner" },
      text: "업무 지시",
      disabled: owner ? null : "",
      onclick: () => switchMode("owner"),
    }),
  ]);
  dom.modeSeg = modeSeg;

  const gearBtn = el("button", {
    class: "icon-button",
    type: "button",
    "aria-label": "설정 열기",
    title: "설정",
    onclick: () => openDrawer(),
  });
  gearBtn.append(icon("gear"));

  const rail = el("aside", { class: "rail", id: "rail" }, [
    el("div", { class: "rail-head" }, [
      el("div", { class: "rail-brand" }, [
        el("div", { class: "mark", text: "A" }),
        el("div", {}, [
          el("div", { class: "name", text: "Avatar Chat" }),
          el("div", { class: "sub", text: "marketplace workspace" }),
        ]),
      ]),
      newChatBtn,
    ]),
    el("div", { class: "rail-history" }, [
      el("div", { class: "rail-section-label", text: "대화" }),
      dom.convList,
    ]),
    el("div", { class: "rail-footer" }, [
      modeSeg,
      el("div", { class: "rail-user-row" }, [
        el("div", { class: "rail-user" }, [
          el("div", { class: "avatar", text: initial }),
          el("div", { class: "meta" }, [
            el("b", { text: state.user.name }),
            el("span", { text: owner ? "소유자" : "동료" }),
          ]),
        ]),
        el("div", { class: "rail-actions" }, [
          el("button", { class: "rail-logout", type: "button", text: "나가기", onclick: logout }),
          gearBtn,
        ]),
      ]),
    ]),
  ]);

  // --- Chat header ---
  dom.headerTitle = el("h2");
  dom.headerSub = el("p");
  dom.marketBadge = el("button", {
    class: "market-badge",
    type: "button",
    "aria-label": "마켓플레이스 설정 열기",
    onclick: () => openDrawer("market"),
  });

  const railToggle = el("button", {
    class: "icon-button rail-toggle",
    type: "button",
    "aria-label": "대화 목록 열기",
    title: "대화 목록",
    onclick: () => openRail(),
  });
  railToggle.append(icon("menu"));

  const header = el("header", { class: "chat-header" }, [
    el("div", { class: "header-left" }, [railToggle, el("div", { class: "title" }, [dom.headerTitle, dom.headerSub])]),
    el("div", { class: "header-badges" }, [dom.marketBadge]),
  ]);

  // --- Transcript ---
  dom.transcriptInner = el("div", { class: "transcript-inner" });
  dom.transcript = el("div", {
    class: "transcript scroll-thin",
    role: "log",
    "aria-live": "polite",
    "aria-relevant": "additions",
  });
  dom.transcript.append(dom.transcriptInner);
  dom.transcript.addEventListener("scroll", updateScrollButton);

  // Scroll-to-bottom affordance.
  dom.scrollBtn = el("button", {
    class: "scroll-bottom",
    type: "button",
    "aria-label": "맨 아래로",
    title: "맨 아래로",
    hidden: "",
    onclick: () => scrollToBottom(true),
  });
  dom.scrollBtn.append(icon("send"));
  dom.scrollBtn.classList.add("rotate-down");

  // --- Composer ---
  dom.textarea = el("textarea", {
    name: "message",
    rows: "1",
    placeholder: "메시지를 입력하세요…  (Enter 전송 · Shift+Enter 줄바꿈)",
    "aria-label": "메시지 입력",
  });
  dom.sendButton = el("button", {
    class: "send-button",
    type: "submit",
    "aria-label": "보내기",
    title: "보내기",
  });
  dom.sendButton.append(icon("send"));

  dom.composerBox = el("div", { class: "composer-box" }, [dom.textarea, dom.sendButton]);

  const composerForm = el(
    "form",
    {
      class: "composer-form",
      onsubmit: (event) => {
        event.preventDefault();
        if (state.streaming) {
          stopStreaming();
        } else {
          submitMessage();
        }
      },
    },
    [
      dom.composerBox,
      el("div", { class: "composer-hint" }, [
        el("span", {}, [
          document.createTextNode("Enter 전송 · "),
          el("kbd", { text: "Shift+Enter" }),
          document.createTextNode(" 줄바꿈"),
        ]),
        el("span", { id: "composer-state", text: "" }),
      ]),
    ],
  );

  const composer = el("footer", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [composerForm]),
  ]);

  const chatBody = el("div", { class: "chat-body" }, [dom.transcript, dom.scrollBtn]);
  const chatCol = el("section", { class: "chat-col" }, [header, chatBody, composer]);

  // --- Drawer + mobile rail backdrop ---
  buildDrawer(owner);
  dom.railBackdrop = el("div", { class: "rail-backdrop", onclick: () => closeRail() });

  app.replaceChildren(
    el("section", { class: "workspace" }, [rail, chatCol]),
    dom.railBackdrop,
    dom.backdrop,
    dom.drawer,
  );
  dom.rail = rail;

  wireComposer();
  syncHeader();
}

/* ============================================================
   Mobile rail (off-canvas conversation sidebar)
   ============================================================ */
function openRail() {
  dom.rail.classList.add("open");
  dom.railBackdrop.classList.add("open");
  document.addEventListener("keydown", onRailKeydown);
}
function closeRail() {
  dom.rail?.classList.remove("open");
  dom.railBackdrop?.classList.remove("open");
  document.removeEventListener("keydown", onRailKeydown);
}
function onRailKeydown(event) {
  if (event.key === "Escape") closeRail();
}

/* ============================================================
   Conversations
   ============================================================ */
async function loadConversations() {
  const result = await api(`/api/conversations?mode=${encodeURIComponent(state.mode)}`);
  state.conversations = result.conversations || [];
}

async function refreshConversations() {
  try {
    await loadConversations();
    renderConversations();
    updateDocTitle();
  } catch {
    /* ignore */
  }
}

function renderConversations() {
  if (!dom.convList) return;
  dom.convList.replaceChildren();
  if (!state.conversations.length) {
    dom.convList.append(el("div", { class: "conv-empty", text: "아직 대화가 없습니다.\n새 채팅으로 시작하세요." }));
    return;
  }
  for (const conv of state.conversations) {
    const active = conv.id === state.conversationId;
    const item = el("div", { class: `conv-item ${active ? "active" : ""}`, dataset: { id: conv.id } });

    const titleBtn = el(
      "button",
      { class: "conv-open", type: "button", title: conv.title, onclick: () => selectConversation(conv.id) },
      [
        el("span", { class: "conv-name", text: conv.title }),
        el("span", { class: "conv-time", text: timeLabel(conv.updatedAt) }),
      ],
    );

    const renameBtn = el("button", {
      class: "conv-act",
      type: "button",
      "aria-label": "이름 변경",
      title: "이름 변경",
      onclick: (e) => {
        e.stopPropagation();
        startRename(item, conv);
      },
    });
    renameBtn.append(icon("edit"));

    const delBtn = el("button", {
      class: "conv-act danger",
      type: "button",
      "aria-label": "삭제",
      title: "삭제",
      onclick: (e) => {
        e.stopPropagation();
        deleteConversation(conv);
      },
    });
    delBtn.append(icon("trash"));

    item.append(titleBtn, el("div", { class: "conv-acts" }, [renameBtn, delBtn]));
    dom.convList.append(item);
  }
}

function newChat() {
  if (state.streaming) return;
  state.conversationId = newId();
  state.messages = [];
  renderTranscript();
  renderConversations();
  updateDocTitle();
  closeRail();
  dom.textarea?.focus();
}

async function selectConversation(id) {
  if (state.streaming) return;
  closeRail();
  if (id === state.conversationId && state.messages.length) return;
  state.conversationId = id;
  try {
    const result = await api(`/api/messages?conversationId=${encodeURIComponent(id)}`);
    state.messages = result.messages || [];
  } catch {
    state.messages = [];
  }
  renderConversations();
  renderTranscript();
  updateDocTitle();
}

function startRename(item, conv) {
  const titleBtn = item.querySelector(".conv-open");
  if (!titleBtn) return;
  item.classList.add("editing"); // hides the action buttons so the input owns the row
  const input = el("input", { class: "conv-rename", value: conv.title, "aria-label": "대화 이름" });
  const onBlur = () => commit(true);
  titleBtn.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const commit = async (save) => {
    if (settled) return;
    settled = true;
    input.removeEventListener("blur", onBlur); // re-render detaches the input; don't re-fire
    const next = input.value.trim(); // capture before any await
    if (save && next && next !== conv.title) {
      try {
        const r = await api(`/api/conversations/${encodeURIComponent(conv.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ title: next }),
        });
        conv.title = r.conversation?.title || next;
      } catch {
        /* keep old title */
      }
    }
    renderConversations();
    updateDocTitle();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", onBlur);
}

async function deleteConversation(conv) {
  if (!window.confirm(`"${conv.title}" 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  if (conv.id === state.conversationId) {
    newChat();
  } else {
    renderConversations();
  }
}

/* ============================================================
   Composer behavior (Enter-to-send + IME guard + auto-grow)
   ============================================================ */
function wireComposer() {
  const ta = dom.textarea;

  const autoGrow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  ta.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });

  ta.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!state.streaming) submitMessage();
    }
  });

  dom.composerBox.addEventListener("focusin", () => dom.composerBox.classList.add("focused"));
  dom.composerBox.addEventListener("focusout", () => dom.composerBox.classList.remove("focused"));

  autoGrow();
  updateSendState();
}

function updateSendState() {
  const hasText = dom.textarea.value.trim().length > 0;
  if (state.streaming) {
    dom.sendButton.disabled = false;
    dom.sendButton.classList.add("is-stop");
    dom.sendButton.setAttribute("aria-label", "중지");
    dom.sendButton.title = "중지";
    dom.sendButton.replaceChildren(icon("stop"));
  } else {
    dom.sendButton.disabled = !hasText;
    dom.sendButton.classList.remove("is-stop");
    dom.sendButton.setAttribute("aria-label", "보내기");
    dom.sendButton.title = "보내기";
    dom.sendButton.replaceChildren(icon("send"));
  }
}

/* ============================================================
   Header / mode sync (no full re-render)
   ============================================================ */
function syncHeader() {
  const copy = modeCopy[state.mode];
  dom.headerTitle.textContent = copy.title;
  dom.headerSub.textContent = copy.sub;

  dom.modeSeg.querySelectorAll("[data-mode]").forEach((btn) => {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });

  syncMarketBadge();
}

function syncMarketBadge() {
  const market = state.marketplace;
  const name = market?.name || state.skills?.marketplace?.name || "marketplace";
  const count = market?.pluginCount ?? market?.plugins?.length;
  let statusClass = "";
  if (market?.registryError) statusClass = "err";
  else if (market?.warnings?.length) statusClass = "warn";

  dom.marketBadge.replaceChildren(
    el("span", { class: `pulse ${statusClass}` }),
    el("span", { text: count != null ? `${name} · 플러그인 ${count}` : name }),
  );
}

/* ============================================================
   Transcript rendering (surgical)
   ============================================================ */
function renderEmptyState() {
  const prompts =
    state.mode === "owner"
      ? [
          ["업무 요약", "오늘 업무 지시를 요약해서 보고해줘"],
          ["상태 확인", "지금 서비스들 정상 작동하고 있는지 확인해줘"],
          ["VM 정리", "우리 과제에서 사용 중인 VM 정보 정리해줘"],
          ["보고 초안", "최근 감사 로그 기준으로 진행 상황 정리해줘"],
        ]
      : [
          ["서비스 상태", "지금 서비스들 정상 작동하고 있는지 확인해줘"],
          ["VM 인벤토리", "우리 과제에서 사용 중인 VM 정보 정리해줘"],
          ["읽기 전용 확인", "현재 확인 가능한 운영 상태만 표로 보여줘"],
          ["최근 결과", "최근 조회된 상태를 요약해줘"],
        ];

  const grid = el("div", { class: "prompt-grid" });
  for (const [label, prompt] of prompts) {
    grid.append(
      el(
        "button",
        {
          class: "prompt-chip",
          type: "button",
          onclick: () => {
            dom.textarea.value = prompt;
            dom.textarea.dispatchEvent(new Event("input"));
            dom.textarea.focus();
          },
        },
        [el("strong", { text: label }), el("span", { text: prompt })],
      ),
    );
  }

  return el("div", { class: "empty-state" }, [
    el("div", { class: "hero" }, [
      el("h3", { text: state.mode === "owner" ? "업무 지시를 시작하세요" : "운영 상태를 바로 확인하세요" }),
      el("p", {
        text:
          state.mode === "owner"
            ? "소유자 모드는 marketplace skill 정책에 따라 작업을 실행하고 결과를 보고합니다. 아래 예시로 시작하거나 직접 지시를 입력하세요."
            : "동료 모드는 초대된 프로젝트 범위 안에서 읽기 전용 skill만 실행합니다. 아래 예시로 빠르게 조회하세요.",
      }),
    ]),
    grid,
  ]);
}

function renderTranscript() {
  dom.transcriptInner.replaceChildren();
  if (!state.messages.length) {
    dom.transcriptInner.append(renderEmptyState());
    updateScrollButton();
    return;
  }
  state.messages.forEach((message, index) => {
    dom.transcriptInner.append(buildMessageNode(message, index === state.messages.length - 1));
  });
  scrollToBottom(true);
}

function buildMessageNode(message, isLast) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "나" : "어시스턴트" }),
      message.createdAt ? el("time", { class: "msg-time", text: timeLabel(message.createdAt) }) : null,
    ]),
  );

  const bubble = el("div", { class: "bubble" });
  if (isUser) {
    bubble.textContent = message.content; // escaped plaintext, line breaks preserved via white-space
  } else {
    renderAssistantInto(bubble, message);
  }
  wrap.append(bubble);
  wrap.append(buildMessageActions(message, isUser, isLast));
  return wrap;
}

function buildMessageActions(message, isUser, isLast) {
  const row = el("div", { class: "msg-actions" });

  const copyBtn = el("button", { class: "msg-act", type: "button", "aria-label": "복사", title: "복사" });
  copyBtn.append(icon("copy"));
  copyBtn.addEventListener("click", () => copyText(message.content || message.response?.text || "", copyBtn));
  row.append(copyBtn);

  if (isUser) {
    const editBtn = el("button", { class: "msg-act", type: "button", "aria-label": "편집", title: "편집 후 다시 보내기" });
    editBtn.append(icon("edit"));
    editBtn.addEventListener("click", () => {
      dom.textarea.value = message.content;
      dom.textarea.dispatchEvent(new Event("input"));
      dom.textarea.focus();
    });
    row.append(editBtn);
  } else if (isLast) {
    const regenBtn = el("button", { class: "msg-act regen", type: "button", "aria-label": "다시 생성", title: "다시 생성" });
    regenBtn.append(icon("refresh"));
    regenBtn.addEventListener("click", () => regenerate());
    row.append(regenBtn);
  }

  return row;
}

function regenerate() {
  if (state.streaming) return;
  const roles = state.messages.map((m) => m.role);
  const lastUser = roles.lastIndexOf("user");
  if (lastUser < 0) return;
  const text = state.messages[lastUser].content;
  // Drop the previous assistant reply (everything after the last user turn).
  state.messages = state.messages.slice(0, lastUser + 1);
  renderTranscript();
  streamChat(text, { regenerate: true });
}

function renderAssistantInto(bubble, message) {
  const response = message.response;
  bubble.classList.toggle("blocked", response?.runtime === "blocked");
  bubble.classList.toggle("errored", response?.runtime === "error" || message.errored === true);

  if (response) {
    const meta = [
      response.runtime && ["runtime", response.runtime],
      response.pluginName && ["plugin", response.pluginName],
      response.skillName && ["skill", response.skillName],
    ].filter(Boolean);
    if (meta.length) {
      const metaRow = el("div", { class: "response-meta" });
      for (const [kind, val] of meta) {
        metaRow.append(el("span", { class: `meta-badge ${kind === "runtime" ? `runtime-${val}` : ""}`, text: val }));
      }
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
  if (response.title || response.summary) {
    wrap.append(el("div", { class: "response-title", text: response.title || response.summary }));
  }
  if (response.title && response.summary && response.title !== response.summary) {
    wrap.append(el("p", { class: "response-summary", text: response.summary }));
  }
  const tableWrap = el("div", { class: "table-wrap" });
  const table = el("table");
  const thead = el("tr");
  for (const c of columns) thead.append(el("th", { text: c }));
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

/* ============================================================
   Scroll handling — auto-scroll only when near bottom
   ============================================================ */
function isNearBottom() {
  const t = dom.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || isNearBottom()) {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }
  updateScrollButton();
}
function updateScrollButton() {
  if (!dom.scrollBtn) return;
  const t = dom.transcript;
  const scrollable = t.scrollHeight - t.clientHeight > 40;
  dom.scrollBtn.hidden = !(scrollable && !isNearBottom());
}

/* ============================================================
   Mode switching (surgical, no shell rebuild)
   ============================================================ */
async function switchMode(mode) {
  if (state.streaming) return;
  if (mode === "owner" && state.user?.role !== "owner") return;
  if (mode === state.mode) return;
  state.mode = mode;
  syncHeader();
  state.conversationId = newId();
  state.messages = [];
  try {
    await loadConversations();
  } catch {
    state.conversations = [];
  }
  renderConversations();
  renderTranscript();
  updateDocTitle();
}

async function logout() {
  // Cancel any in-flight stream so the request (and its server-side SDK run)
  // is torn down rather than left running against a discarded transcript.
  abortController?.abort();
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  sessionExpired = false;
  state.user = null;
  state.messages = [];
  state.conversations = [];
  state.error = "";
  renderLogin();
}

/* ============================================================
   Sending + SSE streaming
   ============================================================ */
async function submitMessage() {
  const message = dom.textarea.value.trim();
  if (!message || state.streaming) return;

  const isNewConversation = !state.messages.length;
  if (isNewConversation) dom.transcriptInner.replaceChildren();

  // The previous reply is no longer the last turn — drop its regenerate button.
  dom.transcriptInner.querySelectorAll(".msg-act.regen").forEach((b) => b.remove());

  const userMsg = { role: "user", content: message, createdAt: new Date().toISOString() };
  state.messages.push(userMsg);
  dom.transcriptInner.append(buildMessageNode(userMsg, false));

  dom.textarea.value = "";
  dom.textarea.style.height = "auto";
  scrollToBottom(true);

  await streamChat(message, { isNewConversation });
}

async function streamChat(message, { isNewConversation = false, regenerate = false } = {}) {
  state.streaming = true;
  updateSendState();
  setComposerState("응답 대기 중…");
  dom.transcript.setAttribute("aria-busy", "true");
  updateDocTitle();

  // Live assistant bubble scaffold.
  const bubble = el("div", { class: "bubble" });
  const mdNode = el("div", { class: "md" });
  const caret = el("span", { class: "stream-caret", "aria-hidden": "true" });
  const statusRow = el("div", { class: "stream-status" }, [
    el("span", { class: "spinner" }),
    el("span", { class: "label", text: "준비 중…" }),
  ]);
  const pluginChips = el("div", { class: "plugin-chips" });
  bubble.append(mdNode, caret, statusRow, pluginChips);

  const wrap = el("div", { class: "message assistant" }, [
    el("div", { class: "msg-role" }, [el("span", { class: "role-dot" }), el("span", { text: "어시스턴트" })]),
    bubble,
  ]);
  dom.transcriptInner.append(wrap);
  scrollToBottom(true);

  const live = {
    wrap,
    bubble,
    mdNode,
    caret,
    statusRow,
    statusLabel: statusRow.querySelector(".label"),
    pluginChips,
    text: "",
    rafPending: false,
    done: false,
    aborted: false,
    isNewConversation,
  };

  const flush = () => {
    live.rafPending = false;
    live.mdNode.innerHTML = renderMarkdown(live.text);
    scrollToBottom();
  };
  const scheduleFlush = () => {
    if (live.rafPending) return;
    live.rafPending = true;
    requestAnimationFrame(flush);
  };

  abortController = new AbortController();

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: abortController.signal,
      body: JSON.stringify({ mode: state.mode, message, conversationId: state.conversationId, regenerate }),
    });

    if (response.status === 401) {
      handleSessionExpired();
      return;
    }
    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }

    await consumeSse(response.body, (event, data) => handleSseEvent(event, data, live, scheduleFlush));
  } catch (error) {
    if (error.name === "AbortError" || live.aborted) {
      finalizeStopped(live);
    } else {
      finalizeError(live, error.message || "스트리밍 오류가 발생했습니다.");
      // Pure connection failure (nothing streamed): restore the prompt so the
      // user can retry without retyping.
      if (!live.text && dom.textarea && !dom.textarea.value) {
        dom.textarea.value = message;
        dom.textarea.dispatchEvent(new Event("input"));
      }
    }
  } finally {
    if (!live.done) {
      if (live.aborted) finalizeStopped(live);
      else if (!live.text) finalizeError(live, "연결이 종료되었습니다.");
      else finalizeStopped(live);
    }
    state.streaming = false;
    abortController = null;
    updateSendState();
    setComposerState("");
    dom.transcript.setAttribute("aria-busy", "false");
    updateDocTitle();
    dom.textarea.focus();
  }
}

/* Manual SSE frame parser: split on \n\n, parse event:/data: lines. */
async function consumeSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseFrame(rawFrame);
      if (frame) onEvent(frame.event, frame.data);
    }
  }
}

function parseFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = { text: dataStr };
  }
  return { event, data };
}

function handleSseEvent(event, data, live, scheduleFlush) {
  switch (event) {
    case "open":
      if (data?.conversationId) state.conversationId = data.conversationId;
      setStatus(live, data?.runtime === "local" ? "로컬 런타임 준비 중…" : "Claude 준비 중…");
      break;
    case "status":
      if (data?.label) setStatus(live, data.label);
      break;
    case "plugin":
      handlePluginEvent(live, data);
      break;
    case "tool":
      if (data?.name) setStatus(live, `도구 실행 중: ${data.name}`);
      break;
    case "delta":
      if (typeof data?.text === "string") {
        live.text += data.text;
        scheduleFlush();
      }
      break;
    case "done":
      finalizeDone(live, data);
      break;
    case "error":
      finalizeError(live, data?.error || "오류가 발생했습니다.");
      break;
    default:
      break;
  }
}

function setStatus(live, label) {
  if (live.statusLabel) live.statusLabel.textContent = label;
}

function handlePluginEvent(live, data) {
  if (!data?.name) return;
  const status = data.status || "started";
  let chip = live.pluginChips.querySelector(`[data-plugin="${cssEscape(data.name)}"]`);
  if (!chip) {
    chip = el("span", { class: "plugin-chip", dataset: { plugin: data.name } }, [
      el("span", { class: "pc-dot" }),
      el("span", { class: "pc-text", text: data.name }),
    ]);
    live.pluginChips.append(chip);
  }
  chip.dataset.status = status;
  const labelMap = { started: "설치 중", installed: "설치됨", completed: "로드됨", failed: "실패" };
  chip.querySelector(".pc-text").textContent = `${data.name} · ${labelMap[status] || status}`;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function setComposerState(text) {
  const node = document.querySelector("#composer-state");
  if (node) node.textContent = text;
}

function cleanupLive(live) {
  live.caret.remove();
  live.statusRow.remove();
  if (!live.pluginChips.children.length) live.pluginChips.remove();
}

function finalizeDone(live, data) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  const message = data?.message || {
    role: "assistant",
    content: data?.response?.text || data?.response?.summary || live.text,
    response: data?.response,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  // Replace bubble content with authoritative render (tables, meta, etc.).
  live.bubble.replaceChildren();
  live.bubble.className = "bubble";
  renderAssistantInto(live.bubble, message);
  // Attach per-message actions (this is now the last message).
  live.wrap.append(buildMessageActions(message, false, true));
  scrollToBottom();
  loadAudit().catch(() => {});
  // Refresh the sidebar so a new conversation gets its title and an existing one
  // moves to the top with an updated timestamp.
  refreshConversations();
}

function finalizeError(live, msg) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  live.bubble.classList.add("errored");
  if (live.text) {
    live.mdNode.innerHTML = renderMarkdown(live.text);
    enhanceCodeBlocks(live.mdNode);
  } else {
    live.mdNode.remove();
  }
  live.bubble.append(
    el("div", { class: "response-meta" }, [el("span", { class: "meta-badge runtime-error", text: "오류" })]),
  );
  live.bubble.append(el("div", { class: "md", text: msg }));
  state.messages.push({
    role: "assistant",
    content: live.text ? `${live.text}\n\n${msg}` : msg,
    errored: true,
    response: { kind: "text", runtime: "error", summary: "오류", text: live.text || msg },
  });
}

function finalizeStopped(live) {
  if (live.done) return;
  live.done = true;
  live.aborted = true;
  cleanupLive(live);
  live.mdNode.innerHTML = renderMarkdown(live.text);
  enhanceCodeBlocks(live.mdNode);
  live.bubble.append(
    el("div", { class: "stream-status" }, [el("span", { class: "label", text: "· 사용자가 중지함" })]),
  );
  state.messages.push({
    role: "assistant",
    content: live.text || "(중지됨)",
    response: { kind: "text", runtime: "claude", summary: "중지됨", text: live.text },
  });
}

function stopStreaming() {
  if (abortController) abortController.abort();
}

/* ============================================================
   Settings drawer
   ============================================================ */
function buildDrawer(owner) {
  dom.backdrop = el("div", { class: "drawer-backdrop", onclick: () => closeDrawer() });

  const tabs = [
    { id: "market", label: "마켓플레이스 · 플러그인" },
    { id: "skills", label: "스킬" },
    owner ? { id: "invites", label: "초대" } : null,
    { id: "audit", label: "감사 로그" },
  ].filter(Boolean);

  dom.drawerTabs = el("div", { class: "drawer-tabs", role: "tablist" });
  dom.drawerPanels = {};
  const panelsWrap = el("div", { class: "drawer-body scroll-thin" });

  for (const tab of tabs) {
    const btn = el("button", {
      class: "drawer-tab",
      type: "button",
      role: "tab",
      id: `tab-${tab.id}`,
      "aria-controls": `panel-${tab.id}`,
      tabindex: "-1",
      dataset: { tab: tab.id },
      text: tab.label,
      onclick: () => selectTab(tab.id),
    });
    dom.drawerTabs.append(btn);

    const panel = el("div", {
      class: "drawer-panel",
      dataset: { panel: tab.id },
      role: "tabpanel",
      id: `panel-${tab.id}`,
      "aria-labelledby": `tab-${tab.id}`,
      tabindex: "0",
    });
    dom.drawerPanels[tab.id] = panel;
    panelsWrap.append(panel);
  }

  // Roving arrow-key navigation across the tablist.
  dom.drawerTabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const btns = [...dom.drawerTabs.querySelectorAll(".drawer-tab")];
    const current = btns.findIndex((b) => b.classList.contains("active"));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = btns[(current + delta + btns.length) % btns.length];
    if (next) {
      selectTab(next.dataset.tab);
      next.focus();
    }
  });

  const closeBtn = el("button", {
    class: "drawer-close",
    type: "button",
    "aria-label": "설정 닫기",
    onclick: () => closeDrawer(),
  });
  closeBtn.append(icon("close"));

  dom.drawer = el(
    "aside",
    { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "설정", hidden: "" },
    [el("div", { class: "drawer-header" }, [el("h2", { text: "설정" }), closeBtn]), dom.drawerTabs, panelsWrap],
  );

  selectTab("market", false);
}

function selectTab(id, render = true) {
  dom.drawerTabs.querySelectorAll(".drawer-tab").forEach((btn) => {
    const active = btn.dataset.tab === id;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });
  for (const [pid, panel] of Object.entries(dom.drawerPanels)) {
    panel.classList.toggle("active", pid === id);
  }
  if (render) renderPanel(id);
}

function openDrawer(tab) {
  dom.drawerOpener = document.activeElement;
  dom.drawer.hidden = false;
  document.querySelector(".workspace")?.setAttribute("aria-hidden", "true");
  requestAnimationFrame(() => {
    dom.backdrop.classList.add("open");
    dom.drawer.classList.add("open");
  });
  if (tab) selectTab(tab);
  else {
    const active = dom.drawerTabs.querySelector(".drawer-tab.active")?.dataset.tab || "market";
    renderPanel(active);
  }
  document.addEventListener("keydown", onDrawerKeydown);
  dom.drawer.querySelector(".drawer-tab.active")?.focus();
}

function closeDrawer() {
  dom.backdrop.classList.remove("open");
  dom.drawer.classList.remove("open");
  document.removeEventListener("keydown", onDrawerKeydown);
  document.querySelector(".workspace")?.removeAttribute("aria-hidden");
  const opener = dom.drawerOpener;
  if (opener && typeof opener.focus === "function") opener.focus();
  setTimeout(() => {
    if (!dom.drawer.classList.contains("open")) dom.drawer.hidden = true;
  }, 320);
}

function drawerFocusables() {
  return [
    ...dom.drawer.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((node) => node.offsetParent !== null || node === document.activeElement);
}

function onDrawerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key === "Tab") {
    const focusables = drawerFocusables();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dom.drawer.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dom.drawer.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
}

function renderPanel(id) {
  const panel = dom.drawerPanels[id];
  if (!panel) return;
  if (id === "market") renderMarketPanel(panel);
  else if (id === "skills") renderSkillsPanel(panel);
  else if (id === "invites") renderInvitesPanel(panel);
  else if (id === "audit") renderAuditPanel(panel);
}

/* ---------- Marketplace panel ---------- */
function renderMarketPanel(panel) {
  panel.replaceChildren();
  const market = state.marketplace;

  const isOwner = state.user?.role === "owner";
  let headAction;
  if (isOwner) {
    const refreshBtn = el("button", { class: "refresh-btn", type: "button", title: "마켓플레이스 다시 동기화" });
    refreshBtn.append(icon("refresh"), el("span", { text: "다시 동기화" }));
    refreshBtn.addEventListener("click", () => refreshMarketplace(refreshBtn, panel));
    headAction = refreshBtn;
  } else {
    headAction = el("span", { class: "tag", text: "소유자가 동기화를 관리합니다" });
  }

  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "마켓플레이스 · 플러그인" }),
        el("p", { text: "부팅 시 자동으로 로드된 Claude 플러그인 상태입니다." }),
      ]),
      headAction,
    ]),
  );

  if (!market) {
    panel.append(el("div", { class: "empty-note", text: "마켓플레이스 정보를 불러오는 중…" }));
    loadMarketplace()
      .then(() => {
        if (dom.drawerPanels.market?.classList.contains("active")) renderMarketPanel(dom.drawerPanels.market);
        syncMarketBadge();
      })
      .catch((err) => {
        panel
          .querySelector(".empty-note")
          ?.replaceWith(el("div", { class: "warn-box", text: `상태를 불러오지 못했습니다: ${err.message}` }));
      });
    return;
  }

  panel.append(
    el("div", { class: "market-meta" }, [
      el("div", { class: "market-summary" }, [
        el("span", { class: "tag accent", text: market.name || "marketplace" }),
        el("span", { class: "tag", text: `플러그인 ${market.pluginCount ?? market.plugins?.length ?? 0}개` }),
      ]),
    ]),
  );

  if (market.registryError) {
    panel.append(el("div", { class: "warn-box", text: `레지스트리 오류: ${market.registryError}` }));
  }
  if (market.warnings?.length) {
    panel.append(el("div", { class: "warn-box", text: market.warnings.join("\n") }));
  }

  const cards = el("div", { class: "plugin-cards" });
  const plugins = market.plugins || [];
  if (!plugins.length) {
    cards.append(el("div", { class: "empty-note", text: "로드된 플러그인이 없습니다." }));
  }
  for (const plugin of plugins) {
    cards.append(buildPluginCard(plugin));
  }
  panel.append(cards);
}

function buildPluginCard(plugin) {
  const owner = state.user?.role === "owner";
  const card = el("div", { class: "plugin-card" }, [
    el("div", { class: "plugin-card-head" }, [
      el("span", { class: "pc-name", text: plugin.name }),
      plugin.version ? el("span", { class: "pc-version", text: `v${plugin.version}` }) : null,
    ]),
  ]);
  if (plugin.description) card.append(el("p", { class: "pc-desc", text: plugin.description }));

  const tags = el("div", { class: "pc-tags" });
  if (typeof plugin.commandCount === "number") {
    tags.append(el("span", { class: "tag", text: `명령 ${plugin.commandCount}개` }));
  }
  if (plugin.source) {
    const src = typeof plugin.source === "string" ? plugin.source : plugin.source.source || "source";
    tags.append(el("span", { class: "tag", text: src }));
  }
  const access = pluginAccess(plugin.name);
  if (access) tags.append(el("span", { class: `tag ${access.cls}`, text: access.label }));
  for (const t of plugin.tags || []) tags.append(el("span", { class: "tag", text: t }));
  if (!owner) tags.append(el("span", { class: "tag", text: "조회 전용" }));
  card.append(tags);
  return card;
}

function pluginAccess(name) {
  const skillsPlugin = (state.skills?.plugins || []).find((p) => p.name === name);
  if (!skillsPlugin) return null;
  const cmds = skillsPlugin.commands || [];
  if (!cmds.length) return null;
  const hasWrite = cmds.some((c) => c.readOnly === false);
  return hasWrite ? { cls: "write", label: "owner 작업 포함" } : { cls: "read", label: "read-only" };
}

async function refreshMarketplace(btn, panel) {
  if (state.user?.role !== "owner") return;
  btn.classList.add("loading");
  btn.disabled = true;
  const labelNode = btn.querySelector("span");
  const prev = labelNode.textContent;
  labelNode.textContent = "동기화 중…";
  try {
    const result = await api("/api/marketplace/refresh", { method: "POST" });
    state.marketplace = result;
    try {
      await loadSkills();
    } catch {
      /* ignore */
    }
    renderMarketPanel(panel);
    syncMarketBadge();
  } catch (error) {
    btn.classList.remove("loading");
    btn.disabled = false;
    labelNode.textContent = prev;
    panel.append(el("div", { class: "warn-box", text: `동기화 실패: ${error.message}` }));
  }
}

/* ---------- Skills panel ---------- */
function renderSkillsPanel(panel) {
  panel.replaceChildren();
  const plugins = state.skills?.plugins || [];
  const items = plugins.flatMap((plugin) => (plugin.commands || []).map((command) => ({ plugin: plugin.name, command })));

  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "사용 가능한 스킬" }),
        el("p", { text: "현재 모드에서 실행 가능한 marketplace 스킬입니다." }),
      ]),
      el("span", { class: "tag accent", text: `${items.length}개` }),
    ]),
  );

  if (!items.length) {
    panel.append(el("div", { class: "empty-note", text: "현재 모드에서 보이는 스킬이 없습니다." }));
    return;
  }

  const list = el("ul", { class: "skill-list" });
  for (const { plugin, command } of items) {
    list.append(
      el("li", { class: "skill-item" }, [
        el("strong", { text: `${plugin}:${command.name}` }),
        el("p", { text: command.description || "" }),
        el("div", { class: "tags" }, [
          el("span", { class: `tag ${command.readOnly ? "read" : "write"}`, text: command.readOnly ? "read-only" : "write" }),
          el("span", { class: "tag", text: command.projectScoped ? "project-scoped" : "owner-only" }),
        ]),
      ]),
    );
  }
  panel.append(list);
}

/* ---------- Invites panel ---------- */
function inviteStatus(invite) {
  if (invite.revokedAt) return { cls: "blocked", label: "취소됨" };
  if (invite.uses >= invite.maxUses) return { cls: "warn", label: "소진됨" };
  return { cls: "ok", label: "활성" };
}

function renderInvitesPanel(panel) {
  panel.replaceChildren();
  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [el("h3", { text: "초대" }), el("p", { text: "팀원 초대 코드를 발급하고 관리합니다." })]),
    ]),
  );

  // Existing invites list.
  const listWrap = el("div", { class: "invite-list" });
  panel.append(listWrap);
  renderInviteList(listWrap);
  loadInvites()
    .then(() => renderInviteList(listWrap))
    .catch(() => {
      listWrap.replaceChildren(el("div", { class: "empty-note", text: "초대 목록을 불러오지 못했습니다." }));
    });

  // Create form.
  const result = el("div", {});
  const form = el(
    "form",
    {
      class: "form-stack invite-form",
      onsubmit: async (event) => {
        event.preventDefault();
        const fd = new FormData(event.currentTarget);
        const btn = event.currentTarget.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          const res = await api("/api/invites", {
            method: "POST",
            body: JSON.stringify({
              label: fd.get("label"),
              role: fd.get("role"),
              projectScope: fd.get("projectScope"),
              maxUses: Number(fd.get("maxUses")),
            }),
          });
          const code = res.invite.code;
          const copyBtn = el("button", { class: "ghost-sm", type: "button", text: "복사" });
          copyBtn.addEventListener("click", () => copyText(code, copyBtn));
          result.replaceChildren(
            el("div", { class: "invite-created" }, [
              el("div", { class: "invite-result", text: code }),
              copyBtn,
            ]),
          );
          await loadInvites().catch(() => {});
          renderInviteList(listWrap);
          await loadAudit().catch(() => {});
        } catch (error) {
          result.replaceChildren(el("div", { class: "warn-box", text: error.message }));
        } finally {
          btn.disabled = false;
        }
      },
    },
    [
      el("div", { class: "form-sub", text: "새 초대 만들기" }),
      el("label", { class: "field" }, [el("span", { text: "라벨" }), el("input", { name: "label", value: "팀원 초대" })]),
      el("label", { class: "field" }, [
        el("span", { text: "역할" }),
        el("select", { name: "role" }, [
          el("option", { value: "colleague", text: "동료" }),
          el("option", { value: "owner", text: "소유자" }),
        ]),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "프로젝트 범위" }),
        el("input", { name: "projectScope", value: state.user?.projectScope || "default-project" }),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "사용 횟수" }),
        el("input", { name: "maxUses", type: "number", min: "1", max: "500", value: "5" }),
      ]),
      el("button", { class: "primary", type: "submit", text: "초대 코드 만들기" }),
    ],
  );
  panel.append(form, result);
}

function renderInviteList(listWrap) {
  listWrap.replaceChildren();
  const invites = state.invites || [];
  if (!invites.length) {
    listWrap.append(el("div", { class: "empty-note", text: "발급된 초대가 없습니다." }));
    return;
  }
  for (const invite of invites) {
    const status = inviteStatus(invite);
    const canRevoke = !invite.revokedAt;
    const item = el("div", { class: "invite-item" }, [
      el("div", { class: "invite-item-main" }, [
        el("strong", { text: invite.label || "초대" }),
        el("div", { class: "invite-tags" }, [
          el("span", { class: `tag ${invite.role === "owner" ? "write" : "read"}`, text: invite.role === "owner" ? "소유자" : "동료" }),
          el("span", { class: "tag", text: invite.projectScope }),
          el("span", { class: "tag", text: `${invite.uses}/${invite.maxUses}회` }),
          el("span", { class: `tag ${status.cls === "ok" ? "accent" : status.cls === "warn" ? "write" : "read"}`, text: status.label }),
          invite.codePreview ? el("span", { class: "tag mono", text: `…${invite.codePreview}` }) : null,
        ]),
      ]),
    ]);
    if (canRevoke) {
      const revokeBtn = el("button", { class: "ghost-sm danger", type: "button", text: "취소" });
      revokeBtn.addEventListener("click", () => revokeInvite(invite, listWrap, revokeBtn));
      item.append(revokeBtn);
    }
    listWrap.append(item);
  }
}

async function revokeInvite(invite, listWrap, btn) {
  if (!window.confirm(`"${invite.label}" 초대를 취소할까요?`)) return;
  btn.disabled = true;
  try {
    await api(`/api/invites/${encodeURIComponent(invite.id)}/revoke`, { method: "POST" });
    await loadInvites().catch(() => {});
    renderInviteList(listWrap);
    await loadAudit().catch(() => {});
  } catch (error) {
    btn.disabled = false;
    listWrap.append(el("div", { class: "warn-box", text: `취소 실패: ${error.message}` }));
  }
}

/* ---------- Audit panel ---------- */
function renderAuditPanel(panel) {
  panel.replaceChildren();
  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [el("h3", { text: "감사 로그" }), el("p", { text: "최근 활동 기록입니다." })]),
    ]),
  );

  const events = state.audit.slice(0, 40);
  if (!events.length) {
    panel.append(el("div", { class: "empty-note", text: "아직 로그가 없습니다." }));
    return;
  }
  const list = el("ul", { class: "audit-list" });
  for (const event of events) {
    list.append(
      el("li", { class: `audit-item ${event.status}` }, [
        el("strong", { text: `${event.action} · ${event.mode}` }),
        el("p", { text: event.detail || "" }),
        event.createdAt ? el("time", { text: timeLabel(event.createdAt) }) : null,
      ]),
    );
  }
  panel.append(list);
}

/* ============================================================
   Data loaders
   ============================================================ */
async function loadSkills() {
  state.skills = await api("/api/skills");
}
async function loadAudit() {
  const result = await api("/api/audit");
  state.audit = result.audit || [];
  if (dom.drawerPanels?.audit?.classList.contains("active")) {
    renderAuditPanel(dom.drawerPanels.audit);
  }
}
async function loadInvites() {
  const result = await api("/api/invites");
  state.invites = result.invites || [];
}
async function loadMarketplace() {
  state.marketplace = await api("/api/marketplace/status");
}

async function hydrate() {
  await Promise.all([loadSkills().catch(() => {}), loadAudit().catch(() => {}), loadConversations().catch(() => {})]);
  // If the session expired during the parallel loads, handleSessionExpired has
  // already switched to the login view — don't clobber it by mounting.
  if (!state.user || sessionExpired) return;
  mountWorkspace();
  renderConversations();

  // Resume the most recent conversation, else start fresh.
  const recent = state.conversations[0];
  if (recent) {
    state.conversationId = recent.id;
    try {
      const result = await api(`/api/messages?conversationId=${encodeURIComponent(recent.id)}`);
      state.messages = result.messages || [];
    } catch {
      state.messages = [];
    }
    renderConversations();
  } else {
    state.conversationId = newId();
    state.messages = [];
  }
  renderTranscript();
  updateDocTitle();

  // Warm marketplace status in background for the header badge + drawer.
  loadMarketplace()
    .then(() => syncMarketBadge())
    .catch(() => {});
}

async function boot() {
  renderBootSkeleton();
  state.bootstrap = await api("/api/bootstrap").catch(() => null);
  const me = await api("/api/me");
  state.user = me.user;
  if (!state.user) {
    renderLogin();
    return;
  }
  state.mode = state.user.role === "owner" ? "owner" : "colleague";
  await hydrate();
}

// Close the off-canvas rail (and its backdrop) when leaving the mobile breakpoint.
if (window.matchMedia) {
  const mq = window.matchMedia("(min-width: 861px)");
  const onChange = () => {
    if (mq.matches) closeRail();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

boot().catch((error) => {
  state.error = error.message;
  renderLogin();
});
