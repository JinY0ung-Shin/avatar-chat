import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const app = document.querySelector("#app");

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const state = {
  user: null,
  view: "explore", // explore | chat | settings | admin
  avatars: [],
  currentAvatar: null, // avatar being chatted with
  conversations: [],
  conversationId: newId(),
  messages: [],
  plugins: [],
  adminUsers: [],
  audit: [],
  streaming: false,
  authError: "",
};

const dom = {};
let abortController = null;
let sessionExpired = false;

/* ============================================================ Networking */
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
  });
  if (response.status === 401 && state.user) {
    handleSessionExpired();
    throw new Error("세션이 만료되었습니다.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function handleSessionExpired() {
  if (sessionExpired) return;
  sessionExpired = true;
  abortController?.abort();
  state.user = null;
  state.authError = "세션이 만료되었습니다. 다시 로그인해 주세요.";
  renderAuth();
}

/* ============================================================ DOM helpers */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const paths = {
    compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    gear: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
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

function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    const wrapper = el("div", { class: "code-block" });
    pre.replaceWith(wrapper);
    wrapper.append(pre);
    const btn = el("button", { class: "code-copy", type: "button", "aria-label": "코드 복사", title: "복사" });
    btn.append(icon("copy"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(pre.querySelector("code")?.innerText ?? pre.innerText, btn);
    });
    wrapper.append(btn);
  });
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
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
    /* ignore */
  }
}

function flashCopied(btn) {
  if (!btn) return;
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
    return new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/* ============================================================ Avatar image */
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}
function paintGenerated(wrap, person) {
  const seed = person.id || person.username || person.displayName || "a";
  const h = hashHue(seed);
  wrap.style.background = `linear-gradient(135deg, hsl(${h} 58% 52%), hsl(${(h + 48) % 360} 64% 42%))`;
  wrap.style.color = "#fff";
  wrap.textContent = (person.displayName || person.username || "?").trim().charAt(0).toUpperCase();
}
function avatarNode(person, size = 40) {
  const wrap = el("div", {
    class: "avatar-img",
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
  });
  if (person?.hasImage && person.id) {
    const img = el("img", { src: `/api/users/${person.id}/avatar-image`, alt: person.displayName || person.username || "" });
    img.addEventListener("error", () => {
      img.remove();
      paintGenerated(wrap, person);
    });
    wrap.append(img);
  } else {
    paintGenerated(wrap, person);
  }
  return wrap;
}

async function resizeImage(file, max = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ============================================================ Auth view */
function renderAuth(mode = "login") {
  abortController?.abort();
  abortController = null;
  state.streaming = false;
  document.title = "Avatar Chat";

  const isLogin = mode === "login";
  const isSetup = mode === "setup";
  const form = el("form", {
    class: "form-stack",
    onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const btn = event.currentTarget.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const path = isLogin ? "/api/auth/login" : "/api/auth/signup";
        const payload = isLogin
          ? { username: fd.get("username"), password: fd.get("password") }
          : { username: fd.get("username"), displayName: fd.get("displayName"), password: fd.get("password") };
        const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
        sessionExpired = false;
        state.user = result.user;
        state.authError = "";
        await enterApp();
      } catch (error) {
        state.authError = error.message;
        renderAuth(mode);
      }
    },
  });

  const fields = [];
  fields.push(
    el("label", { class: "field" }, [
      el("span", { text: "아이디" }),
      el("input", { name: "username", autocomplete: "username", placeholder: "user123", required: "", minlength: "3" }),
    ]),
  );
  if (!isLogin) {
    fields.push(
      el("label", { class: "field" }, [
        el("span", { text: "표시 이름" }),
        el("input", { name: "displayName", autocomplete: "nickname", placeholder: "홍길동", required: "" }),
      ]),
    );
  }
  fields.push(
    el("label", { class: "field" }, [
      el("span", { text: "비밀번호" }),
      el("input", {
        name: "password",
        type: "password",
        autocomplete: isLogin ? "current-password" : "new-password",
        placeholder: isLogin ? "비밀번호" : "8자 이상",
        required: "",
        minlength: "8",
      }),
    ]),
  );
  fields.push(el("button", { class: "primary", type: "submit", text: isLogin ? "로그인" : isSetup ? "관리자 계정 만들기" : "가입하기" }));
  form.append(...fields);

  app.replaceChildren(
    el("section", { class: "auth-view" }, [
      el("div", { class: "auth-panel" }, [
        el("div", { class: "login-mark", text: "A" }),
        isSetup ? el("div", { class: "setup-badge", text: "첫 실행 · 관리자 설정" }) : null,
        el("h1", { text: isSetup ? "관리자 계정 생성" : isLogin ? "다시 오신 걸 환영해요" : "Avatar Chat 시작하기" }),
        el("p", {
          text: isSetup
            ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
            : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.",
        }),
        state.authError ? el("div", { class: "error", text: state.authError }) : null,
        form,
        isSetup
          ? null
          : el("div", { class: "auth-switch" }, [
              el("span", { text: isLogin ? "계정이 없으신가요? " : "이미 계정이 있으신가요? " }),
              el("button", {
                class: "linkish",
                type: "button",
                text: isLogin ? "회원가입" : "로그인",
                onclick: () => {
                  state.authError = "";
                  renderAuth(isLogin ? "signup" : "login");
                },
              }),
            ]),
      ]),
    ]),
  );
  app.querySelector('input[name="username"]')?.focus();
}

