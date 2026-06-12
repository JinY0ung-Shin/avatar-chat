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
  settingsTab: "profile", // profile | access | knowledge | routines
  avatars: [],
  avatarsLoaded: false,
  avatarsLoading: false,
  splitAvatarId: "",
  currentAvatar: null, // avatar being chatted with
  chatPanes: [],
  activePaneId: null,
  chatLayout: "vertical", // vertical | horizontal | grid
  conversations: [],
  conversationId: newId(),
  messages: [],
  // Skills for the chat capabilities panel, keyed by avatar id (lazy-loaded).
  // value: { loading, error, skills } | undefined (not yet fetched)
  skillsByAvatar: {},
  plugins: [],
  knowledgeRequests: [],
  routines: [],
  adminTab: "overview", // overview | users | access | system | audit
  adminUsers: [],
  adminUserDetail: {}, // id -> AdminUserDetail (lazy, cached per expand)
  adminUserSearch: "",
  adminSystem: null,
  adminStats: null,
  audit: [],
  streaming: false,
  authError: "",
  githubHost: "github.com",
  signupMode: "open", // mirrors /api/bootstrap; gates the auth-screen signup link
};

const dom = {};
let abortController = null;
let sessionExpired = false;

/* ============================================================ Networking */
// Known English server errors → Korean (the UI is Korean-first; raw English
// or bare HTTP codes in alerts are unintelligible to most users here).
const API_ERROR_KO = {
  "Internal server error": "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  "Authentication required": "로그인이 필요합니다.",
  "Admin access required": "관리자 권한이 필요합니다.",
};

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin",
      // Long timeout (repo clones can be slow), but never "forever" — a hung
      // request would otherwise strand every disabled-while-saving button.
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
      ...options,
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new Error("요청 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요.");
    if (err?.name === "AbortError") throw err;
    throw new Error("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
  }
  if (response.status === 401 && state.user) {
    handleSessionExpired();
    throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = (body.error || "").trim();
    throw new Error(API_ERROR_KO[raw] || raw || `서버 오류가 발생했습니다. (코드 ${response.status}) 잠시 후 다시 시도해 주세요.`);
  }
  return body;
}

function handleSessionExpired() {
  if (sessionExpired) return;
  sessionExpired = true;
  stopAllChatStreams();
  hidePromptModal();
  state.user = null;
  state.currentAvatar = null;
  state.chatPanes = [];
  state.activePaneId = null;
  state.messages = [];
  state.conversations = [];
  state.authError = "세션이 만료되었습니다. 다시 로그인해 주세요.";
  renderAuth();
}

