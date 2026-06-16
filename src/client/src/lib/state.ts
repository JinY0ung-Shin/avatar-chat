import { get, writable } from "svelte/store";
import type {
  AdminGroupSummary,
  AdminStats,
  AdminTab,
  AdminUserSummary,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  BootstrapInfo,
  ChatLayout,
  ChatPane,
  ConversationSummary,
  KnowledgeRequest,
  Plugin,
  PromptRequest,
  RoutineJob,
  SettingsTab,
  Toast,
  User,
  ViewName,
} from "./types";

export interface ClientState {
  booted: boolean;
  bootError: string;
  bootstrap: BootstrapInfo | null;
  user: User | null;
  view: ViewName;
  settingsTab: SettingsTab;
  adminTab: AdminTab;
  /** Active source on the brain (knowledge-graph) view: "personal" or "group:<id>". */
  brainSource: string;
  avatars: AvatarSummary[];
  avatarsLoaded: boolean;
  avatarsLoading: boolean;
  exploreQuery: string;
  currentAvatar: AvatarDetail | null;
  chatPanes: ChatPane[];
  activePaneId: string | null;
  chatLayout: ChatLayout;
  conversations: ConversationSummary[];
  plugins: Plugin[];
  knowledgeRequests: KnowledgeRequest[];
  notifications: AvatarNotification[];
  inboxFilter: "all" | "unread" | "requests" | "notifications";
  routines: RoutineJob[];
  routineConversations: ConversationSummary[];
  routineConversationId: string;
  routineMessages: import("./types").StoredMessage[];
  routineSearch: string;
  routineFilter: "all" | "enabled" | "paused" | "error";
  adminUsers: AdminUserSummary[];
  adminGroups: AdminGroupSummary[];
  adminUserFilter: "all" | "admins" | "suspended" | "public" | "sessions";
  adminUserSearch: string;
  adminGroupSearch: string;
  adminStats: AdminStats | null;
  adminSystem: Record<string, unknown> | null;
  audit: AuditEvent[];
  /** Interactive permission/question prompts awaiting the owner (one shown at a time). */
  promptQueue: PromptRequest[];
  splitAvatarId: string;
  streaming: boolean;
  themePref: "system" | "light" | "dark";
}

export const appState = writable<ClientState>({
  booted: false,
  bootError: "",
  bootstrap: null,
  user: null,
  view: "explore",
  settingsTab: "profile",
  adminTab: "overview",
  brainSource: "personal",
  avatars: [],
  avatarsLoaded: false,
  avatarsLoading: false,
  exploreQuery: "",
  currentAvatar: null,
  chatPanes: [],
  activePaneId: null,
  chatLayout: "vertical",
  conversations: [],
  plugins: [],
  knowledgeRequests: [],
  notifications: [],
  inboxFilter: "all",
  routines: [],
  routineConversations: [],
  routineConversationId: "",
  routineMessages: [],
  routineSearch: "",
  routineFilter: "all",
  adminUsers: [],
  adminGroups: [],
  adminUserFilter: "all",
  adminUserSearch: "",
  adminGroupSearch: "",
  adminStats: null,
  adminSystem: null,
  audit: [],
  promptQueue: [],
  splitAvatarId: "",
  streaming: false,
  themePref: "system",
});

export const toasts = writable<Toast[]>([]);

export function readState(): ClientState {
  return get(appState);
}

export function updateState(mutator: (state: ClientState) => void): void {
  appState.update((state) => {
    mutator(state);
    state.streaming = state.chatPanes.some((pane) => pane.streaming);
    return state;
  });
}

export function replaceState(patch: Partial<ClientState>): void {
  appState.update((state) => {
    const next = { ...state, ...patch };
    next.streaming = next.chatPanes.some((pane) => pane.streaming);
    return next;
  });
}

export function newId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function activePane(): ChatPane | null {
  const state = readState();
  return state.chatPanes.find((pane) => pane.id === state.activePaneId) ?? state.chatPanes[0] ?? null;
}

export function notify(message: string, kind: Toast["kind"] = "warn", opts: Partial<Toast> = {}): void {
  const toast: Toast = { id: newId(), message, kind, ...opts };
  toasts.update((items) => [...items.slice(-3), toast]);
  window.setTimeout(() => {
    toasts.update((items) => items.filter((item) => item.id !== toast.id));
  }, 5000);
}

export function dismissToast(id: string): void {
  toasts.update((items) => items.filter((item) => item.id !== id));
}

export function setDocumentTitle(): void {
  const state = readState();
  if (state.streaming) {
    document.title = "● 응답 중 · Noah Almighty";
    return;
  }
  if (!state.user) {
    document.title = "Noah Almighty";
    return;
  }
  const titles: Record<ViewName, string> = {
    explore: "탐색",
    chat: activePane()?.avatar.alias || activePane()?.avatar.displayName || "대화",
    brain: "지식 그래프",
    inbox: "알림",
    routines: "루틴",
    settings: "내 아바타",
    admin: "관리자",
  };
  document.title = `${titles[state.view] || "Noah Almighty"} · Noah Almighty`;
}

appState.subscribe(() => {
  if (typeof document !== "undefined") setDocumentTitle();
});