/* ============================================================ App shell */
function mountShell() {
  const admin = state.user.roles?.includes("admin");

  dom.navButtons = {};
  const nav = el("nav", { class: "rail-nav" });
  const navItem = (view, label, ic) => {
    const btn = el("button", { class: "nav-item", type: "button", dataset: { view }, onclick: () => goView(view) }, [
      icon(ic),
      el("span", { text: label }),
    ]);
    dom.navButtons[view] = btn;
    nav.append(btn);
    return btn;
  };
  navItem("explore", "탐색", "compass");
  navItem("chat", "채팅", "chat");
  navItem("settings", "내 아바타", "user");
  if (admin) navItem("admin", "관리자", "shield");

  dom.convList = el("div", { class: "conv-list scroll-thin" });

  const meRow = el("button", { class: "rail-me", type: "button", title: "내 아바타 설정", onclick: () => goView("settings") }, [
    avatarNode(state.user, 34),
    el("div", { class: "meta" }, [
      el("b", { text: state.user.displayName }),
      el("span", { text: `@${state.user.username}` }),
    ]),
  ]);
  const logoutBtn = el("button", { class: "icon-button", type: "button", "aria-label": "로그아웃", title: "로그아웃", onclick: logout });
  logoutBtn.append(icon("logout"));

  const rail = el("aside", { class: "rail", id: "rail" }, [
    el("div", { class: "rail-head" }, [
      el("div", { class: "rail-brand" }, [
        el("div", { class: "mark", text: "A" }),
        el("div", {}, [el("div", { class: "name", text: "Avatar Chat" }), el("div", { class: "sub", text: "avatar platform" })]),
      ]),
      nav,
    ]),
    el("div", { class: "rail-history" }, [
      el("div", { class: "rail-section-label", text: "내 대화" }),
      dom.convList,
    ]),
    el("div", { class: "rail-footer" }, [el("div", { class: "rail-user-row" }, [meRow, logoutBtn])]),
  ]);

  const railToggle = el("button", { class: "icon-button rail-toggle", type: "button", "aria-label": "메뉴", title: "메뉴", onclick: () => openRail() });
  railToggle.append(icon("menu"));
  dom.railToggle = railToggle;

  dom.main = el("main", { class: "main", id: "main" });
  dom.railBackdrop = el("div", { class: "rail-backdrop", onclick: () => closeRail() });

  app.replaceChildren(el("section", { class: "workspace" }, [rail, dom.main]), dom.railBackdrop);
  dom.rail = rail;
}

function openRail() {
  dom.rail.classList.add("open");
  dom.railBackdrop.classList.add("open");
}
function closeRail() {
  dom.rail?.classList.remove("open");
  dom.railBackdrop?.classList.remove("open");
}

function goView(view) {
  if (state.streaming && view !== "chat") return;
  state.view = view;
  closeRail();
  renderView();
}

function syncNav() {
  for (const [view, btn] of Object.entries(dom.navButtons)) {
    btn.classList.toggle("active", view === state.view);
  }
}

function renderView() {
  syncNav();
  dom.main.replaceChildren();
  if (state.view === "explore") renderExplore();
  else if (state.view === "chat") renderChat();
  else if (state.view === "settings") renderSettings();
  else if (state.view === "admin") renderAdmin();
}