/* ============================================================ Notifications */
// Non-blocking toast — replaces window.alert so errors don't freeze the page
// (and don't pile on top of the login screen after a session expiry).
let notifyWrap = null;
function notify(message, kind = "error", opts = {}) {
  if (sessionExpired) return;
  if (!notifyWrap || !notifyWrap.isConnected) {
    notifyWrap = el("div", { class: "toast-wrap", role: "status", "aria-live": "polite" });
    document.body.append(notifyWrap);
  }
  const toast = el("div", { class: `toast ${kind}${opts.onClick ? " clickable" : ""}`, text: message });
  // An actionable toast (e.g. "you have pending questions → open settings") is a
  // button: click or Enter/Space dismisses it and runs the action.
  if (opts.onClick) {
    toast.setAttribute("role", "button");
    toast.tabIndex = 0;
    const fire = () => {
      toast.remove();
      opts.onClick();
    };
    toast.onclick = fire;
    toast.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fire();
      }
    };
  }
  notifyWrap.append(toast);
  while (notifyWrap.children.length > 4) notifyWrap.firstChild.remove();
  setTimeout(() => {
    toast.classList.add("out");
    setTimeout(() => toast.remove(), 300);
  }, 5000);
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
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    columns: '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>',
    rows: '<rect x="4" y="3" width="16" height="7" rx="1"/><rect x="4" y="14" width="16" height="7" rx="1"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
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
    const btn = el("button", { class: "code-copy", type: "button", "aria-label": "코드 복사", title: "코드 복사" });
    btn.append(icon("copy"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(pre.querySelector("code")?.innerText ?? pre.innerText, btn);
    });
    wrapper.append(btn);
  });
  // GFM tables: wrap in a horizontal scroller so a wide table can't letter-break
  // every cell on narrow screens.
  container.querySelectorAll("table").forEach((table) => {
    if (table.closest(".table-wrap")) return;
    const wrap = el("div", { class: "table-wrap" });
    table.replaceWith(wrap);
    wrap.append(table);
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
    if (btn) {
      btn.classList.add("copy-failed");
      setTimeout(() => btn.classList.remove("copy-failed"), 1200);
    }
    notify("클립보드에 복사하지 못했습니다.", "warn");
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
    const d = new Date(iso);
    const opts = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
    // Older than this year → "06. 11." alone is ambiguous; include the year.
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "2-digit";
    return d.toLocaleString("ko-KR", opts);
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
// `alt: ""` marks the image decorative (when the name is adjacent visible
// text) — the wrap is then aria-hidden so generated-initial avatars don't
// announce a stray letter either.
function avatarNode(person, size = 40, { alt } = {}) {
  const wrap = el("div", { class: "avatar-img", style: `--av-size:${size}px` });
  if (alt === "") wrap.setAttribute("aria-hidden", "true");
  if (person?.hasImage && person.id) {
    const img = el("img", { src: `/api/users/${person.id}/avatar-image`, alt: alt ?? (person.displayName || person.username || "") });
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
function renderAuth(mode = "login", { username = "", displayName = "" } = {}) {
  stopAllChatStreams();
  abortController = null;
  state.streaming = false;
  document.title = "Noah Almighty";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  // Self-service signup is gated by the deployment's signup mode. The very first
  // account (setup) is always allowed; otherwise "closed" hides the signup form.
  const signupAllowed = mode === "setup" || state.signupMode !== "closed";
  if (mode === "signup" && !signupAllowed) {
    renderAuth("login", { username, displayName });
    return;
  }
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
        // Approval-mode signup: the account is created but parked until an admin
        // activates it — there's no session yet, so bounce back to the login form.
        if (!isLogin && result.pending) {
          state.authError = "";
          renderAuth("login", { username: fd.get("username") || "" });
          notify("가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.", "info");
          return;
        }
        sessionExpired = false;
        state.user = result.user;
        state.authError = "";
        await enterApp();
      } catch (error) {
        state.authError = error.message;
        // Keep what the user typed — re-entering the username after a wrong
        // password is pure friction.
        renderAuth(mode, { username: fd.get("username") || "", displayName: fd.get("displayName") || "" });
      }
    },
  });

  const fields = [];
  fields.push(
    el("label", { class: "field" }, [
      el("span", { text: "사용자명" }),
      el("input", { name: "username", autocomplete: "username", placeholder: "user123", required: "", minlength: "3", value: username }),
    ]),
  );
  if (!isLogin) {
    fields.push(
      el("label", { class: "field" }, [
        el("span", { text: "표시 이름" }),
        el("input", { name: "displayName", autocomplete: "nickname", placeholder: "홍길동", required: "", value: displayName }),
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
  fields.push(el("button", { class: "primary", type: "submit", text: isLogin ? "로그인" : isSetup ? "관리자 계정 만들기" : "회원가입" }));
  form.append(...fields);

  app.replaceChildren(
    el("section", { class: "auth-view" }, [
      el("div", { class: "auth-panel" }, [
        el("img", { class: "login-mark", src: "/icon-192.png", alt: "Noah Almighty", width: "48", height: "48" }),
        isSetup ? el("div", { class: "setup-badge", text: "첫 실행 · 관리자 설정" }) : null,
        el("h1", { text: isSetup ? "관리자 계정 만들기" : isLogin ? "다시 오신 것을 환영합니다" : "Noah Almighty 시작하기" }),
        el("p", {
          text: isSetup
            ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
            : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.",
        }),
        !isLogin && !isSetup && state.signupMode === "approval"
          ? el("p", { class: "muted auth-note", text: "관리자 승인 후 로그인할 수 있습니다." })
          : null,
        state.authError ? el("div", { class: "error", role: "alert", text: state.authError }) : null,
        form,
        renderAuthSwitch({ isLogin, isSetup, signupAllowed }),
      ]),
    ]),
  );
  const userInput = app.querySelector('input[name="username"]');
  if (userInput && !userInput.value) userInput.focus();
  else app.querySelector('input[name="password"]')?.focus();
}

/* Login↔signup toggle. Hidden during setup; on the login screen it collapses to
   a "signup disabled" note when the deployment has closed self-service signup. */
function renderAuthSwitch({ isLogin, isSetup, signupAllowed }) {
  if (isSetup) return null;
  if (isLogin && !signupAllowed) {
    return el("div", { class: "auth-switch" }, [
      el("span", { class: "muted", text: "현재 회원가입을 받지 않습니다." }),
    ]);
  }
  return el("div", { class: "auth-switch" }, [
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
  ]);
}

/* ============================================================ App shell */
function mountShell() {
  const admin = state.user.roles?.includes("admin");

  dom.navButtons = {};
  const nav = el("nav", { class: "rail-nav", "aria-label": "주 메뉴" });
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
  navItem("chat", "대화", "chat");
  navItem("settings", "내 아바타", "user");
  if (admin) navItem("admin", "관리자", "shield");

  const newChatBtn = el("button", { class: "new-chat", type: "button", onclick: () => goView("explore") }, [
    icon("plus"),
    el("span", { text: "새 대화" }),
  ]);

  dom.convList = el("div", { class: "conv-list scroll-thin" });
  dom.convList.append(el("div", { class: "conv-empty", text: "불러오는 중…" }));
  dom.convSearch = el("input", {
    class: "conv-search",
    type: "search",
    placeholder: "대화 검색",
    "aria-label": "대화 검색",
    oninput: () => renderConversations(),
  });

  const meRow = el("button", { class: "rail-me", type: "button", title: "내 아바타 설정", onclick: () => goView("settings") }, [
    avatarNode(state.user, 34, { alt: "" }),
    el("div", { class: "meta" }, [
      el("b", { text: state.user.displayName }),
      el("span", { text: `@${state.user.username}` }),
    ]),
  ]);
  const logoutBtn = el("button", { class: "icon-button", type: "button", "aria-label": "로그아웃", title: "로그아웃", onclick: logout });
  logoutBtn.append(icon("logout"));

  const rail = el("aside", { class: "rail", id: "rail", "aria-label": "대화 목록" }, [
    el("div", { class: "rail-head" }, [
      el("div", { class: "rail-brand" }, [
        el("img", { class: "mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "34", height: "34" }),
        el("div", {}, [el("div", { class: "name", text: "Noah Almighty" }), el("div", { class: "sub", text: "아바타 플랫폼" })]),
      ]),
      nav,
      newChatBtn,
    ]),
    el("div", { class: "rail-history" }, [
      el("div", { class: "rail-section-label", text: "내 대화" }),
      el("div", { class: "conv-list-wrap" }, [dom.convSearch, dom.convList]),
    ]),
    el("div", { class: "rail-footer" }, [el("div", { class: "rail-user-row" }, [meRow, logoutBtn])]),
  ]);

  const railToggle = el("button", { class: "icon-button rail-toggle", type: "button", "aria-label": "메뉴 열기", title: "메뉴", onclick: () => openRail() });
  railToggle.append(icon("menu"));
  dom.railToggle = railToggle;

  dom.main = el("main", { class: "main", id: "main" });
  dom.railBackdrop = el("div", { class: "rail-backdrop", onclick: () => closeRail() });

  // Polite status line for screen readers (streamed replies are announced once
  // on completion instead of flooding on every token).
  dom.srStatus = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });

  // Interactive prompts (permission / AskUserQuestion) surface as a standalone
  // centered modal — not inside the chat bubble — so the owner can't miss them;
  // it's dismissed once they respond (or when the run ends).
  dom.promptModal = el("div", { class: "prompt-modal-backdrop", hidden: true });
  dom.promptModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dom.promptModal.querySelector("[data-prompt-cancel]")?.click();
    } else if (event.key === "Tab") {
      trapTab(event, dom.promptModal);
    }
  });
  // Clicking the scrim (outside the card) dismisses via the card's own
  // cancel/skip — an obvious escape so a prompt never feels like a hard trap.
  dom.promptModal.addEventListener("click", (event) => {
    if (event.target === dom.promptModal) {
      dom.promptModal.querySelector("[data-prompt-cancel]")?.click();
    }
  });

  app.replaceChildren(el("section", { class: "workspace" }, [rail, dom.main]), dom.railBackdrop, dom.promptModal, dom.srStatus);
  dom.rail = rail;
}

/* ---- Prompt modal queue ------------------------------------------------
   Split panes can raise prompts concurrently; a single global modal would let
   the second card silently destroy the first (stalling that run forever). We
   queue instead, and a finishing run only dismisses ITS OWN cards. */
const promptQueue = [];
let promptRestoreFocus = null;

function trapTab(event, container) {
  const focusables = [...container.querySelectorAll("button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    last.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first.focus();
    event.preventDefault();
  }
}

function showPromptModal(card, runKey = "") {
  if (!dom.promptModal) return;
  card.dataset.run = runKey || "";
  if (!dom.promptModal.hidden && dom.promptModal.firstChild && dom.promptModal.firstChild !== card) {
    promptQueue.push(card);
    return;
  }
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  const titleEl = card.querySelector(".prompt-title") || card.querySelector(".prompt-head-label");
  if (titleEl) {
    if (!titleEl.id) titleEl.id = `prompt-title-${newId()}`;
    card.setAttribute("aria-labelledby", titleEl.id);
  }
  // Capture only at the START of a prompt session — advancing between queued
  // cards passes through here with focus already on <body>.
  if (dom.promptModal.hidden && !promptRestoreFocus) {
    promptRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  dom.promptModal.replaceChildren(card);
  dom.promptModal.hidden = false;
  // Skip the header ✕ for initial focus (it stays Tab-reachable) so focus lands
  // on the first real control — an option to pick, not the dismiss button.
  (card.querySelector("button:not(:disabled):not(.prompt-close), input, select, textarea") || card).focus?.();
}

// Hide the current card and surface the next queued one (or close + restore focus).
function advancePromptModal() {
  if (!dom.promptModal) return;
  dom.promptModal.replaceChildren();
  const next = promptQueue.shift();
  if (next) {
    dom.promptModal.hidden = true; // force showPromptModal down its "show now" path
    showPromptModal(next, next.dataset.run);
    return;
  }
  dom.promptModal.hidden = true;
  if (promptRestoreFocus?.isConnected) promptRestoreFocus.focus?.();
  promptRestoreFocus = null;
}

// A run ended: drop its queued cards and dismiss its visible card (only its own).
function dismissRunPrompts(runKey) {
  const key = runKey || "";
  for (let i = promptQueue.length - 1; i >= 0; i--) {
    if ((promptQueue[i].dataset.run || "") === key) promptQueue.splice(i, 1);
  }
  const current = dom.promptModal?.firstChild;
  if (current && (current.dataset.run || "") === key) advancePromptModal();
}

function hidePromptModal() {
  if (!dom.promptModal) return;
  promptQueue.length = 0;
  dom.promptModal.hidden = true;
  dom.promptModal.replaceChildren();
}

function openRail() {
  dom.rail.classList.add("open");
  dom.railBackdrop.classList.add("open");
  dom.rail.querySelector(".nav-item")?.focus();
}
function closeRail() {
  const wasOpen = dom.rail?.classList.contains("open");
  dom.rail?.classList.remove("open");
  dom.railBackdrop?.classList.remove("open");
  if (wasOpen && dom.rail?.contains(document.activeElement)) dom.railToggle?.focus();
}

// Navigating away from a streaming chat: ask, then stop cleanly. A silent
// dead nav (the old behavior) made the whole app feel broken during long runs.
function confirmLeaveStreaming() {
  if (!anyChatStreaming()) return true;
  if (!window.confirm("응답이 생성되는 중입니다. 중지하고 이동할까요?")) return false;
  stopAllChatStreams();
  return true;
}

function goView(view) {
  if (view === state.view) {
    closeRail();
    return;
  }
  if (!confirmLeaveStreaming()) return;
  state.view = view;
  closeRail();
  syncHash();
  renderView();
}

function syncNav() {
  for (const [view, btn] of Object.entries(dom.navButtons)) {
    const active = view === state.view;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
}

const VIEW_TITLES = { explore: "탐색", chat: "대화", settings: "내 아바타", admin: "관리자" };

function syncDocumentTitle() {
  if (state.streaming) {
    document.title = "● 응답 중 · Noah Almighty";
    return;
  }
  if (!state.user) {
    document.title = "Noah Almighty";
    return;
  }
  const chatName = state.view === "chat" ? activePane()?.avatar?.alias || activePane()?.avatar?.displayName : null;
  document.title = `${chatName || VIEW_TITLES[state.view] || "Noah Almighty"} · Noah Almighty`;
}

function renderView() {
  // Non-admins must never land on the admin view — including via hash nav
  // (manual URL / Back-Forward), which bypasses enterApp's initial guard.
  // Coerce before syncNav so the nav highlight stays consistent too.
  if (state.view === "admin" && !state.user?.roles?.includes("admin")) state.view = "explore";
  syncNav();
  syncDocumentTitle();
  dom.main.replaceChildren();
  if (state.view === "explore") renderExplore();
  else if (state.view === "chat") renderChat();
  else if (state.view === "settings") renderSettings();
  else if (state.view === "admin") renderAdmin();
}

/* ---- Hash routing -------------------------------------------------------
   #/explore · #/chat · #/chat/<convId> · #/settings/<tab> · #/admin
   Keeps Back/Forward inside the SPA and survives a reload. */
const VIEW_ROUTES = ["explore", "chat", "settings", "admin"];
let applyingRoute = false;

function routeFromHash() {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  let decoded = null;
  try {
    decoded = arg ? decodeURIComponent(arg) : null;
  } catch {
    decoded = null; // malformed percent-encoding in a hand-edited URL
  }
  return { view: VIEW_ROUTES.includes(view) ? view : null, arg: decoded };
}

function currentRoute() {
  if (state.view === "chat") {
    const pane = activePane();
    return pane?.messages?.length && pane.conversationId ? `#/chat/${encodeURIComponent(pane.conversationId)}` : "#/chat";
  }
  if (state.view === "settings") return `#/settings/${state.settingsTab}`;
  if (state.view === "admin") return `#/admin/${state.adminTab}`;
  return `#/${state.view}`;
}

function syncHash(replace = false) {
  if (applyingRoute || !state.user) return;
  const target = currentRoute();
  if (location.hash === target) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
}

async function applyRoute() {
  if (!state.user) return;
  const { view, arg } = routeFromHash();
  if (!view) return;
  applyingRoute = true;
  try {
    if (view === "chat" && arg && activePane()?.conversationId !== arg) {
      const conv = state.conversations.find((c) => c.id === arg);
      if (conv) {
        await selectConversation(conv);
        return;
      }
    }
    if (view === "settings" && arg && arg !== state.settingsTab) state.settingsTab = arg;
    if (view === "admin" && arg && arg !== state.adminTab) state.adminTab = arg;
    if (view !== state.view || view === "settings" || view === "admin") {
      if (!confirmLeaveStreaming()) return;
      state.view = view;
      closeRail();
      renderView();
    }
  } finally {
    applyingRoute = false;
  }
}

window.addEventListener("popstate", () => {
  applyRoute();
});

function viewHeader(title, sub, extra) {
  const left = el("div", { class: "header-left" }, [
    dom.railToggle,
    el("div", { class: "title" }, [el("h1", { text: title }), sub ? el("p", { text: sub }) : null]),
  ]);
  return el("header", { class: "view-header" }, [left, extra || el("div", {})]);
}

/* ============================================================ Chat panes */
const MAX_CHAT_PANES = 4;

function makeChatPane(avatar, { conversationId = newId(), messages = [] } = {}) {
  return {
    id: newId(),
    avatar,
    conversationId,
    messages,
    streaming: false,
    abortController: null,
    dom: {},
    greetedConversationId: null,
    greetingStarted: false,
  };
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

function activePane() {
  return state.chatPanes.find((p) => p.id === state.activePaneId) || state.chatPanes[0] || null;
}

function setActivePane(pane) {
  if (!pane) return;
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  dom.main?.querySelectorAll(".chat-pane").forEach((node) => {
    node.classList.toggle("active", node.dataset.pane === pane.id);
  });
}

function syncLegacyChatState(pane = activePane()) {
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
  abortController = activePane()?.abortController || null;
  // Keep header "새 대화" buttons in sync with their pane's streaming state.
  dom.main?.querySelectorAll("[data-newchat]").forEach((btn) => {
    const paneEl = btn.closest(".chat-pane");
    const pane = paneEl ? state.chatPanes.find((p) => p.id === paneEl.dataset.pane) : activePane();
    btn.disabled = Boolean(pane?.streaming);
  });
}

function anyChatStreaming() {
  return state.chatPanes.some((p) => p.streaming);
}

function stopAllChatStreams() {
  for (const pane of state.chatPanes) {
    pane.abortController?.abort();
  }
  abortController = null;
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

/* ============================================================ Explore view */
// First-run pointer shown when the user skipped onboarding and never connected
// anything — the onboarding modal itself is otherwise buried 3 levels deep.
function buildSetupBanner() {
  const u = state.user;
  if (!u || u.gitTokenSet || u.knowledgeRepo) return null;
  try {
    if (sessionStorage.getItem("setupBannerDismissed") === "1") return null;
  } catch {
    /* storage unavailable — just show it */
  }
  const banner = el("div", { class: "setup-banner" }, [
    el("span", { text: "아바타가 아직 지식 저장소와 연결되지 않았습니다. 연결하면 대화로 지식을 쌓을 수 있어요." }),
    el("div", { class: "sb-actions" }, [
      el("button", { class: "primary small", type: "button", text: "설정하기", onclick: () => openOnboarding() }),
      el("button", {
        class: "linkish small",
        type: "button",
        text: "닫기",
        onclick: () => {
          try {
            sessionStorage.setItem("setupBannerDismissed", "1");
          } catch {
            /* ignore */
          }
          banner.remove();
        },
      }),
    ]),
  ]);
  return banner;
}

async function renderExplore() {
  const header = viewHeader("탐색", "공개된 아바타와 대화를 시작하세요");
  const grid = el("div", { class: "avatar-grid" });
  const body = el("div", { class: "view-body scroll-thin" }, [grid]);
  dom.main.append(header, body);

  grid.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  let loadError = null;
  try {
    await loadAvatars();
  } catch (e) {
    loadError = e;
  }
  grid.replaceChildren();
  if (loadError) {
    // A failed fetch must not masquerade as "no avatars exist".
    grid.append(
      el("div", { class: "warn-box" }, [
        `아바타 목록을 불러오지 못했습니다: ${loadError.message} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  const banner = buildSetupBanner();
  if (banner) body.prepend(banner);
  if (!state.avatars.length) {
    grid.append(el("div", { class: "empty-note", text: "공개된 아바타가 아직 없습니다.\n내 아바타 탭에서 아바타를 공개해 보세요." }));
    return;
  }
  // Pin my own avatar first — the most common chat target needs a stable spot.
  const avatars = [...state.avatars].sort((a, b) => Number(b.id === state.user.id) - Number(a.id === state.user.id));
  for (const av of avatars) {
    grid.append(buildAvatarCard(av));
  }
}

function buildAvatarCard(av) {
  const isMe = av.id === state.user.id;
  const card = el("button", { class: "avatar-card", type: "button", onclick: () => startChatWith(av) }, [
    avatarNode(av, 56, { alt: "" }),
    el("div", { class: "ac-body" }, [
      el("div", { class: "ac-name" }, [
        el("strong", { text: av.displayName }),
        isMe ? el("span", { class: "tag accent", text: "나" }) : null,
        av.published ? null : el("span", { class: "tag", text: "비공개" }),
      ]),
      el("div", { class: "ac-handle", text: `@${av.username}` }),
      av.alias ? el("div", { class: "ac-alias", text: `"${av.alias}"` }) : null,
      av.bio ? el("p", { class: "ac-bio", text: av.bio }) : null,
      el("div", { class: "ac-tags" }, [el("span", { class: "tag", text: `플러그인 ${av.pluginCount}개` })]),
    ]),
  ]);
  return card;
}

async function startChatWith(av) {
  if (!confirmLeaveStreaming()) return;
  // Resume the most recent conversation with this avatar instead of silently
  // forking a new one — Explore and the rail used to diverge here, spawning
  // duplicate threads. "새 대화" in the chat header remains the fork path.
  const existing = state.conversations.find((c) => c.avatarUserId === av.id);
  if (existing && state.chatPanes.length <= 1) {
    await selectConversation(existing);
    return;
  }
  state.currentAvatar = av;
  const pane = makeChatPane(av);
  state.chatPanes = [pane];
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  state.view = "chat";
  syncHash();
  renderView();
  await refreshConversations();
}

/* ============================================================ Chat view */
function renderChat() {
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
  const disabled = anyChatStreaming();
  const canAdd = splitEnabled() && state.chatPanes.length < MAX_CHAT_PANES && !disabled;
  const wrap = el("div", { class: "split-controls", role: "group", "aria-label": "분할 대화" });
  if (!state.avatarsLoaded && !state.avatarsLoading) {
    loadAvatars()
      // Mid-stream re-render would detach the live streaming bubble — skip it.
      .then(() => { if (state.view === "chat" && !anyChatStreaming()) renderView(); })
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
      disabled,
      onclick: () => {
        if (anyChatStreaming()) return;
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
  const selectedAvatarId = avatars.some((av) => av.id === state.splitAvatarId) ? state.splitAvatarId : activeAvatarId;
  const avatarSelect = el("select", {
    class: "split-avatar-select",
    title: "분할로 추가할 아바타",
    "aria-label": "분할로 추가할 아바타",
    disabled,
    onchange: (event) => { state.splitAvatarId = event.currentTarget.value; },
  }, avatars.map((av) => el("option", { value: av.id, text: av.alias || av.displayName || av.username || "아바타" })));
  avatarSelect.value = selectedAvatarId;
  state.splitAvatarId = selectedAvatarId;
  wrap.append(avatarSelect);
  const addBtn = el("button", {
    class: "split-add",
    type: "button",
    title: "대화 추가 (분할)",
    "aria-label": "대화 추가 (분할)",
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
  pdom.transcript.addEventListener("scroll", () => updateScrollButton(pane));

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
  pdom.sendButton = el("button", { class: "send-button", type: "submit", "aria-label": "보내기", title: "보내기" });
  pdom.sendButton.append(icon("send"));
  pdom.composerBox = el("div", { class: "composer-box" }, [pdom.textarea, pdom.sendButton]);
  pdom.composerState = el("span", { class: "composer-state", text: "" });
  const composerForm = el("form", {
    class: "composer-form",
    onsubmit: (e) => {
      e.preventDefault();
      setActivePane(pane);
      if (pane.streaming) stopStreaming(pane);
      else submitMessage(pane);
    },
  }, [
    pdom.composerBox,
    (pdom.composerHint = el("div", { class: "composer-hint" }, [])),
  ]);
  // Rebuilt when a physical keyboard is detected mid-session (enterSends() flips).
  pdom.renderHint = () => {
    const lead = compact
      ? el("span", { text: `대화 ${index + 1}` })
      : enterSends()
        ? el("span", {}, [document.createTextNode("Enter 전송 · "), el("kbd", { text: "Shift+Enter" }), document.createTextNode(" 줄바꿈")])
        : el("span", { text: "보내기 버튼으로 전송" });
    pdom.composerHint.replaceChildren(lead, pdom.composerState);
  };
  pdom.renderHint();
  const composer = el("footer", { class: "composer" }, [el("div", { class: "composer-inner" }, [composerForm])]);

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
    "aria-label": "대화 창 닫기",
    title: "대화 창 닫기",
    disabled: state.chatPanes.length <= 1 || anyChatStreaming() ? "" : null,
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
  if (!splitEnabled() || state.chatPanes.length >= MAX_CHAT_PANES || anyChatStreaming()) return;
  const avatar = splitAvatarOptions().find((av) => av.id === avatarId) || activePane()?.avatar || state.currentAvatar || state.user;
  const pane = makeChatPane(avatar);
  state.chatPanes.push(pane);
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  renderView();
}

function closeChatPane(pane) {
  if (state.chatPanes.length <= 1 || anyChatStreaming()) return;
  state.chatPanes = state.chatPanes.filter((p) => p.id !== pane.id);
  if (state.activePaneId === pane.id) state.activePaneId = state.chatPanes[0]?.id || null;
  syncLegacyChatState(activePane());
  renderView();
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
function isFinePointer() {
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
function capPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function setCapPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); prefs just won't persist */
  }
}

function renderCapabilitiesPanel(av) {
  const skillsBody = el("div", { class: "cap-section-body cap-skills" });
  const plugins = av.plugins || [];
  const pluginsBody = el("div", { class: "cap-section-body cap-plugins" },
    plugins.length
      ? plugins.map((p) => el("div", { class: "cap-plugin" }, [
          el("span", { class: "cap-plugin-name", text: p.label || p.repo }),
          p.label ? el("span", { class: "cap-plugin-repo", text: p.repo }) : null,
        ]))
      : [el("p", { class: "cap-empty", text: "연결된 플러그인이 없습니다." })],
  );

  const collapseBtn = el("button", {
    class: "cap-collapse",
    type: "button",
    title: "패널 접기",
    "aria-label": "패널 접기",
    text: "›",
  });
  // The avatar's self-introduction (markdown), shown atop the panel when present.
  const introText = (av.intro || "").trim();
  const introBlock = introText
    ? el("div", { class: "cap-intro" }, [el("div", { class: "cap-intro-text md", html: renderMarkdown(introText) })])
    : null;
  const body = el("div", { class: "cap-body scroll-thin" }, [
    el("div", { class: "cap-head" }, [
      el("h3", { text: "이 아바타의 역량" }),
      el("p", { class: "cap-sub", text: `${av.displayName}이(가) 사용할 수 있는 도구` }),
    ]),
    introBlock,
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

  if (capPref("capPanelCollapsed", isMobileLayout() ? "1" : "0") === "1") panel.classList.add("collapsed");

  const setCollapsed = (collapsed) => {
    panel.classList.toggle("collapsed", collapsed);
    expandBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    setCapPref("capPanelCollapsed", collapsed ? "1" : "0");
  };
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
      body.replaceChildren(el("p", { class: "cap-empty", text: st.error }));
    } else if (!st.skills.length) {
      body.replaceChildren(el("p", { class: "cap-empty", text: "사용 가능한 스킬이 없습니다." }));
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
  try {
    const { skills } = await api(`/api/avatars/${avatarId}/skills`);
    const done = { loading: false, error: "", skills: skills || [] };
    state.skillsByAvatar[avatarId] = done;
    // Avoid clobbering the panel if the user navigated to a different avatar.
    if (state.currentAvatar?.id === avatarId) renderState(done);
  } catch (err) {
    const failed = { loading: false, error: "스킬을 불러오지 못했습니다.", skills: [] };
    state.skillsByAvatar[avatarId] = failed;
    if (state.currentAvatar?.id === avatarId) renderState(failed);
  }
}

/**
 * Drop the cached skills for an avatar so the capabilities panel re-fetches
 * next time it opens. Called whenever the owner mutates their own plugins —
 * the skill set is derived from those plugins, so the cache would go stale.
 */
function invalidateSkillsCache(avatarId) {
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
    autoGrow();
    updateSendState(pane);
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
  });
  pdom.composerBox.addEventListener("focusout", () => pdom.composerBox.classList.remove("focused"));
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
  pane.greetedConversationId = null;
  pane.greetingStarted = false;
  setActivePane(pane);
  syncHash(true);
  renderTranscript(pane);
  renderConversations();
  pane.dom.textarea?.focus();
  // Owner's own avatar greets first in the new empty conversation.
  maybeGreet(pane);
}

/* ---------- transcript ---------- */
function renderTranscript(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.transcriptInner) return;
  pdom.transcriptInner.replaceChildren();
  if (!pane.messages.length) {
    pdom.transcriptInner.append(renderChatEmpty(pane));
    updateScrollButton(pane);
    return;
  }
  pane.messages.forEach((m, i) => pdom.transcriptInner.append(buildMessageNode(pane, m, i === pane.messages.length - 1)));
  scrollToBottom(pane, true);
}

function renderChatEmpty(pane = activePane()) {
  const av = pane?.avatar || state.currentAvatar;
  const elevated = av.elevated || av.id === state.user?.id;
  return el("div", { class: "empty-state" }, [
    avatarNode(av, 72, { alt: "" }),
    el("div", { class: "hero" }, [
      el("h3", { text: `${av.displayName}와(과) 대화` }),
      el("p", { text: av.bio || (elevated ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.") }),
    ]),
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
      pane.dom.textarea.value = message.content;
      pane.dom.textarea.dispatchEvent(new Event("input"));
      pane.dom.textarea.focus();
    });
    row.append(editBtn);
  } else if (isLast) {
    const regenBtn = el("button", { class: "msg-act regen", type: "button", "aria-label": "다시 생성", title: "다시 생성" });
    regenBtn.append(icon("refresh"));
    regenBtn.addEventListener("click", () => regenerate(pane));
    row.append(regenBtn);
  }
  return row;
}

function regenerate(pane = activePane()) {
  if (!pane || pane.streaming) return;
  setActivePane(pane);
  const roles = pane.messages.map((m) => m.role);
  const lastUser = roles.lastIndexOf("user");
  if (lastUser < 0) return;
  const text = pane.messages[lastUser].content;
  // Stash the discarded tail: if the re-run errors before producing anything,
  // the original answer is restored instead of being lost.
  const removed = pane.messages.slice(lastUser + 1);
  pane.messages = pane.messages.slice(0, lastUser + 1);
  syncLegacyChatState(pane);
  renderTranscript(pane);
  streamChat(pane, text, { regenerate: true, restoreOnError: removed });
}

// Internal runtime identifiers → user-facing badge labels. `claude` is the
// normal case and renders no badge at all; raw identifiers never surface.
const RUNTIME_BADGE_LABELS = { claude: null, local: "로컬", blocked: "차단됨", error: "오류" };

function renderAssistantInto(bubble, message) {
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
  if (force || isNearBottom(pane)) t.scrollTop = t.scrollHeight;
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
  const message = pdom.textarea.value.trim();
  if (!message || pane.streaming || !pane.avatar) return;
  if (!pane.messages.length) pdom.transcriptInner.replaceChildren();
  pdom.transcriptInner.querySelectorAll(".msg-act.regen").forEach((b) => b.remove());
  const userMsg = { role: "user", content: message, createdAt: new Date().toISOString() };
  pane.messages.push(userMsg);
  syncLegacyChatState(pane);
  pdom.transcriptInner.append(buildMessageNode(pane, userMsg, false));
  pdom.textarea.value = "";
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

async function streamChat(pane, message, { isNewConversation = false, regenerate = false, greeting = false, restoreOnError = null } = {}) {
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
    text: "", rafPending: false, done: false, aborted: false, isNewConversation,
    restoreOnError: Array.isArray(restoreOnError) && restoreOnError.length ? restoreOnError : null,
  };
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

  pane.abortController = new AbortController();
  if (activePane()?.id === pane.id) abortController = pane.abortController;
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
      }),
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
      if (data?.conversationId) {
        live.pane.conversationId = data.conversationId;
        if (activePane()?.id === live.pane.id) {
          syncLegacyChatState(live.pane);
          syncHash(true);
        }
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
      renderPermissionCard(live, data);
      break;
    case "question":
      renderQuestionCard(live, data);
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

// Submit the owner's response to a prompt. The card stays up until the POST
// succeeds — hiding first meant a transient failure dismissed the prompt while
// the run kept waiting forever on an answer the UI could no longer deliver.
// The tool id (if any) is remembered so a later "blocked" event for the same
// tool isn't double-reported in the activity tree.
async function submitPromptResponse(live, data, value, card) {
  if (data.toolUseId) {
    (live.resolvedPermissions || (live.resolvedPermissions = new Set())).add(data.toolUseId);
  }
  const buttons = card ? [...card.querySelectorAll("button")] : [];
  const disabledBefore = buttons.map((b) => b.disabled);
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId: live.runId, requestId: data.requestId, value }) });
    advancePromptModal();
  } catch (err) {
    if (!live.done && live.pane?.streaming) {
      // Run still alive — keep the card so the user can retry.
      buttons.forEach((b, i) => (b.disabled = disabledBefore[i]));
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
      el("button", { class: "btn btn-ghost btn-sm", text: "거부", "data-prompt-cancel": "", onclick: () => submitPromptResponse(live, data, { behavior: "deny" }, card) }),
      el("button", { class: "btn btn-primary btn-sm", text: "승인", onclick: () => submitPromptResponse(live, data, { behavior: "allow" }, card) }),
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
      el("button", { class: "btn btn-ghost btn-sm", text: "취소", "data-prompt-cancel": "", onclick: () => submitPromptResponse(live, data, { cancelled: true }, card) }),
      el("button", { class: "btn btn-primary btn-sm", text: "확인", onclick: () => submitPromptResponse(live, data, { result: {} }, card) }),
    ]));
    showPromptModal(card, live.runId || "");
    setStatus(live, "질문에 답해 주세요…", { sticky: true });
    return;
  }

  // selections[i] = array of chosen labels for question i.
  const selections = questions.map(() => []);
  const submitBtn = el("button", { class: "btn btn-primary btn-sm", text: "보내기", disabled: true });

  const refreshSubmit = () => {
    submitBtn.disabled = selections.some((s) => s.length === 0);
  };

  questions.forEach((q, qi) => {
    const multi = q.multiSelect === true;
    const block = el("div", { class: "q-block" }, [
      q.header ? el("span", { class: "q-chip", text: q.header }) : null,
      el("div", { class: "q-text", text: q.question || "" }),
    ]);
    const opts = Array.isArray(q.options) ? q.options : [];
    const optsEl = el("div", { class: "q-options", role: "group", "aria-label": multi ? "여러 개 선택 가능" : "하나 선택" });
    opts.forEach((opt) => {
      const optBtn = el("button", { class: "q-option", type: "button", "aria-pressed": "false" }, [
        el("span", { class: "q-opt-label", text: opt.label || "" }),
        opt.description ? el("span", { class: "q-opt-desc", text: opt.description }) : null,
      ]);
      const setSelected = (btn, on) => {
        btn.classList.toggle("selected", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      };
      optBtn.addEventListener("click", () => {
        if (multi) {
          const idx = selections[qi].indexOf(opt.label);
          if (idx >= 0) { selections[qi].splice(idx, 1); setSelected(optBtn, false); }
          else { selections[qi].push(opt.label); setSelected(optBtn, true); }
        } else {
          selections[qi] = [opt.label];
          optsEl.querySelectorAll(".q-option").forEach((b) => setSelected(b, false));
          setSelected(optBtn, true);
        }
        refreshSubmit();
      });
      optsEl.append(optBtn);
    });
    block.append(optsEl);
    card.append(block);
  });

  submitBtn.addEventListener("click", () => {
    // Shape the result like AskUserQuestionOutput: an answers map keyed by the
    // question text (multi-select answers comma-joined), echoing the questions.
    const answers = {};
    questions.forEach((q, qi) => { answers[q.question || `q${qi}`] = selections[qi].join(", "); });
    submitPromptResponse(live, data, { result: { questions, answers } }, card);
  });

  // Always offer an exit: without 건너뛰기 the disabled submit + full-screen
  // backdrop could hard-stick a user who doesn't want to answer.
  card.append(el("div", { class: "prompt-actions" }, [
    el("button", { class: "btn btn-ghost btn-sm", text: "건너뛰기", "data-prompt-cancel": "", onclick: () => submitPromptResponse(live, data, { cancelled: true }, card) }),
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
  pane?.abortController?.abort();
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
    if (dom.convList && !state.conversations.length) {
      dom.convList.replaceChildren(
        el("div", { class: "conv-empty" }, [
          "대화 목록을 불러오지 못했습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => refreshConversations() }),
        ]),
      );
    }
  }
}
function renderConversations() {
  if (!dom.convList) return;
  // Don't rebuild while a rename is being typed (e.g. a finishing stream calls
  // refreshConversations) — that would wipe the input mid-edit.
  if (dom.convList.querySelector(".conv-item.editing")) return;
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
    dom.convList.append(el("div", { class: "conv-empty", text: "검색 결과가 없습니다." }));
    return;
  }
  for (const conv of visible) {
    const active = state.chatPanes.some((pane) => pane.conversationId === conv.id);
    const item = el("div", { class: `conv-item ${active ? "active" : ""}`, dataset: { id: conv.id } });
    const openBtn = el("button", { class: "conv-open", type: "button", title: conv.title, onclick: () => selectConversation(conv) }, [
      el("span", { class: "conv-name", text: conv.title || "새 대화" }),
      el("span", { class: "conv-time", text: [conv.avatarDisplayName, timeLabel(conv.updatedAt)].filter(Boolean).join(" · ") }),
    ]);
    const renameBtn = el("button", { class: "conv-act", type: "button", "aria-label": "대화 이름 바꾸기", title: "이름 바꾸기", onclick: (e) => { e.stopPropagation(); startRenameConversation(item, conv); } });
    renameBtn.append(icon("edit"));
    const delBtn = el("button", { class: "conv-act danger", type: "button", "aria-label": "대화 삭제", title: "삭제", onclick: (e) => { e.stopPropagation(); deleteConversation(conv); } });
    delBtn.append(icon("trash"));
    item.append(openBtn, el("div", { class: "conv-acts" }, [renameBtn, delBtn]));
    dom.convList.append(item);
  }
}

// Inline rename: swaps the row content for an input; Enter/blur saves, Escape cancels.
function startRenameConversation(item, conv) {
  if (item.classList.contains("editing")) return;
  item.classList.add("editing");
  const open = item.querySelector(".conv-open");
  const input = el("input", { class: "conv-rename", value: conv.title || "", "aria-label": "대화 이름" });
  open.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    if (save && title && title !== conv.title) {
      api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "PATCH", body: JSON.stringify({ title }) })
        .then(({ conversation }) => {
          conv.title = conversation?.title || title;
          renderConversations();
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

async function selectConversation(conv) {
  if (!confirmLeaveStreaming()) return;
  if (state.chatPanes.length > 1) {
    // Already open in a split pane → just focus that pane, keep the split.
    const openPane = state.chatPanes.find((p) => p.conversationId === conv.id);
    if (openPane) {
      setActivePane(openPane);
      closeRail();
      state.view = "chat";
      syncHash();
      renderView();
      renderConversations();
      return;
    }
    // Otherwise opening it replaces the whole split — ask first.
    if (!window.confirm("분할 대화를 닫고 이 대화를 열까요?")) return;
  }
  closeRail();
  try {
    const [msgRes, avRes] = await Promise.all([
      api(`/api/messages?conversationId=${encodeURIComponent(conv.id)}`),
      api(`/api/avatars/${encodeURIComponent(conv.avatarUserId)}`).catch(() => null),
    ]);
    const avatar = avRes?.avatar || { id: conv.avatarUserId, displayName: conv.avatarDisplayName, username: "", hasImage: true };
    const pane = makeChatPane(avatar, { conversationId: conv.id, messages: msgRes.messages || [] });
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    syncLegacyChatState(pane);
  } catch (e) {
    // Don't render an empty transcript that looks like wiped history — stay
    // where we are and say what happened.
    notify(`대화를 불러오지 못했습니다: ${e.message}`);
    return;
  }
  state.view = "chat";
  syncHash();
  renderView();
  renderConversations();
}
async function deleteConversation(conv) {
  const streamingPane = state.chatPanes.find((p) => p.conversationId === conv.id && p.streaming);
  if (streamingPane) {
    notify("응답 중인 대화는 삭제할 수 없습니다. 먼저 응답을 중지해 주세요.", "warn");
    return;
  }
  if (!window.confirm(`"${conv.title || "새 대화"}" 대화를 삭제할까요? 삭제하면 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: "DELETE" });
  } catch (e) {
    notify(`삭제 실패: ${e.message}`);
    return;
  }
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  const pane = state.chatPanes.find((p) => p.conversationId === conv.id);
  if (pane) newChat(pane);
  else renderConversations();
}

/* ============================================================ Settings (my avatar) */
async function renderSettings() {
  const header = viewHeader("내 아바타", "프로필과 플러그인을 관리하고 공개하세요");
  const body = el("div", { class: "view-body scroll-thin settings-body" });
  dom.main.append(header, body);

  body.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  // One failed loader must NOT render every card as its empty state ("플러그인이
  // 없습니다" 등) — that reads as data loss and invites duplicate re-adds.
  const results = await Promise.allSettled([refreshMe(), loadPlugins(), loadKnowledge(), loadRoutines(), loadTrusted()]);
  if (sessionExpired) return;
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `설정 정보를 불러오지 못했습니다: ${failed.reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  updateKnowledgeBadge();
  const u = state.user;

  // Profile card — picture edits update in place so typed-but-unsaved form
  // text in the rest of the card survives.
  const picWrap = el("div", { class: "pic-edit" });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: "" });
  const camBtn = el("button", { class: "pic-cam", type: "button", "aria-label": "사진 변경", title: "사진 변경", onclick: () => fileInput.click() });
  camBtn.append(icon("camera"));
  const delPicBtn = el("button", {
    class: "linkish small",
    type: "button",
    text: "사진 삭제",
    onclick: async () => {
      if (!window.confirm("아바타 사진을 삭제할까요?")) return;
      try {
        await api("/api/me/avatar-image", { method: "DELETE" });
        state.user.hasImage = false;
        renderPic();
        renderRailUser();
      } catch (e) {
        notify(`사진 삭제 실패: ${e.message}`);
      }
    },
  });
  const renderPic = () => {
    picWrap.replaceChildren(avatarNode(state.user, 96, { alt: "내 아바타 사진" }), camBtn, fileInput);
    if (state.user.hasImage) picWrap.append(delPicBtn);
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image: dataUrl }) });
      state.user.hasImage = true;
      renderPic();
      renderRailUser();
    } catch (e) {
      notify(`업로드 실패: ${e.message}`);
    } finally {
      fileInput.value = "";
    }
  });
  renderPic();

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
          body: JSON.stringify({ displayName: fd.get("displayName"), alias: fd.get("alias"), bio: fd.get("bio"), persona: fd.get("persona"), intro: fd.get("intro") }),
        });
        state.user = res.user;
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; btn.disabled = false; }, 1200);
        if (dom.navButtons) renderRailUser();
      } catch (err) {
        btn.textContent = saved;
        btn.disabled = false;
        notify(`저장 실패: ${err.message}`);
      }
    },
  });

  // Self-introduction field with an "auto-generate" button: the avatar writes a
  // first-person blurb from its persona + skills, dropped into this textarea for
  // the owner to review/edit before saving (it isn't persisted until 프로필 저장).
  const introField = el("textarea", {
    name: "intro",
    rows: "4",
    placeholder: "대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 '아바타가 자동 생성' 버튼으로 만들 수 있어요.",
    text: u.intro || "",
  });
  const introGenBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "아바타가 자동 생성",
    onclick: async () => {
      introGenBtn.disabled = true;
      const label = introGenBtn.textContent;
      introGenBtn.textContent = "생성 중…";
      try {
        const { intro } = await api("/api/me/intro/generate", { method: "POST" });
        if (intro) introField.value = intro;
      } catch (err) {
        notify(`자기소개 생성 실패: ${err.message}`);
      } finally {
        introGenBtn.textContent = label;
        introGenBtn.disabled = false;
      }
    },
  });

  profileForm.append(
    el("label", { class: "field" }, [el("span", { text: "표시 이름" }), el("input", { name: "displayName", value: u.displayName || "", required: "" })]),
    el("label", { class: "field" }, [
      el("span", { text: "별칭 (아바타가 스스로를 부르는 이름)" }),
      el("input", { name: "alias", value: u.alias || "", placeholder: "비우면 표시 이름을 사용합니다" }),
    ]),
    el("label", { class: "field" }, [el("span", { text: "소개 (한 줄)" }), el("input", { name: "bio", value: u.bio || "", placeholder: "어떤 아바타인지 소개하세요" })]),
    el("div", { class: "field" }, [
      el("div", { class: "field-row" }, [
        el("span", { text: "자기소개 (대화 패널 상단에 표시)" }),
        introGenBtn,
      ]),
      introField,
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "페르소나 (행동 지침)" }),
      el("textarea", { name: "persona", rows: "4", placeholder: "이 아바타가 어떻게 행동해야 하는지 (선택)", text: u.persona || "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "프로필 저장" }),
  );

  // Publish toggle — updates in place: a full renderView here would wipe
  // whatever the user typed (but hasn't saved) in the profile form above.
  const publishStrong = el("strong", { text: u.published ? "공개됨" : "비공개" });
  const publishDesc = el("p", { class: "muted", text: u.published ? "다른 사용자가 탐색에서 찾아 대화할 수 있어요." : "나만 볼 수 있어요. 공개하면 탐색 목록에 표시돼요." });
  const publishRow = el("div", { class: "publish-row" }, [
    el("div", {}, [publishStrong, publishDesc]),
    buildToggle(u.published, async (val) => {
      try {
        const res = await api("/api/me", { method: "PATCH", body: JSON.stringify({ published: val }) });
        state.user = res.user;
        publishStrong.textContent = res.user.published ? "공개됨" : "비공개";
        publishDesc.textContent = res.user.published ? "다른 사용자가 탐색에서 찾아 대화할 수 있어요." : "나만 볼 수 있어요. 공개하면 탐색 목록에 표시돼요.";
      } catch (e) {
        notify(`공개 설정 변경 실패: ${e.message}`);
        throw e;
      }
    }, "아바타 공개"),
  ]);

  // Group the (many) settings cards into tabs so a single screen no longer
  // dumps everything into one long scroll. Each tab lazily builds its cards.
  const profileCard = el("section", { class: "settings-card" }, [
    el("div", { class: "settings-head" }, [picWrap, el("div", { class: "settings-id" }, [el("h3", { text: u.displayName }), el("div", { class: "muted", text: `@${u.username}` })])]),
    profileForm,
  ]);
  const publishCard = el("section", { class: "settings-card" }, [el("h3", { text: "공개 설정" }), publishRow]);

  const tabs = [
    { id: "profile", label: "프로필", icon: "user", cards: () => [profileCard, publishCard] },
    { id: "access", label: "권한·연결", icon: "shield", cards: () => [buildTrustedUsersCard(), buildGitCredentialsCard(), buildSecretsCard()] },
    { id: "knowledge", label: "지식·플러그인", icon: "book", cards: () => [buildKnowledgeRepoCard(), buildPluginsCard(), buildKnowledgeCard()] },
    { id: "routines", label: "루틴", icon: "clock", cards: () => [buildRoutinesCard()] },
  ];
  if (!tabs.some((t) => t.id === state.settingsTab)) state.settingsTab = "profile";

  const panel = el("div", { class: "settings-panel", role: "tabpanel", id: "settings-panel" });
  const renderTab = () => {
    const active = tabs.find((t) => t.id === state.settingsTab) || tabs[0];
    panel.setAttribute("aria-labelledby", `settings-tab-${active.id}`);
    panel.replaceChildren(...active.cards());
  };

  const tabBar = el("nav", { class: "settings-tabs", role: "tablist", "aria-label": "설정 분류" });
  const syncTabs = () => {
    for (const b of tabBar.children) {
      const active = b.dataset.tab === state.settingsTab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    }
  };
  for (const t of tabs) {
    const btn = el("button", {
      class: "settings-tab" + (t.id === state.settingsTab ? " active" : ""),
      type: "button",
      role: "tab",
      id: `settings-tab-${t.id}`,
      "aria-controls": "settings-panel",
      dataset: { tab: t.id },
      onclick: () => {
        if (state.settingsTab === t.id) return;
        state.settingsTab = t.id;
        syncHash(true);
        syncTabs();
        renderTab();
      },
    });
    if (t.icon) btn.append(icon(t.icon));
    btn.append(el("span", { text: t.label }));
    tabBar.append(btn);
  }
  // Standard tablist keyboard interaction: arrows move + activate.
  tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const items = [...tabBar.children];
    const idx = items.findIndex((b) => b.dataset.tab === state.settingsTab);
    const next = items[(idx + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
    next.focus();
    next.click();
  });
  syncTabs();

  renderTab();
  body.replaceChildren(tabBar, panel);
}

function renderRailUser() {
  // refresh the rail "me" row (name + picture) after profile edits
  const meRow = dom.rail?.querySelector(".rail-me");
  if (!meRow) return;
  const nameEl = meRow.querySelector(".meta b");
  if (nameEl) nameEl.textContent = state.user.displayName;
  const oldAvatar = meRow.querySelector(".avatar-img");
  if (oldAvatar) oldAvatar.replaceWith(avatarNode(state.user, 34, { alt: "" }));
}

/**
 * Settings card: designate trusted users who may chat with MY avatar at my own
 * tool-permission level (file edits / command execution run instead of being
 * read-only). Backed by GET/POST/DELETE /api/me/trusted. Trust does NOT expose
 * the owner-only knowledge inbox or greeting — only the elevated tool path.
 */
function buildTrustedUsersCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "신뢰하는 사용자" }),
        el("p", { class: "muted", text: "추가한 사용자는 내 아바타와 대화할 때 소유자와 동일하게 파일 수정·명령 실행 도구를 사용할 수 있습니다(비공개 아바타 포함). 신뢰하는 사람만 추가하세요." }),
      ]),
    ]),
  );
  const list = el("div", { class: "plugin-rows" });
  card.append(list);
  renderTrustedRows(list);

  // Search-and-add: find users by display name OR @id and click to trust them.
  // Replaces the old "type the exact username" form, which required knowing the
  // username verbatim.
  const search = el("input", {
    type: "search",
    class: "trusted-search-input",
    placeholder: "이름 또는 아이디로 검색",
    "aria-label": "신뢰할 사용자 검색 (이름 또는 아이디)",
    autocomplete: "off",
  });
  const results = el("div", { class: "trusted-results", hidden: "" });
  const searchWrap = el("div", { class: "trusted-search" }, [search, results]);
  card.append(searchWrap);

  const addTrusted = async (user) => {
    try {
      const { trusted } = await api("/api/me/trusted", { method: "POST", body: JSON.stringify({ username: user.username }) });
      state.trusted = trusted;
      renderTrustedRows(list);
      search.value = "";
      results.replaceChildren();
      results.hidden = true;
    } catch (err) {
      notify(`추가 실패: ${err.message}`);
    }
  };

  const renderResults = (users) => {
    results.replaceChildren();
    if (!users.length) {
      results.append(el("div", { class: "empty-note", text: "일치하는 사용자가 없습니다." }));
    } else {
      for (const u of users) {
        results.append(
          el("button", {
            type: "button",
            class: "trusted-result",
            disabled: u.trusted ? "" : null,
            title: u.trusted ? "이미 신뢰함" : `${u.displayName} 신뢰에 추가`,
            onclick: () => addTrusted(u),
          }, [
            el("div", { class: "pr-main" }, [
              el("strong", { text: u.displayName }),
              el("div", { class: "pr-sub", text: `@${u.username}` }),
            ]),
            el("span", { class: "trusted-result-cta", text: u.trusted ? "추가됨" : "추가" }),
          ]),
        );
      }
    }
    results.hidden = false;
  };

  // A monotonically increasing sequence guards against out-of-order responses:
  // a slow earlier query must not overwrite a faster later one.
  let searchSeq = 0;
  let searchTimer = null;
  const runSearch = async (q) => {
    const seq = ++searchSeq;
    try {
      const { users } = await api(`/api/me/trusted/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      renderResults(users);
    } catch (err) {
      if (seq !== searchSeq) return;
      results.replaceChildren(el("div", { class: "empty-note", text: `검색 실패: ${err.message}` }));
      results.hidden = false;
    }
  };

  search.addEventListener("input", () => {
    const q = search.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      searchSeq++; // cancel any in-flight query
      results.replaceChildren();
      results.hidden = true;
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 200);
  });
  // Hide the dropdown when focus leaves the search area (delayed so a click on a
  // result registers first — clicking a result moves focus inside searchWrap).
  search.addEventListener("blur", () => {
    setTimeout(() => { if (!searchWrap.contains(document.activeElement)) results.hidden = true; }, 150);
  });
  search.addEventListener("focus", () => {
    if (results.children.length) results.hidden = false;
  });
  return card;
}

function renderTrustedRows(list) {
  list.replaceChildren();
  const trusted = state.trusted || [];
  if (!trusted.length) {
    list.append(el("div", { class: "empty-note", text: "신뢰하는 사용자가 없습니다." }));
    return;
  }
  for (const t of trusted) {
    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": `${t.displayName} 신뢰 해제`, title: "신뢰 해제", onclick: async () => {
      if (!window.confirm(`${t.displayName}님의 신뢰 권한을 해제할까요?`)) return;
      try {
        const { trusted: next } = await api(`/api/me/trusted/${encodeURIComponent(t.id)}`, { method: "DELETE" });
        state.trusted = next;
        renderTrustedRows(list);
      } catch (e) {
        notify(`신뢰 해제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    list.append(
      el("div", { class: "plugin-row" }, [
        el("div", { class: "pr-main" }, [
          el("strong", { text: t.displayName }),
          el("div", { class: "pr-sub", text: `@${t.username}` }),
        ]),
        del,
      ]),
    );
  }
}

// Accessible switch. `label` names it for screen readers (a bare "switch"
// announcing nothing is a WCAG hard-fail). The button disables while onChange
// is in flight and only flips visually when it resolves — callers should
// re-throw on failure so a failed save doesn't render as "on".
function buildToggle(on, onChange, label) {
  const btn = el("button", {
    class: `toggle ${on ? "on" : ""}`,
    type: "button",
    role: "switch",
    "aria-checked": on ? "true" : "false",
    "aria-label": label || "사용",
    title: label || null,
  }, [el("span", { class: "knob" })]);
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const next = !btn.classList.contains("on");
    btn.disabled = true;
    try {
      await onChange(next);
      btn.classList.toggle("on", next);
      btn.setAttribute("aria-checked", next ? "true" : "false");
    } catch {
      /* caller already surfaced the error; keep previous visual state */
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function buildPluginsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [el("h3", { text: "GitHub 플러그인" }), el("p", { class: "muted", text: "내 아바타가 사용할 플러그인. 다른 사용자와의 대화에서는 읽기 전용으로 실행됩니다." })]),
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
      const saved = btn.textContent;
      btn.textContent = "추가 중…"; // server-side git clone — can take a while
      try {
        await api("/api/me/plugins", { method: "POST", body: JSON.stringify({ repo: fd.get("repo"), ref: fd.get("ref") || undefined, label: fd.get("label") || undefined }) });
        await loadPlugins();
        renderPluginRows(list);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        formEl.reset();
      } catch (err) {
        notify(`플러그인 추가 실패: ${err.message}`);
      } finally {
        btn.textContent = saved;
        btn.disabled = false;
      }
    },
  }, [
    el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", "aria-label": "플러그인 저장소 (owner/repo 또는 git URL)", required: "" }),
    el("input", { name: "ref", placeholder: "브랜치/태그 (선택)", "aria-label": "브랜치/태그 (선택)", class: "narrow" }),
    el("input", { name: "label", placeholder: "라벨 (선택)", "aria-label": "라벨 (선택)", class: "narrow" }),
    el("button", { class: "primary", type: "submit", text: "추가" }),
  ]);
  form.classList.add("rows-3");
  card.append(form);
  return card;
}

function pluginSyncLabel(p) {
  if (!p.lastSyncedAt) return "아직 동기화되지 않음";
  const d = new Date(p.lastSyncedAt);
  if (Number.isNaN(d.getTime())) return "";
  return `동기화: ${timeLabel(p.lastSyncedAt)}`;
}

function renderPluginRows(list) {
  list.replaceChildren();
  if (!state.plugins.length) {
    list.append(el("div", { class: "empty-note", text: "추가한 플러그인이 없습니다." }));
    return;
  }
  for (const p of state.plugins) {
    const selSummary = !p.selected
      ? "모든 플러그인 사용"
      : `${p.selected.length}개 선택됨`;
    const sub = el("div", { class: "pr-sub", text: p.ref ? `${p.repo} @ ${p.ref}` : p.repo });
    const meta = el("div", { class: "pr-meta muted" }, [pluginSyncLabel(p), " · ", selSummary]);

    const row = el("div", { class: "plugin-row" }, [
      el("div", { class: "pr-main" }, [
        el("strong", { text: p.label || p.repo }),
        sub,
        meta,
      ]),
      buildToggle(p.enabled, async (val) => {
        try {
          await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
          p.enabled = val;
          invalidateSkillsCache(state.user.id);
          renderPluginRows(list);
        } catch (e) {
          notify(`변경 실패: ${e.message}`);
          throw e;
        }
      }, `플러그인 사용: ${p.label || p.repo}`),
    ]);

    // Expandable contents area for per-plugin selection within the repo.
    const contents = el("div", { class: "plugin-contents", hidden: "" });

    // "선택" — clone/inspect the repo and show a checkbox per contained plugin.
    const selectBtn = el("button", { class: "msg-act", type: "button", "aria-label": "저장소 내 플러그인 선택", title: "저장소 내 플러그인 선택", "aria-expanded": "false", onclick: async () => {
      if (!contents.hidden) {
        contents.hidden = true;
        selectBtn.setAttribute("aria-expanded", "false");
        return;
      }
      contents.hidden = false;
      selectBtn.setAttribute("aria-expanded", "true");
      contents.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
      try {
        const { contents: info } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/contents`);
        renderPluginContents(contents, list, p, info);
      } catch (e) {
        contents.replaceChildren(el("div", { class: "error-note", text: `조회 실패: ${e.message}` }));
      }
    } });
    selectBtn.append(icon("menu"));
    row.append(selectBtn);

    // "새로고침" — force git fetch + checkout, bypassing the clone cache.
    const refreshBtn = el("button", { class: "msg-act", type: "button", "aria-label": "최신 버전으로 새로고침", title: "최신 버전으로 새로고침", onclick: async () => {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("spinning");
      try {
        const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
        Object.assign(p, plugin);
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
      } catch (e) {
        notify(`새로고침 실패: ${e.message}`);
      } finally {
        refreshBtn.classList.remove("spinning");
        refreshBtn.disabled = false;
      }
    } });
    refreshBtn.append(icon("refresh"));
    row.append(refreshBtn);

    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": `플러그인 삭제: ${p.label || p.repo}`, title: "삭제", onclick: async () => {
      if (!window.confirm(`플러그인 "${p.label || p.repo}"을(를) 삭제할까요?`)) return;
      try {
        await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        state.plugins = state.plugins.filter((x) => x.id !== p.id);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
      } catch (e) {
        notify(`삭제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    row.append(del);

    list.append(row);
    list.append(contents);
  }
}

// Render the repo's plugin list with per-plugin checkboxes. For a single-plugin
// repo there's nothing to select; for a marketplace repo the owner picks a
// subset (or "all"). `selected === null` means "load all".
function renderPluginContents(container, list, p, info) {
  container.replaceChildren();
  if (info.kind === "none") {
    container.append(el("div", { class: "error-note", text: "Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음)." }));
    return;
  }
  if (info.kind === "single") {
    container.append(el("div", { class: "muted", text: "단일 플러그인 저장소입니다 — 선택할 항목이 없습니다." }));
    return;
  }
  if (!info.plugins.length) {
    container.append(el("div", { class: "muted", text: "불러올 수 있는 플러그인이 없습니다." }));
    return;
  }

  // null selection = all enabled; otherwise only names in the set.
  const selectedSet = p.selected ? new Set(p.selected) : null;
  const checks = [];
  const head = el("div", { class: "pc-head muted", text: "사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다." });
  container.append(head);

  for (const entry of info.plugins) {
    const checked = !selectedSet || selectedSet.has(entry.name);
    const cb = el("input", { type: "checkbox" });
    cb.checked = checked && entry.loadable;
    cb.disabled = !entry.loadable;
    checks.push({ cb, name: entry.name });
    const labelText = entry.loadable ? entry.name : `${entry.name} (로드 불가)`;
    container.append(el("label", { class: "pc-item" }, [cb, el("span", { text: labelText })]));
  }

  const save = el("button", { class: "primary small", type: "button", text: "선택 저장", onclick: async () => {
    save.disabled = true;
    const loadable = info.plugins.filter((e) => e.loadable).map((e) => e.name);
    const chosen = checks.filter((c) => c.cb.checked).map((c) => c.name);
    // If everything (or nothing) is selected, store null = "load all".
    const selected = chosen.length === 0 || chosen.length === loadable.length ? null : chosen;
    try {
      const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ selected }) });
      Object.assign(p, plugin);
      invalidateSkillsCache(state.user.id);
      renderPluginRows(list);
    } catch (e) {
      notify(`저장 실패: ${e.message}`);
      save.disabled = false;
    }
  } });
  container.append(el("div", { class: "pc-actions" }, [save]));
}

// GitHub 자격증명: a write-only personal access token + commit identity. The
// token is never returned by the server — we only know whether one is set
// (u.gitTokenSet). Used for private plugin repos and knowledge-repo push.
function buildGitCredentialsCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "GitHub 자격증명" }),
        el("p", { class: "muted", text: "비공개 플러그인 저장소 접근과 내 지식 저장소 푸시에 사용됩니다. 토큰은 암호화되어 저장되며 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const status = el("div", { class: "git-token-status muted" });
  const renderStatus = () => {
    status.replaceChildren(
      state.user.gitTokenSet
        ? el("span", { class: "token-set", text: "● 토큰이 설정되어 있습니다" })
        : el("span", { text: "토큰이 설정되지 않았습니다" }),
    );
  };
  renderStatus();

  const tokenForm = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const token = (fd.get("token") || "").toString().trim();
      if (!token) return;
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
        state.user = user;
        formEl.reset();
        renderStatus();
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    },
  }, [
    el("input", { name: "token", type: "password", placeholder: "GitHub personal access token (repo 권한)", "aria-label": "GitHub 토큰", required: "", autocomplete: "off" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);

  const clearBtn = el("button", {
    class: "linkish small",
    type: "button",
    text: "토큰 삭제",
    onclick: async () => {
      if (!window.confirm("저장된 GitHub 토큰을 삭제할까요? 비공개 저장소 접근과 지식 저장소 푸시가 중단됩니다.")) return;
      try {
        const { user } = await api("/api/me/git-token", { method: "DELETE" });
        state.user = user;
        renderStatus();
      } catch (e) {
        notify(`삭제 실패: ${e.message}`);
      }
    },
  });

  // Commit identity used for knowledge-repo pushes.
  const identityForm = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      const saved = btn.textContent;
      btn.textContent = "저장 중…";
      try {
        const { user } = await api("/api/me/git-identity", {
          method: "PUT",
          body: JSON.stringify({ name: fd.get("name") || null, email: fd.get("email") || null }),
        });
        state.user = user;
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; btn.disabled = false; }, 1200);
      } catch (err) {
        btn.textContent = saved;
        btn.disabled = false;
        notify(`저장 실패: ${err.message}`);
      }
    },
  }, [
    el("div", { class: "field-row-2col" }, [
      el("label", { class: "field" }, [el("span", { text: "커밋 이름" }), el("input", { name: "name", value: u.gitIdentityName || "", placeholder: u.alias || u.displayName || "" })]),
      el("label", { class: "field" }, [el("span", { text: "커밋 이메일" }), el("input", { name: "email", type: "email", value: u.gitIdentityEmail || "", placeholder: `${u.username}@example.com` })]),
    ]),
    el("button", { class: "primary", type: "submit", text: "커밋 정보 저장" }),
  ]);

  card.append(status, tokenForm, el("div", { class: "git-token-actions" }, [clearBtn]), identityForm);
  return card;
}

// 시크릿: write-only named secrets (e.g. SSH_PRIVATE_KEY) encrypted at rest.
// Values are injected ONLY into the avatar's MCP tool subprocesses as env, so
// the avatar can use them (e.g. ssh into your servers) without ever seeing the
// raw value, and they're never returned to the client. We only know the NAMES
// that are set (u.secretNames). The avatar uses ITS OWNER's secrets regardless
// of who is chatting with it.
function buildSecretsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "시크릿" }),
        el("p", { class: "muted", text: "내 아바타가 도구를 쓸 때만 주입되는 비밀값(예: SSH_PRIVATE_KEY). 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다. SSH 원격 접속에 쓰려면 OpenSSH 형식 개인키를 SSH_PRIVATE_KEY로 등록하세요." }),
      ]),
    ]),
  );

  // List of currently-set secret names, each with a delete button.
  const list = el("div", { class: "secret-list" });
  const renderList = () => {
    const names = state.user.secretNames || [];
    if (!names.length) {
      list.replaceChildren(el("div", { class: "muted", text: "등록된 시크릿이 없습니다." }));
      return;
    }
    list.replaceChildren(
      ...names.map((name) =>
        el("div", { class: "secret-row" }, [
          el("code", { text: name }),
          el("span", { class: "muted token-set", text: "● 설정됨" }),
          el("button", {
            class: "linkish small",
            type: "button",
            text: "삭제",
            "aria-label": `시크릿 삭제: ${name}`,
            onclick: async () => {
              if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
              try {
                const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
                state.user = user;
                renderList();
              } catch (err) {
                notify(`삭제 실패: ${err.message}`);
              }
            },
          }),
        ]),
      ),
    );
  };
  renderList();

  // Add/update form: an env-style NAME plus a (multiline-capable) value.
  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const name = (fd.get("name") || "").toString().trim();
      const value = (fd.get("value") || "").toString();
      if (!name || !value) {
        notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
        return;
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
        state.user = user;
        formEl.reset();
        renderList();
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: "이름" }),
      el("input", { name: "name", placeholder: "SSH_PRIVATE_KEY", autocomplete: "off", required: "" }),
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "값" }),
      el("textarea", { name: "value", rows: "4", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----…", autocomplete: "off", required: "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "시크릿 저장" }),
  ]);

  card.append(list, form);
  return card;
}

// Convert an `owner/repo` or git/https URL into a browsable https GitHub link,
// or null if we can't (e.g. ssh `git@` remote). Strips a trailing `.git`.
function repoToHref(repo) {
  if (!repo) return null;
  const r = repo.trim();
  if (/^https?:\/\//.test(r)) return r.replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
    const host = (state.githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
    return `https://${host}/${r.replace(/\.git$/, "")}`;
  }
  return null;
}

// 지식 저장소: configure the personal knowledge repo (owner/repo or git URL).
// The avatar itself browses/edits/commits the repo via chat (the owner-only
// mcp__repo__* tools), so this card only points at the repo + shows its status.
function buildKnowledgeRepoCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  // When a repo is connected, offer a refresh button that re-fetches it from the
  // remote (ensureClone does git fetch + checkout). Useful after the owner pushes
  // changes from elsewhere and wants the avatar to pick them up without waiting
  // for a process restart.
  const headerActions = [];
  if (u.knowledgeRepo) {
    const refreshBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "새로고침",
      title: "저장소를 원격에서 다시 가져옵니다",
      onclick: async () => {
        refreshBtn.disabled = true;
        const saved = refreshBtn.textContent;
        refreshBtn.textContent = "새로고침 중…";
        try {
          await api("/api/me/knowledge-repo/refresh", { method: "POST" });
          invalidateSkillsCache(state.user.id);
          refreshBtn.textContent = "새로고침됨 ✓";
          setTimeout(() => { refreshBtn.textContent = saved; refreshBtn.disabled = false; }, 1200);
        } catch (e) {
          refreshBtn.textContent = saved;
          refreshBtn.disabled = false;
          notify(`새로고침 실패: ${e.message}`);
        }
      },
    });
    headerActions.push(refreshBtn);
  }
  headerActions.push(el("button", { class: "linkish small", type: "button", text: "설정 안내 다시 보기", onclick: () => openOnboarding() }));
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "지식 저장소" }),
        el("p", { class: "muted", text: "내 아바타가 일하며 쌓는 지식·스킬을 담는 전용 저장소. 아바타와 대화하며 직접 파일을 추가·수정·커밋하도록 시킬 수 있어요." }),
      ]),
      el("div", { class: "head-actions" }, headerActions),
    ]),
  );

  // Repo configuration form.
  const repoForm = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const { user } = await api("/api/me/knowledge-repo", {
          method: "PUT",
          body: JSON.stringify({ repo: (fd.get("repo") || "").toString().trim() || null, branch: (fd.get("branch") || "").toString().trim() || null }),
        });
        state.user = user;
        renderView();
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    },
  }, [
    el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", "aria-label": "지식 저장소 (owner/repo 또는 git URL)", value: u.knowledgeRepo || "" }),
    el("input", { name: "branch", placeholder: "브랜치 (선택)", "aria-label": "브랜치 (선택)", class: "narrow", value: u.knowledgeBranch || "" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  repoForm.classList.add("rows-2");
  card.append(repoForm);

  if (!u.knowledgeRepo) {
    card.append(el("div", { class: "empty-note", text: "지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요." }));
    return card;
  }

  // Connected: show a clickable link + token status.
  const href = repoToHref(u.knowledgeRepo);
  const link = href
    ? el("a", { href, target: "_blank", rel: "noreferrer noopener", text: u.knowledgeRepo + (u.knowledgeBranch ? ` @ ${u.knowledgeBranch}` : "") })
    : el("code", { text: u.knowledgeRepo + (u.knowledgeBranch ? ` @ ${u.knowledgeBranch}` : "") });
  card.append(el("div", { class: "kr-link" }, [icon("globe"), link]));
  card.append(
    el("div", { class: "git-token-status muted" }, [
      u.gitTokenSet
        ? el("span", { class: "token-set", text: "● GitHub 토큰 연결됨 · 아바타가 커밋·푸시할 수 있어요" })
        : el("span", {}, [
            // The git-credentials card lives in a DIFFERENT tab — link there
            // instead of pointing at a card that isn't on this screen.
            "토큰이 없어 읽기만 가능합니다. ",
            el("button", {
              class: "linkish",
              type: "button",
              text: "권한·연결 탭의 GitHub 자격증명",
              onclick: () => {
                state.settingsTab = "access";
                syncHash(true);
                renderView();
              },
            }),
            "에서 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.",
          ]),
    ]),
  );

  // Plugin selection: the repo's plugins are all loaded by default; the owner
  // can deselect some here. Mirrors the marketplace-plugin selection UI.
  const selSummary = !u.knowledgeSelected
    ? "저장소의 모든 플러그인을 사용 중"
    : `${u.knowledgeSelected.length}개 플러그인만 사용 중`;
  const contents = el("div", { class: "plugin-contents", hidden: "" });
  const pickBtn = el("button", { class: "linkish small", type: "button", text: "사용할 플러그인 선택", "aria-expanded": "false" });
  pickBtn.onclick = async () => {
    if (!contents.hidden) {
      contents.hidden = true;
      pickBtn.setAttribute("aria-expanded", "false");
      return;
    }
    contents.hidden = false;
    pickBtn.setAttribute("aria-expanded", "true");
    contents.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const { contents: info } = await api("/api/me/knowledge-repo/contents");
      renderKnowledgeRepoContents(contents, info);
    } catch (e) {
      contents.replaceChildren(el("div", { class: "error-note", text: `조회 실패: ${e.message}` }));
    }
  };
  card.append(
    el("div", { class: "kr-plugins" }, [
      el("span", { class: "muted", text: selSummary }),
      pickBtn,
    ]),
  );
  card.append(contents);
  return card;
}

// Render the knowledge repo's plugin list with per-plugin checkboxes. The repo
// is the avatar's by default, so all plugins load unless the owner deselects
// some; `knowledgeSelected === null` means "load all". Mirrors
// `renderPluginContents`.
function renderKnowledgeRepoContents(container, info) {
  container.replaceChildren();
  if (info.kind === "none") {
    container.append(el("div", { class: "error-note", text: "Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음)." }));
    return;
  }
  if (info.kind === "single") {
    container.append(el("div", { class: "muted", text: "단일 플러그인 저장소입니다 — 선택할 항목이 없습니다." }));
    return;
  }
  if (!info.plugins.length) {
    container.append(el("div", { class: "muted", text: "불러올 수 있는 플러그인이 없습니다." }));
    return;
  }

  const selectedSet = state.user.knowledgeSelected ? new Set(state.user.knowledgeSelected) : null;
  const checks = [];
  container.append(el("div", { class: "pc-head muted", text: "아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다." }));

  for (const entry of info.plugins) {
    const checked = !selectedSet || selectedSet.has(entry.name);
    const cb = el("input", { type: "checkbox" });
    cb.checked = checked && entry.loadable;
    cb.disabled = !entry.loadable;
    checks.push({ cb, name: entry.name });
    const labelText = entry.loadable ? entry.name : `${entry.name} (로드 불가)`;
    container.append(el("label", { class: "pc-item" }, [cb, el("span", { text: labelText })]));
  }

  const save = el("button", { class: "primary small", type: "button", text: "선택 저장", onclick: async () => {
    save.disabled = true;
    const loadable = info.plugins.filter((e) => e.loadable).map((e) => e.name);
    const chosen = checks.filter((c) => c.cb.checked).map((c) => c.name);
    // All (or none) selected → store null = "load all".
    const selected = chosen.length === 0 || chosen.length === loadable.length ? null : chosen;
    try {
      const { user } = await api("/api/me/knowledge-repo/selected", { method: "PUT", body: JSON.stringify({ selected }) });
      state.user = user;
      invalidateSkillsCache(state.user.id);
      renderView();
    } catch (e) {
      notify(`저장 실패: ${e.message}`);
      save.disabled = false;
    }
  } });
  container.append(el("div", { class: "pc-actions" }, [save]));
}

function buildRoutinesCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "루틴" }),
        el("p", { class: "muted", text: "내 아바타가 매일 정해진 시각(한국 시간, KST)에 스스로 실행할 작업. 결과는 전용 대화에 쌓입니다." }),
      ]),
    ]),
  );
  const list = el("div", { class: "plugin-rows" });
  card.append(list);
  renderRoutineRows(list);

  const form = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/me/routines", {
          method: "POST",
          body: JSON.stringify({ prompt: fd.get("prompt"), time: fd.get("time") }),
        });
        await loadRoutines();
        renderRoutineRows(list);
        formEl.reset();
      } catch (err) {
        notify(`루틴 추가 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    },
  }, [
    el("input", { name: "prompt", placeholder: "예: 오늘의 서비스 상태를 요약해줘", "aria-label": "루틴 작업 내용", required: "" }),
    el("input", { name: "time", type: "time", value: "09:00", required: "", class: "narrow", "aria-label": "매일 실행 시각" }),
    el("button", { class: "primary", type: "submit", text: "추가" }),
  ]);
  form.classList.add("rows-2");
  card.append(form);
  return card;
}

function renderRoutineRows(list) {
  list.replaceChildren();
  if (!state.routines.length) {
    list.append(el("div", { class: "empty-note", text: "등록한 루틴이 없습니다." }));
    return;
  }
  for (const r of state.routines) {
    const statusBits = [`매일 ${r.time} (KST)`];
    if (r.lastRunAt) {
      const mark = r.lastStatus === "error" ? "실패" : "완료";
      statusBits.push(`최근 실행: ${timeLabel(r.lastRunAt)} (${mark})`);
    } else {
      statusBits.push("아직 실행되지 않음");
    }

    const row = el("div", { class: "plugin-row" }, [
      el("div", { class: "pr-main" }, [
        el("strong", { text: r.prompt }),
        el("div", { class: "pr-sub", text: statusBits.join(" · ") }),
        r.lastStatus === "error" && r.lastError
          ? el("div", { class: "pr-sub", text: `실행 오류 — ${r.lastError}` })
          : null,
      ]),
      buildToggle(r.enabled, async (val) => {
        try {
          await api(`/api/me/routines/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
          r.enabled = val;
          await loadRoutines();
          renderRoutineRows(list);
        } catch (e) {
          notify(`변경 실패: ${e.message}`);
          throw e;
        }
      }, `루틴 사용: ${r.prompt}`),
    ]);

    const actions = el("div", { class: "kr-actions" });
    const runBtn = el("button", { class: "ghost-sm", type: "button", text: "지금 실행", onclick: async () => {
      runBtn.disabled = true;
      runBtn.textContent = "실행 중…";
      try {
        const res = await api(`/api/me/routines/${encodeURIComponent(r.id)}/run`, { method: "POST" });
        await loadRoutines();
        renderRoutineRows(list);
        if (!res.ok) notify(`루틴 실행 실패: ${res.error || "알 수 없는 오류"}`);
      } catch (e) {
        notify(`루틴 실행 실패: ${e.message}`);
        runBtn.disabled = false;
        runBtn.textContent = "지금 실행";
      }
    } });
    actions.append(runBtn);
    actions.append(el("button", { class: "ghost-sm", type: "button", text: "결과 보기", onclick: () => {
      selectConversation({ id: r.conversationId, avatarUserId: state.user.id, avatarDisplayName: state.user.displayName });
    } }));
    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": "루틴 삭제", title: "삭제", onclick: async () => {
      if (!window.confirm("이 루틴을 삭제할까요? (쌓인 결과 대화는 그대로 남습니다)")) return;
      try {
        await api(`/api/me/routines/${encodeURIComponent(r.id)}`, { method: "DELETE" });
        state.routines = state.routines.filter((x) => x.id !== r.id);
        renderRoutineRows(list);
      } catch (e) {
        notify(`삭제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    actions.append(del);
    row.append(actions);
    list.append(row);
  }
}

function buildKnowledgeCard() {
  const card = el("section", { class: "settings-card" });
  const countLabel = () => {
    const openCount = state.knowledgeRequests.filter((r) => r.status === "open").length;
    return `지식·정보 요청${openCount ? ` (${openCount})` : ""}`;
  };
  const titleEl = el("h3", { text: countLabel() });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        titleEl,
        el("p", { class: "muted", text: "동료가 모르는 것을 물으면 여기에 정보 요청으로 쌓입니다. 아바타와 대화하며 답을 지식 저장소에 기록하게 하면 영구히 학습됩니다." }),
      ]),
    ]),
  );

  const reqList = el("div", { class: "knowledge-rows" });
  card.append(el("h4", { class: "knowledge-sub", text: "대기 중인 정보 요청" }), reqList);

  const refresh = async () => {
    try {
      await loadKnowledge();
    } catch (e) {
      /* keep current state */
    }
    titleEl.textContent = countLabel(); // header count must track resolves
    updateKnowledgeBadge();
    renderKnowledgeRequests(reqList);
  };
  renderKnowledgeRequests(reqList, refresh);
  // wire refresh into the renderer via closure on next render
  reqList._refresh = refresh;
  return card;
}

function renderKnowledgeRequests(list, refresh) {
  refresh = refresh || list._refresh;
  list.replaceChildren();
  const open = state.knowledgeRequests.filter((r) => r.status === "open");
  if (!open.length) {
    list.append(el("div", { class: "empty-note", text: "대기 중인 정보 요청이 없습니다." }));
    return;
  }
  for (const r of open) {
    const resolveBtn = el("button", { class: "primary small", type: "button", text: "처리 완료", onclick: async () => {
      resolveBtn.disabled = true;
      try {
        await api(`/api/me/knowledge/requests/${encodeURIComponent(r.id)}`, { method: "DELETE" });
        await refresh?.();
      } catch (e) {
        resolveBtn.disabled = false;
        notify(`처리 실패: ${e.message}`);
      }
    } });
    list.append(el("div", { class: "knowledge-row" }, [
      el("div", { class: "kr-q", text: r.question }),
      r.askerName ? el("div", { class: "muted kr-meta", text: `질문자: ${r.askerName} · ${timeLabel(r.createdAt)}` }) : el("div", { class: "muted kr-meta", text: timeLabel(r.createdAt) }),
      el("div", { class: "kr-actions" }, [resolveBtn]),
    ]));
  }
}

/* ============================================================ Admin */
const ADMIN_TABS = [
  { id: "overview", label: "개요", icon: "activity" },
  { id: "users", label: "사용자", icon: "users" },
  { id: "access", label: "가입·접근", icon: "key" },
  { id: "system", label: "시스템", icon: "server" },
  { id: "audit", label: "감사 로그", icon: "list" },
];
const ADMIN_TAB_BUILDERS = {
  overview: adminOverviewCards,
  users: adminUsersCards,
  access: adminAccessCards,
  system: adminSystemCards,
  audit: adminAuditCards,
};

async function renderAdmin() {
  const header = viewHeader("관리자", "사용자·접근·시스템을 관리하세요");
  const body = el("div", { class: "view-body scroll-thin" });
  dom.main.append(header, body);
  if (!ADMIN_TABS.some((t) => t.id === state.adminTab)) state.adminTab = "overview";

  const panel = el("div", { class: "admin-panel", role: "tabpanel", id: "admin-panel" });
  const renderTab = async () => {
    panel.setAttribute("aria-labelledby", `admin-tab-${state.adminTab}`);
    panel.replaceChildren(el("div", { class: "muted pad", text: "불러오는 중…" }));
    try {
      const build = ADMIN_TAB_BUILDERS[state.adminTab] || adminOverviewCards;
      const nodes = await build();
      panel.replaceChildren(...nodes);
    } catch (e) {
      panel.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderTab() }),
        ]),
      );
    }
  };

  const tabBar = el("nav", { class: "settings-tabs", role: "tablist", "aria-label": "관리자 분류" });
  const syncTabs = () => {
    for (const b of tabBar.children) {
      const active = b.dataset.tab === state.adminTab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    }
  };
  for (const t of ADMIN_TABS) {
    const btn = el("button", {
      class: "settings-tab" + (t.id === state.adminTab ? " active" : ""),
      type: "button",
      role: "tab",
      id: `admin-tab-${t.id}`,
      "aria-controls": "admin-panel",
      dataset: { tab: t.id },
      onclick: () => {
        if (state.adminTab === t.id) return;
        state.adminTab = t.id;
        syncHash(true);
        syncTabs();
        renderTab();
      },
    });
    btn.append(icon(t.icon), el("span", { text: t.label }));
    tabBar.append(btn);
  }
  tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const items = [...tabBar.children];
    const idx = items.findIndex((b) => b.dataset.tab === state.adminTab);
    const next = items[(idx + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
    next.focus();
    next.click();
  });
  syncTabs();

  body.replaceChildren(tabBar, panel);
  await renderTab();
}

/* ---- 개요 (dashboard) ---- */
async function adminOverviewCards() {
  await loadAdminStats();
  const s = state.adminStats || {};
  const stat = (label, value, sub) =>
    el("div", { class: "stat-card" }, [
      el("div", { class: "stat-value", text: String(value ?? 0) }),
      el("div", { class: "stat-label", text: label }),
      sub ? el("div", { class: "stat-sub muted", text: sub }) : null,
    ]);
  const grid = el("div", { class: "stat-grid" }, [
    stat("전체 사용자", s.users, s.suspended ? `정지 ${s.suspended}명 포함` : null),
    stat("관리자", s.admins),
    stat("공개 아바타", s.published),
    stat("대화", s.conversations),
    stat("메시지", s.messages),
    stat("활성 루틴", s.activeRoutines),
    stat("미응답 질문", s.openRequests),
    stat("활성 세션", s.activeSessions),
  ]);
  return [
    el("div", { class: "admin-list" }, [
      el("section", { class: "settings-card" }, [
        el("h3", { text: "현황" }),
        el("p", { class: "muted", text: "이 인스턴스의 전체 사용 현황입니다." }),
        grid,
      ]),
    ]),
  ];
}

/* ---- 사용자 (user management) ---- */
async function adminUsersCards() {
  await loadAdminUsers();
  const list = el("div", { class: "admin-list" });
  const reload = async () => {
    await loadAdminUsers();
    renderList();
  };
  const renderList = () => {
    const q = state.adminUserSearch.trim().toLowerCase();
    const users = state.adminUsers.filter(
      (u) =>
        !q ||
        (u.displayName || "").toLowerCase().includes(q) ||
        (u.username || "").toLowerCase().includes(q),
    );
    if (!users.length) {
      list.replaceChildren(
        el("div", { class: "muted pad", text: q ? "일치하는 사용자가 없습니다." : "사용자가 없습니다." }),
      );
      return;
    }
    list.replaceChildren(...users.map((u) => adminUserRow(u, reload)));
  };

  const search = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "이름 또는 아이디로 검색",
    value: state.adminUserSearch,
    "aria-label": "사용자 검색",
  });
  search.addEventListener("input", () => {
    state.adminUserSearch = search.value;
    renderList();
  });

  renderList();
  const head = el("div", { class: "admin-users-head" }, [
    search,
    el("span", { class: "muted nowrap", text: `총 ${state.adminUsers.length}명` }),
  ]);
  return [el("div", { class: "admin-users" }, [head, list])];
}

function adminUserRow(u, reload) {
  const isMe = u.id === state.user.id;
  const isAdmin = u.roles?.includes("admin");
  const tags = el("div", { class: "ar-tags" }, [
    el("span", { class: `tag ${isAdmin ? "write" : "read"}`, text: isAdmin ? "관리자" : "멤버" }),
    u.published ? el("span", { class: "tag accent", text: "공개" }) : null,
    u.suspended ? el("span", { class: "tag danger", text: "정지" }) : null,
    isMe ? el("span", { class: "tag", text: "나" }) : null,
  ]);

  const detail = el("div", { class: "ar-detail" });
  detail.hidden = true;
  let loaded = false;
  const manageBtn = el("button", { class: "ghost-sm", type: "button", text: "관리" });
  manageBtn.setAttribute("aria-expanded", "false");
  manageBtn.addEventListener("click", async () => {
    if (!detail.hidden) {
      detail.hidden = true;
      manageBtn.setAttribute("aria-expanded", "false");
      return;
    }
    detail.hidden = false;
    manageBtn.setAttribute("aria-expanded", "true");
    if (loaded) return;
    detail.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const d = await loadAdminUserDetail(u.id);
      detail.replaceChildren(buildUserDetailGrid(d), buildUserActions(u, isAdmin, isMe, reload));
      loaded = true;
    } catch (e) {
      detail.replaceChildren(el("div", { class: "warn-box", text: `불러오기 실패: ${e.message}` }));
    }
  });

  const lastSeen = u.lastSeenAt ? timeLabel(u.lastSeenAt) : "기록 없음";
  const row = el("div", { class: "admin-row" }, [
    avatarNode(u, 40, { alt: "" }),
    el("div", { class: "ar-main" }, [
      el("strong", { text: u.displayName }),
      el("div", { class: "muted", text: `@${u.username} · 가입 ${timeLabel(u.createdAt)} · 최근 ${lastSeen}` }),
    ]),
    tags,
    el("div", { class: "ar-actions" }, [manageBtn]),
  ]);
  return el("div", { class: "admin-user" + (u.suspended ? " is-suspended" : "") }, [row, detail]);
}

function buildUserDetailGrid(d) {
  const item = (k, v) =>
    el("div", { class: "ud-item" }, [
      el("span", { class: "ud-val", text: String(v ?? 0) }),
      el("span", { class: "ud-key muted", text: k }),
    ]);
  return el("div", { class: "ud-grid" }, [
    item("시작한 대화", d.conversationsStarted),
    item("받은 대화", d.conversationsReceived),
    item("플러그인", d.pluginCount),
    item("루틴", `${d.routinesActive}/${d.routinesTotal}`),
    item("시크릿", d.secretCount),
    item("활성 세션", d.activeSessions),
    item("미응답 질문", d.openRequests),
    item("Git 토큰", d.gitTokenSet ? "있음" : "없음"),
    item("지식 저장소", d.knowledgeRepoSet ? "연결됨" : "없음"),
  ]);
}

function buildUserActions(u, isAdmin, isMe, reload) {
  const wrap = el("div", { class: "ud-actions" });
  const run = async (btn, fn, errLabel) => {
    btn.disabled = true;
    try {
      await fn();
      await reload();
    } catch (e) {
      btn.disabled = false;
      notify(`${errLabel}: ${e.message}`);
    }
  };
  const uid = encodeURIComponent(u.id);

  const roleBtn = el("button", { class: "ghost-sm", type: "button", text: isAdmin ? "관리자 해제" : "관리자 지정" });
  if (isMe) roleBtn.disabled = true;
  roleBtn.addEventListener("click", () => {
    const verb = isAdmin ? "해제" : "부여";
    if (!window.confirm(`${u.displayName}(@${u.username})님의 관리자 권한을 ${verb}할까요?`)) return;
    run(roleBtn, () => api(`/api/admin/users/${uid}/roles`, { method: "POST", body: JSON.stringify({ role: "admin", grant: !isAdmin }) }), "권한 변경 실패");
  });

  const pubBtn = el("button", { class: "ghost-sm", type: "button", text: u.published ? "비공개로 전환" : "공개로 전환" });
  pubBtn.addEventListener("click", () => {
    run(pubBtn, () => api(`/api/admin/users/${uid}/published`, { method: "POST", body: JSON.stringify({ published: !u.published }) }), "공개 설정 실패");
  });

  const susBtn = el("button", { class: "ghost-sm" + (u.suspended ? "" : " danger"), type: "button", text: u.suspended ? "활성화" : "정지" });
  if (isMe) susBtn.disabled = true;
  susBtn.addEventListener("click", () => {
    if (!u.suspended && !window.confirm(`${u.displayName} 계정을 정지할까요?\n로그인과 활성 세션이 즉시 차단됩니다.`)) return;
    run(susBtn, () => api(`/api/admin/users/${uid}/suspend`, { method: "POST", body: JSON.stringify({ suspended: !u.suspended }) }), "상태 변경 실패");
  });

  const pwBtn = el("button", { class: "ghost-sm", type: "button", text: "비밀번호 재설정" });
  pwBtn.addEventListener("click", () => {
    const pw = window.prompt(`${u.displayName}님의 새 비밀번호 (8자 이상).\n설정하면 이 사용자의 기존 세션이 모두 로그아웃됩니다.`);
    if (pw === null) return;
    if (pw.length < 8) {
      notify("비밀번호는 8자 이상이어야 합니다.", "warn");
      return;
    }
    run(
      pwBtn,
      async () => {
        await api(`/api/admin/users/${uid}/password`, { method: "POST", body: JSON.stringify({ password: pw }) });
        notify("비밀번호를 재설정했습니다.", "ok");
      },
      "재설정 실패",
    );
  });

  const outBtn = el("button", { class: "ghost-sm", type: "button", text: "강제 로그아웃" });
  outBtn.addEventListener("click", () => {
    run(
      outBtn,
      async () => {
        const r = await api(`/api/admin/users/${uid}/logout`, { method: "POST" });
        notify(`세션 ${r.revoked ?? 0}개를 종료했습니다.`, "ok");
      },
      "로그아웃 실패",
    );
  });

  const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "삭제" });
  if (isMe) delBtn.disabled = true;
  delBtn.addEventListener("click", () => {
    if (!window.confirm(`${u.displayName}(@${u.username}) 계정을 삭제할까요?\n이 사용자의 아바타·대화·설정이 모두 영구 삭제되며 되돌릴 수 없습니다.`)) return;
    run(delBtn, () => api(`/api/admin/users/${uid}`, { method: "DELETE" }), "삭제 실패");
  });

  wrap.append(roleBtn, pubBtn, susBtn, pwBtn, outBtn, delBtn);
  if (isMe) {
    wrap.append(el("p", { class: "muted ud-self-note", text: "자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다." }));
  }
  return wrap;
}

/* ---- 가입·접근 (signup policy) ---- */
async function adminAccessCards() {
  await loadAdminSystem();
  return [el("div", { class: "admin-list" }, [buildSignupModeCard(state.adminSystem)])];
}

function buildSignupModeCard(sys) {
  const current = sys?.signupMode || "open";
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "회원가입 정책" }),
        el("p", {
          class: "muted",
          text: "새 사용자가 스스로 가입하는 방식을 정합니다. 첫 관리자 계정은 정책과 무관하게 항상 허용됩니다.",
        }),
      ]),
    ]),
  );
  const modes = [
    { id: "open", label: "개방", desc: "누구나 즉시 가입하고 바로 사용할 수 있습니다." },
    { id: "approval", label: "승인 후 사용", desc: "가입은 가능하지만 관리자가 활성화해야 로그인됩니다. 대기 중인 계정은 사용자 탭에 ‘정지’ 상태로 표시됩니다." },
    { id: "closed", label: "차단", desc: "신규 가입을 받지 않습니다." },
  ];
  const opts = el("div", { class: "radio-cards" });
  for (const m of modes) {
    const input = el("input", { type: "radio", name: "signup-mode", id: `sm-${m.id}` });
    input.value = m.id;
    input.checked = m.id === current;
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      opts.querySelectorAll("input").forEach((i) => (i.disabled = true));
      try {
        await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode: m.id }) });
        state.signupMode = m.id;
        notify("회원가입 정책을 저장했습니다.", "ok");
        await loadAdminSystem();
      } catch (e) {
        notify(`저장 실패: ${e.message}`);
        // Restore the last-saved selection rather than leaving the group blank.
        const prior = opts.querySelector(`#sm-${state.signupMode || current}`);
        if (prior) prior.checked = true;
        else input.checked = false;
      } finally {
        opts.querySelectorAll("input").forEach((i) => (i.disabled = false));
      }
    });
    opts.append(
      el("label", { class: "radio-card", for: `sm-${m.id}` }, [
        input,
        el("div", { class: "radio-card-body" }, [
          el("strong", { text: m.label }),
          el("div", { class: "muted", text: m.desc }),
        ]),
      ]),
    );
  }
  card.append(opts);
  return card;
}

