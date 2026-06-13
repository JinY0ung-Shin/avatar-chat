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
  view: "explore", // explore | chat | inbox | routines | settings | admin
  settingsTab: "profile", // profile | access | knowledge | groups
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
  routineSearch: "",
  routineFilter: "all", // all | enabled | paused | error
  routineConversations: [],
  routineConversationId: "",
  routineMessages: [],
  notifications: [],
  inboxFilter: "all",
  adminTab: "overview", // overview | users | groups | access | system | audit
  adminUsers: [],
  adminUserDetail: {}, // id -> AdminUserDetail (lazy, cached per expand)
  adminUserSearch: "",
  adminUserFilter: "all", // all | admins | suspended | public | sessions
  adminGroupSearch: "",
  adminSystem: null,
  adminStats: null,
  audit: [],
  streaming: false,
  authError: "",
  githubHost: "github.com",
  signupMode: "open", // mirrors /api/bootstrap; gates the auth-screen signup link
  confluenceConfigured: false, // mirrors /api/bootstrap; gates the onboarding Confluence PAT field
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
  stopKnowledgeWatch();
  hidePromptModal();
  state.user = null;
  state.currentAvatar = null;
  state.chatPanes = [];
  state.activePaneId = null;
  state.messages = [];
  state.conversations = [];
  state.routineConversations = [];
  state.routineConversationId = "";
  state.routineMessages = [];
  state.notifications = [];
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

function setFormBusy(root, busy) {
  if (!root) return;
  root.setAttribute("aria-busy", busy ? "true" : "false");
  root.querySelectorAll("input, textarea, select, button").forEach((control) => {
    if (busy) {
      if (!("busyWasDisabled" in control.dataset)) {
        control.dataset.busyWasDisabled = control.disabled ? "true" : "false";
      }
      control.disabled = true;
      return;
    }
    const wasDisabled = control.dataset.busyWasDisabled === "true";
    delete control.dataset.busyWasDisabled;
    control.disabled = wasDisabled;
  });
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
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7C3.49 7.17 7.61 4 12 4s8.51 3.17 9.94 7.65a1 1 0 0 1 0 .7C20.51 16.83 16.39 20 12 20s-8.51-3.17-9.94-7.65Z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="m2 2 20 20"/><path d="M10.58 10.58a2 2 0 0 0 2.83 2.83"/><path d="M9.88 4.24A10.95 10.95 0 0 1 12 4c4.39 0 8.51 3.17 9.94 7.65a1 1 0 0 1 0 .7 10.7 10.7 0 0 1-2.29 3.95"/><path d="M6.61 6.61a10.73 10.73 0 0 0-4.55 5.04 1 1 0 0 0 0 .7C3.49 16.83 7.61 20 12 20a10.9 10.9 0 0 0 5.39-1.43"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
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
  const html = DOMPurify.sanitize(marked.parse(text || ""));
  // If sanitization reduced a non-empty answer to nothing — e.g. the model replied
  // with only forbidden HTML (<script>/<iframe>/<style>…), whose CONTENT DOMPurify
  // also strips — show the raw text escaped instead of leaving a blank bubble.
  if (text && text.trim() && !html.trim()) {
    const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return DOMPurify.sanitize(`<pre>${escaped}</pre>`);
  }
  return html;
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
    flashCopyFailed(btn);
    notify("클립보드에 복사하지 못했습니다.", "warn");
  }
}

function flashCopied(btn) {
  if (!btn) return;
  if (!btn._copyOriginal) {
    btn._copyOriginal = {
      nodes: [...btn.childNodes],
      label: btn.getAttribute("aria-label"),
      title: btn.title,
    };
  }
  clearTimeout(btn._copyTimer);
  btn.classList.remove("copy-failed");
  btn.classList.add("copied");
  btn.setAttribute("aria-label", "복사됨");
  btn.title = "복사됨";
  btn.replaceChildren(icon("check"));
  btn._copyTimer = setTimeout(() => {
    const original = btn._copyOriginal;
    btn.classList.remove("copied");
    btn.replaceChildren(...original.nodes);
    if (original.label) btn.setAttribute("aria-label", original.label);
    else btn.removeAttribute("aria-label");
    btn.title = original.title || "";
  }, 1200);
}

function flashCopyFailed(btn) {
  if (!btn) return;
  const original = btn._copyOriginal || {
    label: btn.getAttribute("aria-label"),
    title: btn.title,
  };
  clearTimeout(btn._copyTimer);
  btn.classList.remove("copied");
  btn.classList.add("copy-failed");
  if (original.nodes) btn.replaceChildren(...original.nodes);
  btn.setAttribute("aria-label", "복사 실패");
  btn.title = "복사 실패";
  btn._copyTimer = setTimeout(() => {
    btn.classList.remove("copy-failed");
    if (original.label) btn.setAttribute("aria-label", original.label);
    else btn.removeAttribute("aria-label");
    btn.title = original.title || "";
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

// Wire an expand/collapse toggle between a button and its associated content
// element. The button must already have aria-expanded="false".
// `load(contents)` is called when the contents are first shown; if `once` is
// true (default false), the load is skipped on subsequent re-opens.
function wireExpander(btn, contents, load, { once = false } = {}) {
  let loaded = false;
  const runLoad = async () => {
    btn.disabled = true;
    try {
      await load(contents);
      loaded = true;
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", async () => {
    if (!contents.hidden) {
      contents.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    contents.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (once && loaded) return;
    await runLoad();
  });
  return runLoad;
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
function buildRevealableInput({
  name,
  autocomplete = "off",
  placeholder = "",
  ariaLabel = "",
  revealLabel = "비밀번호",
  required = false,
  minlength = null,
}) {
  const input = el("input", {
    name,
    type: "password",
    autocomplete,
    placeholder,
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(required ? { required: "" } : {}),
    ...(minlength ? { minlength: String(minlength) } : {}),
  });
  const toggle = el("button", {
    class: "password-toggle",
    type: "button",
    "aria-label": `${revealLabel} 보기`,
    title: `${revealLabel} 보기`,
  });
  const sync = () => {
    const visible = input.type === "text";
    toggle.setAttribute("aria-label", visible ? `${revealLabel} 숨기기` : `${revealLabel} 보기`);
    toggle.title = visible ? `${revealLabel} 숨기기` : `${revealLabel} 보기`;
    toggle.replaceChildren(icon(visible ? "eye-off" : "eye"));
  };
  toggle.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    sync();
    input.focus();
  });
  sync();
  return { input, wrap: el("div", { class: "password-field" }, [input, toggle]) };
}

function buildPasswordInput({ autocomplete, placeholder }) {
  return buildRevealableInput({
    name: "password",
    autocomplete,
    placeholder,
    required: true,
    minlength: 8,
  }).wrap;
}

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
      const formEl = event.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      const savedLabel = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = isLogin ? "로그인 중…" : isSetup ? "계정 만드는 중…" : "가입 중…";
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
        btn.textContent = savedLabel;
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
      buildPasswordInput({
        autocomplete: isLogin ? "current-password" : "new-password",
        placeholder: isLogin ? "비밀번호" : "8자 이상",
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
        const currentUsername = app.querySelector('input[name="username"]')?.value || "";
        const currentDisplayName = app.querySelector('input[name="displayName"]')?.value || "";
        state.authError = "";
        renderAuth(isLogin ? "signup" : "login", {
          username: currentUsername,
          displayName: currentDisplayName,
        });
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
  navItem("inbox", "알림", "bell");
  navItem("routines", "루틴", "clock");
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
    placeholder: "대화 불러오는 중",
    "aria-label": "대화 검색",
    disabled: "",
    oninput: () => renderConversations(),
  });

  const meRow = el("button", { class: "rail-me", type: "button", title: "내 아바타 설정", onclick: () => goView("settings") }, [
    avatarNode(state.user, 34, { alt: "" }),
    el("div", { class: "meta" }, [
      el("b", { text: state.user.displayName }),
      el("span", { text: `@${state.user.username}` }),
    ]),
  ]);
  const logoutBtn = el("button", { class: "icon-button", type: "button", "aria-label": "로그아웃", title: "로그아웃", onclick: () => logout(logoutBtn) });
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
  const focusables = [...container.querySelectorAll(
    "button:not(:disabled), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )].filter((el) => !el.disabled && el.getAttribute("aria-hidden") !== "true");
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

function streamingPane() {
  return state.chatPanes.find((p) => p.streaming) || null;
}

// View changes do not stop an in-flight chat. The fetch keeps running in the
// background, and the live bubble is reattached if the user returns to Chat.
function noteStreamingContinues() {
  if (!anyChatStreaming()) return;
  notify("응답은 백그라운드에서 계속 생성됩니다. 대화 화면으로 돌아오면 이어서 볼 수 있습니다.", "info");
}

// Replacing the active conversation while a run is streaming would orphan the
// local live state. Keep that narrow path explicit: stop first, then switch.
function guardChatReplacement(targetConversationId = "") {
  const pane = streamingPane();
  if (!pane) return true;
  if (targetConversationId && pane.conversationId === targetConversationId) return true;
  notify("응답 생성 중인 대화가 있습니다. 다른 대화로 전환하려면 먼저 중지해 주세요.", "warn");
  return false;
}

function goView(view) {
  if (view === state.view) {
    closeRail();
    return;
  }
  noteStreamingContinues();
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

const VIEW_TITLES = { explore: "탐색", chat: "대화", inbox: "알림", routines: "루틴", settings: "내 아바타", admin: "관리자" };

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
  else if (state.view === "inbox") renderInboxView();
  else if (state.view === "routines") renderRoutinesView();
  else if (state.view === "settings") renderSettings();
  else if (state.view === "admin") renderAdmin();
}

/* ---- Hash routing -------------------------------------------------------
   #/explore · #/chat · #/chat/<convId> · #/routines · #/routines/<convId> · #/settings/<tab> · #/admin/<tab>
   Keeps Back/Forward inside the SPA and survives a reload. */
const VIEW_ROUTES = ["explore", "chat", "inbox", "routines", "settings", "admin"];
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
    // Carry the conversationId as soon as it exists (not only after a message is
    // persisted) so a mid-stream reload — including the first turn and greetings —
    // routes back to the conversation and re-attaches its in-flight run.
    return pane?.conversationId ? `#/chat/${encodeURIComponent(pane.conversationId)}` : "#/chat";
  }
  if (state.view === "routines") {
    return state.routineConversationId ? `#/routines/${encodeURIComponent(state.routineConversationId)}` : "#/routines";
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

function syncHashAfterRoute(replace = true) {
  queueMicrotask(() => syncHash(replace));
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
    if (view === "routines" && arg && arg !== state.routineConversationId) state.routineConversationId = arg;
    if (view === "admin" && arg && arg !== state.adminTab) state.adminTab = arg;
    if (view !== state.view || view === "settings" || view === "routines" || view === "admin") {
      noteStreamingContinues();
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

function makeChatPane(avatar, { conversationId = newId(), messages = [], groupKnowledgeOff = defaultGroupKnowledgeOff(avatar) } = {}) {
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

const MAX_HASHTAGS = 12;

// Normalize a list of capability hashtags client-side (mirrors the server's
// normalizeHashtags): strip leading "#"/markers, collapse spaces to hyphens,
// dedupe, cap. Bare tags (no "#") are stored; the UI renders the "#".
function normalizeTagList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of [].concat(list || [])) {
    if (typeof raw !== "string") continue;
    let t = raw.trim().replace(/^[#*•·\-\s]+/, "").replace(/\s+/g, "-").replace(/[.,!?]+$/, "").trim();
    if (!t) continue;
    if (t.length > 30) t = t.slice(0, 30);
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

// A chip editor for capability hashtags: type + Enter/comma/space to add, click
// × or Backspace-on-empty to remove. Returns the wrapper plus get/set helpers.
function buildHashtagEditor(initial) {
  let tags = normalizeTagList(initial || []);
  const chips = el("div", { class: "tag-chips" });
  const input = el("input", {
    class: "tag-input",
    type: "text",
    placeholder: "태그 입력 후 Enter",
    "aria-label": "역량 해시태그 추가",
  });
  function renderChips() {
    chips.replaceChildren(
      ...tags.map((t, i) =>
        el("span", { class: "tag accent hashtag-chip" }, [
          el("span", { text: `#${t}` }),
          el("button", {
            type: "button",
            class: "chip-x",
            "aria-label": `${t} 제거`,
            text: "×",
            onclick: () => {
              tags.splice(i, 1);
              renderChips();
            },
          }),
        ]),
      ),
    );
  }
  function addFromInput() {
    const parts = input.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const truncated = parts.some((p) => p.replace(/^[#*•·\-\s]+/, "").length > 30);
    tags = normalizeTagList([...tags, ...parts]);
    input.value = "";
    renderChips();
    if (truncated) notify("해시태그는 최대 30자까지만 사용할 수 있어 일부가 잘렸습니다.", "info");
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFromInput();
    } else if (e.key === " " && input.value.trim()) {
      e.preventDefault();
      addFromInput();
    } else if (e.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      renderChips();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) addFromInput();
  });
  const wrap = el("div", { class: "hashtag-editor" }, [chips, input]);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target === chips) input.focus();
  });
  renderChips();
  return {
    wrap,
    getTags: () => tags.slice(),
    setTags: (next) => {
      tags = normalizeTagList(next);
      renderChips();
    },
  };
}

// Explore directory search. renderExploreGridImpl is (re)assigned each time the
// Explore view renders; renderExploreGrid is a stable wrapper so the search box
// can call it safely even before the impl exists (e.g. typing while loading).
let renderExploreGridImpl = null;
let exploreViewSeq = 0;
function renderExploreGrid() {
  if (typeof renderExploreGridImpl === "function") renderExploreGridImpl();
}
function matchesAvatarQuery(av, tokens) {
  const hay = [av.displayName, av.alias, av.username, av.bio, ...(av.hashtags || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

async function renderExplore() {
  const renderSeq = ++exploreViewSeq;
  renderExploreGridImpl = null;
  const header = viewHeader("탐색", "공개된 아바타와 대화를 시작하세요");
  const searchInput = el("input", {
    class: "explore-search",
    type: "search",
    placeholder: "이름·해시태그로 검색 (예: #코드리뷰)",
    value: state.exploreQuery || "",
    "aria-label": "아바타 검색",
    oninput: (e) => {
      state.exploreQuery = e.target.value;
      renderExploreGrid();
    },
  });
  const searchBar = el("div", { class: "explore-search-bar" }, [icon("compass"), searchInput]);
  const grid = el("div", { class: "avatar-grid" });
  const body = el("div", { class: "view-body scroll-thin" }, [searchBar, grid]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === exploreViewSeq && state.view === "explore" && body.isConnected;
  const clearExploreSearch = () => {
    state.exploreQuery = "";
    searchInput.value = "";
    renderExploreGrid();
    searchInput.focus();
  };

  grid.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  let loadError = null;
  try {
    await loadAvatars();
  } catch (e) {
    loadError = e;
  }
  if (!isCurrent()) return;
  grid.replaceChildren();
  if (loadError) {
    // A failed fetch must not masquerade as "no avatars exist".
    searchBar.remove();
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
    searchBar.remove();
    grid.append(
      el("div", { class: "empty-note" }, [
        "공개된 아바타가 아직 없습니다.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "내 아바타 공개 설정",
          onclick: () => {
            state.settingsTab = "profile";
            goView("settings");
          },
        }),
      ]),
    );
    return;
  }
  // Filter by the search query + (re)build cards. Reused on every keystroke.
  renderExploreGridImpl = () => {
    if (!isCurrent()) return;
    const raw = (state.exploreQuery || "").trim();
    const tokens = raw ? raw.toLowerCase().split(/\s+/).map((t) => t.replace(/^#+/, "")).filter(Boolean) : [];
    // Order: my own avatar first, then group teammates (auto-trusted), then the
    // rest. Within a tier the server's display-name order is preserved.
    const rank = (av) => (av.id === state.user.id ? 0 : av.sharesGroup ? 1 : 2);
    const sorted = [...state.avatars].sort(
      (a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""),
    );
    const list = tokens.length ? sorted.filter((av) => matchesAvatarQuery(av, tokens)) : sorted;
    grid.replaceChildren();
    if (!list.length) {
      grid.append(
        el("div", { class: "empty-note" }, [
          `"${raw}"에 맞는 아바타가 없습니다.\n`,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearExploreSearch }),
        ]),
      );
      return;
    }
    for (const av of list) grid.append(buildAvatarCard(av));
  };
  renderExploreGrid();
}

function buildAvatarCard(av) {
  const isMe = av.id === state.user.id;
  const card = el("button", { class: "avatar-card", type: "button", onclick: () => startChatWith(av, card) }, [
    avatarNode(av, 56, { alt: "" }),
    el("div", { class: "ac-body" }, [
      el("div", { class: "ac-name" }, [
        el("strong", { text: av.displayName }),
        isMe ? el("span", { class: "tag accent", text: "나" }) : null,
        !isMe && av.sharesGroup ? el("span", { class: "tag write", text: "같은 그룹" }) : null,
        av.visibility === "group" ? el("span", { class: "tag", text: "그룹 공개" }) : null,
        av.visibility === "private" ? el("span", { class: "tag", text: "비공개" }) : null,
      ]),
      el("div", { class: "ac-handle", text: `@${av.username}` }),
      av.alias ? el("div", { class: "ac-alias", text: `"${av.alias}"` }) : null,
      av.bio ? el("p", { class: "ac-bio", text: av.bio }) : null,
      el("div", { class: "ac-tags" }, [
        ...(av.hashtags || []).slice(0, 6).map((t) => el("span", { class: "tag accent", text: `#${t}` })),
        el("span", { class: "tag", text: `플러그인 ${av.pluginCount}개` }),
      ]),
    ]),
  ]);
  return card;
}

async function startChatWith(av, triggerCard = null) {
  const activeStreaming = streamingPane();
  if (activeStreaming) {
    if (activeStreaming.avatar?.id === av.id) {
      setActivePane(activeStreaming);
      state.view = "chat";
      syncHash();
      renderView();
      return;
    }
    if (!guardChatReplacement()) return;
  }
  const handle = triggerCard?.querySelector(".ac-handle");
  const previousHandle = handle?.textContent || "";
  if (triggerCard) {
    triggerCard.disabled = true;
    triggerCard.setAttribute("aria-busy", "true");
    if (handle) handle.textContent = "대화 여는 중…";
  }
  const restoreTrigger = () => {
    if (!triggerCard?.isConnected) return;
    triggerCard.disabled = false;
    triggerCard.removeAttribute("aria-busy");
    if (handle) handle.textContent = previousHandle;
  };
  // Resume the most recent conversation with this avatar instead of silently
  // forking a new one — Explore and the rail used to diverge here, spawning
  // duplicate threads. "새 대화" in the chat header remains the fork path.
  const existing = state.conversations.find((c) => c.avatarUserId === av.id);
  try {
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
  } catch (e) {
    notify(`대화를 시작하지 못했습니다: ${e.message}`);
  } finally {
    restoreTrigger();
  }
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

/* ============================================================ Routines view */
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// Korean schedule formatter (user-facing). Mirrors the RoutineSchedule contract.
function formatRoutineSchedule(r) {
  const kind = r.scheduleKind || "daily";
  if (kind === "weekly") {
    const days = Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [];
    const labels = days.map((d) => WEEKDAY_NAMES[d] ?? "?").join("·");
    return `매주 ${labels} ${r.time} (KST)`;
  }
  if (kind === "interval") {
    const n = Number(r.intervalMinutes) || 0;
    if (n % 60 === 0) return `${n / 60}시간마다`;
    return `${n}분마다`;
  }
  return `매일 ${r.time} (KST)`;
}

// Short title for a routine row: explicit name, else a one-line prompt preview.
function routineTitle(r) {
  const name = (r.name || "").trim();
  if (name) return name;
  const oneLine = (r.prompt || "").replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine || "(이름 없는 루틴)";
}

// Generic modal builder used by openRoutineModal and openOnboarding.
// Handles: restoreFocus, overlay + card creation, backdrop click, document-level
// Escape/Tab (capture, cleaned up on close). Returns { overlay, close }.
// buildCard(card, close) populates the card element and returns { focusTarget }
// where focusTarget is the element to focus on fine-pointer devices.
// onBeforeClose() is called before overlay.remove() (e.g. bookkeeping).
function openModal({ cardClass, ariaLabelledby, buildCard, onBeforeClose, canClose } = {}) {
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = el("div", { class: `modal-card ${cardClass}`, tabindex: "-1" });
  const overlay = el("div", { class: "modal-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": ariaLabelledby }, [card]);
  const close = () => {
    if (canClose && !canClose()) return false;
    onBeforeClose?.();
    overlay.remove();
    document.removeEventListener("keydown", onKeydown, true);
    restoreFocus?.focus?.();
    return true;
  };
  const { focusTarget } = buildCard(card, close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const onKeydown = (e) => {
    if (!overlay.isConnected) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "Tab") { trapTab(e, overlay); }
  };
  document.addEventListener("keydown", onKeydown, true);
  document.body.append(overlay);
  if (isFinePointer()) focusTarget?.focus();
  else card.focus();
  return { overlay, close };
}

// Builds the schedule-form section (daily/weekly/interval) for the routine modal.
// Mirrors the server's routineSchedule.ts semantics on the client.
// `routine` is the existing routine object (or null for create).
// Returns { element, getSchedulePayload, validateSchedule, applyKindVisibility }.
function buildScheduleForm(routine) {
  const initialKind = routine?.scheduleKind || "daily";
  const kindSelect = el("select", { name: "scheduleKind", "aria-label": "주기" }, [
    el("option", { value: "daily", text: "매일" }),
    el("option", { value: "weekly", text: "매주" }),
    el("option", { value: "interval", text: "간격" }),
  ]);
  kindSelect.value = initialKind;

  const timeInput = el("input", {
    name: "time",
    type: "time",
    "aria-label": "실행 시각",
    value: routine?.time || "09:00",
  });
  const timeRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "시각" }),
    timeInput,
  ]);

  // Weekday chips (매주).
  const selectedDays = new Set(Array.isArray(routine?.daysOfWeek) ? routine.daysOfWeek : []);
  const dayChipWrap = el("div", { class: "weekday-chips", role: "group", "aria-label": "반복 요일" });
  const dayChips = WEEKDAY_NAMES.map((label, idx) => {
    const chip = el("button", {
      type: "button",
      class: `weekday-chip ${selectedDays.has(idx) ? "selected" : ""}`,
      "aria-pressed": selectedDays.has(idx) ? "true" : "false",
      text: label,
    });
    chip.addEventListener("click", () => {
      if (selectedDays.has(idx)) selectedDays.delete(idx);
      else selectedDays.add(idx);
      const on = selectedDays.has(idx);
      chip.classList.toggle("selected", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      dayChipWrap.removeAttribute("aria-invalid");
    });
    return chip;
  });
  dayChipWrap.append(...dayChips);
  const daysRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "요일" }),
    dayChipWrap,
  ]);

  // Interval (간격): number + unit.
  const intervalMin = Number(routine?.intervalMinutes) || 0;
  const intervalUnit = el("select", { class: "narrow", "aria-label": "반복 간격 단위" }, [
    el("option", { value: "hour", text: "시간" }),
    el("option", { value: "minute", text: "분" }),
  ]);
  let intervalValue = 1;
  if (intervalMin > 0 && intervalMin % 60 === 0) {
    intervalUnit.value = "hour";
    intervalValue = intervalMin / 60;
  } else if (intervalMin > 0) {
    intervalUnit.value = "minute";
    intervalValue = intervalMin;
  } else {
    intervalUnit.value = "hour";
    intervalValue = 1;
  }
  const intervalInput = el("input", {
    type: "number",
    min: "1",
    step: "1",
    class: "narrow",
    "aria-label": "반복 간격 값",
    value: String(intervalValue),
  });
  intervalInput.addEventListener("input", () => intervalInput.removeAttribute("aria-invalid"));
  intervalUnit.addEventListener("change", () => intervalInput.removeAttribute("aria-invalid"));
  const intervalRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "반복 간격" }),
    el("div", { class: "interval-inputs" }, [intervalInput, intervalUnit]),
  ]);

  const intervalMinutesFromInputs = () => {
    const n = Math.floor(Number(intervalInput.value) || 0);
    return intervalUnit.value === "hour" ? n * 60 : n;
  };

  const applyKindVisibility = () => {
    const kind = kindSelect.value;
    dayChipWrap.removeAttribute("aria-invalid");
    intervalInput.removeAttribute("aria-invalid");
    timeRow.hidden = kind === "interval";
    daysRow.hidden = kind !== "weekly";
    intervalRow.hidden = kind !== "interval";
  };
  kindSelect.addEventListener("change", applyKindVisibility);

  const kindRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "주기" }),
    kindSelect,
  ]);

  const element = el("div", { class: "schedule-builder" }, [kindRow, timeRow, daysRow, intervalRow]);

  const getSchedulePayload = () => {
    const kind = kindSelect.value;
    const payload = { scheduleKind: kind };
    if (kind === "daily" || kind === "weekly") payload.time = timeInput.value;
    if (kind === "weekly") payload.daysOfWeek = [...selectedDays].sort((a, b) => a - b);
    if (kind === "interval") payload.intervalMinutes = intervalMinutesFromInputs();
    return payload;
  };

  // Returns null if valid, or an error string if invalid.
  const validateSchedule = () => {
    const kind = kindSelect.value;
    dayChipWrap.removeAttribute("aria-invalid");
    intervalInput.removeAttribute("aria-invalid");
    if (kind === "weekly" && selectedDays.size === 0) {
      dayChipWrap.setAttribute("aria-invalid", "true");
      return "매주 반복은 요일을 1개 이상 선택해 주세요.";
    }
    if (kind === "interval" && intervalMinutesFromInputs() < 15) {
      intervalInput.setAttribute("aria-invalid", "true");
      return "반복 간격은 15분 이상이어야 합니다.";
    }
    return null;
  };

  const focusInvalid = () => {
    const kind = kindSelect.value;
    if (kind === "weekly" && selectedDays.size === 0) dayChips[0]?.focus();
    else if (kind === "interval" && intervalMinutesFromInputs() < 15) intervalInput.focus();
  };

  return { element, getSchedulePayload, validateSchedule, focusInvalid, applyKindVisibility };
}