function viewHeader(title, sub, extra) {
  const left = el("div", { class: "header-left" }, [
    dom.railToggle,
    el("div", { class: "title" }, [el("h2", { text: title }), sub ? el("p", { text: sub }) : null]),
  ]);
  return el("header", { class: "view-header" }, [left, extra || el("div", {})]);
}

/* ============================================================ Explore view */
async function renderExplore() {
  const header = viewHeader("탐색", "공개된 아바타와 대화를 시작하세요");
  const grid = el("div", { class: "avatar-grid" });
  const body = el("div", { class: "view-body scroll-thin" }, [grid]);
  dom.main.append(header, body);

  grid.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  try {
    await loadAvatars();
  } catch {
    /* ignore */
  }
  grid.replaceChildren();
  if (!state.avatars.length) {
    grid.append(el("div", { class: "empty-note", text: "공개된 아바타가 아직 없습니다." }));
    return;
  }
  for (const av of state.avatars) {
    grid.append(buildAvatarCard(av));
  }
}

function buildAvatarCard(av) {
  const isMe = av.id === state.user.id;
  const card = el("button", { class: "avatar-card", type: "button", onclick: () => startChatWith(av) }, [
    avatarNode(av, 56),
    el("div", { class: "ac-body" }, [
      el("div", { class: "ac-name" }, [
        el("strong", { text: av.displayName }),
        isMe ? el("span", { class: "tag accent", text: "나" }) : null,
        av.published ? null : el("span", { class: "tag", text: "비공개" }),
      ]),
      el("div", { class: "ac-handle", text: `@${av.username}` }),
      av.bio ? el("p", { class: "ac-bio", text: av.bio }) : null,
      el("div", { class: "ac-tags" }, [el("span", { class: "tag", text: `플러그인 ${av.pluginCount}개` })]),
    ]),
  ]);
  return card;
}

async function startChatWith(av) {
  state.currentAvatar = av;
  state.conversationId = newId();
  state.messages = [];
  state.view = "chat";
  renderView();
  await refreshConversations();
}

/* ============================================================ Chat view */
function renderChat() {
  if (!state.currentAvatar) {
    const header = viewHeader("채팅", "탐색에서 아바타를 골라 대화를 시작하세요");
    dom.main.append(
      header,
      el("div", { class: "view-body" }, [
        el("div", { class: "empty-state" }, [
          el("div", { class: "hero" }, [
            el("h3", { text: "아직 선택한 아바타가 없어요" }),
            el("p", { text: "탐색 탭에서 대화할 아바타를 선택하세요." }),
          ]),
          el("button", { class: "primary", type: "button", text: "아바타 탐색", onclick: () => goView("explore") }),
        ]),
      ]),
    );
    return;
  }

  const av = state.currentAvatar;
  const headerExtra = el("div", { class: "chat-avatar" }, [
    avatarNode(av, 36),
    el("div", {}, [
      el("div", { class: "ca-name", text: av.displayName }),
      el("div", { class: "ca-handle", text: `@${av.username} · 읽기전용` }),
    ]),
  ]);
  const header = el("header", { class: "view-header chat-head" }, [
    el("div", { class: "header-left" }, [dom.railToggle, headerExtra]),
    el("button", { class: "ghost-sm", type: "button", text: "새 대화", onclick: () => newChat() }),
  ]);

  dom.transcriptInner = el("div", { class: "transcript-inner" });
  dom.transcript = el("div", { class: "transcript scroll-thin", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  dom.transcript.append(dom.transcriptInner);
  dom.transcript.addEventListener("scroll", updateScrollButton);

  dom.scrollBtn = el("button", { class: "scroll-bottom rotate-down", type: "button", "aria-label": "맨 아래로", title: "맨 아래로", hidden: "", onclick: () => scrollToBottom(true) });
  dom.scrollBtn.append(icon("send"));

  dom.textarea = el("textarea", { name: "message", rows: "1", placeholder: `${av.displayName}에게 메시지…  (Enter 전송 · Shift+Enter 줄바꿈)`, "aria-label": "메시지 입력" });
  dom.sendButton = el("button", { class: "send-button", type: "submit", "aria-label": "보내기", title: "보내기" });
  dom.sendButton.append(icon("send"));
  dom.composerBox = el("div", { class: "composer-box" }, [dom.textarea, dom.sendButton]);
  const composerForm = el("form", {
    class: "composer-form",
    onsubmit: (e) => {
      e.preventDefault();
      if (state.streaming) stopStreaming();
      else submitMessage();
    },
  }, [
    dom.composerBox,
    el("div", { class: "composer-hint" }, [
      el("span", {}, [document.createTextNode("Enter 전송 · "), el("kbd", { text: "Shift+Enter" }), document.createTextNode(" 줄바꿈")]),
      el("span", { id: "composer-state", text: "" }),
    ]),
  ]);
  const composer = el("footer", { class: "composer" }, [el("div", { class: "composer-inner" }, [composerForm])]);

  dom.main.append(header, el("div", { class: "chat-body" }, [dom.transcript, dom.scrollBtn]), composer);
  wireComposer();
  renderTranscript();
}

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
    dom.sendButton.replaceChildren(icon("stop"));
  } else {
    dom.sendButton.disabled = !hasText;
    dom.sendButton.classList.remove("is-stop");
    dom.sendButton.replaceChildren(icon("send"));
  }
}