/* ---- 감사 로그 ---- */
async function adminAuditCards() {
  await loadAudit();
  const rows = state.audit || [];
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "감사 로그" }),
        el("p", { class: "muted", text: `최근 활동 ${rows.length}건 (로그인·권한 변경·관리 작업 등).` }),
      ]),
    ]),
  );

  const tableWrap = el("div", { class: "audit-table-wrap" });
  const render = (filterAction) => {
    const shown = filterAction ? rows.filter((r) => r.action === filterAction) : rows;
    if (!shown.length) {
      tableWrap.replaceChildren(el("div", { class: "muted pad", text: "기록이 없습니다." }));
      return;
    }
    const body = shown.map((r) =>
      el("div", { class: "audit-row" }, [
        el("span", { class: "audit-time muted", text: timeLabel(r.createdAt) }),
        el("span", { class: "audit-actor", text: r.actorName || "—" }),
        el("span", { class: "tag mono", text: r.action }),
        el("span", { class: `tag ${r.status === "success" ? "read" : "danger"}`, text: r.status }),
        el("span", { class: "audit-detail muted", text: r.detail || "" }),
      ]),
    );
    tableWrap.replaceChildren(el("div", { class: "audit-table" }, body));
  };

  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const filter = el("select", { class: "admin-search", "aria-label": "액션 필터" });
  filter.append(el("option", { value: "", text: "전체 액션" }));
  for (const a of actions) filter.append(el("option", { value: a, text: a }));
  filter.addEventListener("change", () => render(filter.value));

  card.append(el("div", { class: "admin-users-head" }, [filter]), tableWrap);
  render("");
  return [el("div", { class: "admin-list" }, [card])];
}