// Centered create/edit modal for a routine. `routine === null` = create mode.
function openRoutineModal(routine) {
  const isEdit = Boolean(routine);

  // ---- Fields ----
  const nameInput = el("input", {
    name: "name",
    type: "text",
    placeholder: "예: 아침 서비스 점검",
    "aria-label": "루틴 이름",
    value: routine?.name || "",
  });

  const promptInput = el("textarea", {
    name: "prompt",
    rows: "4",
    placeholder: "예: 오늘의 서비스 상태를 요약해줘",
    "aria-label": "작업 프롬프트",
    required: "",
  });
  promptInput.value = routine?.prompt || "";

  const preview = el("div", { class: "routine-prompt-preview md" });
  const updatePreview = () => {
    const text = promptInput.value.trim();
    if (text) preview.innerHTML = renderMarkdown(text);
    else preview.replaceChildren(el("span", { class: "muted", text: "프롬프트 미리보기가 여기에 표시됩니다." }));
  };
  promptInput.addEventListener("input", () => {
    updatePreview();
    if (promptInput.value.trim()) promptInput.removeAttribute("aria-invalid");
  });

  const schedule = buildScheduleForm(routine);

  const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
  const saveBtn = el("button", { class: "primary", type: "submit", text: "저장" });
  let routineModalBusy = false;

  openModal({
    cardClass: "routine-modal-card",
    ariaLabelledby: "routine-modal-title",
    canClose: () => !routineModalBusy,
    buildCard: (card, close) => {
      const afterSave = async (successMessage) => {
        try {
          await Promise.all([loadRoutines(), loadRoutineConversations()]);
        } catch (err) {
          routineModalBusy = false;
          close();
          renderView();
          notify(`루틴은 저장했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
          return;
        }
        routineModalBusy = false;
        close();
        renderView();
        notify(successMessage, "ok");
      };
      const setRoutineModalBusy = (busy) => {
        routineModalBusy = busy;
        card.setAttribute("aria-busy", busy ? "true" : "false");
        nameInput.disabled = busy;
        promptInput.disabled = busy;
        schedule.element.querySelectorAll("input, select, button").forEach((control) => {
          control.disabled = busy;
        });
        card.querySelectorAll(".routine-modal-actions button").forEach((control) => {
          control.disabled = busy;
        });
      };

      const form = el("form", {
        class: "routine-modal-form",
        onsubmit: async (e) => {
          e.preventDefault();
          if (!promptInput.value.trim()) {
            errorBox.textContent = "작업 프롬프트를 입력해 주세요.";
            errorBox.hidden = false;
            promptInput.setAttribute("aria-invalid", "true");
            promptInput.focus();
            return;
          }
          promptInput.removeAttribute("aria-invalid");
          const schedErr = schedule.validateSchedule();
          if (schedErr) {
            errorBox.textContent = schedErr;
            errorBox.hidden = false;
            schedule.focusInvalid();
            return;
          }
          errorBox.hidden = true;
          const savedLabel = saveBtn.textContent;
          setRoutineModalBusy(true);
          saveBtn.textContent = "저장 중…";
          try {
            const payload = {
              name: (nameInput.value || "").trim() || null,
              prompt: promptInput.value,
              ...schedule.getSchedulePayload(),
            };
            if (isEdit) {
              await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
            } else {
              await api("/api/me/routines", { method: "POST", body: JSON.stringify(payload) });
            }
            await afterSave(isEdit ? "루틴을 수정했습니다." : "루틴을 추가했습니다.");
          } catch (err) {
            errorBox.textContent = err.message || "저장에 실패했습니다.";
            errorBox.hidden = false;
            saveBtn.textContent = savedLabel;
            setRoutineModalBusy(false);
          }
        },
      }, [
        el("label", { class: "field" }, [
          el("span", { text: "이름 (선택)" }),
          nameInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { text: "작업 프롬프트" }),
          promptInput,
        ]),
        el("div", { class: "routine-preview-wrap" }, [
          el("span", { class: "field-hint muted", text: "미리보기" }),
          preview,
        ]),
        schedule.element,
        errorBox,
      ]);

      // Action buttons.
      const actions = el("div", { class: "routine-modal-actions" });
      const leftActions = el("div", { class: "routine-modal-actions-left" });
      if (isEdit) {
        const runBtn = el("button", { class: "ghost-sm", type: "button", text: "지금 실행" });
        runBtn.addEventListener("click", async () => {
          const saved = runBtn.textContent;
          setRoutineModalBusy(true);
          runBtn.textContent = "실행 중…";
          try {
            await runRoutineNow(routine);
            routineModalBusy = false;
            close();
          } catch (err) {
            notify(`루틴 실행 실패: ${err.message}`);
            runBtn.textContent = saved;
            setRoutineModalBusy(false);
          }
        });
        leftActions.append(runBtn);

        const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "삭제" });
        delBtn.addEventListener("click", async () => {
          if (!window.confirm("이 루틴을 삭제할까요? 지난 실행 결과 기록은 더 이상 표시되지 않습니다.")) return;
          const saved = delBtn.textContent;
          setRoutineModalBusy(true);
          delBtn.textContent = "삭제 중…";
          try {
            await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
            state.routines = state.routines.filter((x) => x.id !== routine.id);
            state.routineConversations = state.routineConversations.filter((x) => x.routineId !== routine.id);
            if (state.routineConversationId === routine.conversationId) state.routineConversationId = "";
            routineModalBusy = false;
            close();
            renderView();
            notify("루틴을 삭제했습니다.", "ok");
          } catch (err) {
            notify(`삭제 실패: ${err.message}`);
            delBtn.textContent = saved;
            setRoutineModalBusy(false);
          }
        });
        leftActions.append(delBtn);
      }
      const rightActions = el("div", { class: "routine-modal-actions-right" }, [
        el("button", { class: "ghost-sm", type: "button", text: "닫기", onclick: () => close() }),
        saveBtn,
      ]);
      actions.append(leftActions, rightActions);
      form.append(actions);

      card.append(
        el("h2", { id: "routine-modal-title", text: isEdit ? "루틴 편집" : "루틴 추가" }),
        form,
      );
      return { focusTarget: isEdit ? promptInput : nameInput };
    },
  });
  schedule.applyKindVisibility();
  updatePreview();
}

let routinesViewSeq = 0;

async function renderRoutinesView() {
  const renderSeq = ++routinesViewSeq;
  const header = viewHeader("루틴", "아바타가 스스로 실행하는 예약 작업과 그 결과를 관리하세요");
  const body = el("div", { class: "view-body routines-body" }, [
    el("div", { class: "muted pad", text: "불러오는 중…" }),
  ]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === routinesViewSeq && state.view === "routines" && body.isConnected;

  const results = await Promise.allSettled([loadRoutines(), loadRoutineConversations()]);
  if (sessionExpired) return;
  if (!isCurrent()) return;
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `루틴 정보를 불러오지 못했습니다: ${failed.reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }

  if (state.routineConversationId && !state.routineConversations.some((c) => c.id === state.routineConversationId)) {
    state.routineConversationId = state.routineConversations[0]?.id || "";
  } else if (!state.routineConversationId && state.routineConversations.length) {
    state.routineConversationId = state.routineConversations[0].id;
  }
  let messageLoadError = "";
  if (state.routineConversationId) {
    const conversationId = state.routineConversationId;
    try {
      const msgRes = await api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
      if (!isCurrent() || state.routineConversationId !== conversationId) return;
      state.routineMessages = msgRes.messages || [];
    } catch (e) {
      if (!isCurrent() || state.routineConversationId !== conversationId) return;
      state.routineMessages = [];
      messageLoadError = e.message || "네트워크 오류";
    }
  } else {
    state.routineMessages = [];
  }

  if (!isCurrent()) return;
  body.replaceChildren(
    el("div", { class: "routine-workspace" }, [
      el("div", { class: "routine-side scroll-thin" }, [
        buildRoutineManagePanel(),
      ]),
      buildRoutineResultPanel(messageLoadError),
    ]),
  );
}

// One notification row (avatar → owner). `refresh` re-renders the inbox in place
// after a read/read-all so we don't blow away the whole view.
function buildNotificationRow(n, refresh) {
  // Messenger-style: the whole card is clickable — it opens a fresh chat with my
  // own avatar seeded with this notification's topic (and marks it read). A delete
  // (X) dismisses it; the routine ones keep a "결과 보기" shortcut.
  const row = el("div", {
    class: `notification-row clickable ${n.readAt ? "" : "unread"}`,
    role: "button",
    tabindex: "0",
    onclick: (e) => {
      if (row.getAttribute("aria-busy") === "true") return;
      if (e.target.closest("button")) return; // inner actions handle themselves
      openNotificationChat(n);
    },
    onkeydown: (e) => {
      if (row.getAttribute("aria-busy") === "true") return;
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openNotificationChat(n);
      }
    },
  }, [
    el("div", { class: "pr-main" }, [
      el("div", { class: "inbox-row-head" }, [
        el("span", { class: "inbox-chip note", text: "알림" }),
        el("strong", { text: n.title }),
      ]),
      el("div", { class: "pr-sub", text: `${n.avatarDisplayName} · ${timeLabel(n.createdAt)}` }),
      el("p", { text: n.message }),
    ]),
  ]);
  const actions = el("div", { class: "kr-actions" });
  if (n.conversationId && state.routineConversations.some((c) => c.id === n.conversationId)) {
    actions.append(el("button", {
      class: "ghost-sm",
      type: "button",
      text: "결과 보기",
      onclick: () => {
        markNotificationRead(n);
        openRoutineResult(n.conversationId);
      },
    }));
  }
  const delBtn = el("button", { class: "msg-act danger", type: "button", "aria-label": "알림 삭제", title: "알림 삭제" });
  delBtn.append(icon("trash"));
  delBtn.addEventListener("click", async () => {
    setFormBusy(row, true);
    const savedTitle = delBtn.title;
    const savedLabel = delBtn.getAttribute("aria-label");
    delBtn.title = "삭제 중…";
    delBtn.setAttribute("aria-label", "알림 삭제 중");
    try {
      await api(`/api/me/notifications/${encodeURIComponent(n.id)}`, { method: "DELETE" });
      try {
        await refresh?.({ surfaceErrors: true });
        notify("알림을 삭제했습니다.", "ok");
      } catch (err) {
        setFormBusy(row, false);
        delBtn.title = savedTitle;
        delBtn.setAttribute("aria-label", savedLabel || "알림 삭제");
        notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      }
    } catch (e) {
      setFormBusy(row, false);
      delBtn.title = savedTitle;
      delBtn.setAttribute("aria-label", savedLabel || "알림 삭제");
      notify(`삭제 실패: ${e.message}`);
    }
  });
  actions.append(delBtn);
  row.append(actions);
  return row;
}

function markNotificationRead(n) {
  if (!n || n.readAt) return;
  n.readAt = new Date().toISOString();
  updateInboxBadge();
  // Fire-and-forget; the navigation target should not wait on this bookkeeping.
  api(`/api/me/notifications/${encodeURIComponent(n.id)}/read`, { method: "PATCH" }).catch(() => {});
}

// Open a new chat with my own avatar, composer pre-filled with the notification's
// topic (the owner can edit before sending). Marks the notification read in passing.
function openNotificationChat(n) {
  markNotificationRead(n);
  const seed = `다음은 네가 남긴 알림이야. 이 주제로 이어서 이야기하자.\n\n[${n.title}]\n${n.message}`;
  chatAboutTopic(seed);
}

// Spin up a fresh conversation with the owner's own avatar and drop `seedText`
// into the composer (not sent — the owner reviews/edits first).
function chatAboutTopic(seedText) {
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
  }
  refreshConversations();
}

// The routines tab is now the single home for routines: this panel both MANAGES
// them (add/edit/toggle/run/delete) and selects which result transcript shows on
// the right. The old settings ▸ 루틴 tab is gone — this replaces it.
function buildRoutineManagePanel() {
  const list = el("div", { class: "routine-manage-list" });
  const filterBar = el("div", { class: "routine-filter seg-control", role: "radiogroup", "aria-label": "루틴 필터" });
  wireSegmentedRadioKeys(filterBar);
  const countLabel = el("span", { class: "muted nowrap" });
  const search = el("input", {
    class: "routine-search",
    type: "search",
    placeholder: "루틴 검색",
    value: state.routineSearch,
    "aria-label": "루틴 검색",
    disabled: state.routines.length ? null : "",
    oninput: () => {
      state.routineSearch = search.value;
      renderRoutineManageRows(list, { searchInput: search, filterBar, countLabel });
    },
  });
  const addBtn = el("button", { class: "primary small routine-add-btn", type: "button", onclick: () => openRoutineModal(null) });
  addBtn.append(icon("plus"), el("span", { text: "루틴 추가" }));
  const tools = el("div", { class: "routine-tools" }, [search, countLabel]);
  const card = el("section", { class: "settings-card routine-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "내 루틴" }),
        el("p", { class: "muted", text: "매일·매주 또는 일정 간격(KST)으로 아바타가 스스로 실행합니다. 카드를 누르면 결과가 오른쪽에 표시돼요." }),
      ]),
      addBtn,
    ]),
    tools,
    filterBar,
    list,
  ]);
  renderRoutineManageRows(list, { searchInput: search, filterBar, countLabel });
  return card;
}

function renderRoutineManageRows(list, { searchInput = null, filterBar = null, countLabel = null } = {}) {
  list.replaceChildren();
  const filterDefs = [
    { id: "all", label: "전체", match: () => true },
    { id: "enabled", label: "사용 중", match: (r) => r.enabled },
    { id: "paused", label: "일시 정지", match: (r) => !r.enabled },
    { id: "error", label: "실패", match: (r) => r.lastStatus === "error" },
  ];
  const filterLabel = (id) => filterDefs.find((f) => f.id === id)?.label || "전체";
  if (!filterDefs.some((f) => f.id === state.routineFilter)) state.routineFilter = "all";
  const syncFilters = () => {
    if (!filterBar) return;
    filterBar.replaceChildren(
      ...filterDefs.map((f) => {
        const active = state.routineFilter === f.id;
        const count = state.routines.filter(f.match).length;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: `${f.label} ${count}`,
          onclick: () => {
            state.routineFilter = f.id;
            renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
          },
        });
      }),
    );
  };
  syncFilters();
  if (!state.routines.length) {
    if (countLabel) countLabel.textContent = "총 0개";
    if (filterBar) filterBar.hidden = true;
    list.append(
      el("div", { class: "empty-note" }, [
        "아직 등록한 루틴이 없습니다.\n",
        el("button", { class: "linkish small", type: "button", text: "첫 루틴 추가", onclick: () => openRoutineModal(null) }),
      ]),
    );
    return;
  }
  if (filterBar) filterBar.hidden = false;
  const q = state.routineSearch.trim().toLowerCase();
  const activeFilter = filterDefs.find((f) => f.id === state.routineFilter) || filterDefs[0];
  const filtered = state.routines.filter(activeFilter.match);
  const routines = q
    ? filtered.filter((r) => {
        const haystack = [
          routineTitle(r),
          r.prompt || "",
          formatRoutineSchedule(r),
          r.enabled ? "사용 중" : "일시 정지",
          r.lastStatus === "error" ? "실패" : "완료",
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      })
    : filtered;
  if (countLabel) countLabel.textContent = routines.length === state.routines.length ? `총 ${state.routines.length}개` : `표시 ${routines.length}개 / 전체 ${state.routines.length}개`;
  if (!routines.length) {
    const resetRoutineFilter = () => {
      state.routineFilter = "all";
      renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
      filterBar?.querySelector('[data-value="all"]')?.focus();
    };
    const clearRoutineSearch = () => {
      state.routineSearch = "";
      if (searchInput) searchInput.value = "";
      renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
      searchInput?.focus();
    };
    const children = [
      q
        ? `"${state.routineSearch.trim()}"에 맞는 ${state.routineFilter === "all" ? "루틴" : `${filterLabel(state.routineFilter)} 루틴`}이 없습니다.\n`
        : `${filterLabel(state.routineFilter)} 루틴이 없습니다.\n`,
    ];
    if (q) children.push(el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearRoutineSearch }));
    if (state.routineFilter !== "all") children.push(q ? " " : "", el("button", { class: "linkish small", type: "button", text: "전체 루틴 보기", onclick: resetRoutineFilter }));
    list.append(
      el("div", { class: "empty-note" }, children),
    );
    return;
  }
  for (const r of routines) {
    const active = state.routineConversationId === r.conversationId;
    const errored = r.lastStatus === "error";

    // Status dot: green=enabled+ok, red=enabled+last error, grey=disabled.
    const dotClass = !r.enabled ? "off" : errored ? "err" : "on";
    const dot = el("span", { class: `routine-dot ${dotClass}`, "aria-hidden": "true" });

    const title = routineTitle(r);
    const toggle = buildToggle(r.enabled, async (val) => {
      try {
        await api(`/api/me/routines/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
      } catch (e) {
        notify(`변경 실패: ${e.message}`);
        throw e;
      }
      r.enabled = val;
      try {
        await loadRoutines();
        renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
        notify(`"${title}" 루틴을 ${val ? "사용" : "일시 정지"}했습니다.`, "ok");
      } catch (e) {
        renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
        notify(`루틴 상태는 변경했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    }, `루틴 사용: ${title}`);
    // Don't let the toggle's click bubble to the row (which would change selection).
    toggle.addEventListener("click", (e) => e.stopPropagation());

    const meta = [formatRoutineSchedule(r)];
    if (r.lastRunAt) meta.push(`최근 실행 ${timeLabel(r.lastRunAt)} · ${errored ? "실패" : "완료"}`);
    else meta.push("아직 실행되지 않음");

    const editBtn = el("button", { class: "ghost-sm", type: "button" });
    editBtn.append(icon("edit"), el("span", { text: "편집" }));
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRoutineModal(r);
    });

    let row;
    const runBtn = el("button", { class: "ghost-sm", type: "button", text: "지금 실행" });
    runBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runRoutineFromButton(r, runBtn, row);
    });

    row = el("div", {
      class: `routine-manage-row ${active ? "active" : ""} ${r.enabled ? "" : "paused"}`,
      role: "button",
      tabindex: "0",
      "aria-pressed": active ? "true" : "false",
      onclick: () => {
        if (row.getAttribute("aria-busy") === "true") return;
        openRoutineResult(r.conversationId);
      },
      onkeydown: (e) => {
        if (row.getAttribute("aria-busy") === "true") return;
        // Only act on keys aimed at the row itself, not its inner buttons.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openRoutineResult(r.conversationId);
        }
      },
    }, [
      el("div", { class: "routine-manage-head" }, [
        dot,
        el("strong", { class: "routine-manage-title", text: routineTitle(r) }),
        toggle,
      ]),
      el("div", { class: "routine-manage-meta", text: meta.join(" · ") }),
      errored && r.lastError ? el("div", { class: "error-note", text: r.lastError }) : null,
      el("div", { class: "routine-manage-actions" }, [editBtn, runBtn]),
    ]);
    list.append(row);
  }
}