function newChat() {
  if (state.streaming) return;
  state.conversationId = newId();
  state.messages = [];
  renderTranscript();
  renderConversations();
  dom.textarea?.focus();
}

/* ---------- transcript ---------- */
function renderTranscript() {
  dom.transcriptInner.replaceChildren();
  if (!state.messages.length) {
    dom.transcriptInner.append(renderChatEmpty());
    updateScrollButton();
    return;
  }
  state.messages.forEach((m, i) => dom.transcriptInner.append(buildMessageNode(m, i === state.messages.length - 1)));
  scrollToBottom(true);
}

function renderChatEmpty() {
  const av = state.currentAvatar;
  return el("div", { class: "empty-state" }, [
    avatarNode(av, 72),
    el("div", { class: "hero" }, [
      el("h3", { text: `${av.displayName}와 대화` }),
      el("p", { text: av.bio || "무엇이든 물어보세요. 이 아바타의 플러그인은 읽기전용으로 실행됩니다." }),
    ]),
  ]);
}

function buildMessageNode(message, isLast) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "나" : state.currentAvatar?.displayName || "아바타" }),
      message.createdAt ? el("time", { class: "msg-time", text: timeLabel(message.createdAt) }) : null,
    ]),
  );
  const bubble = el("div", { class: "bubble" });
  if (isUser) bubble.textContent = message.content;
  else renderAssistantInto(bubble, message);
  wrap.append(bubble, buildMessageActions(message, isUser, isLast));
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
  state.messages = state.messages.slice(0, lastUser + 1);
  renderTranscript();
  streamChat(text, { regenerate: true });
}

function renderAssistantInto(bubble, message) {
  const response = message.response;
  bubble.classList.toggle("blocked", response?.runtime === "blocked");
  bubble.classList.toggle("errored", response?.runtime === "error" || message.errored === true);
  if (response) {
    const meta = [response.runtime && ["runtime", response.runtime], response.skillName && ["skill", response.skillName]].filter(Boolean);
    if (meta.length) {
      const metaRow = el("div", { class: "response-meta" });
      for (const [kind, val] of meta) metaRow.append(el("span", { class: `meta-badge ${kind === "runtime" ? `runtime-${val}` : ""}`, text: val }));
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

function isNearBottom() {
  const t = dom.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || isNearBottom()) dom.transcript.scrollTop = dom.transcript.scrollHeight;
  updateScrollButton();
}
function updateScrollButton() {
  if (!dom.scrollBtn) return;
  const t = dom.transcript;
  const scrollable = t.scrollHeight - t.clientHeight > 40;
  dom.scrollBtn.hidden = !(scrollable && !isNearBottom());
}

/* ---------- sending / streaming ---------- */
async function submitMessage() {
  const message = dom.textarea.value.trim();
  if (!message || state.streaming || !state.currentAvatar) return;
  if (!state.messages.length) dom.transcriptInner.replaceChildren();
  dom.transcriptInner.querySelectorAll(".msg-act.regen").forEach((b) => b.remove());
  const userMsg = { role: "user", content: message, createdAt: new Date().toISOString() };
  state.messages.push(userMsg);
  dom.transcriptInner.append(buildMessageNode(userMsg, false));
  dom.textarea.value = "";
  dom.textarea.style.height = "auto";
  scrollToBottom(true);
  await streamChat(message, { isNewConversation: state.messages.length === 1 });
}

async function streamChat(message, { isNewConversation = false, regenerate = false } = {}) {
  state.streaming = true;
  updateSendState();
  setComposerState("응답 대기 중…");
  dom.transcript.setAttribute("aria-busy", "true");
  document.title = "● 응답 중 · Avatar Chat";

  const bubble = el("div", { class: "bubble" });
  const mdNode = el("div", { class: "md" });
  const caret = el("span", { class: "stream-caret", "aria-hidden": "true" });
  const statusRow = el("div", { class: "stream-status" }, [el("span", { class: "spinner" }), el("span", { class: "label", text: "준비 중…" })]);
  const pluginChips = el("div", { class: "plugin-chips" });
  bubble.append(mdNode, caret, statusRow, pluginChips);
  const wrap = el("div", { class: "message assistant" }, [
    el("div", { class: "msg-role" }, [el("span", { class: "role-dot" }), el("span", { text: state.currentAvatar?.displayName || "아바타" })]),
    bubble,
  ]);
  dom.transcriptInner.append(wrap);
  scrollToBottom(true);

  const live = { wrap, bubble, mdNode, caret, statusRow, statusLabel: statusRow.querySelector(".label"), pluginChips, text: "", rafPending: false, done: false, aborted: false, isNewConversation };
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
      body: JSON.stringify({ avatarId: state.currentAvatar.id, message, conversationId: state.conversationId, regenerate }),
    });
    if (response.status === 401) {
      handleSessionExpired();
      return;
    }
    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }
    await consumeSse(response.body, (e, d) => handleSseEvent(e, d, live, scheduleFlush));
  } catch (error) {
    if (error.name === "AbortError" || live.aborted) finalizeStopped(live);
    else {
      finalizeError(live, error.message || "스트리밍 오류가 발생했습니다.");
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
    document.title = "Avatar Chat";
    dom.textarea.focus();
  }
}

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
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseFrame(raw);
      if (frame) onEvent(frame.event, frame.data);
    }
  }
}

function parseFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: { text: dataStr } };
  }
}

function handleSseEvent(event, data, live, scheduleFlush) {
  switch (event) {
    case "open":
      if (data?.conversationId) state.conversationId = data.conversationId;
      setStatus(live, "준비 중…");
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
  let chip = live.pluginChips.querySelector(`[data-plugin="${cssEscape(data.name)}"]`);
  if (!chip) {
    chip = el("span", { class: "plugin-chip", dataset: { plugin: data.name } }, [el("span", { class: "pc-dot" }), el("span", { class: "pc-text", text: data.name })]);
    live.pluginChips.append(chip);
  }
  chip.dataset.status = data.status || "started";
  const m = { started: "설치 중", installed: "설치됨", completed: "로드됨", failed: "실패" };
  chip.querySelector(".pc-text").textContent = `${data.name} · ${m[data.status] || data.status || ""}`;
}
function cssEscape(v) {
  return String(v).replace(/["\\]/g, "\\$&");
}
function setComposerState(text) {
  const n = document.querySelector("#composer-state");
  if (n) n.textContent = text;
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
  const message = data?.message || { role: "assistant", content: data?.response?.text || data?.response?.summary || live.text, response: data?.response, createdAt: new Date().toISOString() };
  state.messages.push(message);
  live.bubble.replaceChildren();
  live.bubble.className = "bubble";
  renderAssistantInto(live.bubble, message);
  live.wrap.append(buildMessageActions(message, false, true));
  scrollToBottom();
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
  } else live.mdNode.remove();
  live.bubble.append(el("div", { class: "response-meta" }, [el("span", { class: "meta-badge runtime-error", text: "오류" })]));
  live.bubble.append(el("div", { class: "md", text: msg }));
  state.messages.push({ role: "assistant", content: live.text ? `${live.text}\n\n${msg}` : msg, errored: true, response: { kind: "text", runtime: "error", summary: "오류", text: live.text || msg } });
}
function finalizeStopped(live) {
  if (live.done) return;
  live.done = true;
  live.aborted = true;
  cleanupLive(live);
  live.mdNode.innerHTML = renderMarkdown(live.text);
  enhanceCodeBlocks(live.mdNode);
  live.bubble.append(el("div", { class: "stream-status" }, [el("span", { class: "label", text: "· 사용자가 중지함" })]));
  state.messages.push({ role: "assistant", content: live.text || "(중지됨)", response: { kind: "text", runtime: "claude", summary: "중지됨", text: live.text } });
}
function stopStreaming() {
  if (abortController) abortController.abort();
}

/* ============================================================ Conversations (rail) */
async function loadConversations() {
  const result = await api("/api/conversations");
  state.conversations = result.conversations || [];
}
async function refreshConversations() {
  try {
    await loadConversations();
    renderConversations();
  } catch {
    /* ignore */
  }
}
function renderConversations() {
  if (!dom.convList) return;
  dom.convList.replaceChildren();
  if (!state.conversations.length) {
    dom.convList.append(el("div", { class: "conv-empty", text: "대화가 없습니다." }));
    return;
  }
  for (const conv of state.conversations) {
    const active = conv.id === state.conversationId;
    const item = el("div", { class: `conv-item ${active ? "active" : ""}`, dataset: { id: conv.id } });
    const openBtn = el("button", { class: "conv-open", type: "button", title: conv.title, onclick: () => selectConversation(conv) }, [
      el("span", { class: "conv-name", text: conv.title || "새 대화" }),
      el("span", { class: "conv-time", text: `${conv.avatarDisplayName || ""} · ${timeLabel(conv.updatedAt)}` }),
    ]);
    const delBtn = el("button", { class: "conv-act danger", type: "button", "aria-label": "삭제", title: "삭제", onclick: (e) => { e.stopPropagation(); deleteConversation(conv); } });
    delBtn.append(icon("trash"));
    item.append(openBtn, el("div", { class: "conv-acts" }, [delBtn]));
    dom.convList.append(item);
  }
}
async function selectConversation(conv) {
  if (state.streaming) return;
  closeRail();
  state.conversationId = conv.id;
  try {
    const [msgRes, avRes] = await Promise.all([
      api(`/api/messages?conversationId=${encodeURIComponent(conv.id)}`),
      api(`/api/avatars/${encodeURIComponent(conv.avatarUserId)}`).catch(() => null),
    ]);
    state.messages = msgRes.messages || [];
    if (avRes?.avatar) state.currentAvatar = avRes.avatar;
    else state.currentAvatar = { id: conv.avatarUserId, displayName: conv.avatarDisplayName, username: "", hasImage: true };
  } catch {
    state.messages = [];
  }
  state.view = "chat";
  renderView();
  renderConversations();
}
async function deleteConversation(conv) {
  if (!window.confirm("이 대화를 삭제할까요?")) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  if (conv.id === state.conversationId) newChat();
  else renderConversations();
}

/* ============================================================ Settings (my avatar) */
async function renderSettings() {
  const header = viewHeader("내 아바타", "프로필과 플러그인을 관리하고 공개하세요");
  const body = el("div", { class: "view-body scroll-thin settings-body" });
  dom.main.append(header, body);

  try {
    await Promise.all([refreshMe(), loadPlugins()]);
  } catch {
    /* ignore */
  }
  const u = state.user;

  // Profile card
  const picWrap = el("div", { class: "pic-edit" });
  const pic = avatarNode(u, 96);
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", style: "display:none" });
  const camBtn = el("button", { class: "pic-cam", type: "button", "aria-label": "사진 변경", title: "사진 변경", onclick: () => fileInput.click() });
  camBtn.append(icon("camera"));
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image: dataUrl }) });
      state.user.hasImage = true;
      renderView();
    } catch (e) {
      alert(`업로드 실패: ${e.message}`);
    }
  });
  picWrap.append(pic, camBtn, fileInput);
  if (u.hasImage) {
    picWrap.append(
      el("button", {
        class: "linkish small",
        type: "button",
        text: "사진 삭제",
        onclick: async () => {
          try {
            await api("/api/me/avatar-image", { method: "DELETE" });
            state.user.hasImage = false;
            renderView();
          } catch {
            /* ignore */
          }
        },
      }),
    );
  }

  const profileForm = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const btn = e.currentTarget.querySelector("button[type=submit]");
      btn.disabled = true;
      const saved = btn.textContent;
      btn.textContent = "저장 중…";
      try {
        const res = await api("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ displayName: fd.get("displayName"), bio: fd.get("bio"), persona: fd.get("persona") }),
        });
        state.user = res.user;
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; btn.disabled = false; }, 1200);
        if (dom.navButtons) renderRailUser();
      } catch (err) {
        btn.textContent = saved;
        btn.disabled = false;
        alert(`저장 실패: ${err.message}`);
      }
    },
  }, [
    el("label", { class: "field" }, [el("span", { text: "표시 이름" }), el("input", { name: "displayName", value: u.displayName || "", required: "" })]),
    el("label", { class: "field" }, [el("span", { text: "소개 (한 줄)" }), el("input", { name: "bio", value: u.bio || "", placeholder: "어떤 아바타인지 소개하세요" })]),
    el("label", { class: "field" }, [
      el("span", { text: "페르소나 / 시스템 프롬프트" }),
      el("textarea", { name: "persona", rows: "4", placeholder: "이 아바타가 어떻게 행동해야 하는지 (선택)", text: u.persona || "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "프로필 저장" }),
  ]);

  // Publish toggle
  const publishRow = el("div", { class: "publish-row" }, [
    el("div", {}, [
      el("strong", { text: u.published ? "공개됨" : "비공개" }),
      el("p", { class: "muted", text: u.published ? "다른 사용자가 탐색에서 찾아 대화할 수 있어요." : "나만 볼 수 있어요. 공개하면 탐색 목록에 표시됩니다." }),
    ]),
    buildToggle(u.published, async (val) => {
      try {
        const res = await api("/api/me", { method: "PATCH", body: JSON.stringify({ published: val }) });
        state.user = res.user;
        renderView();
      } catch (e) {
        alert(`변경 실패: ${e.message}`);
        renderView();
      }
    }),
  ]);

  body.append(
    el("section", { class: "settings-card" }, [
      el("div", { class: "settings-head" }, [picWrap, el("div", { class: "settings-id" }, [el("h3", { text: u.displayName }), el("div", { class: "muted", text: `@${u.username}` })])]),
      profileForm,
    ]),
    el("section", { class: "settings-card" }, [el("h3", { text: "공개 설정" }), publishRow]),
    buildPluginsCard(),
  );
}

function renderRailUser() {
  // refresh the rail "me" row label after profile edits
  const meRow = dom.rail?.querySelector(".rail-me .meta b");
  if (meRow) meRow.textContent = state.user.displayName;
}

function buildToggle(on, onChange) {
  const btn = el("button", { class: `toggle ${on ? "on" : ""}`, type: "button", role: "switch", "aria-checked": on ? "true" : "false" }, [el("span", { class: "knob" })]);
  btn.addEventListener("click", () => {
    const next = !btn.classList.contains("on");
    onChange(next);
  });
  return btn;
}

function buildPluginsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [el("h3", { text: "GitHub 플러그인" }), el("p", { class: "muted", text: "내 아바타가 사용할 플러그인. 대화 시 읽기전용으로 실행됩니다." })]),
    ]),
  );
  const list = el("div", { class: "plugin-rows" });
  card.append(list);
  renderPluginRows(list);

  const form = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      // Capture the form node now: event.currentTarget is nulled after the
      // handler's first await, so referencing it later would throw and surface
      // a false "추가 실패" even though the plugin was added.
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/me/plugins", { method: "POST", body: JSON.stringify({ repo: fd.get("repo"), ref: fd.get("ref") || undefined, label: fd.get("label") || undefined }) });
        await loadPlugins();
        renderPluginRows(list);
        state.user.pluginCount = state.plugins.length;
        formEl.reset();
      } catch (err) {
        alert(`추가 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    },
  }, [
    el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", required: "" }),
    el("input", { name: "ref", placeholder: "ref (선택)", class: "narrow" }),
    el("input", { name: "label", placeholder: "라벨 (선택)", class: "narrow" }),
    el("button", { class: "primary", type: "submit", text: "추가" }),
  ]);
  card.append(form);
  return card;
}

function renderPluginRows(list) {
  list.replaceChildren();
  if (!state.plugins.length) {
    list.append(el("div", { class: "empty-note", text: "추가한 플러그인이 없습니다." }));
    return;
  }
  for (const p of state.plugins) {
    const row = el("div", { class: "plugin-row" }, [
      el("div", { class: "pr-main" }, [
        el("strong", { text: p.label || p.repo }),
        el("div", { class: "pr-sub", text: p.ref ? `${p.repo} @ ${p.ref}` : p.repo }),
      ]),
      buildToggle(p.enabled, async (val) => {
        try {
          await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
          p.enabled = val;
          renderPluginRows(list);
        } catch (e) {
          alert(`변경 실패: ${e.message}`);
        }
      }),
    ]);
    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": "삭제", title: "삭제", onclick: async () => {
      if (!window.confirm("이 플러그인을 삭제할까요?")) return;
      try {
        await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        state.plugins = state.plugins.filter((x) => x.id !== p.id);
        state.user.pluginCount = state.plugins.length;
        renderPluginRows(list);
      } catch (e) {
        alert(`삭제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    row.append(del);
    list.append(row);
  }
}