/* Admin "시스템" tab: runtime/model info + subscription + model override + SSH policy. */
async function adminSystemCards() {
  await loadAdminSystem();
  const sys = state.adminSystem;
  if (!sys) return [el("div", { class: "muted pad", text: "시스템 정보를 불러올 수 없습니다." })];
  const runtimeLabel = sys.agentRuntime === "claude" ? "Claude Agent SDK" : "로컬 스텁";
  const authLabel = sys.authMode === "api_key" ? "API 키" : "구독 로그인";
  const rows = [
    sysRow("런타임", el("span", { class: "tag mono", text: runtimeLabel })),
    sysRow(
      "설정된 모델",
      sys.configuredModel
        ? el("span", { class: "tag mono", text: sys.configuredModel })
        : el("span", { class: "muted", text: "미설정 (SDK 기본값)" }),
    ),
    sysRow(
      "실제 사용 모델",
      sys.observedModel
        ? el("span", { class: "tag mono accent", text: sys.observedModel })
        : el("span", { class: "muted", text: "아직 확인되지 않음 (첫 대화 후 표시)" }),
    ),
    sysRow("인증 방식", el("span", { class: "tag", text: authLabel })),
    sysRow(
      "읽기 전용 도구",
      el("span", { class: "muted", text: (sys.readOnlyTools || []).join(", ") || "없음" }),
    ),
  ];
  return [
    el("div", { class: "admin-list" }, [
      el("div", { class: "settings-card sys-card" }, [
        el("h3", { text: "시스템 정보" }),
        el("div", { class: "sys-grid" }, rows),
      ]),
      buildSubscriptionCard(sys),
      buildModelOverrideCard(sys),
      buildHexSshPolicyCard(sys),
    ]),
  ];
}