async function runRoutineNow(routine) {
  const res = await api(`/api/me/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
  await Promise.all([loadRoutines(), loadRoutineConversations(), loadNotifications()]);
  updateNotificationBadge();
  if (res && res.ok === false) notify(`루틴 실행 실패: ${res.error || "알 수 없는 오류"}`);
  // Jump straight to the result this run just produced.
  openRoutineResult(routine.conversationId);
}

async function runRoutineFromButton(routine, button, busyRoot = null) {
  if (!routine || !button) return;
  const saved = button.textContent;
  if (busyRoot) setFormBusy(busyRoot, true);
  else button.disabled = true;
  button.textContent = "실행 중…";
  try {
    await runRoutineNow(routine);
  } catch (err) {
    if (busyRoot) setFormBusy(busyRoot, false);
    else button.disabled = false;
    button.textContent = saved;
    notify(`루틴 실행 실패: ${err.message}`);
  }
}

function buildRoutineResultPanel(messageLoadError = "") {
  const conv = state.routineConversations.find((c) => c.id === state.routineConversationId);
  const routine = conv ? state.routines.find((r) => r.conversationId === conv.id) : null;
  const transcript = el("div", { class: "routine-result-transcript transcript scroll-thin" });
  const inner = el("div", { class: "transcript-inner" });
  transcript.append(inner);
  // Standing prompt block: the instruction this routine runs, always in view above
  // the results (own scroll so a long prompt can't crowd out the transcript).
  let promptBlock = null;
  if (routine) {
    const promptBody = el("div", { class: "routine-result-prompt-body md scroll-thin" });
    const promptText = (routine.prompt || "").trim();
    if (promptText) promptBody.innerHTML = renderMarkdown(promptText);
    else promptBody.append(el("span", { class: "muted", text: "(프롬프트 없음)" }));
    promptBlock = el("div", { class: "routine-result-prompt" }, [
      el("div", { class: "routine-result-prompt-label muted", text: "지시 프롬프트" }),
      promptBody,
    ]);
  }
  const card = el("section", { class: "settings-card routine-result-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: conv?.title || "루틴 결과" }),
        el("p", { class: "muted", text: conv ? `${conv.avatarDisplayName} · ${timeLabel(conv.updatedAt)}` : "루틴 실행 기록을 선택하세요." }),
      ]),
      conv ? el("button", { class: "ghost-sm", type: "button", text: "일반 대화로 열기", onclick: () => selectConversation(conv) }) : null,
    ]),
    promptBlock,
    transcript,
  ]);
  if (!conv) {
    const firstRoutine = state.routines[0];
    const runFirstBtn = firstRoutine
      ? el("button", {
          class: "linkish small",
          type: "button",
          text: "첫 루틴 지금 실행",
          onclick: (event) => runRoutineFromButton(firstRoutine, event.currentTarget, card),
        })
      : null;
    inner.append(
      state.routines.length
        ? el("div", { class: "empty-note" }, [
            "아직 확인할 실행 결과가 없습니다. 바로 실행하거나 다음 예약 실행 후 결과가 표시됩니다.\n",
            runFirstBtn,
          ])
        : el("div", { class: "empty-note" }, [
            "아직 확인할 루틴 결과가 없습니다.\n",
            el("button", { class: "linkish small", type: "button", text: "첫 루틴 추가", onclick: () => openRoutineModal(null) }),
          ]),
    );
    return card;
  }
  if (messageLoadError) {
    inner.append(
      el("div", { class: "warn-box" }, [
        `루틴 결과를 불러오지 못했습니다: ${messageLoadError} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return card;
  }
  if (!state.routineMessages.length) {
    inner.append(
      el("div", { class: "empty-note" }, [
        "아직 실행 메시지가 없습니다.\n",
        routine ? el("button", { class: "linkish small", type: "button", text: "지금 다시 실행", onclick: (event) => runRoutineFromButton(routine, event.currentTarget, card) }) : null,
      ]),
    );
    return card;
  }
  // A flat thread grows unreadable over many runs. Group it into per-run blocks
  // (one user-prompt → its assistant result(s)), newest FIRST and only the newest
  // expanded; the rest collapse to a one-line header you can open on demand.
  const runs = groupRoutineRuns(state.routineMessages);
  const currentPrompt = (routine?.prompt || "").trim();
  for (let i = runs.length - 1; i >= 0; i--) {
    inner.append(buildRoutineRunBlock(runs[i], i + 1, i === runs.length - 1, currentPrompt, routine));
  }
  return card;
}

// Split the alternating user/assistant transcript into runs: each user message
// starts a new run and the assistant message(s) that follow belong to it.
function groupRoutineRuns(messages) {
  const runs = [];
  let current = null;
  for (const m of messages) {
    if (m.role === "user") {
      current = { prompt: m, responses: [], at: m.createdAt || null };
      runs.push(current);
    } else {
      if (!current) {
        current = { prompt: null, responses: [], at: m.createdAt || null };
        runs.push(current);
      }
      current.responses.push(m);
      if (m.createdAt) current.at = m.createdAt;
    }
  }
  return runs;
}

function buildRoutineRunBlock(run, runNumber, expanded, currentPrompt, routine = null) {
  const time = run.at ? timeLabel(run.at) : "";
  const details = el("details", { class: "routine-run-block", ...(expanded ? { open: "" } : {}) });
  details.append(
    el("summary", { class: "routine-run-summary" }, [
      el("span", { class: "routine-run-chevron", "aria-hidden": "true" }),
      el("span", { class: "routine-run-num", text: `실행 #${runNumber}` }),
      time ? el("span", { class: "routine-run-time muted", text: time }) : null,
    ]),
  );
  const body = el("div", { class: "routine-run-body" });
  // If this run's prompt differs from the routine's current one (it was edited
  // since), surface that run's actual instruction; otherwise the pinned block covers it.
  const runPrompt = (run.prompt?.content || "").trim();
  if (runPrompt && runPrompt !== currentPrompt) {
    const note = el("div", { class: "routine-run-prompt md" });
    note.innerHTML = renderMarkdown(runPrompt);
    body.append(el("div", { class: "routine-run-prompt-label muted", text: "이때의 지시" }), note);
  }
  if (run.responses.length) {
    for (const m of run.responses) body.append(buildRoutineMessageNode(m));
  } else {
    body.append(
      el("div", { class: "empty-note" }, [
        "이 실행에는 결과 메시지가 없습니다.\n",
        routine ? el("button", { class: "linkish small", type: "button", text: "현재 루틴 다시 실행", onclick: (event) => runRoutineFromButton(routine, event.currentTarget, details) }) : null,
      ]),
    );
  }
  details.append(body);
  return details;
}

function buildRoutineMessageNode(message) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "루틴 지시" : state.user?.displayName || "아바타" }),
      message.createdAt ? el("time", { class: "msg-time", datetime: message.createdAt, text: timeLabel(message.createdAt) }) : null,
    ]),
  );
  const bubble = el("div", { class: "bubble" });
  if (isUser) bubble.textContent = message.content;
  else renderAssistantInto(bubble, message);
  wrap.append(bubble);
  return wrap;
}

function openRoutineResult(conversationId) {
  state.routineConversationId = conversationId || "";
  state.view = "routines";
  syncHash();
  renderView();
}

/* ============================================================ Inbox (알림) */
// Notification hub: avatar notifications + colleague info-requests in one
// chronological list. Notifications are messenger-style (click → chat about the
// topic, X → delete); info-requests keep their answer/dismiss flow. Two backends
// (avatar_notifications / knowledge_requests) stay distinct — this merges only the UI.
let inboxViewSeq = 0;

async function renderInboxView() {
  const renderSeq = ++inboxViewSeq;
  const header = viewHeader("알림", "아바타가 남긴 알림과 동료의 정보 요청을 한곳에서 확인하세요");
  const body = el("div", { class: "view-body scroll-thin inbox-body" }, [
    el("div", { class: "muted pad", text: "불러오는 중…" }),
  ]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === inboxViewSeq && state.view === "inbox" && body.isConnected;

  // routineConversations only gates the notification "결과 보기" link — its failure
  // shouldn't blank the whole list, so it's tolerated separately.
  const results = await Promise.allSettled([loadKnowledge(), loadNotifications(), loadRoutineConversations()]);
  if (sessionExpired) return;
  if (!isCurrent()) return;
  if (results[0].status === "rejected" && results[1].status === "rejected") {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `알림을 불러오지 못했습니다: ${results[0].reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  const loadWarnings = [];
  if (results[0].status === "rejected") loadWarnings.push("정보 요청");
  if (results[1].status === "rejected") loadWarnings.push("아바타 알림");
  if (results[2].status === "rejected") loadWarnings.push("루틴 결과 링크");
  const loadWarning = loadWarnings.length
    ? el("div", { class: "warn-box inbox-load-warning" }, [
        `일부 항목(${loadWarnings.join(" · ")})을 불러오지 못했습니다. 표시된 목록은 일부만 최신일 수 있습니다. `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ])
    : null;
  updateKnowledgeBadge();
  updateNotificationBadge();

  const list = el("div", { class: "inbox-list" });
  const headerActions = el("div", { class: "head-actions" });
  const filterBar = el("div", { class: "inbox-filter seg-control", role: "radiogroup", "aria-label": "알림 필터" });
  wireSegmentedRadioKeys(filterBar);
  const card = el("section", { class: "settings-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "알림" }),
        el("p", { class: "muted", text: "알림을 누르면 그 주제로 내 아바타와 대화할 수 있고, 휴지통으로 삭제합니다. ‘정보 요청’은 답을 적어 보내면 아바타가 지식 저장소에 기록합니다." }),
      ]),
      headerActions,
    ]),
    loadWarning,
    filterBar,
    list,
  ]);
  let resetInboxFilter = null;
  const syncFilters = () => {
    const openRequests = state.knowledgeRequests.filter((r) => r.status === "open").length;
    const totalNotifications = state.notifications.length;
    const unreadNotifications = state.notifications.filter((n) => !n.readAt).length;
    const filters = [
      { id: "all", label: `전체 ${openRequests + totalNotifications}` },
      { id: "requests", label: `정보 요청 ${openRequests}` },
      { id: "unread", label: `읽지 않은 알림 ${unreadNotifications}` },
      { id: "notifications", label: `알림 ${totalNotifications}` },
    ];
    if (!filters.some((f) => f.id === state.inboxFilter)) state.inboxFilter = "all";
    filterBar.replaceChildren(
      ...filters.map((f) => {
        const active = state.inboxFilter === f.id;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: f.label,
          onclick: () => {
            state.inboxFilter = f.id;
            syncFilters();
            renderInboxItems(list, refresh, resetInboxFilter);
          },
        });
      }),
    );
  };

  const refresh = async ({ surfaceErrors = false } = {}) => {
    let refreshError = null;
    try {
      await Promise.all([loadKnowledge(), loadNotifications()]);
    } catch (err) {
      refreshError = err;
      /* keep current state on transient failure */
    }
    if (!isCurrent()) return;
    updateKnowledgeBadge();
    updateNotificationBadge();
    syncHeaderActions();
    syncFilters();
    renderInboxItems(list, refresh, resetInboxFilter);
    if (refreshError && surfaceErrors) throw refreshError;
  };

  const syncHeaderActions = () => {
    headerActions.replaceChildren();
    const unread = state.notifications.filter((n) => !n.readAt).length;
    const total = state.notifications.length;
    if (unread) {
      headerActions.append(
        el("button", {
          class: "ghost-sm",
          type: "button",
          text: "알림 모두 읽음",
          onclick: async (event) => {
            const btn = event.currentTarget;
            const saved = btn.textContent;
            setFormBusy(card, true);
            btn.textContent = "처리 중…";
            try {
              await api("/api/me/notifications/read-all", { method: "POST" });
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`처리 실패: ${e.message}`);
              return;
            }
            try {
              await refresh({ surfaceErrors: true });
              setFormBusy(card, false);
              notify(`알림 ${unread}개를 읽음 처리했습니다.`, "ok");
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`알림은 읽음 처리했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
            }
          },
        }),
      );
    }
    if (total) {
      headerActions.append(
        el("button", {
          class: "ghost-sm danger",
          type: "button",
          text: "알림 비우기",
          onclick: async (event) => {
            if (!window.confirm(`알림 ${total}개를 모두 삭제할까요? 정보 요청은 삭제되지 않습니다.`)) return;
            const btn = event.currentTarget;
            const saved = btn.textContent;
            setFormBusy(card, true);
            btn.textContent = "삭제 중…";
            try {
              await api("/api/me/notifications", { method: "DELETE" });
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`삭제 실패: ${e.message}`);
              return;
            }
            try {
              await refresh({ surfaceErrors: true });
              setFormBusy(card, false);
              notify(`알림 ${total}개를 삭제했습니다.`, "ok");
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
            }
          },
        }),
      );
    }
  };

  resetInboxFilter = () => {
    state.inboxFilter = "all";
    syncFilters();
    renderInboxItems(list, refresh, resetInboxFilter);
    filterBar.querySelector('[data-value="all"]')?.focus();
  };
  syncHeaderActions();
  syncFilters();
  renderInboxItems(list, refresh, resetInboxFilter);
  if (!isCurrent()) return;
  body.replaceChildren(el("div", { class: "inbox-wrap" }, [card]));
}