/* ============================================================ Admin */
async function renderAdmin() {
  const header = viewHeader("관리자", "사용자와 권한을 관리합니다");
  const body = el("div", { class: "view-body scroll-thin" });
  dom.main.append(header, body);
  body.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  try {
    await loadAdminUsers();
  } catch (e) {
    body.replaceChildren(el("div", { class: "warn-box", text: `불러오기 실패: ${e.message}` }));
    return;
  }
  body.replaceChildren();
  const table = el("div", { class: "admin-list" });
  for (const u of state.adminUsers) {
    const isMe = u.id === state.user.id;
    const isAdmin = u.roles?.includes("admin");
    const row = el("div", { class: "admin-row" }, [
      avatarNode(u, 40),
      el("div", { class: "ar-main" }, [
        el("strong", { text: u.displayName }),
        el("div", { class: "muted", text: `@${u.username} · 가입 ${timeLabel(u.createdAt)}` }),
      ]),
      el("div", { class: "ar-tags" }, [
        el("span", { class: `tag ${isAdmin ? "write" : "read"}`, text: isAdmin ? "admin" : "member" }),
        u.published ? el("span", { class: "tag accent", text: "공개" }) : null,
      ]),
    ]);
    const actions = el("div", { class: "ar-actions" });
    if (!isMe) {
      const roleBtn = el("button", { class: "ghost-sm", type: "button", text: isAdmin ? "admin 해제" : "admin 부여" });
      roleBtn.addEventListener("click", async () => {
        roleBtn.disabled = true;
        try {
          await api(`/api/admin/users/${encodeURIComponent(u.id)}/roles`, { method: "POST", body: JSON.stringify({ role: "admin", grant: !isAdmin }) });
          await loadAdminUsers();
          renderView();
        } catch (e) {
          roleBtn.disabled = false;
          alert(`실패: ${e.message}`);
        }
      });
      const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "삭제" });
      delBtn.addEventListener("click", async () => {
        if (!window.confirm(`${u.displayName}(@${u.username}) 계정을 삭제할까요?`)) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
          await loadAdminUsers();
          renderView();
        } catch (e) {
          alert(`삭제 실패: ${e.message}`);
        }
      });
      actions.append(roleBtn, delBtn);
    } else {
      actions.append(el("span", { class: "tag", text: "나" }));
    }
    row.append(actions);
    table.append(row);
  }
  body.append(table);
}