/* Admin model-override card: pick the agent model from the UI. An env
   ANTHROPIC_MODEL wins at runtime — surfaced here so the choice isn't silent. */
function buildModelOverrideCard(sys) {
  const override = sys.modelOverride || "";
  const envLocked = Boolean(sys.modelEnvLocked);
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "에이전트 모델" }),
        el("p", {
          class: "muted",
          text: "아바타 대화에 사용할 모델을 지정합니다. 비워 두면 SDK 기본값을 사용합니다. 예: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001.",
        }),
      ]),
    ]),
  );
  if (envLocked) {
    card.append(
      el("p", {
        class: "muted",
        text: ".env의 ANTHROPIC_MODEL이 설정되어 있어 환경 변수가 우선합니다. 아래 설정은 환경 변수가 없을 때만 적용됩니다.",
      }),
    );
  }
  const form = el(
    "form",
    {
      class: "settings-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const value = (new FormData(e.currentTarget).get("model") || "").toString().trim();
        const btn = e.currentTarget.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          if (value) {
            await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model: value }) });
            notify("모델을 저장했습니다.", "ok");
          } else {
            await api("/api/admin/model", { method: "DELETE" });
            notify("모델 지정을 해제했습니다. SDK 기본값을 사용합니다.", "ok");
          }
          await loadAdminSystem();
          renderView();
        } catch (err) {
          btn.disabled = false;
          notify(`저장 실패: ${err.message}`);
        }
      },
    },
    [
      el("label", { class: "field" }, [
        el("span", { text: "모델 이름" }),
        el("input", { name: "model", value: override, placeholder: "claude-opus-4-8 (비우면 기본값)", autocomplete: "off" }),
      ]),
      el("button", { class: "primary", type: "submit", text: "저장" }),
    ],
  );
  card.append(form);
  return card;
}