function renderInboxItems(list, refresh, resetFilter = null) {
  list.replaceChildren();
  const items = [
    ...state.knowledgeRequests
      .filter((r) => r.status === "open")
      .map((r) => ({ kind: "request", at: r.createdAt || "", data: r })),
    ...state.notifications.map((n) => ({ kind: "notification", at: n.createdAt || "", data: n })),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const filtered =
    state.inboxFilter === "requests"
      ? items.filter((item) => item.kind === "request")
      : state.inboxFilter === "unread"
        ? items.filter((item) => item.kind === "notification" && !item.data.readAt)
        : state.inboxFilter === "notifications"
          ? items.filter((item) => item.kind === "notification")
          : items;

  if (!filtered.length) {
    const emptyTexts = {
      all: "새 알림이나 정보 요청이 없습니다.",
      requests: "열린 정보 요청이 없습니다.",
      unread: "읽지 않은 알림이 없습니다.",
      notifications: "아바타 알림이 없습니다.",
    };
    const emptyText = items.length
      ? `이 필터에 해당하는 항목이 없습니다. ${emptyTexts[state.inboxFilter] || ""}`.trim()
      : emptyTexts[state.inboxFilter] || emptyTexts.all;
    const emptyChildren = [emptyText];
    if (items.length && state.inboxFilter !== "all") {
      emptyChildren.push("\n", el("button", { class: "linkish small", type: "button", text: "전체 보기", onclick: () => resetFilter?.() }));
    }
    list.append(el("div", { class: "empty-note" }, emptyChildren));
    return;
  }
  for (const item of filtered) {
    list.append(
      item.kind === "request"
        ? buildKnowledgeRequestRow(item.data, refresh)
        : buildNotificationRow(item.data, refresh),
    );
  }
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
  if (!splitEnabled() || state.chatPanes.length >= MAX_CHAT_PANES) return;
  if (state.chatPanes.some((pane) => pane.avatar?.id === avatarId)) return;
  const avatar = splitAvatarOptions().find((av) => av.id === avatarId) || activePane()?.avatar || state.currentAvatar || state.user;
  const pane = makeChatPane(avatar);
  state.chatPanes.push(pane);
  state.activePaneId = pane.id;
  syncLegacyChatState(pane);
  renderView();
}

function closeChatPane(pane) {
  if (state.chatPanes.length <= 1) return;
  if (pane.streaming) stopStreaming(pane);
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

function openKnowledgeSettings() {
  state.settingsTab = "knowledge";
  goView("settings");
}

function renderCapabilitiesPanel(av) {
  const skillsBody = el("div", { class: "cap-section-body cap-skills" });
  const plugins = av.plugins || [];
  const canManageCapabilities = state.user?.id === av.id;
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
  const body = el("div", { class: "cap-body scroll-thin" }, [
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
      pane.dom.textarea.value = message.content;
      pane.dom.textarea.dispatchEvent(new Event("input"));
      pane.dom.textarea.focus();
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
        // Owner-only group-knowledge selection for this conversation (group ids
        // turned OFF). Server applies + persists it; ignored for colleague chats.
        groupKnowledgeOff: pane.groupKnowledgeOff || [],
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
  if (activePane()?.id === pane.id) abortController = pane.abortController;
  let sawEvent = false;
  try {
    const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      credentials: "same-origin",
      signal: pane.abortController.signal,
    });
    if (response.status === 401) {
      handleSessionExpired();
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
async function refreshConversations() {
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
function renderConversations() {
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
    const openBtn = el("button", { class: "conv-open", type: "button", title: conv.title, onclick: () => selectConversation(conv, openBtn, item) }, [
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

async function selectConversation(conv, triggerBtn = null, row = null) {
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

/* ============================================================ Settings (my avatar) */
// Shared tablist builder used by renderSettings and renderAdmin.
// tabs: array of { id, label, icon? }
// getTab: () => current tab id
// setTab: (id) => void — updates state
// ariaLabel: string for the nav element
// idPrefix: string prepended to "tab-<id>" for each button id
// panelId: aria-controls value
// onActivate: () => void — called after setTab when a tab is clicked
// Returns { tabBar, syncTabs } — caller appends tabBar and calls syncTabs() once.
function buildTabBar({ tabs, getTab, setTab, ariaLabel, idPrefix, panelId, onActivate }) {
  const tabBar = el("nav", { class: "settings-tabs", role: "tablist", "aria-label": ariaLabel });
  const scrollActiveTabIntoView = () => {
    const active = tabBar.querySelector(".settings-tab.active");
    if (!active || !tabBar.isConnected) return;
    requestAnimationFrame(() => active.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const syncTabs = () => {
    for (const b of tabBar.children) {
      const active = b.dataset.tab === getTab();
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    }
    scrollActiveTabIntoView();
  };
  for (const t of tabs) {
    const btn = el("button", {
      class: "settings-tab" + (t.id === getTab() ? " active" : ""),
      type: "button",
      role: "tab",
      id: `${idPrefix}-${t.id}`,
      "aria-controls": panelId,
      dataset: { tab: t.id },
      onclick: () => {
        if (getTab() === t.id) return;
        setTab(t.id);
        syncHash(true);
        syncTabs();
        onActivate();
      },
    });
    if (t.icon) btn.append(icon(t.icon));
    btn.append(el("span", { text: t.label }));
    tabBar.append(btn);
  }
  // Standard tablist keyboard interaction: arrows/Home/End move + activate.
  tabBar.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...tabBar.children];
    if (!items.length) return;
    const idx = items.findIndex((b) => b.dataset.tab === getTab());
    const current = idx >= 0 ? idx : 0;
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (current + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
    const next = items[nextIndex];
    next.focus();
    next.click();
  });
  return { tabBar, syncTabs };
}

function wireSegmentedRadioKeys(group) {
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const buttons = [...group.querySelectorAll('button[role="radio"]:not(:disabled)')];
    if (!buttons.length) return;
    e.preventDefault();
    const activeIndex = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const focusIndex = buttons.indexOf(document.activeElement);
    const current = activeIndex >= 0 ? activeIndex : Math.max(0, focusIndex);
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : buttons.length - 1)) % buttons.length;
    const next = buttons[nextIndex];
    const nextValue = next.dataset.value || "";
    next.focus();
    next.click();
    requestAnimationFrame(() => {
      const currentButtons = [...group.querySelectorAll('button[role="radio"]:not(:disabled)')];
      const target = currentButtons.find((b) => nextValue && b.dataset.value === nextValue) ||
        currentButtons.find((b) => b.getAttribute("aria-checked") === "true");
      target?.focus();
    });
  });
}

let settingsViewSeq = 0;

async function renderSettings() {
  const renderSeq = ++settingsViewSeq;
  const header = viewHeader("내 아바타", "프로필과 플러그인을 관리하고 공개하세요");
  const body = el("div", { class: "view-body scroll-thin settings-body" });
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === settingsViewSeq && state.view === "settings" && body.isConnected;

  body.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  // One failed loader must NOT render every card as its empty state ("플러그인이
  // 없습니다" 등) — that reads as data loss and invites duplicate re-adds.
  const results = await Promise.allSettled([refreshMe(), loadPlugins(), loadKnowledge()]);
  if (sessionExpired) return;
  if (!isCurrent()) return;
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
      const saved = delPicBtn.textContent;
      delPicBtn.disabled = true;
      delPicBtn.textContent = "삭제 중…";
      camBtn.disabled = true;
      try {
        await api("/api/me/avatar-image", { method: "DELETE" });
        state.user.hasImage = false;
        delPicBtn.textContent = saved;
        delPicBtn.disabled = false;
        camBtn.disabled = false;
        renderPic();
        renderRailUser();
        notify("아바타 사진을 삭제했습니다.", "ok");
      } catch (e) {
        delPicBtn.textContent = saved;
        delPicBtn.disabled = false;
        camBtn.disabled = false;
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
    const savedTitle = camBtn.title;
    camBtn.disabled = true;
    camBtn.title = "업로드 중…";
    camBtn.setAttribute("aria-label", "사진 업로드 중");
    delPicBtn.disabled = true;
    try {
      const dataUrl = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image: dataUrl }) });
      state.user.hasImage = true;
      camBtn.disabled = false;
      camBtn.title = savedTitle;
      camBtn.setAttribute("aria-label", "사진 변경");
      delPicBtn.disabled = false;
      renderPic();
      renderRailUser();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (e) {
      camBtn.disabled = false;
      camBtn.title = savedTitle;
      camBtn.setAttribute("aria-label", "사진 변경");
      delPicBtn.disabled = false;
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
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const res = await api("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ displayName: fd.get("displayName"), alias: fd.get("alias"), bio: fd.get("bio"), persona: fd.get("persona"), intro: fd.get("intro"), hashtags: hashtagEditor.getTags() }),
        });
        state.user = res.user;
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
        if (dom.navButtons) renderRailUser();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
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
        if (intro) {
          introField.value = intro;
          notify("자기소개 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
        } else {
          notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
        }
      } catch (err) {
        notify(`자기소개 생성 실패: ${err.message}`);
      } finally {
        introGenBtn.textContent = label;
        introGenBtn.disabled = false;
      }
    },
  });

  // Capability hashtags with an "auto-generate" button: the avatar proposes a set
  // of searchable tags from its skills/persona, dropped into the chip editor for
  // the owner to tweak before saving (not persisted until 프로필 저장).
  const hashtagEditor = buildHashtagEditor(u.hashtags || []);
  const tagGenBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "아바타가 자동 생성",
    onclick: async () => {
      tagGenBtn.disabled = true;
      const label = tagGenBtn.textContent;
      tagGenBtn.textContent = "생성 중…";
      try {
        const { hashtags } = await api("/api/me/hashtags/generate", { method: "POST" });
        if (hashtags && hashtags.length) {
          hashtagEditor.setTags(hashtags);
          notify("해시태그 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
        } else {
          notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
        }
      } catch (err) {
        notify(`해시태그 생성 실패: ${err.message}`);
      } finally {
        tagGenBtn.textContent = label;
        tagGenBtn.disabled = false;
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
    el("div", { class: "field" }, [
      el("div", { class: "field-row" }, [
        el("span", { text: "역량 해시태그 (탐색에서 검색됨)" }),
        tagGenBtn,
      ]),
      hashtagEditor.wrap,
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "페르소나 (행동 지침)" }),
      el("textarea", { name: "persona", rows: "4", placeholder: "이 아바타가 어떻게 행동해야 하는지 (선택)", text: u.persona || "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "프로필 저장" }),
  );

  // Visibility selector (모두 공개 / 그룹 공개 / 비공개) — updates in place: a full
  // renderView here would wipe whatever the user typed (but hasn't saved) above.
  const publishRow = buildVisibilitySelect(u.visibility || "group", async (val) => {
    const res = await api("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
    state.user = res.user;
    return res.user.visibility;
  });

  // Group the (many) settings cards into tabs so a single screen no longer
  // dumps everything into one long scroll. Each tab lazily builds its cards.
  const profileCard = el("section", { class: "settings-card" }, [
    el("div", { class: "settings-head" }, [picWrap, el("div", { class: "settings-id" }, [el("h3", { text: u.displayName }), el("div", { class: "muted", text: `@${u.username}` })])]),
    profileForm,
  ]);
  const publishCard = el("section", { class: "settings-card" }, [el("h3", { text: "공개 설정" }), publishRow]);

  const tabs = [
    { id: "profile", label: "프로필", icon: "user", cards: () => [profileCard, publishCard] },
    { id: "access", label: "권한·연결", icon: "shield", cards: () => [buildGitCredentialsCard(), buildSecretsCard()] },
    { id: "knowledge", label: "지식·플러그인", icon: "book", cards: () => [buildKnowledgeRepoCard(), buildPluginsCard()] },
    { id: "groups", label: "그룹", icon: "users", cards: () => [buildGroupsCard()] },
  ];
  const requestedSettingsTab = state.settingsTab;
  if (!tabs.some((t) => t.id === state.settingsTab)) state.settingsTab = "profile";
  if (state.settingsTab !== requestedSettingsTab) syncHashAfterRoute();

  const panel = el("div", { class: "settings-panel", role: "tabpanel", id: "settings-panel" });
  const renderTab = () => {
    const active = tabs.find((t) => t.id === state.settingsTab) || tabs[0];
    panel.setAttribute("aria-labelledby", `settings-tab-${active.id}`);
    panel.replaceChildren(...active.cards());
  };

  const { tabBar, syncTabs } = buildTabBar({
    tabs,
    getTab: () => state.settingsTab,
    setTab: (id) => { state.settingsTab = id; },
    ariaLabel: "설정 분류",
    idPrefix: "settings-tab",
    panelId: "settings-panel",
    onActivate: renderTab,
  });
  renderTab();
  if (!isCurrent()) return;
  body.replaceChildren(tabBar, panel);
  syncTabs();
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

// The three avatar-visibility choices, in display order. `value` matches the
// server's AvatarVisibility enum; `desc` is the explanatory line under the picker.
const VISIBILITY_OPTIONS = [
  { value: "public", label: "모두 공개", desc: "모든 사용자가 탐색에서 찾아 대화할 수 있어요." },
  { value: "group", label: "그룹 공개", desc: "같은 그룹 멤버만 탐색에서 찾아 대화할 수 있어요." },
  { value: "private", label: "비공개", desc: "나만 볼 수 있어요." },
];

// Segmented radio control for avatar visibility. `onChange(value)` should
// persist and resolve to the saved value (the server is authoritative); on
// rejection the selection reverts and a toast shows. Optimistically highlights
// the chosen option while the save is in flight.
function buildVisibilitySelect(current, onChange) {
  let value = VISIBILITY_OPTIONS.some((o) => o.value === current) ? current : "group";
  let saving = false;
  const desc = el("p", { class: "muted" });
  const seg = el("div", { class: "seg-control", role: "radiogroup", "aria-label": "아바타 공개 범위" });
  const buttons = new Map();
  const sync = () => {
    seg.setAttribute("aria-busy", saving ? "true" : "false");
    for (const [val, btn] of buttons) {
      const active = val === value;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
      btn.disabled = saving;
    }
    const baseDesc = VISIBILITY_OPTIONS.find((o) => o.value === value)?.desc || "";
    desc.textContent = saving ? `${baseDesc} 저장 중…` : baseDesc;
  };
  const choose = async (val) => {
    if (saving || val === value) return;
    const prev = value;
    value = val;
    saving = true;
    sync();
    try {
      const saved = await onChange(val);
      if (saved && saved !== value) {
        value = saved;
        sync();
        const savedLabel = VISIBILITY_OPTIONS.find((o) => o.value === saved)?.label || saved;
        notify(`공개 범위가 서버에서 ${savedLabel}(으)로 저장되었습니다.`, "warn");
      } else {
        const savedLabel = VISIBILITY_OPTIONS.find((o) => o.value === value)?.label || value;
        notify(`공개 범위를 ${savedLabel}(으)로 변경했습니다.`, "ok");
      }
    } catch (e) {
      value = prev;
      notify(`공개 범위 변경 실패: ${e.message}`);
    } finally {
      saving = false;
      sync();
    }
  };
  for (const opt of VISIBILITY_OPTIONS) {
    const btn = el("button", { type: "button", class: "seg-btn", role: "radio", dataset: { value: opt.value }, text: opt.label, onclick: () => choose(opt.value) });
    buttons.set(opt.value, btn);
    seg.append(btn);
  }
  wireSegmentedRadioKeys(seg);
  sync();
  return el("div", { class: "visibility-row" }, [seg, desc]);
}

// Turn a text input into a user typeahead: searches /api/me/users/search and
// shows a dropdown of matches; picking one fills the input with that @username.
// Returns a wrapper element (input + results) to place in the layout. Used by
// the group member-add forms — group membership is how trust/elevation is
// granted, so finding people by name (not just exact username) matters.
function attachUserSearch(input, opts = {}) {
  const {
    onSelect = null,
    excludeUserIds = () => new Set(),
    excludeUsernames = () => new Set(),
  } = opts;
  const resultsId = `user-search-${newId()}`;
  const results = el("div", { id: resultsId, class: "trusted-results", role: "listbox", hidden: "" });
  const wrap = el("div", { class: "trusted-search" }, [input, results]);
  let seq = 0;
  let timer = null;
  let activeIndex = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", resultsId);
  input.setAttribute("aria-expanded", "false");

  const optionButtons = () => [...results.querySelectorAll(".trusted-result")];
  const hideResults = () => {
    activeIndex = -1;
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const syncActive = () => {
    const buttons = optionButtons();
    buttons.forEach((btn, idx) => {
      const active = idx === activeIndex;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      if (active) input.setAttribute("aria-activedescendant", btn.id);
    });
    if (!buttons.length || activeIndex < 0) input.removeAttribute("aria-activedescendant");
  };
  const chooseUser = (user) => {
    if (onSelect) {
      const accepted = onSelect(user);
      if (accepted !== false) input.value = "";
    } else {
      input.value = user.username;
    }
    hideResults();
    input.focus();
  };
  const render = (users) => {
    results.replaceChildren();
    const excludedIds = excludeUserIds();
    const excludedNames = excludeUsernames();
    const visibleUsers = users.filter((u) => {
      const key = (u.username || "").toLowerCase();
      return !(excludedIds.has(u.id) || excludedNames.has(key));
    });
    if (!visibleUsers.length) {
      activeIndex = -1;
      results.append(el("div", { class: "empty-note", text: "일치하는 사용자가 없습니다." }));
    } else {
      activeIndex = 0;
      visibleUsers.forEach((u, idx) => {
        results.append(
          el("button", {
            id: `${resultsId}-${idx}`,
            type: "button",
            class: "trusted-result",
            role: "option",
            "aria-selected": idx === activeIndex ? "true" : "false",
            onclick: () => chooseUser(u),
          }, [
            el("div", { class: "pr-main" }, [
              el("strong", { text: u.displayName }),
              el("div", { class: "pr-sub", text: `@${u.username}` }),
            ]),
          ]),
        );
      });
    }
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    syncActive();
  };
  const run = async (q) => {
    const s = ++seq;
    try {
      const { users } = await api(`/api/me/users/search?q=${encodeURIComponent(q)}`);
      if (s === seq) render(users);
    } catch {
      if (s === seq) hideResults();
    }
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().replace(/^@/, "");
    clearTimeout(timer);
    if (!q) { seq++; results.replaceChildren(); hideResults(); return; }
    timer = setTimeout(() => run(q), 200);
  });
  input.addEventListener("keydown", (e) => {
    const buttons = optionButtons();
    if (e.key === "Escape" && !results.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideResults();
      return;
    }
    if (results.hidden || !buttons.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + buttons.length) % buttons.length;
      syncActive();
      buttons[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      buttons[activeIndex].click();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => { if (!wrap.contains(document.activeElement)) hideResults(); }, 150);
  });
  return wrap;
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
  let repoInput;
  const focusPluginForm = () => repoInput?.focus();

  const form = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      // Capture the form node now: event.currentTarget is nulled after the
      // handler's first await, so referencing it later would throw and surface
      // a false "추가 실패" even though the plugin was added.
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const ref = (fd.get("ref") || "").toString().trim();
      const label = (fd.get("label") || "").toString().trim();
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "추가 중…"; // server-side git clone — can take a while
      try {
        await api("/api/me/plugins", { method: "POST", body: JSON.stringify({ repo, ref: ref || undefined, label: label || undefined }) });
        await loadPlugins();
        renderPluginRows(list, focusPluginForm);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        formEl.reset();
        notify(`플러그인 "${label || repo}"을 추가했습니다.`, "ok");
      } catch (err) {
        notify(`플러그인 추가 실패: ${err.message}`);
      } finally {
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    repoInput = el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", "aria-label": "플러그인 저장소 (owner/repo 또는 git URL)", required: "" }),
    el("input", { name: "ref", placeholder: "브랜치/태그 (선택)", "aria-label": "브랜치/태그 (선택)", class: "narrow" }),
    el("input", { name: "label", placeholder: "라벨 (선택)", "aria-label": "라벨 (선택)", class: "narrow" }),
    el("button", { class: "primary", type: "submit", text: "추가" }),
  ]);
  form.classList.add("rows-3");
  card.append(form);
  renderPluginRows(list, focusPluginForm);
  return card;
}

function pluginSyncLabel(p) {
  if (!p.lastSyncedAt) return "아직 동기화되지 않음";
  const d = new Date(p.lastSyncedAt);
  if (Number.isNaN(d.getTime())) return "";
  return `동기화: ${timeLabel(p.lastSyncedAt)}`;
}

function renderPluginRows(list, focusAddForm = null) {
  list.replaceChildren();
  if (!state.plugins.length) {
    list.append(
      el("div", { class: "empty-note" }, [
        "추가한 플러그인이 없습니다.\n",
        focusAddForm ? el("button", { class: "linkish small", type: "button", text: "플러그인 저장소 입력", onclick: focusAddForm }) : null,
      ]),
    );
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
        setFormBusy(row, true);
        try {
          await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
          p.enabled = val;
          invalidateSkillsCache(state.user.id);
          renderPluginRows(list);
          notify(`"${p.label || p.repo}" 플러그인을 ${val ? "사용" : "사용 중지"}했습니다.`, "ok");
        } catch (e) {
          notify(`변경 실패: ${e.message}`);
          throw e;
        } finally {
          if (row.isConnected) setFormBusy(row, false);
        }
      }, `플러그인 사용: ${p.label || p.repo}`),
    ]);

    // Expandable contents area for per-plugin selection within the repo.
    const contents = el("div", { class: "plugin-contents", hidden: "" });

    // "선택" — clone/inspect the repo and show a checkbox per contained plugin.
    const selectBtn = el("button", { class: "msg-act", type: "button", "aria-label": "저장소 내 플러그인 선택", title: "저장소 내 플러그인 선택", "aria-expanded": "false" });
    const reloadPluginContents = wireExpander(selectBtn, contents, async (c) => {
      c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
      try {
        const { contents: info } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/contents`);
        renderPluginContents(c, list, p, info);
      } catch (e) {
        c.replaceChildren(el("div", { class: "error-note" }, [
          `조회 실패: ${e.message} `,
          el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadPluginContents() }),
        ]));
      }
    });
    selectBtn.append(icon("menu"));
    row.append(selectBtn);

    // "새로고침" — force git fetch + checkout, bypassing the clone cache.
    const refreshBtn = el("button", { class: "msg-act", type: "button", "aria-label": "최신 버전으로 새로고침", title: "최신 버전으로 새로고침", onclick: async () => {
      setFormBusy(row, true);
      refreshBtn.classList.add("spinning");
      try {
        const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
        Object.assign(p, plugin);
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
        notify(`"${p.label || p.repo}" 플러그인을 최신 버전으로 새로고침했습니다.`, "ok");
      } catch (e) {
        notify(`새로고침 실패: ${e.message}`);
      } finally {
        refreshBtn.classList.remove("spinning");
        if (row.isConnected) setFormBusy(row, false);
      }
    } });
    refreshBtn.append(icon("refresh"));
    row.append(refreshBtn);

    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": `플러그인 삭제: ${p.label || p.repo}`, title: "삭제", onclick: async () => {
      if (!window.confirm(`플러그인 "${p.label || p.repo}"을(를) 삭제할까요?`)) return;
      setFormBusy(row, true);
      try {
        await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        state.plugins = state.plugins.filter((x) => x.id !== p.id);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
        notify(`"${p.label || p.repo}" 플러그인을 삭제했습니다.`, "ok");
      } catch (e) {
        if (row.isConnected) setFormBusy(row, false);
        notify(`삭제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    row.append(del);

    list.append(row);
    list.append(contents);
  }
}

// Shared core for plugin-selection UIs. `getSelected()` returns the current
// selection array-or-null; `onSave(selected)` persists it and returns a promise.
// Used by plugin, personal knowledge repo, and group knowledge repo selectors;
// all three must produce identical DOM/behavior, differing only in selection
// source and save destination.
function renderPluginSelectionContents(container, info, { getSelected, onSave, headText }) {
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
  const currentSelected = getSelected();
  const selectedSet = currentSelected ? new Set(currentSelected) : null;
  const checks = [];
  const loadableNames = info.plugins.filter((entry) => entry.loadable).map((entry) => entry.name);
  const selectionSummary = el("div", { class: "pc-summary muted", role: "status", "aria-live": "polite" });
  let saving = false;
  container.append(el("div", { class: "pc-head muted", text: headText }));
  const updateSelectionSummary = () => {
    const chosen = checks.filter((c) => c.loadable && c.cb.checked).length;
    if (!loadableNames.length) {
      selectionSummary.textContent = "로드 가능한 플러그인이 없습니다.";
    } else if (chosen === 0) {
      selectionSummary.textContent = `선택된 항목이 없습니다. 저장하면 로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`;
    } else if (chosen === loadableNames.length) {
      selectionSummary.textContent = `로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`;
    } else {
      selectionSummary.textContent = `${chosen}개만 사용하도록 저장됩니다.`;
    }
  };

  for (const entry of info.plugins) {
    const checked = !selectedSet || selectedSet.has(entry.name);
    const cb = el("input", { type: "checkbox" });
    cb.checked = checked && entry.loadable;
    cb.disabled = !entry.loadable;
    cb.addEventListener("change", updateSelectionSummary);
    checks.push({ cb, name: entry.name, loadable: entry.loadable });
    const labelText = entry.loadable ? entry.name : `${entry.name} (로드 불가)`;
    container.append(el("label", { class: `pc-item ${entry.loadable ? "" : "disabled"}` }, [cb, el("span", { text: labelText })]));
  }
  container.append(selectionSummary);
  updateSelectionSummary();
  if (!loadableNames.length) return;

  const setSaving = (busy) => {
    saving = busy;
    container.setAttribute("aria-busy", busy ? "true" : "false");
    save.disabled = busy;
    checks.forEach(({ cb, loadable }) => {
      cb.disabled = busy || !loadable;
    });
  };
  const save = el("button", { class: "primary small", type: "button", text: "선택 저장", onclick: async () => {
    if (saving) return;
    const saved = save.textContent;
    setSaving(true);
    save.textContent = "저장 중…";
    const chosen = checks.filter((c) => c.loadable && c.cb.checked).map((c) => c.name);
    // If everything (or nothing) is selected, store null = "load all".
    const selected = chosen.length === 0 || chosen.length === loadableNames.length ? null : chosen;
    try {
      await onSave(selected);
      notify("플러그인 선택을 저장했습니다.", "ok");
      if (container.isConnected) {
        save.textContent = "저장됨 ✓";
        setTimeout(() => {
          if (!container.isConnected) return;
          save.textContent = saved;
          setSaving(false);
        }, 1200);
      }
    } catch (e) {
      notify(`저장 실패: ${e.message}`);
      save.textContent = saved;
      setSaving(false);
    }
  } });
  container.append(el("div", { class: "pc-actions" }, [save]));
}

// Render the repo's plugin list with per-plugin checkboxes. For a single-plugin
// repo there's nothing to select; for a marketplace repo the owner picks a
// subset (or "all"). `selected === null` means "load all".
function renderPluginContents(container, list, p, info) {
  renderPluginSelectionContents(container, info, {
    getSelected: () => p.selected,
    headText: "사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ selected }) });
      Object.assign(p, plugin);
      invalidateSkillsCache(state.user.id);
      renderPluginRows(list);
    },
  });
}

const INTERNAL_GIT_TOKEN_SECRET_NAME = "GIT_TOKEN";
const EXTERNAL_GIT_TOKEN_SECRET_NAME = "GITHUB_TOKEN";

function hasSecret(name) {
  return (state.user.secretNames || []).includes(name);
}

function buildSshPublicKeyField(publicKey) {
  const copyBtn = el("button", { class: "msg-act", type: "button", "aria-label": "SSH 공개키 복사", title: "SSH 공개키 복사" });
  copyBtn.append(icon("copy"));
  copyBtn.addEventListener("click", () => copyText(publicKey, copyBtn));
  return el("label", { class: "field ssh-public-key-field" }, [
    el("span", { text: "SSH 공개키" }),
    el("div", { class: "ssh-public-key-row" }, [
      el("textarea", { rows: "3", readonly: "", text: publicKey }),
      copyBtn,
    ]),
  ]);
}

// Git 자격증명: write-only internal/external tokens + commit identity. Token
// values are never returned by the server; only set/unset state is exposed.
function buildGitCredentialsCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "Git 자격증명" }),
        el("p", { class: "muted", text: "사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const status = el("div", { class: "git-token-status muted" });
  const renderStatus = () => {
    const externalSet = hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME);
    status.replaceChildren(
      state.user.gitTokenSet
        ? el("span", { class: "token-set", text: "● 사내 Git (GIT_TOKEN) 설정됨" })
        : el("span", { text: "사내 Git (GIT_TOKEN) 미설정" }),
      " · ",
      externalSet
        ? el("span", { class: "token-set", text: "외부 GitHub (GITHUB_TOKEN) 설정됨" })
        : el("span", { text: "외부 GitHub (GITHUB_TOKEN) 미설정" }),
    );
  };
  renderStatus();

  const buildTokenForm = ({ label, secretName, description, placeholder, ariaLabel, saveToken, clearToken, isSet }) => {
    let form;
    const tokenField = buildRevealableInput({ name: "token", placeholder, ariaLabel, revealLabel: "토큰", required: true });
    const input = tokenField.input;
    const saveBtn = el("button", { class: "primary", type: "submit", text: isSet() ? "교체" : "저장" });
    const clearBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "삭제",
      disabled: isSet() ? null : "",
      onclick: async () => {
        if (!window.confirm(`${label}을 삭제할까요?`)) return;
        const saved = clearBtn.textContent;
        setFormBusy(form, true);
        clearBtn.textContent = "삭제 중…";
        try {
          await clearToken();
          notify(`${label}을 삭제했습니다.`, "ok");
          renderStatus();
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        } catch (e) {
          notify(`삭제 실패: ${e.message}`);
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        }
      },
    });
    const rowStatus = el("span", {
      class: isSet() ? "muted token-set" : "muted",
      text: isSet() ? "● 설정됨" : "미설정",
    });
    const refreshRow = () => {
      const set = isSet();
      rowStatus.className = set ? "muted token-set" : "muted";
      rowStatus.textContent = set ? "● 설정됨" : "미설정";
      saveBtn.textContent = set ? "교체" : "저장";
      clearBtn.disabled = set ? false : true;
    };
    form = el("form", {
      class: "secret-preset-row",
      onsubmit: async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const token = input.value.trim();
        if (!token) return;
        const saved = saveBtn.textContent;
        setFormBusy(formEl, true);
        saveBtn.textContent = "저장 중…";
        try {
          await saveToken(token);
          input.value = "";
          renderStatus();
          refreshRow();
          setFormBusy(formEl, true);
          saveBtn.textContent = "저장됨 ✓";
          setTimeout(() => { setFormBusy(formEl, false); refreshRow(); }, 1200);
        } catch (err) {
          saveBtn.textContent = saved;
          setFormBusy(formEl, false);
          refreshRow();
          notify(`저장 실패: ${err.message}`);
        }
      },
    }, [
      el("div", { class: "secret-preset-meta" }, [
        el("div", { class: "secret-preset-title" }, [
          el("strong", { text: label }),
          el("code", { text: secretName }),
          rowStatus,
        ]),
        el("p", { class: "muted", text: description }),
      ]),
      tokenField.wrap,
      el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
    ]);
    return form;
  };

  const internalTokenForm = buildTokenForm({
    label: "사내 Git 토큰",
    secretName: INTERNAL_GIT_TOKEN_SECRET_NAME,
    description: `사내 GitHub(${state.githubHost || "GITHUB_HOST"}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.`,
    placeholder: "사내 GitHub PAT (GIT_TOKEN)",
    ariaLabel: "사내 Git 토큰 GIT_TOKEN",
    isSet: () => Boolean(state.user.gitTokenSet),
    saveToken: async (token) => {
      const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api("/api/me/git-token", { method: "DELETE" });
      state.user = user;
    },
  });

  const externalTokenForm = buildTokenForm({
    label: "외부 GitHub 토큰",
    secretName: EXTERNAL_GIT_TOKEN_SECRET_NAME,
    description: "github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.",
    placeholder: "github.com PAT (GITHUB_TOKEN)",
    ariaLabel: "외부 GitHub 토큰 GITHUB_TOKEN",
    isSet: () => hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME),
    saveToken: async (token) => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, {
        method: "PUT",
        body: JSON.stringify({ value: token }),
      });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, { method: "DELETE" });
      state.user = user;
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
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api("/api/me/git-identity", {
          method: "PUT",
          body: JSON.stringify({ name: fd.get("name") || null, email: fd.get("email") || null }),
        });
        state.user = user;
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
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

  card.append(status, internalTokenForm, externalTokenForm, identityForm);
  return card;
}

