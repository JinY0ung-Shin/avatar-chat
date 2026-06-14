// Auto-split from app.js — module: loaders. Behavior-preserving relocation only.
import { api, dom, el, notify, state } from "./core.js";
import { goView, renderView } from "./nav.js";


/* ============================================================ Loaders */
export async function refreshMe() {
  const me = await api("/api/me");
  if (me.user) state.user = me.user;
}
export async function loadAvatars() {
  state.avatarsLoading = true;
  try {
    const r = await api("/api/avatars");
    state.avatars = r.avatars || [];
    state.avatarsLoaded = true;
  } finally {
    state.avatarsLoading = false;
  }
}
export async function loadPlugins() {
  const r = await api("/api/me/plugins");
  state.plugins = r.plugins || [];
}
export async function loadKnowledge() {
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
export function updateInboxBadge() {
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
export function updateKnowledgeBadge() {
  lastAnnouncedRequestCount = state.knowledgeRequests.filter((r) => r.status === "open").length;
  updateInboxBadge();
}
export function updateNotificationBadge() {
  lastAnnouncedNotificationCount = state.notifications.filter((n) => !n.readAt).length;
  updateInboxBadge();
}

export async function refreshNotificationStatus({ announce = false } = {}) {
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
export async function refreshKnowledgeStatus({ announce = false } = {}) {
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
export function startKnowledgeWatch() {
  stopKnowledgeWatch();
  knowledgeWatchTimer = setInterval(() => {
    if (!document.hidden) {
      refreshKnowledgeStatus({ announce: true });
      refreshNotificationStatus({ announce: true });
    }
  }, 60000);
  document.addEventListener("visibilitychange", onKnowledgeVisible);
}
export function stopKnowledgeWatch() {
  if (knowledgeWatchTimer) {
    clearInterval(knowledgeWatchTimer);
    knowledgeWatchTimer = null;
  }
  document.removeEventListener("visibilitychange", onKnowledgeVisible);
}
export async function loadRoutines() {
  const r = await api("/api/me/routines");
  state.routines = r.routines || [];
}
export async function loadRoutineConversations() {
  const r = await api("/api/conversations?kind=routine");
  state.routineConversations = r.conversations || [];
  if (!state.routineConversationId && state.routineConversations.length) {
    state.routineConversationId = state.routineConversations[0].id;
  }
}
export async function loadNotifications() {
  const r = await api("/api/me/notifications");
  state.notifications = r.notifications || [];
}
export async function loadAdminUsers() {
  const r = await api("/api/admin/users");
  state.adminUsers = r.users || [];
}
export async function loadAdminSystem() {
  const r = await api("/api/admin/system");
  state.adminSystem = r.system || null;
}
export async function loadAdminStats() {
  const r = await api("/api/admin/stats");
  state.adminStats = r.stats || null;
}
export async function loadAudit() {
  const r = await api("/api/audit");
  state.audit = r.audit || [];
}
export async function loadAdminUserDetail(id) {
  const r = await api(`/api/admin/users/${encodeURIComponent(id)}`);
  state.adminUserDetail[id] = r.user;
  return r.user;
}