/* Admin 구독 로그인 card: paste a `claude setup-token` token so the agent runs
   on a Claude subscription instead of an API key. Write-only — the stored token
   is never sent back, only whether one is present (sys.subscriptionConnected). */
function buildSubscriptionCard(sys) {
  const connected = Boolean(sys.subscriptionConnected);
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "구독 로그인" }),
        el("p", {
          class: "muted",
          text: "Claude 구독으로 에이전트를 구동합니다. ① 내 PC에서 claude setup-token 실행 → ② 출력된 sk-ant-oat… 토큰을 아래에 붙여넣고 저장하세요. 토큰은 암호화되어 저장되며 다시 표시되지 않습니다.",
        }),
      ]),
    ]),
  );

  // Connection status (+ a note when an env API key overrides the token).
  const statusRow = el("div", { class: "sys-row" }, [
    el("span", { class: "sys-key muted", text: "구독 연결" }),
    el("span", { class: "sys-val" }, [
      el("span", {
        class: connected ? "tag accent" : "muted",
        text: connected ? "● 연결됨" : "○ 미연결",
      }),
    ]),
  ]);
  card.append(el("div", { class: "sys-grid" }, [statusRow]));
  if (sys.apiKeyOverride) {
    card.append(
      el("p", {
        class: "muted",
        text: ".env의 ANTHROPIC_API_KEY가 설정되어 있어 API 키가 구독 토큰보다 우선합니다. 구독 토큰을 사용하려면 API 키를 비우세요.",
      }),
    );
  }

  // Disconnect button when a token is stored.
  if (connected) {
    const disBtn = el("button", { class: "ghost-sm danger", type: "button", text: "연결 해제" });
    disBtn.addEventListener("click", async () => {
      if (!window.confirm("저장된 구독 토큰을 삭제할까요?")) return;
      disBtn.disabled = true;
      try {
        await api("/api/admin/claude-token", { method: "DELETE" });
        await loadAdminSystem();
        renderView();
      } catch (e) {
        disBtn.disabled = false;
        notify(`해제 실패: ${e.message}`);
      }
    });
    card.append(el("div", { class: "ar-actions" }, [disBtn]));
  }

  // Paste/replace form.
  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const token = (new FormData(formEl).get("token") || "").toString().trim();
      if (!token) {
        notify("토큰을 붙여넣어 주세요.", "warn");
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
        notify("구독 토큰을 저장했습니다.", "ok");
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.disabled = false;
        notify(`저장 실패: ${err.message}`);
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: connected ? "토큰 교체" : "Claude 구독 토큰" }),
      el("textarea", { name: "token", rows: "3", placeholder: "sk-ant-oat01-…", autocomplete: "off", required: "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  card.append(form);
  return card;
}

function buildHexSshPolicyCard(sys) {
  const tools = Array.isArray(sys.hexSshTools) ? sys.hexSshTools : [];
  const policy = sys.hexSshToolPolicy || {};
  const roles = [
    { key: "owner", label: "소유자" },
    { key: "trusted", label: "신뢰 동료" },
    { key: "colleague", label: "일반 동료" },
  ];
  const categoryLabels = {
    read: "조회",
    execute: "실행",
    write: "수정·전송",
    session: "세션",
  };
  const form = el("form", {
    class: "hex-policy-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const nextPolicy = Object.fromEntries(roles.map((role) => [role.key, []]));
      formEl.querySelectorAll("input[data-role][data-tool]").forEach((input) => {
        if (input.checked) nextPolicy[input.dataset.role].push(input.dataset.tool);
      });
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
        notify("SSH 도구 정책을 저장했습니다.", "ok");
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.disabled = false;
        notify(`저장 실패: ${err.message}`);
      }
    },
  });

  const grid = el("div", { class: "hex-policy-grid" });
  grid.append(
    el("div", { class: "hex-policy-head muted", text: "도구" }),
    ...roles.map((role) => el("div", { class: "hex-policy-head", text: role.label })),
  );
  for (const tool of tools) {
    grid.append(
      el("div", { class: "hex-policy-tool" }, [
        el("strong", { text: tool.label || tool.name }),
        el("span", { class: "muted mono", text: tool.name }),
        el("span", { class: `tag ${tool.category === "read" ? "read" : "write"}`, text: categoryLabels[tool.category] || tool.category }),
      ]),
    );
    for (const role of roles) {
      const checked = Array.isArray(policy[role.key]) && policy[role.key].includes(tool.name);
      const label = el("label", { class: "hex-policy-check" }, [
        el("input", {
          type: "checkbox",
          checked,
          dataset: { role: role.key, tool: tool.name },
          "aria-label": `${role.label} ${tool.label || tool.name}`,
        }),
      ]);
      grid.append(label);
    }
  }

  form.append(
    grid,
    el("div", { class: "form-actions" }, [
      el("button", { class: "primary", type: "submit", text: "정책 저장" }),
    ]),
  );

  return el("section", { class: "settings-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "SSH 도구 정책" }),
        el("p", { class: "muted", text: "역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다." }),
      ]),
    ]),
    form,
  ]);
}