// 시크릿: write-only named secrets (e.g. SSH_PRIVATE_KEY) encrypted at rest.
// Values are injected ONLY into the avatar's MCP tool subprocesses as env, so
// the avatar can use them (e.g. ssh into your servers) without ever seeing the
// raw value, and they're never returned to the client. We only know the NAMES
// that are set (u.secretNames). The avatar uses ITS OWNER's secrets regardless
// of who is chatting with it.
const SECRET_PRESETS = [
  {
    name: "SSH_PRIVATE_KEY",
    label: "SSH 개인키",
    description: "원격 SSH 도구가 사용할 OpenSSH/PEM 개인키입니다. 앱에서 키를 생성하면 자동으로 채워집니다.",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    rows: 4,
  },
  {
    name: "CONFLUENCE_PAT",
    label: "Confluence PAT",
    description: "사내 Confluence 공용 도구가 Bearer 인증에 사용할 Personal Access Token입니다.",
    placeholder: "Confluence personal access token",
    rows: 2,
  },
];

function buildSecretsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "시크릿" }),
        el("p", { class: "muted", text: "내 아바타가 도구를 쓸 때만 주입되는 비밀값입니다. 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const presetList = el("div", { class: "secret-preset-list" });

  const saveSecret = async (name, value) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const deleteSecret = async (name) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const renderPresetList = () => {
    const names = new Set(state.user.secretNames || []);
    presetList.replaceChildren(
      ...SECRET_PRESETS.map((preset) => {
        const isSet = names.has(preset.name);
        const valueField = el("textarea", {
          name: "value",
          rows: String(preset.rows),
          placeholder: preset.placeholder,
          autocomplete: "off",
          required: "",
        });
        const saveBtn = el("button", { class: "primary", type: "submit", text: isSet ? "교체" : "저장" });
        const clearBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          disabled: isSet ? null : "",
          onclick: async () => {
            if (!window.confirm(`${preset.label} 시크릿을 삭제할까요?`)) return;
            const formEl = clearBtn.closest("form");
            const saved = clearBtn.textContent;
            setFormBusy(formEl, true);
            clearBtn.textContent = "삭제 중…";
            try {
              await deleteSecret(preset.name);
              notify(`${preset.label} 시크릿을 삭제했습니다.`, "ok");
            } catch (err) {
              notify(`삭제 실패: ${err.message}`);
              clearBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        });
        const form = el("form", {
          class: "secret-preset-row",
          onsubmit: async (e) => {
            e.preventDefault();
            const formEl = e.currentTarget;
            const value = valueField.value;
            if (!value) {
              notify(`${preset.label} 값을 입력해 주세요.`, "warn");
              return;
            }
            const saved = saveBtn.textContent;
            setFormBusy(formEl, true);
            saveBtn.textContent = "저장 중…";
            try {
              await saveSecret(preset.name, value);
              notify(`${preset.label} 시크릿을 저장했습니다.`, "ok");
            } catch (err) {
              notify(`저장 실패: ${err.message}`);
              saveBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        }, [
          el("div", { class: "secret-preset-meta" }, [
            el("div", { class: "secret-preset-title" }, [
              el("strong", { text: preset.label }),
              el("code", { text: preset.name }),
              isSet ? el("span", { class: "muted token-set", text: "● 설정됨" }) : el("span", { class: "muted", text: "미설정" }),
            ]),
            el("p", { class: "muted", text: preset.description }),
          ]),
          valueField,
          el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
        ]);
        return form;
      }),
    );
  };
  renderPresetList();

  // List of currently-set secret names, each with a delete button.
  const list = el("div", { class: "secret-list" });
  let extraSecretNameInput;
  const focusExtraSecretForm = () => extraSecretNameInput?.focus();
  const renderList = () => {
    const presetNames = new Set(SECRET_PRESETS.map((preset) => preset.name));
    const names = (state.user.secretNames || []).filter((name) => !presetNames.has(name));
    if (!names.length) {
      list.replaceChildren(
        el("div", { class: "empty-note" }, [
          "추가 시크릿이 없습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "시크릿 이름 입력", onclick: focusExtraSecretForm }),
        ]),
      );
      return;
    }
    list.replaceChildren(
      ...names.map((name) => {
        const delBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          "aria-label": `시크릿 삭제: ${name}`,
        });
        delBtn.addEventListener("click", async () => {
          if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
          const saved = delBtn.textContent;
          delBtn.disabled = true;
          delBtn.textContent = "삭제 중…";
          try {
            await deleteSecret(name);
            notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
          } catch (err) {
            notify(`삭제 실패: ${err.message}`);
            delBtn.disabled = false;
            delBtn.textContent = saved;
          }
        });
        return el("div", { class: "secret-row" }, [
          el("code", { text: name }),
          el("span", { class: "muted token-set", text: "● 설정됨" }),
          delBtn,
        ]);
      }),
    );
  };
  renderList();

  const publicKeyBox = el("div", { class: "ssh-public-key-box" });
  const renderPublicKey = () => {
    const publicKey = (state.user.sshPublicKey || "").trim();
    if (!publicKey) {
      publicKeyBox.replaceChildren();
      publicKeyBox.hidden = true;
      return;
    }
    publicKeyBox.hidden = false;
    publicKeyBox.replaceChildren(buildSshPublicKeyField(publicKey));
  };
  renderPublicKey();

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
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
        state.user = user;
        formEl.reset();
        renderPresetList();
        renderList();
        renderPublicKey();
        btn.textContent = "저장됨 ✓";
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: "이름" }),
      extraSecretNameInput = el("input", { name: "name", placeholder: "SSH_PRIVATE_KEY", autocomplete: "off", required: "" }),
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "값" }),
      el("textarea", { name: "value", rows: "4", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----…", autocomplete: "off", required: "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "추가 시크릿 저장" }),
  ]);

  card.append(
    presetList,
    publicKeyBox,
    el("div", { class: "secret-extra-head" }, [
      el("strong", { text: "기타 시크릿" }),
      el("p", { class: "muted", text: "도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요." }),
    ]),
    list,
    form,
  );
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

// 지식 저장소: configure the personal internal GitHub repo.
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
        const saved = refreshBtn.textContent;
        setFormBusy(card, true);
        refreshBtn.textContent = "새로고침 중…";
        try {
          await api("/api/me/knowledge-repo/refresh", { method: "POST" });
          invalidateSkillsCache(state.user.id);
          refreshBtn.textContent = "새로고침됨 ✓";
          notify("지식 저장소를 최신 상태로 새로고침했습니다.", "ok");
          setTimeout(() => { refreshBtn.textContent = saved; setFormBusy(card, false); }, 1200);
        } catch (e) {
          refreshBtn.textContent = saved;
          setFormBusy(card, false);
          notify(`새로고침 실패: ${e.message}`);
        }
      },
    });
    headerActions.push(refreshBtn);
    const disconnectBtn = el("button", {
      class: "linkish small danger",
      type: "button",
      text: "연결 해제",
      title: "이 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)",
      onclick: async () => {
        if (!window.confirm("지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 아바타가 더 이상 그 스킬을 불러오지 않습니다.")) return;
        setFormBusy(card, true);
        try {
          const { user } = await api("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo: null }) });
          state.user = user;
          invalidateSkillsCache(state.user.id);
          renderView();
          notify("지식 저장소 연결을 해제했습니다.", "ok");
        } catch (e) {
          setFormBusy(card, false);
          notify(`연결 해제 실패: ${e.message}`);
        }
      },
    });
    headerActions.push(disconnectBtn);
  }
  headerActions.push(el("button", { class: "linkish small", type: "button", text: "설정 안내 다시 보기", onclick: () => openOnboarding() }));
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "지식 저장소" }),
        el("p", { class: "muted", text: `내 아바타가 일하며 쌓는 지식·스킬을 담는 사내 GitHub(${state.githubHost || "github.com"}) 저장소입니다.` }),
      ]),
      el("div", { class: "head-actions" }, headerActions),
    ]),
  );

  // Repo configuration form.
  const knowledgeRepoInput = el("input", {
    name: "repo",
    placeholder: "owner/repo 또는 사내 git URL",
    "aria-label": "지식 저장소 (owner/repo 또는 사내 git URL)",
    value: u.knowledgeRepo || "",
  });
  knowledgeRepoInput.addEventListener("input", () => {
    if (knowledgeRepoInput.value.trim()) knowledgeRepoInput.removeAttribute("aria-invalid");
  });
  const repoForm = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const branch = (fd.get("branch") || "").toString().trim();
      if (!repo) {
        notify(
          u.knowledgeRepo ? "저장소 연결을 해제하려면 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요." : "지식 저장소 주소를 입력해 주세요.",
          "warn",
        );
        knowledgeRepoInput.setAttribute("aria-invalid", "true");
        knowledgeRepoInput.focus();
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(card, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api("/api/me/knowledge-repo", {
          method: "PUT",
          body: JSON.stringify({ repo, branch: branch || null }),
        });
        state.user = user;
        renderView();
        notify(`지식 저장소 "${repo}"을 연결했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        notify(`저장 실패: ${err.message}`);
        setFormBusy(card, false);
      }
    },
  }, [
    knowledgeRepoInput,
    el("input", { name: "branch", placeholder: "브랜치 (선택)", "aria-label": "브랜치 (선택)", class: "narrow", value: u.knowledgeBranch || "" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  repoForm.classList.add("rows-2");
  card.append(repoForm);

  if (!u.knowledgeRepo) {
    card.append(
      el("div", { class: "empty-note" }, [
        "지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "아바타에게 저장소 만들기 요청",
          onclick: () => chatAboutTopic("내 지식 저장소를 만들어서 연결해줘. 사내 GitHub에 저장소를 만들고, 앞으로 쓸 기본 지식/스킬 구조까지 준비해줘."),
        }),
      ]),
    );
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
        ? el("span", { class: "token-set", text: "● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요" })
        : el("span", {}, [
            // The git-credentials card lives in a DIFFERENT tab — link there
            // instead of pointing at a card that isn't on this screen.
            "GIT_TOKEN이 없어 읽기만 가능합니다. ",
            el("button", {
              class: "linkish",
              type: "button",
              text: "권한·연결 탭의 Git 자격증명",
              onclick: () => {
                state.settingsTab = "access";
                syncHash(true);
                renderView();
              },
            }),
            "에서 사내 Git 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.",
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
  const reloadKnowledgeContents = wireExpander(pickBtn, contents, async (c) => {
    c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const { contents: info } = await api("/api/me/knowledge-repo/contents");
      renderKnowledgeRepoContents(c, info);
    } catch (e) {
      c.replaceChildren(el("div", { class: "error-note" }, [
        `조회 실패: ${e.message} `,
        el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadKnowledgeContents() }),
      ]));
    }
  });
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
  renderPluginSelectionContents(container, info, {
    getSelected: () => state.user.knowledgeSelected,
    headText: "아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { user } = await api("/api/me/knowledge-repo/selected", { method: "PUT", body: JSON.stringify({ selected }) });
      state.user = user;
      invalidateSkillsCache(state.user.id);
      renderView();
    },
  });
}

/* ---- 그룹 (member roster + group-admin self-service) ---- */
// The member's view of the groups they belong to: teammate roster (with a chat
// shortcut — teammates auto-trust each other), and for group admins, member
// management + the shared knowledge repo (mirrors the personal knowledge repo).
function buildGroupMemberAddForm({
  members = [],
  endpoint,
  reload,
  placeholder = "추가할 동료 아이디(@) 또는 이름",
  ariaLabel = "멤버 추가",
}) {
  const selected = new Map();
  const existingIds = new Set(members.map((m) => m.userId).filter(Boolean));
  const existingNames = new Set(members.map((m) => (m.username || "").toLowerCase()).filter(Boolean));
  const input = el("input", { type: "search", placeholder, "aria-label": ariaLabel });
  const adminCb = el("input", { type: "checkbox" });
  const addTypedBtn = el("button", {
    class: "icon-button group-add-pick",
    type: "button",
    title: "입력한 사용자를 선택 목록에 추가",
    "aria-label": "입력한 사용자를 선택 목록에 추가",
  }, [icon("plus")]);
  const submitBtn = el("button", { class: "primary small", type: "button", text: "선택한 멤버 추가" });
  const selectedList = el("div", { class: "group-add-selected", hidden: "" });
  const panel = el("div", { class: "group-add-panel" });
  let addingMembers = false;

  const excludeSelectedIds = () => new Set([
    ...existingIds,
    ...[...selected.values()].map((u) => u.id).filter(Boolean),
  ]);
  const excludeSelectedNames = () => new Set([...existingNames, ...selected.keys()]);
  const renderSelected = () => {
    selectedList.replaceChildren();
    if (!selected.size) {
      selectedList.hidden = true;
      submitBtn.textContent = "선택한 멤버 추가";
      return;
    }
    selectedList.hidden = false;
    for (const [key, user] of selected) {
      const remove = el("button", {
        class: "msg-act",
        type: "button",
        title: "선택 해제",
        "aria-label": `${user.displayName || user.username} 선택 해제`,
        disabled: addingMembers ? "" : null,
      }, [icon("close")]);
      remove.addEventListener("click", () => {
        if (addingMembers) return;
        selected.delete(key);
        renderSelected();
      });
      selectedList.append(
        el("span", { class: "group-add-chip" }, [
          el("span", { text: `${user.displayName || user.username} · @${user.username}` }),
          remove,
        ]),
      );
    }
    submitBtn.textContent = `${selected.size}명 추가`;
  };
  const setAddingMembers = (busy) => {
    addingMembers = busy;
    panel.setAttribute("aria-busy", busy ? "true" : "false");
    input.disabled = busy;
    adminCb.disabled = busy;
    addTypedBtn.disabled = busy;
    submitBtn.disabled = busy;
    selectedList.querySelectorAll("button").forEach((btn) => {
      btn.disabled = busy;
    });
    if (busy) {
      search.querySelector(".trusted-results")?.setAttribute("hidden", "");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  };
  const selectUser = (user) => {
    if (addingMembers) return false;
    const username = (user.username || "").trim().replace(/^@/, "");
    const key = username.toLowerCase();
    if (!username) return false;
    if (existingNames.has(key) || (user.id && existingIds.has(user.id))) {
      notify("이미 그룹에 있는 사용자입니다.", "info");
      input.value = "";
      return false;
    }
    if (selected.has(key)) {
      notify("이미 선택한 사용자입니다.", "info");
      input.value = "";
      return false;
    }
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    input.value = "";
    renderSelected();
    return true;
  };
  const addTyped = () => {
    if (addingMembers) return false;
    const username = input.value.trim().replace(/^@/, "");
    if (!username) {
      input.focus();
      return false;
    }
    return selectUser({ username, displayName: username });
  };
  const search = attachUserSearch(input, {
    onSelect: selectUser,
    excludeUserIds: excludeSelectedIds,
    excludeUsernames: excludeSelectedNames,
  });
  addTypedBtn.addEventListener("click", addTyped);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTyped();
    }
  });
  submitBtn.addEventListener("click", async () => {
    if (addingMembers) return;
    if (!selected.size && input.value.trim()) addTyped();
    if (!selected.size) {
      input.focus();
      return;
    }
    const queued = [...selected.entries()];
    const role = adminCb.checked ? "admin" : "member";
    const saved = submitBtn.textContent;
    setAddingMembers(true);
    submitBtn.textContent = "추가 중…";
    try {
      const failures = [];
      const successes = [];
      for (const [key, user] of queued) {
        try {
          const res = await api(endpoint, {
            method: "POST",
            body: JSON.stringify({ username: user.username, role }),
          });
          const member = res.member || {};
          existingNames.add((member.username || user.username).toLowerCase());
          if (member.userId) existingIds.add(member.userId);
          successes.push(key);
        } catch (e) {
          failures.push(`@${user.username}: ${e.message}`);
        }
      }
      for (const key of successes) selected.delete(key);
      let reloadError = null;
      if (successes.length) {
        adminCb.checked = false;
        input.value = "";
        try {
          await reload?.();
        } catch (e) {
          reloadError = e;
        }
      }
      if (failures.length) {
        const added = successes.length ? `${successes.length}명은 추가했습니다. ` : "";
        const refresh = reloadError ? ` 목록 새로고침 실패: ${reloadError.message}` : "";
        notify(`${added}일부 멤버를 추가하지 못했습니다. ${failures.join(" / ")}${refresh}`, "warn");
      } else if (reloadError) {
        notify(`${successes.length}명은 그룹에 추가했지만 목록 새로고침에 실패했습니다: ${reloadError.message}`, "warn");
      } else {
        notify(`${successes.length}명을 그룹에 추가했습니다.`, "ok");
      }
    } finally {
      submitBtn.textContent = saved;
      setAddingMembers(false);
      renderSelected();
    }
  });

  renderSelected();
  panel.append(
    el("div", { class: "group-add" }, [
      search,
      addTypedBtn,
      el("label", { class: "group-add-admin" }, [adminCb, el("span", { text: "그룹 관리자로" })]),
      submitBtn,
    ]),
    selectedList,
  );
  panel.focusMemberSearch = () => input.focus();
  return panel;
}

function buildGroupsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "그룹" }),
        el("p", {
          class: "muted",
          text: "내가 속한 그룹과 동료입니다. 같은 그룹 동료끼리는 자동으로 서로 신뢰해 아바타에 권한이 부여됩니다. 그룹 관리자는 멤버와 공용 지식 저장소를 관리할 수 있어요. 그룹 생성·삭제는 시스템 관리자가 합니다.",
        }),
      ]),
    ]),
  );
  const body = el("div", { class: "groups-body" });
  card.append(body);
  body.append(el("div", { class: "muted", text: "불러오는 중…" }));

  const loadGroups = async () => {
    body.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    let groups;
    try {
      ({ groups } = await api("/api/me/groups"));
    } catch (e) {
      body.replaceChildren(
        el("div", { class: "warn-box" }, [
          `그룹을 불러오지 못했습니다: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadGroups() }),
        ]),
      );
      return;
    }
    const reload = async () => {
      try {
        const { groups: next } = await api("/api/me/groups");
        render(next);
      } catch (e) {
        notify(`새로고침 실패: ${e.message}`);
      }
    };
    const render = (gs) => {
      if (!gs.length) {
        const emptyChildren = ["아직 속한 그룹이 없습니다. 그룹은 시스템 관리자가 만들고 멤버를 추가합니다."];
        if (state.user?.roles?.includes("admin")) {
          emptyChildren.push(
            "\n",
            el("button", {
              class: "linkish small",
              type: "button",
              text: "관리자에서 그룹 만들기",
              onclick: () => {
                state.adminTab = "groups";
                goView("admin");
              },
            }),
          );
        }
        body.replaceChildren(
          el("div", { class: "empty-note" }, emptyChildren),
        );
        return;
      }
      body.replaceChildren(...gs.map((g) => buildGroupBlock(g, reload)));
    };
    render(groups);
  };
  loadGroups();
  return card;
}

function buildGroupBlock(g, reload) {
  const amAdmin = g.role === "admin";
  const block = el("div", { class: "group-block" });
  block.append(
    el("div", { class: "group-block-head" }, [
      el("strong", { text: g.name }),
      amAdmin
        ? el("span", { class: "tag write", text: "내가 관리자" })
        : el("span", { class: "tag read", text: "멤버" }),
    ]),
  );

  const roster = el("div", { class: "plugin-rows" });
  const members = g.members || [];
  let addRow = null;
  if (amAdmin) {
    addRow = buildGroupMemberAddForm({
      members,
      endpoint: `/api/me/groups/${encodeURIComponent(g.id)}/members`,
      reload,
    });
  }
  if (!members.length) {
    roster.append(
      el("div", { class: "empty-note" }, [
        "멤버가 없습니다.\n",
        amAdmin ? el("button", { class: "linkish small", type: "button", text: "멤버 검색 입력", onclick: () => addRow?.focusMemberSearch?.() }) : null,
      ]),
    );
  } else {
    const memberSearch = el("input", {
      type: "search",
      class: "admin-search",
      placeholder: "멤버 이름·아이디 검색",
      "aria-label": `${g.name} 멤버 검색`,
    });
    const memberCount = el("span", { class: "muted nowrap" });
    const renderRoster = () => {
      roster.replaceChildren();
      const q = memberSearch.value.trim().toLowerCase();
      const shown = q
        ? members.filter((m) =>
            [
              m.displayName || "",
              m.username || "",
              m.role === "admin" ? "관리자" : "멤버",
            ].join(" ").toLowerCase().includes(q),
          )
        : members;
      memberCount.textContent = shown.length === members.length ? `멤버 ${members.length}명` : `표시 ${shown.length}명 / 전체 ${members.length}명`;
      if (!shown.length) {
        const clearRosterSearch = () => {
          memberSearch.value = "";
          renderRoster();
          memberSearch.focus();
        };
        roster.append(
          el("div", { class: "empty-note" }, [
            `"${memberSearch.value.trim()}"에 맞는 멤버가 없습니다.\n`,
            el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearRosterSearch }),
          ]),
        );
        return;
      }
      for (const m of shown) roster.append(buildGroupRosterRow(g, m, amAdmin, reload));
    };
    memberSearch.addEventListener("input", renderRoster);
    block.append(el("div", { class: "admin-users-head group-roster-head" }, [memberSearch, memberCount]));
    renderRoster();
  }
  block.append(roster);

  if (amAdmin) {
    block.append(addRow);
    block.append(buildGroupRepoCard(g));
  } else {
    block.append(
      el("p", {
        class: "muted small",
        text: g.knowledgeRepoConfigured
          ? "이 그룹에는 공용 지식 저장소가 연결되어 동료들의 아바타와 공유됩니다."
          : "이 그룹에는 아직 공용 지식 저장소가 없습니다.",
      }),
    );
  }
  return block;
}

