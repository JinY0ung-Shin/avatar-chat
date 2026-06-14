// Auto-split from app.js — module: nav. Behavior-preserving relocation only.
import { renderAdmin } from "./admin.js";
import { activePane, renderChat, selectConversation } from "./chat.js";
import { dom, state } from "./core.js";
import { renderExplore } from "./explore.js";
import { renderInboxView } from "./inbox.js";
import { renderRoutinesView } from "./routines.js";
import { renderSettings } from "./settings.js";
import { closeRail, noteStreamingContinues } from "./shell.js";


export function goView(view) {
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

export function syncDocumentTitle() {
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

export function renderView() {
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

export function routeFromHash() {
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

export function syncHash(replace = false) {
  if (applyingRoute || !state.user) return;
  const target = currentRoute();
  if (location.hash === target) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
}

export function syncHashAfterRoute(replace = true) {
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