/* ============================================================ Loaders */
async function refreshMe() {
  const me = await api("/api/me");
  if (me.user) state.user = me.user;
}
async function loadAvatars() {
  const r = await api("/api/avatars");
  state.avatars = r.avatars || [];
}
async function loadPlugins() {
  const r = await api("/api/me/plugins");
  state.plugins = r.plugins || [];
}
async function loadAdminUsers() {
  const r = await api("/api/admin/users");
  state.adminUsers = r.users || [];
}

/* ============================================================ Lifecycle */
async function logout() {
  abortController?.abort();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  sessionExpired = false;
  state.user = null;
  state.currentAvatar = null;
  state.messages = [];
  state.conversations = [];
  renderAuth("login");
}

async function enterApp() {
  mountShell();
  state.view = "explore";
  renderView();
  refreshConversations();
}

async function boot() {
  app.replaceChildren(
    el("div", { class: "boot" }, [el("div", { class: "boot-mark", text: "A" }), el("div", { class: "boot-spinner" }), el("div", { class: "boot-label", text: "불러오는 중…" })]),
  );
  let me = null;
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  state.user = me?.user || null;
  if (!state.user) {
    // On a fresh install (no accounts yet) show the admin-setup screen.
    let needsSetup = false;
    try {
      needsSetup = Boolean((await api("/api/bootstrap")).needsSetup);
    } catch {
      needsSetup = false;
    }
    renderAuth(needsSetup ? "setup" : "login");
    return;
  }
  await enterApp();
}

if (window.matchMedia) {
  const mq = window.matchMedia("(min-width: 861px)");
  const onChange = () => {
    if (mq.matches) closeRail();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

boot().catch((error) => {
  state.authError = error.message;
  renderAuth("login");
});