function buildGroupRosterRow(g, m, amAdmin, reload) {
  const isMe = m.userId === state.user.id;
  const actions = [];
  let row;
  if (!isMe) {
    const chatBtn = el("button", { class: "ghost-sm", type: "button", text: "대화", title: `${m.displayName}의 아바타와 대화` });
    chatBtn.addEventListener("click", () => {
      const av =
        (state.avatars || []).find((a) => a.id === m.userId) || {
          id: m.userId,
          username: m.username,
          displayName: m.displayName,
          hasImage: m.hasImage,
          visibility: m.visibility,
          alias: "",
          bio: "",
          hashtags: [],
          pluginCount: 0,
        };
      startChatWith(av);
    });
    actions.push(chatBtn);
  }
  if (amAdmin && !isMe) {
    const roleBtn = el("button", { class: "ghost-sm", type: "button", text: m.role === "admin" ? "관리자 해제" : "관리자 지정" });
    roleBtn.addEventListener("click", async () => {
      const saved = roleBtn.textContent;
      setFormBusy(row, true);
      roleBtn.textContent = "변경 중…";
      try {
        await api(`/api/me/groups/${encodeURIComponent(g.id)}/members/${encodeURIComponent(m.userId)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: m.role === "admin" ? "member" : "admin" }),
        });
      } catch (e) {
        roleBtn.textContent = saved;
        setFormBusy(row, false);
        notify(`역할 변경 실패: ${e.message}`);
        return;
      }
      try {
        await reload();
        notify(`${m.displayName}님의 그룹 관리자 역할을 ${m.role === "admin" ? "해제" : "부여"}했습니다.`, "ok");
      } catch (e) {
        roleBtn.textContent = saved;
        if (row.isConnected) setFormBusy(row, false);
        notify(`역할은 변경됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    });
    const del = el("button", { class: "ghost-sm danger", type: "button", text: "제거" });
    del.addEventListener("click", async () => {
      if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
      const saved = del.textContent;
      setFormBusy(row, true);
      del.textContent = "제거 중…";
      try {
        await api(`/api/me/groups/${encodeURIComponent(g.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
      } catch (e) {
        del.textContent = saved;
        setFormBusy(row, false);
        notify(`제거 실패: ${e.message}`);
        return;
      }
      try {
        await reload();
        notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
      } catch (e) {
        del.textContent = saved;
        if (row.isConnected) setFormBusy(row, false);
        notify(`멤버는 제거됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    });
    actions.push(roleBtn, del);
  }
  row = el("div", { class: "plugin-row" }, [
    avatarNode({ ...m, id: m.userId }, 32, { alt: "" }),
    el("div", { class: "pr-main" }, [
      el("strong", { text: m.displayName + (isMe ? " (나)" : "") }),
      el("div", { class: "pr-sub", text: `@${m.username}${m.role === "admin" ? " · 관리자" : ""}` }),
    ]),
    el("div", { class: "pr-actions" }, actions),
  ]);
  return row;
}

// Group admin's view of the shared knowledge repo — mirrors buildKnowledgeRepoCard
// but group-scoped (/api/me/groups/:id/knowledge-repo*).
function buildGroupRepoCard(g) {
  const wrap = el("div", { class: "group-repo" });
  wrap.append(el("h4", { class: "knowledge-sub", text: "공용 지식 저장소" }));
  const gid = encodeURIComponent(g.id);

  if (g.knowledgeRepo) {
    const refreshBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "새로고침",
      onclick: async () => {
        const saved = refreshBtn.textContent;
        setFormBusy(wrap, true);
        refreshBtn.textContent = "새로고침 중…";
        try {
          await api(`/api/me/groups/${gid}/knowledge-repo/refresh`, { method: "POST" });
          invalidateSkillsCache(state.user.id);
          refreshBtn.textContent = "새로고침됨 ✓";
          notify(`"${g.name}" 공용 지식 저장소를 최신 상태로 새로고침했습니다.`, "ok");
          setTimeout(() => { refreshBtn.textContent = saved; setFormBusy(wrap, false); }, 1200);
        } catch (e) {
          refreshBtn.textContent = saved;
          setFormBusy(wrap, false);
          notify(`새로고침 실패: ${e.message}`);
        }
      },
    });
    const disconnectBtn = el("button", {
      class: "linkish small danger",
      type: "button",
      text: "연결 해제",
      title: "이 그룹의 공용 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)",
      onclick: async () => {
        if (!window.confirm("이 그룹의 공용 지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 멤버 아바타들이 더 이상 그 스킬을 불러오지 않습니다.")) return;
        setFormBusy(wrap, true);
        try {
          await api(`/api/me/groups/${gid}/knowledge-repo`, { method: "PUT", body: JSON.stringify({ repo: null }) });
          invalidateSkillsCache(state.user.id);
          renderView();
          notify(`"${g.name}" 공용 지식 저장소 연결을 해제했습니다.`, "ok");
        } catch (e) {
          setFormBusy(wrap, false);
          notify(`연결 해제 실패: ${e.message}`);
        }
      },
    });
    wrap.append(el("div", { class: "head-actions" }, [refreshBtn, disconnectBtn]));
  }

  const groupRepoInput = el("input", {
    name: "repo",
    placeholder: "owner/repo 또는 사내 git URL",
    "aria-label": "그룹 지식 저장소",
    value: g.knowledgeRepo || "",
  });
  groupRepoInput.addEventListener("input", () => {
    if (groupRepoInput.value.trim()) groupRepoInput.removeAttribute("aria-invalid");
  });
  const form = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const branch = (fd.get("branch") || "").toString().trim();
      if (!repo) {
        notify(
          g.knowledgeRepo ? "공용 저장소 연결을 해제하려면 위의 ‘연결 해제’ 버튼을 사용해 주세요." : "공용 지식 저장소 주소를 입력해 주세요.",
          "warn",
        );
        groupRepoInput.setAttribute("aria-invalid", "true");
        groupRepoInput.focus();
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(wrap, true);
      btn.textContent = "저장 중…";
      try {
        await api(`/api/me/groups/${gid}/knowledge-repo`, {
          method: "PUT",
          body: JSON.stringify({
            repo,
            branch: branch || null,
          }),
        });
        invalidateSkillsCache(state.user.id);
        renderView();
        notify(`"${g.name}" 공용 지식 저장소 "${repo}"을 연결했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        notify(`저장 실패: ${err.message}`);
        setFormBusy(wrap, false);
      }
    },
  }, [
    groupRepoInput,
    el("input", { name: "branch", placeholder: "브랜치 (선택)", "aria-label": "브랜치", class: "narrow", value: g.knowledgeBranch || "" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  wrap.append(form);

  if (!g.knowledgeRepo) {
    wrap.append(
      el("div", { class: "empty-note" }, [
        "공용 저장소를 연결하면 그룹 멤버 전원의 아바타가 그 저장소의 스킬을 사용합니다.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "아바타에게 공용 저장소 만들기 요청",
          onclick: () => chatAboutTopic(`"${g.name}" 그룹의 공용 지식 저장소를 만들어서 연결해줘. 그룹 멤버들이 함께 사용할 기본 지식/스킬 구조까지 준비해줘.`),
        }),
      ]),
    );
    return wrap;
  }

  const href = repoToHref(g.knowledgeRepo);
  const linkText = g.knowledgeRepo + (g.knowledgeBranch ? ` @ ${g.knowledgeBranch}` : "");
  const link = href
    ? el("a", { href, target: "_blank", rel: "noreferrer noopener", text: linkText })
    : el("code", { text: linkText });
  wrap.append(el("div", { class: "kr-link" }, [icon("globe"), link]));

  // Plugin subset picker (mirrors the personal repo card).
  const selSummary = !g.knowledgeSelected
    ? "저장소의 모든 플러그인을 사용 중"
    : `${g.knowledgeSelected.length}개 플러그인만 사용 중`;
  const contents = el("div", { class: "plugin-contents", hidden: "" });
  const pickBtn = el("button", { class: "linkish small", type: "button", text: "사용할 플러그인 선택", "aria-expanded": "false" });
  const reloadGroupContents = wireExpander(pickBtn, contents, async (c) => {
    c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const { contents: info } = await api(`/api/me/groups/${gid}/knowledge-repo/contents`);
      renderGroupRepoContents(c, info, g);
    } catch (e) {
      c.replaceChildren(el("div", { class: "error-note" }, [
        `조회 실패: ${e.message} `,
        el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadGroupContents() }),
      ]));
    }
  });
  wrap.append(el("div", { class: "kr-plugins" }, [el("span", { class: "muted", text: selSummary }), pickBtn]));
  wrap.append(contents);
  return wrap;
}

// Per-plugin selection for a group repo. Mirrors renderKnowledgeRepoContents but
// posts to the group endpoint and reads the group's current selection.
function renderGroupRepoContents(container, info, g) {
  renderPluginSelectionContents(container, info, {
    getSelected: () => g.knowledgeSelected,
    headText: "그룹 멤버 아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { group } = await api(`/api/me/groups/${encodeURIComponent(g.id)}/knowledge-repo/selected`, { method: "PUT", body: JSON.stringify({ selected }) });
      Object.assign(g, group);
      invalidateSkillsCache(state.user.id);
      renderView();
    },
  });
}

// One info-request row (colleague → owner). `refresh` re-renders the inbox after
// a record/ignore so the resolved row drops out in place.
function buildKnowledgeRequestRow(r, refresh) {
  // Inline "record" composer — hidden until the owner chooses to teach the
  // avatar an answer. Keeping it in the row means the question stays in view
  // while typing, and the whole flow happens without leaving the inbox.
  const textarea = el("textarea", {
    class: "kr-answer",
    rows: "3",
    placeholder: "이 질문에 대한 답·정보를 적어주세요. 아바타가 지식 저장소에 기록하고 이 요청을 닫습니다.",
  });
  const sendBtn = el("button", { class: "primary small", type: "button", text: "기록 요청" });
  const cancelBtn = el("button", { class: "ghost-sm", type: "button", text: "취소" });
  const compose = el("div", { class: "kr-compose", hidden: "" }, [
    textarea,
    el("div", { class: "kr-compose-actions" }, [sendBtn, cancelBtn]),
  ]);

  // Two intents, made explicit: "정보 추가" teaches the avatar (records the
  // answer into the knowledge repo); "무시" only clears the notification — the
  // old DELETE resolve, which never taught the avatar anything.
  const addBtn = el("button", { class: "primary small", type: "button", text: "정보 추가" });
  const ignoreBtn = el("button", { class: "ghost-sm", type: "button", text: "무시" });

  addBtn.addEventListener("click", () => {
    const willShow = compose.hidden;
    compose.hidden = !willShow;
    addBtn.classList.toggle("active", willShow);
    if (willShow) textarea.focus();
  });
  cancelBtn.addEventListener("click", () => {
    compose.hidden = true;
    addBtn.classList.remove("active");
  });
  ignoreBtn.addEventListener("click", async () => {
    const controls = [textarea, sendBtn, cancelBtn, addBtn, ignoreBtn];
    controls.forEach((c) => (c.disabled = true));
    const saved = ignoreBtn.textContent;
    ignoreBtn.textContent = "무시 중…";
    try {
      await api(`/api/me/knowledge/requests/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    } catch (e) {
      ignoreBtn.textContent = saved;
      controls.forEach((c) => (c.disabled = false));
      notify(`무시 처리 실패: ${e.message}`);
      return;
    }
    try {
      await refresh?.({ surfaceErrors: true });
      notify("정보 요청을 무시했습니다.", "ok");
    } catch (e) {
      ignoreBtn.textContent = saved;
      controls.forEach((c) => (c.disabled = false));
      notify(`정보 요청은 무시했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  sendBtn.addEventListener("click", async () => {
    const answer = textarea.value.trim();
    if (!answer) {
      textarea.focus();
      return;
    }
    const controls = [textarea, sendBtn, cancelBtn, addBtn, ignoreBtn];
    controls.forEach((c) => (c.disabled = true));
    const sendLabel = sendBtn.textContent;
    sendBtn.textContent = "기록 중…";
    const result = await recordKnowledgeViaAvatar(r, answer);
    if (!result.ok) {
      controls.forEach((c) => (c.disabled = false));
      sendBtn.textContent = sendLabel;
      notify(`기록 요청 실패: ${result.error}`);
      return;
    }
    // The avatar resolves the request itself after committing; a refresh then
    // drops this row out (the list re-renders). If it's still open afterward
    // the recording didn't complete — say so honestly instead of claiming success.
    try {
      await refresh?.();
    } catch (e) {
      controls.forEach((c) => (c.disabled = false));
      sendBtn.textContent = sendLabel;
      notify(`기록은 요청했지만 목록 새로고침에 실패했어요: ${e.message}`, "warn");
      return;
    }
    const stillOpen = state.knowledgeRequests.some((x) => x.id === r.id && x.status === "open");
    notify(
      stillOpen
        ? "아바타가 기록을 완료하지 못한 것 같아요. ‘대화’의 ‘지식 기록’ 스레드를 확인해 주세요."
        : "아바타가 답을 지식 저장소에 기록했어요.",
      stillOpen ? "warn" : "info",
    );
  });

  return el("div", { class: "knowledge-row" }, [
    el("div", { class: "inbox-row-head" }, [
      el("span", { class: "inbox-chip req", text: "정보 요청" }),
    ]),
    el("div", { class: "kr-q", text: r.question }),
    r.askerName
      ? el("div", { class: "muted kr-meta", text: `질문자: ${r.askerName} · ${timeLabel(r.createdAt)}` })
      : el("div", { class: "muted kr-meta", text: timeLabel(r.createdAt) }),
    el("div", { class: "kr-actions" }, [addBtn, ignoreBtn]),
    compose,
  ]);
}

// Per-user localStorage key for the reused "지식 기록" conversation (below).
function knowledgeRecConvKey() {
  return `noah.knowledgeRecordConv.${state.user?.id || "anon"}`;
}

// Recordings share one reused conversation, so two in flight would collide on
// the same SDK session — a module-level guard serializes them.
let knowledgeRecordInFlight = false;

// Teach the avatar an answer WITHOUT leaving the settings view: post a normal
// owner turn to the chat stream and silently drain the SSE. The avatar (the
// owner's own, so it carries elevated repo + knowledge tools) writes the answer
// into its knowledge repo, commits, and then calls resolve_request — so the gap
// clears itself only once the knowledge is actually saved, not optimistically on
// click. Reuses one hidden "지식 기록" conversation per user so these turns don't
// litter the sidebar with a fresh conversation every time.
async function recordKnowledgeViaAvatar(request, answer) {
  const avatarId = state.user?.id;
  if (!avatarId) return { ok: false, error: "로그인이 필요합니다." };
  if (knowledgeRecordInFlight) {
    return { ok: false, error: "다른 기록 요청을 처리하는 중이에요. 잠시 후 다시 시도해 주세요." };
  }
  knowledgeRecordInFlight = true;
  try {
    const askerBit = request.askerName ? `동료 "${request.askerName}"가` : "한 동료가";
    const message =
      `${askerBit} 다음을 물었는데 내가 답하지 못했어:\n` +
      `"${request.question}"\n\n` +
      "아래 정보를 내 지식 저장소(knowledge repo)에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘. " +
      "적절한 스킬이나 문서에 반영하고 commit까지 해줘. 기록을 커밋한 뒤에는 이 정보 요청을 " +
      `resolve_request 도구로 닫아줘 (request_id: ${request.id}).\n\n` +
      `--- 기록할 내용 ---\n${answer}`;

    const prevConv = capPref(knowledgeRecConvKey(), "") || undefined;
    let response;
    try {
      response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ avatarId, message, conversationId: prevConv }),
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (response.status === 401) {
      handleSessionExpired();
      return { ok: false, error: "세션이 만료되었습니다." };
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }

    let convId = null;
    let runId = null;
    let errText = null;
    try {
      await consumeSse(response.body, (event, data) => {
        if (event === "open") {
          if (data?.conversationId) convId = data.conversationId;
          if (data?.runId) runId = data.runId;
        } else if (event === "error") {
          errText = data?.error || "오류가 발생했습니다.";
        } else if (event === "permission" && runId && data?.requestId) {
          // No prompt UI in settings. The avatar's repo/knowledge tools are
          // auto-approved server-side, so a prompt here means an unexpected
          // action — deny it rather than run something the owner can't see.
          api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId, requestId: data.requestId, value: { behavior: "deny" } }) }).catch(() => {});
        } else if (event === "question" && runId && data?.requestId) {
          api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId, requestId: data.requestId, value: { cancelled: true } }) }).catch(() => {});
        }
      });
    } catch (e) {
      // Network drop / aborted stream mid-run — surface it instead of leaving the
      // row stuck on "기록 중…".
      return { ok: false, error: e.message || "스트림 연결이 끊어졌습니다." };
    }

    // Remember (and name) the conversation so later recordings reuse one thread.
    if (convId && convId !== prevConv) {
      setCapPref(knowledgeRecConvKey(), convId);
      api(`/api/conversations/${encodeURIComponent(convId)}`, { method: "PATCH", body: JSON.stringify({ title: "지식 기록" }) }).catch(() => {});
    }
    if (errText) return { ok: false, error: errText };
    return { ok: true };
  } finally {
    knowledgeRecordInFlight = false;
  }
}

/* ============================================================ Admin */
const ADMIN_TABS = [
  { id: "overview", label: "개요", icon: "activity" },
  { id: "users", label: "사용자", icon: "users" },
  { id: "groups", label: "그룹", icon: "users" },
  { id: "access", label: "가입·접근", icon: "key" },
  { id: "system", label: "시스템", icon: "server" },
  { id: "audit", label: "감사 로그", icon: "list" },
];
const ADMIN_TAB_BUILDERS = {
  overview: adminOverviewCards,
  users: adminUsersCards,
  groups: adminGroupsCards,
  access: adminAccessCards,
  system: adminSystemCards,
  audit: adminAuditCards,
};

async function renderAdmin() {
  const header = viewHeader("관리자", "사용자·접근·시스템을 관리하세요");
  const body = el("div", { class: "view-body scroll-thin" });
  dom.main.append(header, body);
  const requestedAdminTab = state.adminTab;
  if (!ADMIN_TABS.some((t) => t.id === state.adminTab)) state.adminTab = "overview";
  if (state.adminTab !== requestedAdminTab) syncHashAfterRoute();

  const panel = el("div", { class: "admin-panel", role: "tabpanel", id: "admin-panel" });
  let tabRenderSeq = 0;
  const renderTab = async () => {
    const tabId = state.adminTab;
    const seq = ++tabRenderSeq;
    panel.setAttribute("aria-labelledby", `admin-tab-${tabId}`);
    panel.replaceChildren(el("div", { class: "muted pad", text: "불러오는 중…" }));
    try {
      const build = ADMIN_TAB_BUILDERS[tabId] || adminOverviewCards;
      const nodes = await build();
      if (seq !== tabRenderSeq || state.adminTab !== tabId) return;
      panel.replaceChildren(...nodes);
    } catch (e) {
      if (seq !== tabRenderSeq || state.adminTab !== tabId) return;
      panel.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderTab() }),
        ]),
      );
    }
  };

  const { tabBar, syncTabs } = buildTabBar({
    tabs: ADMIN_TABS,
    getTab: () => state.adminTab,
    setTab: (id) => { state.adminTab = id; },
    ariaLabel: "관리자 분류",
    idPrefix: "admin-tab",
    panelId: "admin-panel",
    onActivate: renderTab,
  });
  body.replaceChildren(tabBar, panel);
  syncTabs();
  await renderTab();
}

/* ---- 개요 (dashboard) ---- */
async function adminOverviewCards() {
  await loadAdminStats();
  const s = state.adminStats || {};
  const goAdminOverviewTarget = (tabId, userFilter = "all") => {
    state.adminTab = tabId;
    if (tabId === "users") state.adminUserFilter = userFilter;
    syncHash(true);
    renderView();
  };
  const stat = (label, value, sub, targetTab = "", userFilter = "all") => {
    const children = [
      el("div", { class: "stat-value", text: String(value ?? 0) }),
      el("div", { class: "stat-label", text: label }),
      sub ? el("div", { class: "stat-sub muted", text: sub }) : null,
    ];
    if (!targetTab) return el("div", { class: "stat-card" }, children);
    children.push(el("div", { class: "stat-link muted", text: targetTab === "groups" ? "그룹 관리" : "사용자 관리" }));
    return el("button", {
      class: "stat-card stat-clickable",
      type: "button",
      "aria-label": `${label} ${targetTab === "groups" ? "그룹 관리" : "사용자 관리"}로 이동`,
      onclick: () => goAdminOverviewTarget(targetTab, userFilter),
    }, children);
  };
  const grid = el("div", { class: "stat-grid" }, [
    stat("전체 사용자", s.users, s.suspended ? `정지 ${s.suspended}명 포함` : null, "users"),
    stat("관리자", s.admins, null, "users", "admins"),
    stat("공개 아바타", s.publicAvatars, null, "users", "public"),
    stat("대화", s.conversations),
    stat("메시지", s.messages),
    stat("활성 루틴", s.activeRoutines),
    stat("미응답 질문", s.openRequests),
    stat("활성 세션", s.activeSessions, null, "users", "sessions"),
    stat("그룹", s.groups, null, "groups"),
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
  const filterBar = el("div", { class: "admin-filter seg-control", role: "radiogroup", "aria-label": "사용자 필터" });
  wireSegmentedRadioKeys(filterBar);
  const search = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "이름 또는 아이디로 검색",
    value: state.adminUserSearch,
    "aria-label": "사용자 검색",
  });
  const countLabel = el("span", { class: "muted nowrap" });
  const filterDefs = [
    { id: "all", label: "전체", match: () => true },
    { id: "admins", label: "관리자", match: (u) => u.roles?.includes("admin") },
    { id: "suspended", label: "정지", match: (u) => u.suspended },
    { id: "public", label: "공개", match: (u) => u.visibility === "public" },
    { id: "sessions", label: "활성 세션", match: (u) => (u.activeSessions || 0) > 0 },
  ];
  const filterLabel = (id) => filterDefs.find((f) => f.id === id)?.label || "전체";
  const currentFilter = () => filterDefs.find((f) => f.id === state.adminUserFilter) || filterDefs[0];
  const syncFilters = () => {
    if (!filterDefs.some((f) => f.id === state.adminUserFilter)) state.adminUserFilter = "all";
    filterBar.replaceChildren(
      ...filterDefs.map((f) => {
        const active = state.adminUserFilter === f.id;
        const count = state.adminUsers.filter(f.match).length;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: `${f.label} ${count}`,
          onclick: () => {
            state.adminUserFilter = f.id;
            syncFilters();
            renderList();
          },
        });
      }),
    );
  };
  const reload = async () => {
    await loadAdminUsers();
    syncFilters();
    renderList();
  };
  const renderList = () => {
    const q = state.adminUserSearch.trim().toLowerCase();
    const activeFilter = currentFilter();
    const users = state.adminUsers.filter(
      (u) =>
        activeFilter.match(u) &&
        (!q ||
          (u.displayName || "").toLowerCase().includes(q) ||
          (u.username || "").toLowerCase().includes(q)),
    );
    countLabel.textContent = `표시 ${users.length}명 / 전체 ${state.adminUsers.length}명`;
    if (!users.length) {
      const resetUserFilter = () => {
        state.adminUserFilter = "all";
        syncFilters();
        renderList();
        filterBar.querySelector('[data-value="all"]')?.focus();
      };
      if (q) {
        const clearAdminUserSearch = () => {
          state.adminUserSearch = "";
          search.value = "";
          renderList();
          search.focus();
        };
        const children = [
          `"${state.adminUserSearch.trim()}"에 맞는 ${state.adminUserFilter === "all" ? "사용자" : `${filterLabel(state.adminUserFilter)} 사용자`}가 없습니다. `,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearAdminUserSearch }),
        ];
        if (state.adminUserFilter !== "all") {
          children.push(" ", el("button", { class: "linkish small", type: "button", text: "전체 사용자 보기", onclick: resetUserFilter }));
        }
        list.replaceChildren(
          el("div", { class: "muted pad" }, children),
        );
      } else if (state.adminUserFilter !== "all") {
        list.replaceChildren(
          el("div", { class: "muted pad" }, [
            `${filterLabel(state.adminUserFilter)} 사용자가 없습니다. `,
            el("button", { class: "linkish small", type: "button", text: "전체 사용자 보기", onclick: resetUserFilter }),
          ]),
        );
      } else {
        list.replaceChildren(
          el("div", { class: "muted pad", text: "사용자가 없습니다." }),
        );
      }
      return;
    }
    list.replaceChildren(...users.map((u) => adminUserRow(u, reload)));
  };

  search.addEventListener("input", () => {
    state.adminUserSearch = search.value;
    renderList();
  });

  syncFilters();
  renderList();
  const head = el("div", { class: "admin-users-head" }, [
    search,
    countLabel,
  ]);
  return [el("div", { class: "admin-users" }, [head, filterBar, list])];
}

function adminUserRow(u, reload) {
  const isMe = u.id === state.user.id;
  const isAdmin = u.roles?.includes("admin");
  const tags = el("div", { class: "ar-tags" }, [
    el("span", { class: `tag ${isAdmin ? "write" : "read"}`, text: isAdmin ? "관리자" : "멤버" }),
    u.visibility === "public" ? el("span", { class: "tag accent", text: "공개" }) : null,
    u.visibility === "group" ? el("span", { class: "tag", text: "그룹 공개" }) : null,
    u.visibility === "private" ? el("span", { class: "tag", text: "비공개" }) : null,
    u.suspended ? el("span", { class: "tag danger", text: "정지" }) : null,
    u.activeSessions ? el("span", { class: "tag read", text: `세션 ${u.activeSessions}` }) : null,
    isMe ? el("span", { class: "tag", text: "나" }) : null,
  ]);

  const detail = el("div", { class: "ar-detail" });
  detail.hidden = true;
  let loaded = false;
  const manageBtn = el("button", { class: "ghost-sm", type: "button", text: "관리" });
  manageBtn.setAttribute("aria-expanded", "false");
  const loadDetail = async () => {
    detail.hidden = false;
    manageBtn.setAttribute("aria-expanded", "true");
    if (loaded) return;
    const saved = manageBtn.textContent;
    manageBtn.disabled = true;
    manageBtn.textContent = "불러오는 중…";
    detail.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const d = await loadAdminUserDetail(u.id);
      detail.replaceChildren(buildUserDetailGrid(d), buildUserActions(u, isAdmin, isMe, reload));
      loaded = true;
    } catch (e) {
      detail.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadDetail() }),
        ]),
      );
    } finally {
      manageBtn.textContent = saved;
      manageBtn.disabled = false;
    }
  };
  manageBtn.addEventListener("click", async () => {
    if (!detail.hidden) {
      detail.hidden = true;
      manageBtn.setAttribute("aria-expanded", "false");
      return;
    }
    await loadDetail();
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
    item("GIT_TOKEN", d.gitTokenSet ? "있음" : "없음"),
    item("지식 저장소", d.knowledgeRepoSet ? "연결됨" : "없음"),
  ]);
}

function openAdminPasswordResetModal(u, triggerBtn, reload) {
  triggerBtn.disabled = true;
  const uid = encodeURIComponent(u.id);
  openModal({
    cardClass: "password-reset-card",
    ariaLabelledby: "admin-password-reset-title",
    onBeforeClose: () => { triggerBtn.disabled = false; },
    buildCard: (card, close) => {
      const passwordField = buildRevealableInput({
        name: "password",
        autocomplete: "new-password",
        placeholder: "새 비밀번호",
        ariaLabel: `${u.displayName} 새 비밀번호`,
        required: true,
        minlength: 8,
      });
      const confirmField = buildRevealableInput({
        name: "confirmPassword",
        autocomplete: "new-password",
        placeholder: "새 비밀번호 확인",
        ariaLabel: `${u.displayName} 새 비밀번호 확인`,
        required: true,
        minlength: 8,
      });
      const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
      const saveBtn = el("button", { class: "primary", type: "submit", text: "재설정" });
      const cancelBtn = el("button", { class: "ghost-sm", type: "button", text: "취소", onclick: () => close() });
      const setBusy = (busy) => {
        passwordField.input.disabled = busy;
        confirmField.input.disabled = busy;
        saveBtn.disabled = busy;
        cancelBtn.disabled = busy;
        saveBtn.textContent = busy ? "재설정 중…" : "재설정";
      };
      const showError = (message) => {
        errorBox.textContent = message;
        errorBox.hidden = false;
      };
      const form = el("form", {
        class: "routine-modal-form",
        onsubmit: async (e) => {
          e.preventDefault();
          const pw = passwordField.input.value;
          const confirm = confirmField.input.value;
          if (pw.length < 8) {
            showError("비밀번호는 8자 이상이어야 합니다.");
            passwordField.input.focus();
            return;
          }
          if (pw !== confirm) {
            showError("두 비밀번호가 일치하지 않습니다.");
            confirmField.input.focus();
            return;
          }
          errorBox.hidden = true;
          setBusy(true);
          try {
            await api(`/api/admin/users/${uid}/password`, { method: "POST", body: JSON.stringify({ password: pw }) });
            notify("비밀번호를 재설정했습니다.", "ok");
            close();
            try {
              await reload();
            } catch (err) {
              notify(`비밀번호는 재설정했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
            }
          } catch (err) {
            setBusy(false);
            showError(`재설정 실패: ${err.message}`);
          }
        },
      }, [
        el("label", { class: "field" }, [
          el("span", { text: "새 비밀번호" }),
          passwordField.wrap,
        ]),
        el("label", { class: "field" }, [
          el("span", { text: "새 비밀번호 확인" }),
          confirmField.wrap,
        ]),
        errorBox,
        el("div", { class: "routine-modal-actions" }, [
          el("div", { class: "routine-modal-actions-left" }, [
            el("span", { class: "muted", text: `대상: ${u.displayName} (@${u.username})` }),
          ]),
          el("div", { class: "routine-modal-actions-right" }, [cancelBtn, saveBtn]),
        ]),
      ]);
      card.append(
        el("h2", { id: "admin-password-reset-title", text: "비밀번호 재설정" }),
        el("p", { class: "muted", text: "저장하면 이 사용자의 기존 세션이 모두 로그아웃됩니다." }),
        form,
      );
      return { focusTarget: passwordField.input };
    },
  });
}