function sysRow(label, valueNode) {
  return el("div", { class: "sys-row" }, [
    el("span", { class: "sys-key muted", text: label }),
    el("span", { class: "sys-val" }, [valueNode]),
  ]);
}

/* ============================================================ Loaders */
async function refreshMe() {
  const me = await api("/api/me");
  if (me.user) state.user = me.user;
}
async function loadAvatars() {
  state.avatarsLoading = true;
  try {
    const r = await api("/api/avatars");
    state.avatars = r.avatars || [];
    state.avatarsLoaded = true;
  } finally {
    state.avatarsLoading = false;
  }
}
async function loadPlugins() {
  const r = await api("/api/me/plugins");
  state.plugins = r.plugins || [];
}
async function loadKnowledge() {
  const reqs = await api("/api/me/knowledge/requests");
  state.knowledgeRequests = reqs.requests || [];
}
// Open-request count we've already nudged the owner about, so the toast fires
// only on genuinely NEW questions (or once on login) — not on every poll/render.
// Every badge update resyncs it to what's shown, so a resolve lowers the baseline
// and a later re-ask announces again.
let lastAnnouncedRequestCount = 0;
// Pending info-request count on the 내 아바타 nav item — otherwise owners only
// discover waiting questions by wandering into the right settings tab.
function updateKnowledgeBadge() {
  const btn = dom.navButtons?.settings;
  if (!btn) return;
  const count = state.knowledgeRequests.filter((r) => r.status === "open").length;
  lastAnnouncedRequestCount = count;
  let badge = btn.querySelector(".nav-badge");
  if (!count) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = el("span", { class: "nav-badge" });
    btn.append(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
  btn.title = `대기 중인 정보 요청 ${count}건`;
}

// Reload open requests and refresh the badge. With { announce } it also toasts
// when the count grew since we last nudged — this is the in-app "alarm" for gaps
// the avatar logged via request_info while the owner was elsewhere in the app.
async function refreshKnowledgeStatus({ announce = false } = {}) {
  if (!state.user) return;
  try {
    await loadKnowledge();
  } catch {
    return; // transient failure: keep the current badge rather than clearing it
  }
  const open = state.knowledgeRequests.filter((r) => r.status === "open").length;
  if (announce && open > lastAnnouncedRequestCount) {
    notify(`아직 답하지 못한 정보 요청이 ${open}건 있어요. ‘내 아바타’에서 확인해 주세요.`, "info", {
      onClick: openKnowledgeRequests,
    });
  }
  updateKnowledgeBadge(); // resyncs lastAnnouncedRequestCount
}

// Jump straight to the gap inbox (knowledge tab), re-rendering even if the owner
// is already on the settings view (goView no-ops on a same-view navigation).
function openKnowledgeRequests() {
  state.settingsTab = "knowledge";
  if (state.view === "settings") {
    syncHash();
    renderView();
  } else {
    goView("settings");
  }
}

// Keep the badge/toast fresh while the tab is open: a colleague's new question
// then surfaces without a reload. Poll only when visible (cheap: one small GET/min)
// and also refresh the moment the owner returns to the tab.
let knowledgeWatchTimer = null;
function onKnowledgeVisible() {
  if (!document.hidden) refreshKnowledgeStatus({ announce: true });
}
function startKnowledgeWatch() {
  stopKnowledgeWatch();
  knowledgeWatchTimer = setInterval(() => {
    if (!document.hidden) refreshKnowledgeStatus({ announce: true });
  }, 60000);
  document.addEventListener("visibilitychange", onKnowledgeVisible);
}
function stopKnowledgeWatch() {
  if (knowledgeWatchTimer) {
    clearInterval(knowledgeWatchTimer);
    knowledgeWatchTimer = null;
  }
  document.removeEventListener("visibilitychange", onKnowledgeVisible);
}
async function loadRoutines() {
  const r = await api("/api/me/routines");
  state.routines = r.routines || [];
}
async function loadTrusted() {
  const r = await api("/api/me/trusted");
  state.trusted = r.trusted || [];
}
async function loadAdminUsers() {
  const r = await api("/api/admin/users");
  state.adminUsers = r.users || [];
}
async function loadAdminSystem() {
  const r = await api("/api/admin/system");
  state.adminSystem = r.system || null;
}
async function loadAdminStats() {
  const r = await api("/api/admin/stats");
  state.adminStats = r.stats || null;
}
async function loadAudit() {
  const r = await api("/api/audit");
  state.audit = r.audit || [];
}
async function loadAdminUserDetail(id) {
  const r = await api(`/api/admin/users/${encodeURIComponent(id)}`);
  state.adminUserDetail[id] = r.user;
  return r.user;
}

/* ============================================================ Lifecycle */
async function logout() {
  stopAllChatStreams();
  stopKnowledgeWatch();
  hidePromptModal();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  sessionExpired = false;
  state.user = null;
  state.currentAvatar = null;
  state.chatPanes = [];
  state.activePaneId = null;
  state.messages = [];
  state.conversations = [];
  renderAuth("login");
}

async function enterApp() {
  mountShell();
  // Restore the view (and conversation) from the URL hash so a reload doesn't
  // dump the user back on Explore.
  const { view, arg } = routeFromHash();
  const isAdmin = state.user.roles?.includes("admin");
  state.view = view && !(view === "admin" && !isAdmin) ? view : "explore";
  if (view === "settings" && arg) state.settingsTab = arg;
  if (view === "admin" && arg) state.adminTab = arg;
  const wantConversation = view === "chat" && arg ? arg : null;
  if (wantConversation) state.view = "explore"; // placeholder frame until messages load
  renderView();
  syncHash(true);
  refreshKnowledgeStatus({ announce: true });
  startKnowledgeWatch();
  await refreshConversations();
  if (wantConversation) {
    const conv = state.conversations.find((c) => c.id === wantConversation);
    if (conv) await selectConversation(conv);
    else syncHash(true);
  }
  // First-time guidance: prompt for a GitHub token + knowledge repo. Skippable,
  // tracked per-user in localStorage so it doesn't reappear once dismissed.
  if (!onboardingDone(state.user.id)) {
    openOnboarding();
  }
}

/** localStorage key flagging that a user has seen/dismissed onboarding. */
function onboardingKey(userId) {
  return `onboarded:${userId}`;
}
function onboardingDone(userId) {
  try {
    return localStorage.getItem(onboardingKey(userId)) === "1";
  } catch {
    return false; // storage blocked → just show it; harmless
  }
}
function markOnboardingDone(userId) {
  try {
    localStorage.setItem(onboardingKey(userId), "1");
  } catch {
    /* ignore */
  }
}

/**
 * Skippable onboarding overlay: connect a GitHub token and point at a personal
 * knowledge repo. Reuses PUT /api/me/git-token and PUT /api/me/knowledge-repo.
 * Re-openable from the settings 지식 저장소 card.
 */
function openOnboarding() {
  const u = state.user;
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = () => {
    markOnboardingDone(state.user.id);
    overlay.remove();
    restoreFocus?.focus?.();
  };

  const tokenInput = el("input", { name: "token", type: "password", placeholder: "GitHub personal access token (repo 권한)", autocomplete: "off" });
  const repoInput = el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", value: u.knowledgeRepo || "" });
  const branchInput = el("input", { name: "branch", class: "narrow", placeholder: "main (비우면 기본 브랜치)", value: u.knowledgeBranch || "" });
  const errorBox = el("div", { class: "error", role: "alert", hidden: "" });

  const saveBtn = el("button", { class: "primary", type: "submit", text: "저장하고 시작" });
  const form = el("form", {
    class: "form-stack",
    onsubmit: async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      const savedLabel = saveBtn.textContent;
      saveBtn.textContent = "저장 중…"; // repo validation may clone — can be slow
      errorBox.hidden = true;
      try {
        const token = tokenInput.value.trim();
        if (token) {
          const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
          state.user = user;
        }
        const repo = repoInput.value.trim();
        // Only call when something is provided, so "skip the repo" stays valid.
        if (repo || u.knowledgeRepo) {
          const { user } = await api("/api/me/knowledge-repo", {
            method: "PUT",
            body: JSON.stringify({ repo: repo || null, branch: branchInput.value.trim() || null }),
          });
          state.user = user;
        }
        close();
        renderView();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        saveBtn.textContent = savedLabel;
        saveBtn.disabled = false;
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", {}, [
        "GitHub 토큰 (선택) ",
        el("a", {
          class: "linkish",
          href: `https://${(state.githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/settings/tokens`,
          target: "_blank",
          rel: "noopener noreferrer",
          text: "토큰 만들러 가기 ↗",
        }),
      ]),
      tokenInput,
    ]),
    el("label", { class: "field" }, [el("span", { text: "지식 저장소" }), repoInput]),
    el("label", { class: "field" }, [el("span", { text: "브랜치 (선택)" }), branchInput]),
    errorBox,
    el("div", { class: "onboard-actions" }, [
      el("button", { class: "linkish", type: "button", text: "건너뛰기", onclick: () => { close(); } }),
      saveBtn,
    ]),
  ]);

  const card = el("div", { class: "modal-card onboard-card", tabindex: "-1" }, [
    el("img", { class: "login-mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "48", height: "48" }),
    el("h2", { id: "onboarding-title", text: "지식 저장소 연결하기" }),
    el("p", {
      class: "muted",
      text: "내 아바타가 업무 지식·스킬을 쌓아 둘 전용 GitHub 저장소를 연결하세요. 비공개 저장소를 쓰거나 아바타가 직접 커밋·푸시하게 하려면 토큰도 입력하세요. 나중에 설정에서 다시 할 수 있어요.",
    }),
    form,
  ]);
  const overlay = el("div", { class: "modal-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "onboarding-title" }, [card]);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      trapTab(e, overlay);
    }
  });
  document.body.append(overlay);
  // Autofocusing the token field pops the keyboard over the explanation on
  // phones — focus the card itself there instead.
  if (isFinePointer()) tokenInput.focus();
  else card.focus();
}

async function boot() {
  app.replaceChildren(
    el("div", { class: "boot" }, [
      el("img", { class: "boot-mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "52", height: "52" }),
      el("div", { class: "boot-spinner" }),
      el("div", { class: "boot-label", text: "불러오는 중…" }),
    ]),
  );
  let me = null;
  let bootstrap = null;
  try {
    bootstrap = await api("/api/bootstrap");
    state.githubHost = bootstrap.githubHost || state.githubHost;
    state.signupMode = bootstrap.signupMode || state.signupMode;
  } catch {
    bootstrap = null;
  }
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  state.user = me?.user || null;
  if (!state.user) {
    // On a fresh install (no accounts yet) show the admin-setup screen.
    const needsSetup = Boolean(bootstrap?.needsSetup);
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

// Escape closes the mobile rail drawer (modals handle their own Escape and
// stop propagation before this fires).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dom.promptModal && !dom.promptModal.hidden) return;
  if (document.querySelector(".modal-overlay")) return;
  if (dom.rail?.classList.contains("open")) closeRail();
});

boot().catch((error) => {
  state.authError = error.message;
  renderAuth("login");
});
