import { api, refreshMe } from "./api";
import { replaceState, updateState } from "./state";
import type {
  AdminGroupSummary,
  AdminStats,
  AdminUserSummary,
  AuditEvent,
  AvatarNotification,
  AvatarSummary,
  ConversationSummary,
  KnowledgeRequest,
  Plugin,
  RoutineJob,
  StoredMessage,
} from "./types";

export async function loadAvatars(force = false): Promise<AvatarSummary[]> {
  let shouldLoad = false;
  updateState((state) => {
    shouldLoad = force || (!state.avatarsLoaded && !state.avatarsLoading);
    if (shouldLoad) state.avatarsLoading = true;
  });
  if (!shouldLoad) return [];
  try {
    const { avatars } = await api<{ avatars: AvatarSummary[] }>("/api/avatars");
    replaceState({ avatars, avatarsLoaded: true, avatarsLoading: false });
    return avatars;
  } catch (err) {
    updateState((state) => {
      state.avatarsLoading = false;
    });
    throw err;
  }
}

export async function loadConversations(kind: "chat" | "routine" | "all" = "chat"): Promise<ConversationSummary[]> {
  const path = kind === "chat" ? "/api/conversations" : `/api/conversations?kind=${kind}`;
  const { conversations } = await api<{ conversations: ConversationSummary[] }>(path);
  if (kind === "routine") replaceState({ routineConversations: conversations });
  else replaceState({ conversations });
  return conversations;
}

export async function loadMessages(conversationId: string): Promise<{ messages: StoredMessage[]; groupKnowledgeOff: string[] }> {
  return api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
}

export async function loadSettingsData(): Promise<void> {
  const [me, plugins, requests] = await Promise.all([
    refreshMe(),
    api<{ plugins: Plugin[] }>("/api/me/plugins"),
    api<{ requests: KnowledgeRequest[] }>("/api/me/knowledge/requests"),
  ]);
  void me;
  replaceState({ plugins: plugins.plugins, knowledgeRequests: requests.requests });
}

export async function loadInboxData(): Promise<void> {
  const [requests, notifications, routines] = await Promise.allSettled([
    api<{ requests: KnowledgeRequest[] }>("/api/me/knowledge/requests"),
    api<{ notifications: AvatarNotification[] }>("/api/me/notifications"),
    loadConversations("routine"),
  ]);
  if (requests.status === "fulfilled") replaceState({ knowledgeRequests: requests.value.requests });
  if (notifications.status === "fulfilled") replaceState({ notifications: notifications.value.notifications });
  if (routines.status === "rejected") throw routines.reason;
  if (requests.status === "rejected") throw requests.reason;
  if (notifications.status === "rejected") throw notifications.reason;
}

export async function loadRoutinesData(): Promise<void> {
  const [routines, conversations] = await Promise.all([
    api<{ routines: RoutineJob[] }>("/api/me/routines"),
    loadConversations("routine"),
  ]);
  replaceState({ routines: routines.routines, routineConversations: conversations });
}

export async function loadRoutineMessages(conversationId: string): Promise<void> {
  const { messages } = await loadMessages(conversationId);
  replaceState({ routineMessages: messages });
}

export async function loadAdminOverview(): Promise<void> {
  const [stats, system, users, audit] = await Promise.all([
    api<{ stats: AdminStats }>("/api/admin/stats"),
    api<Record<string, unknown>>("/api/admin/system"),
    api<{ users: AdminUserSummary[] }>("/api/admin/users"),
    api<{ events: AuditEvent[] }>("/api/audit"),
  ]);
  replaceState({ adminStats: stats.stats, adminSystem: system, adminUsers: users.users, audit: audit.events });
}

export async function loadAdminGroups(): Promise<void> {
  const { groups } = await api<{ groups: AdminGroupSummary[] }>("/api/admin/groups");
  replaceState({ adminGroups: groups });
}