function buildUserActions(u, isAdmin, isMe, reload) {
  const wrap = el("div", { class: "ud-actions" });
  const run = async (btn, fn, errLabel, successLabel = "") => {
    const saved = btn.textContent;
    setFormBusy(wrap, true);
    btn.textContent = "처리 중…";
    try {
      await fn();
    } catch (e) {
      btn.textContent = saved;
      setFormBusy(wrap, false);
      notify(`${errLabel}: ${e.message}`);
      return;
    }
    try {
      await reload();
      if (successLabel) notify(successLabel, "ok");
    } catch (e) {
      btn.textContent = saved;
      setFormBusy(wrap, false);
      notify(`작업은 완료됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  };
  const uid = encodeURIComponent(u.id);

  const roleBtn = el("button", { class: "ghost-sm", type: "button", text: isAdmin ? "관리자 해제" : "관리자 지정" });
  if (isMe) roleBtn.disabled = true;
  roleBtn.addEventListener("click", () => {
    const verb = isAdmin ? "해제" : "부여";
    if (!window.confirm(`${u.displayName}(@${u.username})님의 관리자 권한을 ${verb}할까요?`)) return;
    run(
      roleBtn,
      () => api(`/api/admin/users/${uid}/roles`, { method: "POST", body: JSON.stringify({ role: "admin", grant: !isAdmin }) }),
      "권한 변경 실패",
      `${u.displayName}님의 관리자 권한을 ${verb}했습니다.`,
    );
  });

  // Moderation: hide an avatar from discovery (force private) or restore it to
  // public. The owner can still re-set their own visibility afterward.
  const willHide = u.visibility !== "private";
  const pubBtn = el("button", { class: "ghost-sm", type: "button", text: willHide ? "비공개로 전환" : "공개로 전환" });
  pubBtn.addEventListener("click", () => {
    run(
      pubBtn,
      () => api(`/api/admin/users/${uid}/visibility`, { method: "PUT", body: JSON.stringify({ visibility: willHide ? "private" : "public" }) }),
      "공개 설정 실패",
      `${u.displayName}님의 공개 범위를 ${willHide ? "비공개" : "공개"}로 전환했습니다.`,
    );
  });

  const susBtn = el("button", { class: "ghost-sm" + (u.suspended ? "" : " danger"), type: "button", text: u.suspended ? "활성화" : "정지" });
  if (isMe) susBtn.disabled = true;
  susBtn.addEventListener("click", () => {
    if (!u.suspended && !window.confirm(`${u.displayName} 계정을 정지할까요?\n로그인과 활성 세션이 즉시 차단됩니다.`)) return;
    run(
      susBtn,
      () => api(`/api/admin/users/${uid}/suspend`, { method: "POST", body: JSON.stringify({ suspended: !u.suspended }) }),
      "상태 변경 실패",
      `${u.displayName} 계정을 ${u.suspended ? "활성화" : "정지"}했습니다.`,
    );
  });

  const pwBtn = el("button", { class: "ghost-sm", type: "button", text: "비밀번호 재설정" });
  pwBtn.addEventListener("click", () => {
    openAdminPasswordResetModal(u, pwBtn, reload);
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
    run(delBtn, () => api(`/api/admin/users/${uid}`, { method: "DELETE" }), "삭제 실패", `${u.displayName} 계정을 삭제했습니다.`);
  });

  wrap.append(roleBtn, pubBtn, susBtn, pwBtn, outBtn, delBtn);
  if (isMe) {
    wrap.append(el("p", { class: "muted ud-self-note", text: "자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다." }));
  }
  return wrap;
}

/* ---- 그룹 (group management) ---- */
// System admins create/delete groups, add members, and assign group admins here.
// Group members auto-trust each other; the group's shared knowledge repo is
// edited by group admins from their own 내 아바타 ▸ 그룹 tab.
async function adminGroupsCards() {
  const { groups } = await api("/api/admin/groups");
  let currentGroups = groups;
  const list = el("div", { class: "admin-list" });
  const countLabel = el("span", { class: "muted nowrap" });
  const search = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "그룹 이름·설명 검색",
    value: state.adminGroupSearch,
    "aria-label": "그룹 검색",
    disabled: groups.length ? null : "",
  });
  let groupNameInput;
  const focusGroupForm = () => groupNameInput?.focus();

  const reload = async () => {
    const { groups: next } = await api("/api/admin/groups");
    currentGroups = next;
    renderList(currentGroups);
  };
  const renderList = (gs) => {
    list.replaceChildren();
    search.disabled = gs.length ? false : true;
    const q = state.adminGroupSearch.trim().toLowerCase();
    if (!gs.length) {
      countLabel.textContent = "총 0개";
      list.append(
        el("div", { class: "muted pad" }, [
          "아직 그룹이 없습니다. ",
          el("button", { class: "linkish small", type: "button", text: "그룹 이름 입력", onclick: focusGroupForm }),
        ]),
      );
      return;
    }
    const shown = q
      ? gs.filter((g) =>
          [
            g.name,
            g.description || "",
            g.knowledgeRepo ? "공용 저장소" : "",
            `멤버 ${g.memberCount}`,
            `관리자 ${g.adminCount}`,
          ].join(" ").toLowerCase().includes(q),
        )
      : gs;
    countLabel.textContent = shown.length === gs.length ? `총 ${gs.length}개` : `표시 ${shown.length}개 / 전체 ${gs.length}개`;
    if (!shown.length) {
      const clearAdminGroupSearch = () => {
        state.adminGroupSearch = "";
        search.value = "";
        renderList(gs);
        search.focus();
      };
      list.append(
        el("div", { class: "muted pad" }, [
          `"${state.adminGroupSearch.trim()}"에 맞는 그룹이 없습니다. `,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearAdminGroupSearch }),
        ]),
      );
      return;
    }
    for (const g of shown) list.append(adminGroupRow(g, reload));
  };

  const form = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      // Capture the form node now: event.currentTarget is nulled after the
      // handler's first await, so referencing it later (reset) would throw.
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const name = (fd.get("name") || "").toString().trim();
      if (!name) { notify("그룹 이름을 입력하세요.", "warn"); return; }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "생성 중…";
      try {
        await api("/api/admin/groups", {
          method: "POST",
          body: JSON.stringify({ name, description: (fd.get("description") || "").toString().trim() }),
        });
      } catch (err) {
        notify(`그룹 생성 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
        return;
      }
      formEl.reset();
      state.adminGroupSearch = "";
      search.value = "";
      try {
        await reload();
        notify(`그룹 "${name}"을 만들었습니다.`, "ok");
      } catch (err) {
        notify(`그룹은 만들었지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      } finally {
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    groupNameInput = el("input", { name: "name", placeholder: "그룹 이름", "aria-label": "그룹 이름", required: "" }),
    el("input", { name: "description", placeholder: "설명 (선택)", "aria-label": "그룹 설명" }),
    el("button", { class: "primary", type: "submit", text: "그룹 만들기" }),
  ]);

  search.addEventListener("input", () => {
    state.adminGroupSearch = search.value;
    renderList(currentGroups);
  });

  renderList(currentGroups);
  const searchHead = el("div", { class: "admin-users-head" }, [search, countLabel]);
  const card = el("section", { class: "settings-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "그룹" }),
        el("p", {
          class: "muted",
          text: "같은 그룹 멤버끼리는 자동으로 서로 신뢰해 권한을 얻고, 그룹 공용 지식 저장소를 공유합니다. 그룹 생성·삭제와 그룹 관리자 지정은 시스템 관리자만 합니다. 공용 저장소 편집은 각 그룹 관리자가 ‘내 아바타 ▸ 그룹’에서 합니다.",
        }),
      ]),
    ]),
    form,
    searchHead,
    list,
  ]);
  return [card];
}

function adminGroupRow(g, reload) {
  const detail = el("div", { class: "ar-detail" });
  detail.hidden = true;
  let loaded = false;
  const manageBtn = el("button", { class: "ghost-sm", type: "button", text: "관리" });
  manageBtn.setAttribute("aria-expanded", "false");
  const loadDetail = async () => {
    detail.hidden = false;
    manageBtn.setAttribute("aria-expanded", "true");
    if (loaded) return;
    const saved = manageBtn.textContent;
    manageBtn.disabled = true;
    manageBtn.textContent = "불러오는 중…";
    detail.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const d = await api(`/api/admin/groups/${encodeURIComponent(g.id)}`);
      detail.replaceChildren(buildAdminGroupDetail(g, d.members, reload));
      loaded = true;
    } catch (e) {
      detail.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadDetail() }),
        ]),
      );
    } finally {
      manageBtn.textContent = saved;
      manageBtn.disabled = false;
    }
  };
  manageBtn.addEventListener("click", async () => {
    if (!detail.hidden) {
      detail.hidden = true;
      manageBtn.setAttribute("aria-expanded", "false");
      return;
    }
    await loadDetail();
  });

  const tags = el("div", { class: "ar-tags" }, [
    el("span", { class: "tag", text: `멤버 ${g.memberCount}` }),
    el("span", { class: "tag write", text: `관리자 ${g.adminCount}` }),
    g.knowledgeRepo ? el("span", { class: "tag accent", text: "공용 저장소" }) : null,
  ]);
  const row = el("div", { class: "admin-row" }, [
    el("div", { class: "ar-main" }, [
      el("strong", { text: g.name }),
      el("div", { class: "muted", text: g.description || "(설명 없음)" }),
    ]),
    tags,
    el("div", { class: "ar-actions" }, [manageBtn]),
  ]);
  return el("div", { class: "admin-user" }, [row, detail]);
}

function buildAdminGroupDetail(g, members, reload) {
  const wrap = el("div", { class: "ar-detail-inner" });
  let currentMembers = members;

  const editForm = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const nextName = (fd.get("name") || "").toString().trim();
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api(`/api/admin/groups/${encodeURIComponent(g.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: nextName,
            description: (fd.get("description") || "").toString(),
          }),
        });
      } catch (err) {
        notify(`수정 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
        return;
      }
      try {
        await reload();
        notify(`그룹 "${nextName || g.name}" 정보를 수정했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`그룹 정보는 수정했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      }
    },
  }, [
    el("input", { name: "name", value: g.name, "aria-label": "그룹 이름" }),
    el("input", { name: "description", value: g.description || "", placeholder: "설명", "aria-label": "그룹 설명" }),
    el("button", { class: "ghost-sm", type: "submit", text: "수정" }),
  ]);

  const memberList = el("div", { class: "plugin-rows" });
  const memberSearch = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "멤버 이름·아이디 검색",
    value: "",
    "aria-label": "그룹 멤버 검색",
    disabled: members.length ? null : "",
  });
  const memberCount = el("span", { class: "muted nowrap" });
  const reloadMembers = async () => {
    const d = await api(`/api/admin/groups/${encodeURIComponent(g.id)}`);
    currentMembers = d.members;
    renderMembers(currentMembers);
    reload().catch(() => {});
  };
  const renderMembers = (ms) => {
    memberList.replaceChildren();
    memberSearch.disabled = ms.length ? false : true;
    const q = memberSearch.value.trim().toLowerCase();
    if (!ms.length) {
      memberCount.textContent = "멤버 0명";
      memberList.append(
        el("div", { class: "empty-note" }, [
          "멤버가 없습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "멤버 검색 입력", onclick: () => addRow.focusMemberSearch?.() }),
        ]),
      );
      return;
    }
    const shown = q
      ? ms.filter((m) =>
          [
            m.displayName || "",
            m.username || "",
            m.role === "admin" ? "관리자" : "멤버",
          ].join(" ").toLowerCase().includes(q),
        )
      : ms;
    memberCount.textContent = shown.length === ms.length ? `멤버 ${ms.length}명` : `표시 ${shown.length}명 / 전체 ${ms.length}명`;
    if (!shown.length) {
      const clearMemberSearch = () => {
        memberSearch.value = "";
        renderMembers(ms);
        memberSearch.focus();
      };
      memberList.append(
        el("div", { class: "empty-note" }, [
          `"${memberSearch.value.trim()}"에 맞는 멤버가 없습니다.\n`,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearMemberSearch }),
        ]),
      );
      return;
    }
    for (const m of shown) memberList.append(adminGroupMemberRow(g.id, m, reloadMembers));
  };

  const addRow = buildGroupMemberAddForm({
    members,
    endpoint: `/api/admin/groups/${encodeURIComponent(g.id)}/members`,
    reload: reloadMembers,
    placeholder: "추가할 사용자 아이디(@) 또는 이름",
  });
  memberSearch.addEventListener("input", () => renderMembers(currentMembers));
  renderMembers(members);

  const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "그룹 삭제" });
  delBtn.addEventListener("click", async () => {
    if (!window.confirm(`'${g.name}' 그룹을 삭제할까요?\n멤버십이 모두 해제되고 멤버 간 자동 신뢰가 사라집니다. (공용 저장소 자체는 GitHub에 남습니다.)`)) return;
    delBtn.disabled = true;
    const saved = delBtn.textContent;
    delBtn.textContent = "삭제 중…";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(g.id)}`, { method: "DELETE" });
    } catch (e) {
      delBtn.textContent = saved;
      delBtn.disabled = false;
      notify(`삭제 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${g.name}"을 삭제했습니다.`, "ok");
    } catch (e) {
      delBtn.textContent = saved;
      delBtn.disabled = false;
      notify(`그룹은 삭제했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });

  wrap.append(
    el("h4", { class: "knowledge-sub", text: "그룹 정보" }),
    editForm,
    el("h4", { class: "knowledge-sub", text: "멤버" }),
    el("div", { class: "admin-users-head" }, [memberSearch, memberCount]),
    memberList,
    addRow,
    el("div", { class: "ud-actions" }, [delBtn]),
  );
  return wrap;
}

function adminGroupMemberRow(groupId, m, reload) {
  const isAdmin = m.role === "admin";
  let row;
  const roleBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    title: isAdmin ? "그룹 관리자 해제" : "그룹 관리자 지정",
    text: isAdmin ? "관리자 해제" : "관리자 지정",
  });
  roleBtn.addEventListener("click", async () => {
    const saved = roleBtn.textContent;
    setFormBusy(row, true);
    roleBtn.textContent = "변경 중…";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: isAdmin ? "member" : "admin" }),
      });
    } catch (e) {
      roleBtn.textContent = saved;
      setFormBusy(row, false);
      notify(`역할 변경 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`${m.displayName}님의 그룹 관리자 역할을 ${isAdmin ? "해제" : "부여"}했습니다.`, "ok");
    } catch (e) {
      roleBtn.textContent = saved;
      if (row.isConnected) setFormBusy(row, false);
      notify(`역할은 변경됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  const del = el("button", { class: "msg-act danger", type: "button", title: "멤버 제거", "aria-label": `${m.displayName} 제거` });
  del.append(icon("trash"));
  del.addEventListener("click", async () => {
    if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
    const savedTitle = del.title;
    const savedLabel = del.getAttribute("aria-label");
    setFormBusy(row, true);
    del.title = "제거 중…";
    del.setAttribute("aria-label", `${m.displayName} 제거 중`);
    try {
      await api(`/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (e) {
      del.title = savedTitle;
      del.setAttribute("aria-label", savedLabel || `${m.displayName} 제거`);
      setFormBusy(row, false);
      notify(`제거 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
    } catch (e) {
      del.title = savedTitle;
      del.setAttribute("aria-label", savedLabel || `${m.displayName} 제거`);
      if (row.isConnected) setFormBusy(row, false);
      notify(`멤버는 제거됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  row = el("div", { class: "plugin-row" }, [
    avatarNode({ ...m, id: m.userId }, 32, { alt: "" }),
    el("div", { class: "pr-main" }, [
      el("strong", { text: m.displayName }),
      el("div", { class: "pr-sub", text: `@${m.username}` }),
    ]),
    isAdmin ? el("span", { class: "tag write", text: "관리자" }) : el("span", { class: "tag read", text: "멤버" }),
    el("div", { class: "pr-actions" }, [roleBtn, del]),
  ]);
  return row;
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
      } catch (e) {
        notify(`저장 실패: ${e.message}`);
        // Restore the last-saved selection rather than leaving the group blank.
        const prior = opts.querySelector(`#sm-${state.signupMode || current}`);
        if (prior) prior.checked = true;
        else input.checked = false;
        opts.querySelectorAll("input").forEach((i) => (i.disabled = false));
        return;
      }
      state.signupMode = m.id;
      try {
        await loadAdminSystem();
        notify("회원가입 정책을 저장했습니다.", "ok");
      } catch (e) {
        notify(`회원가입 정책은 저장했지만 상태 새로고침에 실패했습니다: ${e.message}`, "warn");
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
      if (filterAction) {
        const resetAuditFilter = () => {
          filter.value = "";
          render("");
          filter.focus();
        };
        tableWrap.replaceChildren(
          el("div", { class: "muted pad" }, [
            `"${filterAction}" 액션 기록이 없습니다. `,
            el("button", { class: "linkish small", type: "button", text: "전체 액션 보기", onclick: resetAuditFilter }),
          ]),
        );
      } else {
        tableWrap.replaceChildren(el("div", { class: "muted pad", text: "기록이 없습니다." }));
      }
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
  const filter = el("select", { class: "admin-search", "aria-label": "액션 필터", disabled: actions.length ? null : "" });
  filter.append(el("option", { value: "", text: actions.length ? "전체 액션" : "필터할 액션 없음" }));
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
  if (!sys) {
    return [
      el("div", { class: "warn-box" }, [
        "시스템 정보를 불러올 수 없습니다. ",
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    ];
  }
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
    sysRow(
      "Confluence",
      sys.confluenceConfigured
        ? el("span", { class: "tag", text: "host 설정됨" })
        : el("span", { class: "muted", text: "CONFLUENCE_URL 미설정" }),
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
        const formEl = e.currentTarget;
        const value = (new FormData(formEl).get("model") || "").toString().trim();
        const btn = formEl.querySelector("button[type=submit]");
        const saved = btn.textContent;
        setFormBusy(formEl, true);
        btn.textContent = "저장 중…";
        const successMessage = value ? "모델을 저장했습니다." : "모델 지정을 해제했습니다. SDK 기본값을 사용합니다.";
        try {
          if (value) {
            await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model: value }) });
          } else {
            await api("/api/admin/model", { method: "DELETE" });
          }
        } catch (err) {
          btn.textContent = saved;
          setFormBusy(formEl, false);
          notify(`저장 실패: ${err.message}`);
          return;
        }
        try {
          await loadAdminSystem();
          renderView();
        } catch (err) {
          btn.textContent = saved;
          setFormBusy(formEl, false);
          notify(`모델 설정은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
          return;
        }
        notify(successMessage, "ok");
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
  const tokenField = buildRevealableInput({
    name: "token",
    placeholder: "sk-ant-oat01-...",
    autocomplete: "off",
    ariaLabel: connected ? "Claude 구독 토큰 교체" : "Claude 구독 토큰",
    revealLabel: "토큰",
    required: true,
  });
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
      const saved = disBtn.textContent;
      disBtn.textContent = "해제 중…";
      try {
        await api("/api/admin/claude-token", { method: "DELETE" });
      } catch (e) {
        disBtn.textContent = saved;
        disBtn.disabled = false;
        notify(`해제 실패: ${e.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (e) {
        disBtn.textContent = saved;
        disBtn.disabled = false;
        notify(`구독 토큰은 삭제했지만 상태 새로고침에 실패했습니다: ${e.message}`, "warn");
        return;
      }
      notify("구독 토큰 연결을 해제했습니다.", "ok");
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
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`구독 토큰은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
        return;
      }
      notify("구독 토큰을 저장했습니다.", "ok");
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: connected ? "토큰 교체" : "Claude 구독 토큰" }),
      tokenField.wrap,
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
  const children = [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "SSH 도구 정책" }),
        el("p", { class: "muted", text: "역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다." }),
      ]),
    ]),
  ];
  if (!tools.length) {
    children.push(
      el("div", { class: "empty-note" }, [
        "현재 설정할 SSH 도구가 없습니다. hex-ssh 도구 목록이 서버에서 제공되면 역할별 정책 표가 여기에 표시됩니다.",
      ]),
    );
    return el("section", { class: "settings-card" }, children);
  }
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
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`SSH 도구 정책은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
        return;
      }
      notify("SSH 도구 정책을 저장했습니다.", "ok");
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

  children.push(form);
  return el("section", { class: "settings-card" }, children);
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
let lastAnnouncedNotificationCount = 0;

// Single combined badge on the 받은함 nav item: open info-requests + unread
// notifications. Both inboxes now live in one tab, so they share one count.
function updateInboxBadge() {
  const btn = dom.navButtons?.inbox;
  if (!btn) return;
  const requests = state.knowledgeRequests.filter((r) => r.status === "open").length;
  const notifications = state.notifications.filter((n) => !n.readAt).length;
  const count = requests + notifications;
  let badge = btn.querySelector(".nav-badge");
  if (!count) {
    badge?.remove();
    btn.removeAttribute("title");
    return;
  }
  if (!badge) {
    badge = el("span", { class: "nav-badge" });
    btn.append(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
  btn.title = `받은함: 정보 요청 ${requests}건 · 알림 ${notifications}건`;
}

// Kept as the names every caller already uses; each resyncs its own "announce"
// baseline (so a resolve lowers it and a later re-ask announces again) and then
// repaints the shared badge.
function updateKnowledgeBadge() {
  lastAnnouncedRequestCount = state.knowledgeRequests.filter((r) => r.status === "open").length;
  updateInboxBadge();
}
function updateNotificationBadge() {
  lastAnnouncedNotificationCount = state.notifications.filter((n) => !n.readAt).length;
  updateInboxBadge();
}

async function refreshNotificationStatus({ announce = false } = {}) {
  if (!state.user) return;
  try {
    await loadNotifications();
  } catch {
    return;
  }
  const unread = state.notifications.filter((n) => !n.readAt).length;
  if (announce && unread > lastAnnouncedNotificationCount) {
    notify(`새 아바타 알림이 ${unread}건 있습니다. ‘받은함’에서 확인해 주세요.`, "info", {
      onClick: () => goView("inbox"),
    });
  }
  updateNotificationBadge();
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
    notify(`아직 답하지 못한 정보 요청이 ${open}건 있어요. ‘받은함’에서 확인해 주세요.`, "info", {
      onClick: openKnowledgeRequests,
    });
  }
  updateKnowledgeBadge(); // resyncs lastAnnouncedRequestCount
}

// Jump straight to the unified inbox, re-rendering even if the owner is already
// on it (goView no-ops on a same-view navigation).
function openKnowledgeRequests() {
  if (state.view === "inbox") {
    renderView();
  } else {
    goView("inbox");
  }
}

// Keep the badge/toast fresh while the tab is open: a colleague's new question
// then surfaces without a reload. Poll only when visible (cheap: one small GET/min)
// and also refresh the moment the owner returns to the tab.
let knowledgeWatchTimer = null;
function onKnowledgeVisible() {
  if (!document.hidden) {
    refreshKnowledgeStatus({ announce: true });
    refreshNotificationStatus({ announce: true });
  }
}
function startKnowledgeWatch() {
  stopKnowledgeWatch();
  knowledgeWatchTimer = setInterval(() => {
    if (!document.hidden) {
      refreshKnowledgeStatus({ announce: true });
      refreshNotificationStatus({ announce: true });
    }
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
async function loadRoutineConversations() {
  const r = await api("/api/conversations?kind=routine");
  state.routineConversations = r.conversations || [];
  if (!state.routineConversationId && state.routineConversations.length) {
    state.routineConversationId = state.routineConversations[0].id;
  }
}
async function loadNotifications() {
  const r = await api("/api/me/notifications");
  state.notifications = r.notifications || [];
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
async function logout(triggerBtn = null) {
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.title = "로그아웃 중…";
    triggerBtn.setAttribute("aria-label", "로그아웃 중");
  }
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
  state.routineConversations = [];
  state.routineConversationId = "";
  state.routineMessages = [];
  state.notifications = [];
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
  if (view === "routines" && arg) state.routineConversationId = arg;
  if (view === "admin" && arg) state.adminTab = arg;
  const wantConversation = view === "chat" && arg ? arg : null;
  if (wantConversation) state.view = "explore"; // placeholder frame until messages load
  renderView();
  syncHash(true);
  refreshKnowledgeStatus({ announce: true });
  startKnowledgeWatch();
  refreshNotificationStatus({ announce: true });
  await refreshConversations();
  if (wantConversation) {
    const conv = state.conversations.find((c) => c.id === wantConversation);
    if (conv) await selectConversation(conv);
    else syncHash(true);
  }
  // First-time guidance: explain the app and optionally collect the internal Git token. Skippable,
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

const ONBOARDING_FEATURES = [
  {
    title: "내 아바타 만들기",
    desc: "이름, 별칭, 프로필, 페르소나, 자기소개를 설정하고 공개하면 탐색 목록에서 다른 사용자가 대화할 수 있습니다.",
  },
  {
    title: "나의 업무 아바타로 키우기",
    desc: "반복 업무, 프로젝트 규칙, 운영 절차를 지식 저장소·스킬·루틴으로 쌓아 두고 점점 더 많은 일을 맡길 수 있습니다.",
  },
  {
    title: "아바타와 대화하기",
    desc: "탐색에서 공개 아바타를 고르거나 내 아바타와 바로 대화합니다. 응답은 스트리밍되고, 복사·재생성·편집 후 재전송을 지원합니다.",
  },
  {
    title: "동료 아바타에게 질문·요청하기",
    desc: "동료가 공개한 아바타를 찾아 그 사람이 쌓아 둔 지식과 스킬에 업무 질문을 하거나 조사·검토·정리 같은 작업을 요청할 수 있습니다.",
  },
  {
    title: "지식 저장소로 학습시키기",
    desc: "전용 GitHub 저장소를 연결하면 아바타가 대화 중 얻은 지식과 스킬을 파일로 정리하고 다음 대화에서 다시 사용합니다.",
  },
  {
    title: "플러그인과 스킬 확장",
    desc: "GitHub 플러그인 저장소를 추가해 읽기 도구, 업무 규칙, MCP 도구 설명을 아바타에 붙일 수 있습니다.",
  },
  {
    title: "SSH 서버 작업 맡기기",
    desc: "SSH 키와 신뢰 호스트를 설정하면 이 앱이 실행되는 호스트에서 접근 가능한 서버에 접속해 로그 확인, 파일 점검, 명령 실행 같은 원격 작업을 시킬 수 있습니다.",
  },
  {
    title: "루틴 자동 실행",
    desc: "매일 정해진 시각에 내 아바타가 스스로 작업하게 하고, 결과를 전용 대화에 계속 쌓을 수 있습니다.",
  },
  {
    title: "보안 설정 관리",
    desc: "사내·외부 Git 토큰, 커밋 정보, 시크릿, SSH 키를 설정해 비공개 저장소와 원격 작업에 필요한 권한을 안전하게 제공합니다.",
  },
];

const ONBOARDING_EXAMPLES = [
  "내가 자주 맡기는 배포 점검 절차를 스킬로 정리하고 다음부터 그대로 수행해줘.",
  "민수님의 아바타에게 이번 장애 원인과 재발 방지 체크리스트를 물어봐.",
  "데이터팀 아바타에게 이 쿼리 결과를 검토하고 요약해 달라고 요청해줘.",
  "내 지식 저장소에 이 프로젝트 운영 절차를 스킬로 정리해줘.",
  "이 저장소에서 로그인 흐름을 읽고 개선할 부분을 찾아줘.",
  "접근 가능한 서버에 SSH로 접속해서 서비스 로그와 디스크 사용량을 점검해줘.",
  "매일 09시에 어제 쌓인 정보 요청을 요약해줘.",
];

function buildOnboardingGuide() {
  return el("div", { class: "onboard-guide" }, [
    el("section", { class: "onboard-section" }, [
      el("h3", { text: "이 앱에서 할 수 있는 일" }),
      el("div", { class: "onboard-feature-list" },
        ONBOARDING_FEATURES.map((item) =>
          el("div", { class: "onboard-feature" }, [
            el("strong", { text: item.title }),
            el("p", { text: item.desc }),
          ]),
        ),
      ),
    ]),
    el("section", { class: "onboard-section" }, [
      el("h3", { text: "처음 대화할 때 이렇게 시켜볼 수 있어요" }),
      el("ul", { class: "onboard-examples" }, ONBOARDING_EXAMPLES.map((text) => el("li", { text }))),
    ]),
    el("p", {
      class: "onboard-note",
      text: "권한은 대화 상대에 따라 달라집니다. 내 아바타와 신뢰한 사용자는 작업 도구를 쓸 수 있고, 일반 사용자가 다른 아바타와 대화할 때는 읽기 전용으로 실행됩니다.",
    }),
  ]);
}

/**
 * Skippable onboarding overlay: explains the main workflows and optionally stores
 * an internal Git token. Knowledge repo/branch setup stays in chat or settings so first
 * login does not feel like a repository configuration wizard.
 */
function openOnboarding() {
  const gitTokenField = buildRevealableInput({
    name: "token",
    placeholder: "사내 GitHub PAT (GIT_TOKEN)",
    autocomplete: "off",
    ariaLabel: "사내 Git 토큰 GIT_TOKEN",
    revealLabel: "토큰",
  });
  const tokenInput = gitTokenField.input;
  const confluenceField = buildRevealableInput({
    name: "confluence",
    placeholder: "Confluence PAT (CONFLUENCE_PAT)",
    autocomplete: "off",
    ariaLabel: "Confluence Personal Access Token CONFLUENCE_PAT",
    revealLabel: "토큰",
  });
  const confluenceInput = confluenceField.input;
  const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
  const sshStatus = el("div", { class: "git-token-status muted" });
  const sshPublicKeyBox = el("div", { class: "ssh-public-key-box" });
  const generateSshBtn = el("button", {
    class: "primary",
    type: "button",
    text: "SSH 키 생성",
    onclick: async () => {
      generateSshBtn.disabled = true;
      const savedLabel = generateSshBtn.textContent;
      generateSshBtn.textContent = "생성 중…";
      errorBox.hidden = true;
      try {
        const { user } = await api("/api/me/ssh-key", { method: "POST" });
        state.user = user;
        renderSshSetup();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        generateSshBtn.textContent = savedLabel;
        generateSshBtn.disabled = false;
      }
    },
  });
  function renderSshSetup() {
    const publicKey = (state.user.sshPublicKey || "").trim();
    if (publicKey) {
      sshStatus.replaceChildren(el("span", { class: "token-set", text: "● SSH_PRIVATE_KEY 생성됨" }));
      sshPublicKeyBox.hidden = false;
      sshPublicKeyBox.replaceChildren(buildSshPublicKeyField(publicKey));
      generateSshBtn.textContent = "SSH 키 생성됨";
      generateSshBtn.disabled = true;
      return;
    }
    if (hasSecret("SSH_PRIVATE_KEY")) {
      sshStatus.replaceChildren(el("span", { class: "token-set", text: "● SSH_PRIVATE_KEY 설정됨" }));
      sshPublicKeyBox.hidden = true;
      sshPublicKeyBox.replaceChildren();
      generateSshBtn.textContent = "SSH 키 설정됨";
      generateSshBtn.disabled = true;
      return;
    }
    sshStatus.replaceChildren(el("span", { text: "SSH_PRIVATE_KEY 미설정" }));
    sshPublicKeyBox.hidden = true;
    sshPublicKeyBox.replaceChildren();
    generateSshBtn.textContent = "SSH 키 생성";
    generateSshBtn.disabled = false;
  }
  renderSshSetup();

  const saveBtn = el("button", { class: "primary", type: "submit", text: "시작하기" });
  const skipBtn = el("button", { class: "linkish", type: "button", text: "건너뛰기" });
  const updateSaveButtonLabel = () => {
    const hasToken = Boolean(tokenInput.value.trim());
    const hasConfluencePat = state.confluenceConfigured && Boolean(confluenceInput.value.trim());
    saveBtn.textContent = hasToken || hasConfluencePat ? "저장하고 시작" : "시작하기";
  };
  tokenInput.addEventListener("input", updateSaveButtonLabel);
  confluenceInput.addEventListener("input", updateSaveButtonLabel);
  updateSaveButtonLabel();

  openModal({
    cardClass: "onboard-card",
    ariaLabelledby: "onboarding-title",
    onBeforeClose: () => markOnboardingDone(state.user.id),
    buildCard: (card, close) => {
      const form = el("form", {
        class: "form-stack",
        onsubmit: async (e) => {
          e.preventDefault();
          const formEl = e.currentTarget;
          const savedLabel = saveBtn.textContent;
          const token = tokenInput.value.trim();
          const confluencePat = confluenceInput.value.trim();
          const willSave = Boolean(token || confluencePat);
          setFormBusy(formEl, true);
          saveBtn.textContent = willSave ? "저장 중…" : "시작 중…";
          errorBox.hidden = true;
          try {
            if (token) {
              const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
              state.user = user;
            }
            if (confluencePat) {
              const { user } = await api("/api/me/secrets/CONFLUENCE_PAT", {
                method: "PUT",
                body: JSON.stringify({ value: confluencePat }),
              });
              state.user = user;
            }
            close();
            renderView();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            saveBtn.textContent = savedLabel;
            setFormBusy(formEl, false);
            renderSshSetup();
          }
        },
      }, [
        el("label", { class: "field" }, [
          el("span", {}, [
            "사내 Git 토큰 (GIT_TOKEN, 선택) ",
            el("a", {
              class: "linkish",
              href: `https://${(state.githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/settings/tokens`,
              target: "_blank",
              rel: "noopener noreferrer",
              text: "토큰 만들러 가기 ↗",
            }),
          ]),
          gitTokenField.wrap,
        ]),
        el("div", { class: "onboard-connect" }, [
          el("h3", { text: "SSH 키" }),
          el("div", { class: "onboard-highlight" }, [
            el("strong", { text: "왜 SSH를 설정하면 좋나요?" }),
            el("p", {
              text: "SSH 키를 등록하면 아바타가 이 앱이 접근할 수 있는 원격 서버에 직접 접속해 일할 수 있습니다. 예를 들어 서비스 로그·디스크·프로세스 상태 점검, 설정 파일 확인, 배포·재시작 같은 명령 실행, 파일 송수신을 대화만으로 맡길 수 있어 매번 직접 터미널에 접속하는 수고를 덜어 줍니다.",
            }),
            el("p", {
              class: "onboard-highlight-note",
              text: "개인키는 암호화되어 저장되고 도구 실행 시에만 주입됩니다 — 아바타도 값 자체는 볼 수 없습니다. 공개키만 접속 대상 서버에 등록하면 됩니다.",
            }),
          ]),
          el("p", {
            class: "muted",
            text: "지금 생성하면 개인키는 SSH_PRIVATE_KEY 시크릿으로 저장되고 다시 표시되지 않습니다. 공개키는 생성 후에도 설정에서 다시 확인할 수 있습니다.",
          }),
          sshStatus,
          el("div", { class: "git-token-actions" }, [generateSshBtn]),
          sshPublicKeyBox,
        ]),
        state.confluenceConfigured
          ? el("div", { class: "onboard-connect" }, [
              el("h3", { text: "Confluence 연결" }),
              el("p", {
                class: "muted",
                text: "Confluence PAT를 저장해 두면 아바타가 사내 Confluence에서 문서를 검색·조회하고 페이지를 작성·수정할 수 있습니다. 값은 암호화되어 저장되고 다시 표시되지 않습니다.",
              }),
              el("label", { class: "field" }, [
                el("span", { text: "Confluence PAT (CONFLUENCE_PAT, 선택)" }),
                confluenceField.wrap,
              ]),
            ])
          : null,
        errorBox,
        el("div", { class: "onboard-actions" }, [
          skipBtn,
          saveBtn,
        ]),
      ]);
      skipBtn.onclick = () => close();

      card.append(
        el("img", { class: "login-mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "48", height: "48" }),
        el("h2", { id: "onboarding-title", text: "아바타 사용 준비하기" }),
        el("p", {
          class: "muted",
          text: "Noah Almighty는 내 업무 방식을 아바타에 축적하고, 동료들의 아바타에게도 업무를 질문·요청하는 앱입니다. GitHub 지식 저장소와 플러그인, 루틴, SSH 도구를 붙여 대화로 일하게 할 수 있습니다.",
        }),
        buildOnboardingGuide(),
        el("div", { class: "onboard-connect" }, [
          el("h3", { text: "처음 설정하면 좋은 권한" }),
          el("p", {
            class: "muted",
            text: "GIT_TOKEN을 저장해 두면 아바타가 사내 비공개 저장소를 읽고, 대화 중 지식 저장소에 파일을 추가한 뒤 커밋·푸시할 수 있습니다. SSH 키와 Confluence 연결도 지금 함께 설정해 두면 첫 대화부터 더 많은 일을 맡길 수 있습니다.",
          }),
        ]),
        form,
      );
      // Keep the opening focus on the guide itself; jumping straight to the
      // token field skips the explanation and can scroll the modal past it.
      return { focusTarget: card };
    },
  });
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
    state.confluenceConfigured = Boolean(bootstrap.confluenceConfigured);
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
