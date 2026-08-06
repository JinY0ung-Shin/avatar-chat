import { api } from "./api";
import { confirmAction } from "./confirm";
import { loadConversations, loadMessages } from "./loaders";
import { syncHash } from "./nav";
import { consumeSse, type SseFrame } from "./sse";
import { ensureNotificationPermission, osNotify } from "./notifications";
import { newId, notify, readState, updateState } from "./state";
import { isDrawioAttachment } from "./drawioViewer";
import { sendToExtension } from "./browserBridge";
import { resolveTypedSlashCommand } from "./slash";
import { DEFAULT_MODEL_TIER } from "../../../server/modelTiers";
import { DEFAULT_EFFORT_LEVEL } from "../../../server/effortLevels";
import {
  SDK_HIDDEN_ACTIVITY_TOOLS,
  SDK_TOOL_LABELS,
} from "../../../shared/sdkToolPresentation";
import { DEFAULT_MCP_TOOL_GROUPS } from "../../../shared/mcpToolGroups";
import type {
  AgentActivity,
  AgentResponse,
  AvatarDetail,
  AvatarSummary,
  CanvasArtifact,
  ChatPane,
  ConversationSummary,
  LiveTaskRow,
  LiveToolRow,
  PaneCanvas,
  StoredMessage,
} from "./types";

const MAX_CHAT_PANES = 4;

// Internal orchestration tools the viewer shouldn't see as activity rows.
const HIDDEN_TOOLS = new Set(SDK_HIDDEN_ACTIVITY_TOOLS);

// Friendly, human-readable labels for tools shown in the activity tree. Raw
// names (e.g. `mcp__knowledge__request_info`) are an implementation detail.
const TOOL_LABELS: Record<string, string> = {
  ...SDK_TOOL_LABELS,
  mcp__knowledge__request_info: "정보 요청 기록",
  mcp__knowledge__pending_requests: "대기 요청 확인",
  mcp__knowledge__resolve_request: "요청 처리 완료",
  mcp__canvas__show: "캔버스 표시",
  mcp__confluence__describe_config: "Confluence 설정 확인",
  mcp__confluence__list_spaces: "Confluence 스페이스 조회",
  mcp__confluence__search: "Confluence 검색",
  mcp__confluence__get_page: "Confluence 페이지 조회",
  mcp__confluence__list_attachments: "Confluence 첨부 조회",
  mcp__confluence__get_attachment: "Confluence 첨부 가져오기",
  mcp__file_output__show_file: "이미지 표시",
  mcp__file_output__share_file: "파일 공유",
  mcp__confluence__extract_page_assets: "Confluence 자산 추출",
  mcp__confluence__create_page: "Confluence 페이지 생성",
  mcp__confluence__update_page: "Confluence 페이지 수정",
  mcp__system__notify_user: "사용자 알림",
  mcp__web__fetch: "웹 페이지 읽기",
};

export const PLUGIN_STATUS_LABELS: Record<string, string> = {
  started: "불러오는 중",
  installed: "설치됨",
  completed: "사용 준비됨",
  failed: "불러오기 실패",
};

export function humanTool(name: string | undefined): string {
  if (!name) return "도구";
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // Keep in lockstep with sdkToolLabel (src/shared/sdkToolPresentation.ts):
  // server segments may contain underscores (git_repo, group_agent).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return (mcp ? mcp[2] : name).replace(/_/g, " ");
}

// Intelligent one-line summary of a tool's input: prefer a recognizable key
// (command/file_path/path/pattern/url/query/…) over dumping JSON. Mirrors the
// old summarizeInputForCard().
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input);
  if (typeof input !== "object") return truncate(String(input));
  const obj = input as Record<string, unknown>;
  const keys = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
    "description",
    "repo",
    "name",
  ];
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key])
      return truncate(obj[key] as string);
  }
  const firstStr = Object.values(obj).find((v) => typeof v === "string" && v);
  return typeof firstStr === "string"
    ? truncate(firstStr)
    : truncate(JSON.stringify(obj));
}

function truncate(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function makePane(
  avatar: AvatarDetail,
  conversationId = newId(),
  messages: StoredMessage[] = [],
  canvasArtifacts: CanvasArtifact[] = [],
): ChatPane {
  const canvases = paneCanvasesFromArtifacts(canvasArtifacts);
  return {
    id: newId(),
    avatar,
    conversationId,
    messages,
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveTextBreakPending: false,
    liveThinking: "",
    thinkingActive: false,
    livePlan: "",
    planPending: false,
    planReview: null,
    planReviewSubmitting: false,
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    groupKnowledgeOff: avatar.isOwn
      ? [...(readState().user?.groupKnowledgeOffDefault || [])]
      : [],
    // Seed the composer pickers from the owner's remembered defaults so the last
    // choice carries to a new conversation (null/undefined = fall back to the
    // hardcoded server/SDK default). selectConversation() overrides these with the
    // per-conversation stored value when resuming an existing thread. External
    // panes stay unseeded: their model slot holds a GATEWAY model id, so a native
    // tier alias must never leak into it (undefined = admin-configured default).
    modelTier:
      avatar.runtime === "external"
        ? undefined
        : (readState().user?.modelDefault ?? undefined),
    effort:
      avatar.runtime === "external"
        ? undefined
        : (readState().user?.effortDefault ?? undefined),
    mcpToolGroups: readState().user?.mcpToolGroupsDefault
      ? [...readState().user!.mcpToolGroupsDefault!]
      : [...DEFAULT_MCP_TOOL_GROUPS],
    canvases,
    activeCanvasId: canvases.length ? canvases[canvases.length - 1].id : null,
    stickBottom: true,
    usage: null,
    abortController: null,
  };
}

export async function startChatWith(
  summary: AvatarSummary,
  split = false,
): Promise<void> {
  if (
    !split &&
    readState().chatPanes.some((pane) => pane.streaming) &&
    !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
  ) {
    return;
  }
  // Resume the most recent existing conversation with this avatar instead of
  // spawning a duplicate thread (matches the old explore behavior). Only for a
  // single, non-split open.
  if (!split && readState().chatPanes.length <= 1) {
    const existing = readState().conversations.find(
      (c) => c.avatarUserId === summary.id && !c.isRoutine,
    );
    if (existing) {
      await selectConversation(existing.id);
      return;
    }
  }
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(summary.id)}`,
  );
  const pane = makePane(avatar);
  updateState((state) => {
    state.currentAvatar = avatar;
    if (
      split &&
      state.chatPanes.length &&
      state.chatPanes.length < MAX_CHAT_PANES
    )
      state.chatPanes.push(pane);
    else state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  syncHash();
  void loadConversations();
}

// Open a fresh chat with the owner's own avatar and seed the composer with text
// (not sent — the owner reviews first). Used by the inbox notification handoff,
// "ask my avatar" actions, and the routines "지금 실행" handoff. Mirrors the old
// chatAboutTopic(). `notice` is overridable because the default names a "주제",
// which is wrong for callers seeding something other than a discussion topic.
export async function openSeededChat(
  seedText: string,
  notice = "입력창에 주제를 채웠습니다. 검토 후 보내기를 누르세요.",
): Promise<void> {
  const me = readState().user;
  if (!me) return;
  if (
    readState().chatPanes.some((pane) => pane.streaming) &&
    !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
  )
    return;
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(me.id)}`,
  );
  const pane = makePane(avatar);
  pane.draft = seedText;
  updateState((state) => {
    state.currentAvatar = avatar;
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  syncHash();
  void loadConversations();
  notify(notice, "info");
}

// A routine's thread IS a real conversation, but it lives in a SEPARATE state
// array: loadRoutinesData fetches it with kind:"routine" into routineConversations,
// and /api/conversations defaults to kind:"chat", which EXCLUDES routine threads.
// So a lookup that reads only state.conversations misses every routine handoff
// (the routines view's "일반 대화로 열기") and reports a misleading "대화를 찾을 수
// 없습니다". Both arrays are consulted before refetching, and the refetch keeps the
// two lists SEPARATE instead of pulling routine threads into state.conversations —
// the chat sidebar and startChatWith both treat that array as chat-only.
async function findConversationSummary(
  conversationId: string,
): Promise<ConversationSummary | null> {
  const local = readState();
  const cached =
    local.conversations.find((item) => item.id === conversationId) ??
    local.routineConversations.find((item) => item.id === conversationId);
  if (cached) return cached;
  const chat = await loadConversations();
  return (
    chat.find((item) => item.id === conversationId) ??
    (await loadConversations("routine")).find(
      (item) => item.id === conversationId,
    ) ??
    null
  );
}

export async function selectConversation(
  conversationId: string,
): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find(
    (pane) => pane.conversationId === conversationId,
  );
  if (existingPane?.streaming) {
    updateState((s) => {
      s.activePaneId = existingPane.id;
      s.view = "chat";
    });
    syncHash();
    return;
  }
  const conv = await findConversationSummary(conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return;
  }
  const [loaded, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(conv.avatarUserId)}`,
    ),
  ]);
  const pane = makePane(
    avatarRes.avatar,
    conversationId,
    loaded.messages,
    loaded.canvases,
  );
  applyLoadedConversation(pane, loaded);
  updateState((s) => {
    s.currentAvatar = avatarRes.avatar;
    s.chatPanes = [pane];
    s.activePaneId = pane.id;
    s.view = "chat";
  });
  syncHash(true);
  await attachActiveRun(pane.id);
}

// Add an EXISTING conversation as an extra split pane (drag-from-list / "분할에
// 추가" button). If that conversation is already open in a pane, just focus it
// instead of duplicating. Reuses selectConversation's load path but PUSHES the
// pane rather than replacing the whole split.
export async function addConversationToSplit(
  conversationId: string,
): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find(
    (pane) => pane.conversationId === conversationId,
  );
  if (existingPane) {
    updateState((s) => {
      s.activePaneId = existingPane.id;
      s.currentAvatar = existingPane.avatar;
      s.view = "chat";
    });
    syncHash(true);
    return;
  }
  if (state.chatPanes.length >= MAX_CHAT_PANES) {
    notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
    return;
  }
  const conv = await findConversationSummary(conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return;
  }
  const [loaded, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(
      `/api/avatars/${encodeURIComponent(conv.avatarUserId)}`,
    ),
  ]);
  const pane = makePane(
    avatarRes.avatar,
    conversationId,
    loaded.messages,
    loaded.canvases,
  );
  applyLoadedConversation(pane, loaded);
  updateState((s) => {
    if (s.chatPanes.length >= MAX_CHAT_PANES) return;
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
    s.currentAvatar = pane.avatar;
    s.view = "chat";
  });
  syncHash(true);
  await attachActiveRun(pane.id);
}

export function newChat(paneId?: string, opts?: { force?: boolean }): void {
  const pane = paneId
    ? readState().chatPanes.find((item) => item.id === paneId)
    : readState().chatPanes.find(
        (item) => item.id === readState().activePaneId,
      );
  if (!pane || (pane.streaming && !opts?.force)) return;
  const next = makePane(pane.avatar);
  updateState((state) => {
    state.chatPanes = state.chatPanes.map((item) =>
      item.id === pane.id ? next : item,
    );
    state.activePaneId = next.id;
    state.currentAvatar = next.avatar;
  });
  syncHash();
}

/**
 * Rail "새 대화" action: start a fresh thread IMMEDIATELY (same meaning as the
 * chat-header button), instead of merely navigating to explore. Target: the
 * active pane's avatar; with no open pane, the user's own avatar. Streaming
 * panes get the same confirm as startChatWith before being replaced.
 */
export async function startNewChat(): Promise<void> {
  const state = readState();
  const pane =
    state.chatPanes.find((item) => item.id === state.activePaneId) ??
    state.chatPanes[0];
  if (pane) {
    if (
      pane.streaming &&
      !(await confirmAction("응답 생성 중입니다. 새 대화로 전환할까요?"))
    ) {
      return;
    }
    newChat(pane.id, { force: true });
    updateState((s) => {
      s.view = "chat";
    });
    syncHash();
    return;
  }
  const me = state.user;
  if (!me) return;
  const { avatar } = await api<{ avatar: AvatarDetail }>(
    `/api/avatars/${encodeURIComponent(me.id)}`,
  );
  const fresh = makePane(avatar);
  updateState((s) => {
    s.currentAvatar = avatar;
    s.chatPanes = [fresh];
    s.activePaneId = fresh.id;
    s.view = "chat";
  });
  syncHash();
  void loadConversations();
}

export async function clearChatHistory(): Promise<number> {
  const result = await api<{ deleted: number; conversationIds: string[] }>(
    "/api/conversations",
    { method: "DELETE" },
  );
  const ids = new Set(result.conversationIds || []);
  if (!ids.size) {
    return 0;
  }
  for (const pane of readState().chatPanes) {
    if (ids.has(pane.conversationId)) {
      pane.abortController?.abort();
    }
  }
  updateState((state) => {
    state.conversations = state.conversations.filter(
      (conversation) => !ids.has(conversation.id),
    );
    state.chatPanes = state.chatPanes.map((pane) =>
      ids.has(pane.conversationId) ? makePane(pane.avatar) : pane,
    );
    if (!state.chatPanes.some((pane) => pane.id === state.activePaneId)) {
      state.activePaneId = state.chatPanes[0]?.id ?? null;
    }
    const activePane = state.chatPanes.find(
      (pane) => pane.id === state.activePaneId,
    );
    state.currentAvatar = activePane?.avatar ?? state.currentAvatar;
  });
  syncHash(true);
  return result.deleted || ids.size;
}

export function regenerate(paneId: string): void {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming) return;
  const lastUserIndex = [...pane.messages]
    .map((m) => m.role)
    .lastIndexOf("user");
  if (lastUserIndex < 0) return;
  const text = pane.messages[lastUserIndex].content;
  updatePane(paneId, (target) => {
    target.messages = target.messages.slice(0, lastUserIndex + 1);
  });
  void sendMessage(paneId, text, { regenerate: true });
}

export async function sendMessage(
  paneId: string,
  rawMessage: string,
  opts: {
    regenerate?: boolean;
    /**
     * A non-blocking canvas submission/edit (#50). Delivered as a normal turn: the
     * server formats the agent-facing message and persists a short Korean bubble.
     */
    canvasSubmission?: {
      canvasId: string;
      values?: Record<string, unknown>;
      editedContent?: string;
    };
  } = {},
): Promise<void> {
  let pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.avatar) return;
  let message = rawMessage.trim();
  // A canvas submission carries no typed text — the visible bubble is a short
  // Korean summary mirroring the server's displayMessage (hand-mirrored validator).
  if (opts.canvasSubmission) {
    message = opts.canvasSubmission.editedContent
      ? "캔버스를 수정해 보냈습니다."
      : "캔버스 응답을 보냈습니다.";
  }
  // Snapshot staged images early so a text-empty, image-only turn can be sent.
  // Regenerates carry no freshly staged images.
  const pendingImages = opts.regenerate ? [] : [...(pane.pendingImages || [])];
  if (!message && pendingImages.length === 0) return;

  const slash =
    message && !opts.canvasSubmission
      ? resolveTypedSlashCommand(pane, message)
      : null;
  if (slash) {
    if (slash.command.action === "new") {
      newChat(pane.id);
      return;
    }
    if (slash.command.requiresArgs && !slash.args) {
      updatePane(pane.id, (target) => {
        target.draft = `/${slash.command.name} `;
      });
      notify(
        `/${slash.command.name} 뒤에 ${slash.command.argsLabel || "내용"}을 입력해 주세요.`,
        "warn",
      );
      return;
    }
    // Send the literal "/command [args]"; the server swaps in the expanded
    // (agent-facing) prompt so the bubble + persisted turn stay the literal.
    message = `/${slash.command.name}${slash.args ? ` ${slash.args}` : ""}`;
    if (!message && pendingImages.length === 0) return;
  }

  // Staged images ride this turn and can be restored if the send fails before
  // anything streamed.
  const userMessage: StoredMessage = {
    id: newId(),
    conversationId: pane.conversationId,
    role: "user",
    content: message,
    attachments: pendingImages.length
      ? pendingImages.map((img) => ({
          id: img.id,
          kind: "image" as const,
          mediaType: img.mediaType,
          name: img.name,
        }))
      : undefined,
    response: null,
    createdAt: new Date().toISOString(),
  };
  // A real send is a user gesture — the right moment to (idempotently) ask for OS
  // notification permission so answer-complete / input-needed alerts can fire later.
  void ensureNotificationPermission();

  const controller = new AbortController();
  updatePane(pane.id, (target) => {
    if (opts.regenerate) {
      const last = target.messages[target.messages.length - 1];
      if (last?.role === "assistant") target.messages.pop();
    }
    if (userMessage && !opts.regenerate) target.messages.push(userMessage);
    // Hold the data URLs locally so the just-sent bubble renders images before
    // they're fetchable from the server, and clear the composer's staged images.
    if (pendingImages.length) {
      target.localImages = { ...(target.localImages || {}) };
      for (const img of pendingImages) target.localImages[img.id] = img.dataUrl;
    }
    target.pendingImages = [];
    target.draft = "";
    resetLive(target);
    target.streaming = true;
    // A send is an explicit "follow the response" intent, so re-arm auto-scroll
    // even if a prior turn (or a stray scroll) had detached it — otherwise the
    // new answer streams in off-screen. onTranscriptScroll can still disengage
    // it the moment the user genuinely scrolls up.
    target.stickBottom = true;
    target.liveStatus = "응답 준비 중…";
    target.abortController = controller;
  });

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
      body: JSON.stringify({
        avatarId: pane.avatar.id,
        message,
        conversationId: pane.conversationId,
        regenerate: opts.regenerate === true,
        multiSession: readState().chatPanes.length > 1,
        // External avatars run their own tool stack behind the gateway, so the
        // local-only composer settings (effort/knowledge/MCP groups) stay off
        // that path. The MODEL is the exception: the viewer may pick a gateway
        // model id per conversation ("" = clear back to the admin default).
        ...(pane.avatar.runtime === "external"
          ? { model: pane.modelTier || "" }
          : {
              groupKnowledgeOff: pane.groupKnowledgeOff || [],
              // Model tier / reasoning effort / MCP groups: the pane is seeded from
              // remembered defaults, then persisted per native conversation.
              model: pane.modelTier || DEFAULT_MODEL_TIER,
              effort: pane.effort || DEFAULT_EFFORT_LEVEL,
              mcpToolGroups:
                pane.mcpToolGroups ?? DEFAULT_MCP_TOOL_GROUPS,
            }),
        // Staged image attachments (data URLs). The server reuses our id as the
        // stored attachment id + filename. Omit when none.
        images: pane.avatar.runtime !== "external" && pendingImages.length
          ? pendingImages.map((img) => ({ id: img.id, data: img.dataUrl }))
          : undefined,
        // Non-blocking canvas submission/edit (#50), when this turn was triggered
        // from a canvas form rather than the composer.
        canvasSubmission: opts.canvasSubmission,
      }),
    });
    if (response.status === 401) {
      throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    await consumeSse(response.body, (frame) => handleSseEvent(paneId, frame));
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      finalizePane(paneId, "중지됨", true);
    } else {
      const current = readState().chatPanes.find((item) => item.id === paneId);
      if (!current?.liveText && userMessage) {
        // Nothing arrived for a normal send — undo it cleanly and restore the
        // draft + the staged images so the user can retry without re-attaching.
        updatePane(paneId, (target) => {
          const last = target.messages[target.messages.length - 1];
          if (last?.id === userMessage.id) target.messages.pop();
          target.draft = rawMessage;
          if (pendingImages.length) {
            target.pendingImages = pendingImages;
            for (const img of pendingImages)
              delete target.localImages?.[img.id];
          }
        });
        notify(`메시지를 보내지 못했습니다: ${error.message}`);
      } else {
        finalizeError(paneId, error.message);
      }
    }
  } finally {
    dropRunPrompts(paneId);
    updatePane(paneId, (target) => {
      target.streaming = false;
      target.abortController = null;
      target.liveStatus = "";
    });
    void loadConversations();
  }
}

export async function attachActiveRun(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.conversationId) return;
  try {
    const result = await api<{ run: { runId: string } | null }>(
      `/api/chat/runs?conversationId=${encodeURIComponent(pane.conversationId)}`,
    );
    if (result.run?.runId) {
      await attachRun(paneId, result.run.runId);
      return;
    }
    if (pane.messages[pane.messages.length - 1]?.role === "user") {
      const loaded = await loadMessages(pane.conversationId);
      updatePane(paneId, (target) => {
        applyLoadedConversation(target, loaded);
      });
    }
  } catch {
    /* best effort */
  }
}

export async function attachRun(paneId: string, runId: string): Promise<void> {
  const controller = new AbortController();
  updatePane(paneId, (target) => {
    resetLive(target);
    target.streaming = true;
    target.liveRunId = runId;
    target.liveStatus = "진행 중인 응답에 다시 연결 중…";
    target.abortController = controller;
  });
  try {
    const response = await fetch(
      `/api/chat/runs/${encodeURIComponent(runId)}/events`,
      {
        headers: { Accept: "text/event-stream" },
        credentials: "same-origin",
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      const pane = readState().chatPanes.find((item) => item.id === paneId);
      if (pane) {
        const loaded = await loadMessages(pane.conversationId);
        updatePane(paneId, (target) => {
          applyLoadedConversation(target, loaded);
        });
      }
      return;
    }
    if (!response.ok || !response.body)
      throw new Error(`HTTP ${response.status}`);
    await consumeSse(response.body, (frame) => handleSseEvent(paneId, frame));
  } catch (err) {
    if ((err as Error).name !== "AbortError")
      notify("진행 중인 응답에 다시 연결하지 못했습니다.", "warn");
  } finally {
    dropRunPrompts(paneId);
    updatePane(paneId, (target) => {
      target.streaming = false;
      target.abortController = null;
      target.liveStatus = "";
    });
  }
}

export async function stopPane(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane) return;
  if (pane.liveRunId) {
    api(`/api/chat/runs/${encodeURIComponent(pane.liveRunId)}/cancel`, {
      method: "POST",
    }).catch(() => {});
  }
  pane.abortController?.abort();
  updatePane(paneId, (target) => {
    target.liveStatus = "중지 중…";
  });
}

export function closePane(paneId: string): void {
  const state = readState();
  const pane = state.chatPanes.find((item) => item.id === paneId);
  if (pane?.streaming) void stopPane(paneId);
  updateState((s) => {
    s.chatPanes = s.chatPanes.filter((item) => item.id !== paneId);
    if (!s.chatPanes.length && s.currentAvatar)
      s.chatPanes = [makePane(s.currentAvatar)];
    s.activePaneId = s.chatPanes[0]?.id || null;
  });
}

/* ---------- SSE handling ---------- */

function handleSseEvent(paneId: string, frame: SseFrame): void {
  const { event, data } = frame;
  switch (event) {
    case "delta":
      if (typeof data?.text === "string") {
        const text = data.text;
        updatePane(paneId, (pane) => {
          if (pane.liveTextBreakPending) {
            pane.liveTextBreakPending = false;
            if (
              pane.liveText &&
              !pane.liveText.endsWith("\n") &&
              !text.startsWith("\n")
            )
              pane.liveText += "\n\n";
          }
          pane.liveText += text;
          // Answer text means the reasoning phase has handed off; stop the pulse.
          pane.thinkingActive = false;
        });
      }
      return;
    case "thinking":
      // Reasoning stream — its own collapsible view, never the answer bubble.
      if (typeof data?.text === "string") {
        const text = data.text;
        updatePane(paneId, (pane) => {
          pane.liveThinking = (pane.liveThinking || "") + text;
          pane.thinkingActive = true;
        });
      }
      return;
    case "thinking_reset":
      // Empty-turn retry discarded the prior attempt: drop its reasoning so only
      // the kept turn's thinking shows. On reconnect this frame replays in order
      // between the two thinking bursts, so the end state is the kept turn's only.
      updatePane(paneId, (pane) => {
        pane.liveThinking = "";
      });
      return;
    case "open":
      updatePane(paneId, (pane) => {
        if (data?.conversationId) pane.conversationId = data.conversationId;
        if (data?.runId) pane.liveRunId = data.runId;
        pane.liveStatus = "응답 준비 중…";
      });
      syncHash(true);
      return;
    case "status":
      if (data?.label) setStatus(paneId, data.label, false);
      return;
    case "plugin":
      if (data?.name) {
        updatePane(paneId, (pane) => {
          const chip = pane.livePlugins.find((p) => p.name === data.name);
          if (chip) chip.status = data.status || chip.status;
          else
            pane.livePlugins.push({
              name: data.name,
              status: data.status || "started",
            });
        });
      }
      return;
    case "agent":
      if (data?.agentId) {
        markTextBreak(paneId);
        // Named (agent-teams) teammates lead with their addressable identity.
        const label =
          [data.name ? `@${data.name}` : "", data.subagentType, data.description]
            .filter(Boolean)
            .join(" · ") || "하위 작업";
        ensureAgent(
          paneId,
          data.agentId,
          data.parentId || "main",
          label,
          "running",
        );
        setStatus(paneId, `에이전트 작업 중: ${label}`, true);
      }
      return;
    case "agent_end":
      if (data?.agentId) {
        updatePane(paneId, (pane) => {
          const node = pane.liveAgents.find((a) => a.id === data.agentId);
          if (node) node.status = data.ok === false ? "failed" : "done";
        });
      }
      return;
    case "tool": {
      if (!data?.toolUseId || !data?.name || HIDDEN_TOOLS.has(data.name))
        return;
      markTextBreak(paneId);
      ensureAgent(paneId, data.agentId || "main");
      const label = humanTool(data.name);
      const detail =
        data.inputSummary || summarizeInput(data.input) || undefined;
      upsertTool(paneId, {
        id: data.toolUseId,
        agentId: data.agentId || "main",
        kind: "tool",
        label,
        detail,
        status: "running",
      });
      setStatus(paneId, `${label}${detail ? ` · ${detail}` : ""}`, true);
      return;
    }
    case "tool_end":
      if (data?.toolUseId) {
        updatePane(paneId, (pane) => {
          const row = pane.liveTools.find((t) => t.id === data.toolUseId);
          if (!row || row.status === "blocked") return;
          row.status = data.ok === false ? "failed" : "done";
          const detail =
            data.error ||
            data.inputSummary ||
            (data.output ? summarizeInput(data.output) : "");
          if (detail) row.detail = detail;
        });
      }
      return;
    case "task":
    case "task_update":
    case "task_end": {
      if (!data?.taskId) return;
      if (event === "task") markTextBreak(paneId);
      const label = taskLabel(data);
      const detail = taskDetail(data) || undefined;
      const status =
        event === "task_end"
          ? data.ok === false
            ? "failed"
            : "done"
          : "running";
      ensureAgent(paneId, data.agentId || "main");
      upsertTask(paneId, {
        id: data.taskId,
        agentId: data.agentId || "main",
        label,
        detail,
        status,
      });
      if (event !== "task_end")
        setStatus(
          paneId,
          [label, detail].filter(Boolean).join(" · ") || "태스크 진행 중",
          true,
        );
      else
        setStatus(
          paneId,
          data.ok === false ? "태스크가 완료되지 못했습니다." : "태스크 완료",
          true,
        );
      return;
    }
    case "blocked":
      if (data?.toolName) handleBlocked(paneId, data);
      return;
    case "memory":
      if (data?.path) handleMemory(paneId, data);
      return;
    case "permission":
      enqueuePrompt(paneId, "permission", data);
      return;
    case "question":
      enqueuePrompt(paneId, "question", data);
      return;
    case "canvas":
      if (data?.artifactId) handleCanvas(paneId, data);
      return;
    case "browser":
      if (data?.requestId && data?.op) handleBrowserOp(paneId, data);
      return;
    case "file":
      if (data?.attachment?.id) {
        markTextBreak(paneId);
        updateState((state) => {
          const pane = state.chatPanes.find((item) => item.id === paneId);
          if (!pane) return;
          if (!pane.liveAttachments.some((item) => item.id === data.attachment.id)) {
            // Anchor the card at the CURRENT text length so it stays put while
            // later text streams in below it (the persisted message carries the
            // server-stamped equivalent). The event payload never has an anchor
            // (it's stamped after the emit), so this never overwrites one.
            pane.liveAttachments.push({ ...data.attachment, anchor: pane.liveText.length });
          }
          // A live .drawio share pops the side preview panel open by itself —
          // single-pane layout only: split view has no side-panel slot, so the
          // preview would invisibly hijack the slot for later. Other formats
          // keep click-to-open via the file card.
          if (
            !data.attachment.hidden &&
            isDrawioAttachment(data.attachment) &&
            state.chatPanes.length === 1
          ) {
            pane.filePreview = { attachment: data.attachment, slides: [] };
          }
        });
        setStatus(paneId, data.attachment.kind === "file" ? "파일을 공유했습니다." : "이미지를 표시했습니다.", true);
      }
      return;
    case "plan":
      // Plan mode. EnterPlanMode emits a `planning` signal with no plan yet — show a
      // "writing plan…" placeholder so the (tool-row-suppressed) planning phase isn't
      // mistaken for a stalled turn. ExitPlanMode then delivers the real plan, shown
      // live as a plan card; the persisted `response.plan` takes over once the turn
      // finishes.
      if (typeof data?.plan === "string" && data.plan) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          pane.livePlan = data.plan;
          pane.planPending = false;
        });
        setStatus(paneId, "계획을 제출했습니다.", true);
      } else if (data?.planning) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          pane.planPending = true;
        });
        setStatus(paneId, "계획을 작성하는 중…", true);
      } else {
        // Planning ended without a submitted plan (empty ExitPlanMode): clear the
        // placeholder now so it resolves into the avatar's answer instead of
        // lingering until turn end and vanishing with no trace.
        updatePane(paneId, (pane) => {
          pane.planPending = false;
        });
      }
      return;
    case "plan_review":
      // The avatar proposed a plan (ExitPlanMode) and is awaiting the owner's
      // approval. Show the plan as a live card (in case the "plan" event was
      // missed) and surface inline approve/reject controls keyed by requestId.
      if (data?.requestId && !resolvedRequestIds.has(data.requestId)) {
        markTextBreak(paneId);
        updatePane(paneId, (pane) => {
          if (typeof data.plan === "string" && data.plan) {
            pane.livePlan = data.plan;
            pane.planPending = false;
          }
          pane.planReview = { requestId: data.requestId, runId: data.runId || "" };
          pane.planReviewSubmitting = false;
        });
        setStatus(paneId, "계획 승인을 기다리는 중…", true);
        notifyPlanReview(paneId);
      }
      return;
    case "prompt_resolved":
      if (data?.requestId) {
        resolvePrompt(data.requestId);
        // A canvas awaiting input is resolved server-side (timeout/cancel/reconnect):
        // lock its form so it can't be re-submitted to a 404.
        updatePane(paneId, (pane) => {
          const canvas = pane.canvases.find(
            (c) => c.requestId === data.requestId,
          );
          if (canvas) canvas.pending = false;
          // A plan awaiting approval was resolved (answered elsewhere / timeout /
          // reconnect): drop the inline controls so they can't 404 on re-submit.
          if (pane.planReview?.requestId === data.requestId) {
            pane.planReview = null;
            pane.planReviewSubmitting = false;
          }
        });
      }
      return;
    case "bg_tasks":
      // Live background-task set (REPLACE semantics): swap, never merge.
      updatePane(paneId, (pane) => {
        pane.backgroundTasks = Array.isArray(data?.tasks) ? data.tasks : [];
      });
      return;
    case "bg_message":
      // A background wake-up turn was persisted server-side → its own bubble.
      if (data?.message?.role === "assistant")
        appendBackgroundMessage(paneId, data.message as StoredMessage);
      return;
    case "bg_end":
      finalizeBackgroundPhase(paneId, "done");
      return;
    case "done":
      finalizeDone(paneId, data);
      return;
    case "cancelled": {
      // A stop during the background phase KILLS the pending background work:
      // seal the tree with "failed" rows (and persist that) before the normal
      // stopped-bubble handling.
      const pane = readState().chatPanes.find((p) => p.id === paneId);
      if (pane?.backgroundPhase) finalizeBackgroundPhase(paneId, "failed");
      finalizePane(paneId, "중지됨", true);
      return;
    }
    case "error": {
      const pane = readState().chatPanes.find((p) => p.id === paneId);
      if (pane?.backgroundPhase) finalizeBackgroundPhase(paneId, "failed");
      finalizeError(paneId, data?.error || "오류가 발생했습니다.");
      return;
    }
    default:
      return;
  }
}

function handleBlocked(paneId: string, data: any): void {
  // `uiReason` is the server's Korean, user-facing explanation. `reason` mirrors
  // the SDK's `decision_reason`, which is model-facing text and may still be
  // English on paths the server hasn't phrased yet — show it only when there is
  // nothing Korean, and tag it as a detail rather than pass it off as the label.
  const ui = String(data.uiReason || "").trim();
  const raw = String(data.reason || "").trim();
  const korean = ui || (/[가-힣]/.test(raw) ? raw : "");
  const reason = korean
    ? `차단됨 · ${korean}`
    : raw
      ? `차단됨 (상세: ${raw})`
      : "읽기 전용이라 차단됨";
  updatePane(paneId, (pane) => {
    const existing = data.toolUseId
      ? pane.liveTools.find((t) => t.id === data.toolUseId)
      : null;
    if (existing) {
      existing.status = "blocked";
      existing.detail = reason;
      return;
    }
    pane.liveTools.push({
      id: data.toolUseId || newId(),
      agentId: data.agentId || "main",
      kind: "blocked",
      label: humanTool(data.toolName),
      detail: reason,
      status: "blocked",
    });
  });
}

// A second-brain capture (successful repo write under wiki/): render a
// dedicated "기억" row next to the tool rows so the saved memory is visible at
// a glance. The server mints the event id, so a reattach's replay dedupes here.
function handleMemory(paneId: string, data: any): void {
  const id = String(data.id || "") || newId();
  const action = data.action === "update" ? "갱신됨" : "추가됨";
  const label = data.scope === "group" ? `그룹 기억 ${action}` : `기억 ${action}`;
  const groupName = String(data.groupName || "").trim();
  const path = String(data.path || "").trim();
  const detail = groupName ? `${groupName} · ${path}` : path;
  updatePane(paneId, (pane) => {
    if (pane.liveTools.some((t) => t.id === id)) return;
    pane.liveTools.push({
      id,
      agentId: "main",
      kind: "memory",
      label,
      detail,
      status: "done",
    });
  });
}

function taskLabel(data: any): string {
  if (data?.workflowName) return `워크플로 ${data.workflowName}`;
  if (data?.subagentType) return data.subagentType;
  if (data?.taskType) return String(data.taskType).replace(/_/g, " ");
  // No distinguishing name → leave empty; the row's "태스크" badge already labels
  // it, so a "태스크" fallback here would render redundantly next to the badge.
  return "";
}
function taskDetail(data: any): string {
  return (
    data?.summary ||
    data?.description ||
    data?.prompt ||
    data?.lastToolName ||
    data?.error ||
    data?.status ||
    ""
  );
}

/* ---------- activity-tree mutation helpers ---------- */

function ensureAgent(
  paneId: string,
  agentId: string,
  parentId = "main",
  label?: string,
  status?: "running" | "done" | "failed",
): void {
  updatePane(paneId, (pane) => {
    if (!pane.liveAgents.some((a) => a.id === "main")) {
      pane.liveAgents.push({
        id: "main",
        parentId: "",
        label: "",
        status: "running",
        isMain: true,
      });
    }
    if (agentId === "main") return;
    const existing = pane.liveAgents.find((a) => a.id === agentId);
    if (existing) {
      if (label) existing.label = label;
      if (status) existing.status = status;
      return;
    }
    pane.liveAgents.push({
      id: agentId,
      parentId: parentId || "main",
      label: label || "하위 작업",
      status: status || "running",
      isMain: false,
    });
  });
}

function upsertTool(paneId: string, row: LiveToolRow): void {
  updatePane(paneId, (pane) => {
    const existing = pane.liveTools.find((t) => t.id === row.id);
    if (existing) {
      existing.label = row.label;
      if (row.detail !== undefined) existing.detail = row.detail;
      existing.status = row.status;
      existing.kind = row.kind;
    } else {
      pane.liveTools.push(row);
    }
  });
}

function upsertTask(paneId: string, row: LiveTaskRow): void {
  updatePane(paneId, (pane) => {
    const existing = pane.liveTasks.find((t) => t.id === row.id);
    if (existing) {
      // task_update/task_end frames may omit the naming fields (subagentType/
      // workflowName/taskType), making taskLabel() "" — that must not wipe the
      // label captured at task start.
      if (row.label) existing.label = row.label;
      if (row.detail !== undefined) existing.detail = row.detail;
      existing.status = row.status;
      existing.agentId = row.agentId;
    } else {
      pane.liveTasks.push(row);
    }
  });
}

/** Mark that activity (a tool/agent/task) interrupted the text stream, so the
 *  next text delta starts a fresh paragraph instead of running onto the line
 *  before the activity. Mirrors the server's `\n\n` join between assistant chunks. */
function markTextBreak(paneId: string): void {
  updatePane(paneId, (pane) => {
    if (pane.liveText && !pane.liveText.endsWith("\n"))
      pane.liveTextBreakPending = true;
    // Tool / agent / task / plan activity interrupts reasoning: stop the pulse.
    pane.thinkingActive = false;
  });
}

function setStatus(paneId: string, label: string, sticky: boolean): void {
  updatePane(paneId, (pane) => {
    const now = Date.now();
    if (
      !sticky &&
      pane.liveStatusStickyUntil &&
      now < pane.liveStatusStickyUntil
    )
      return;
    pane.liveStatus = label;
    pane.liveStatusStickyUntil = sticky ? now + 1500 : 0;
  });
}

function resetLive(pane: ChatPane): void {
  pane.liveText = "";
  pane.liveAttachments = [];
  pane.liveTextBreakPending = false;
  pane.liveThinking = "";
  pane.thinkingActive = false;
  pane.livePlan = "";
  pane.planPending = false;
  pane.planReview = null;
  pane.planReviewSubmitting = false;
  pane.liveStatus = "";
  pane.liveAgents = [];
  pane.liveTools = [];
  pane.liveTasks = [];
  pane.livePlugins = [];
  pane.liveStatusStickyUntil = 0;
  pane.backgroundPhase = false;
  pane.backgroundTasks = [];
  pane.backgroundMessageId = null;
}

/* ---------- finalizers ---------- */

// Snapshot the live activity tree so the COMPLETED bubble keeps showing what ran
// (otherwise the tree vanishes the instant the run finishes). Normalize any still
// "running" node to the terminal status so it doesn't render a perpetual spinner:
// "done" on a natural finish, "failed" when the run was killed with background
// work still in flight (those tasks really died — "done" would be a lie).
function snapshotActivity(
  pane: ChatPane,
  terminal: "done" | "failed" = "done",
): AgentActivity | undefined {
  if (!pane.liveTools.length && !pane.liveTasks.length) return undefined;
  return {
    agents: pane.liveAgents.map((a) => ({
      ...a,
      status: a.status === "running" ? terminal : a.status,
    })),
    tools: pane.liveTools.map((t) => ({
      ...t,
      status: t.status === "running" ? terminal : t.status,
    })),
    tasks: pane.liveTasks.map((t) => ({
      ...t,
      status: t.status === "running" ? terminal : t.status,
    })),
  };
}

function attachActivity(
  response: AgentResponse | null,
  activity: AgentActivity | undefined,
): void {
  if (response && activity) response.activity = activity;
}

// Keep the plan card on the finished bubble: the server already sets
// `response.plan` on persisted responses, but a client-built response
// (stop/error, or a fallback done without `response`) wouldn't carry it — so
// graft the live plan on when the response is missing one.
function attachPlan(
  response: AgentResponse | null,
  plan: string | undefined,
): void {
  if (response && plan && !response.plan) response.plan = plan;
}

// Same as attachPlan for the reasoning view: the server sets `response.thinking`
// on persisted responses, but a client-built response (stop/error, or a fallback
// done without `response`) wouldn't carry it — graft the live thinking on then.
function attachThinking(
  response: AgentResponse | null,
  thinking: string | undefined,
): void {
  if (response && thinking && !response.thinking) response.thinking = thinking;
}

function finalizeDone(paneId: string, data: any): void {
  // done{background:true}: the SDK session keeps running background work past
  // this point — finalize the bubble but keep the live tree until bg_end.
  if (data?.background) {
    finalizeBackgroundTurn(paneId, data);
    return;
  }
  // A persisted server message id + its activity → persist the
  // snapshot so the completed tool/agent tree survives reload.
  let persistMessageId: string | null = null;
  let persistActivity: AgentActivity | undefined;
  updatePane(paneId, (pane) => {
    const activity = snapshotActivity(pane);
    const message = data?.message as StoredMessage | undefined;
    // Dedupe by id: a reattach replays the whole event log, and the loaded
    // conversation may already contain this persisted message.
    if (
      message?.role === "assistant" &&
      message.id &&
      pane.messages.some((m) => m.id === message.id)
    ) {
      clearLive(pane);
      return;
    }
    if (message?.role === "assistant") {
      attachActivity(message.response, activity);
      attachPlan(message.response, pane.livePlan);
      attachThinking(message.response, pane.liveThinking);
      pane.messages.push(message);
      pane.usage = message.response?.usage ?? pane.usage;
      if (message.id && activity) {
        persistMessageId = message.id;
        persistActivity = activity;
      }
    } else if (pane.liveText || data?.response) {
      const response = data?.response as AgentResponse | undefined;
      attachActivity(response ?? null, activity);
      attachPlan(response ?? null, pane.livePlan);
      attachThinking(response ?? null, pane.liveThinking);
      pane.messages.push({
        id: newId(),
        conversationId: pane.conversationId,
        role: "assistant",
        content: response?.text || response?.summary || pane.liveText,
        attachments: pane.liveAttachments.length ? [...pane.liveAttachments] : undefined,
        response: response || null,
        createdAt: new Date().toISOString(),
      });
      pane.usage = response?.usage ?? pane.usage;
    }
    clearLive(pane);
  });
  if (persistMessageId && persistActivity) {
    // Best effort: the in-session display already works without this; it only adds
    // reload durability.
    api(`/api/messages/${encodeURIComponent(persistMessageId)}/activity`, {
      method: "PUT",
      body: JSON.stringify({ activity: persistActivity }),
    }).catch(() => {});
  }
  notifyTurnComplete(paneId);
}

// OS notification when a turn finishes — only fires while the app is backgrounded
// (osNotify gates on document visibility), so it never interrupts active reading.
function notifyTurnComplete(paneId: string): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane) return;
  const last = pane.messages[pane.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  const text = (last.content || "").replace(/\s+/g, " ").trim();
  const body = text
    ? text.length > 140
      ? `${text.slice(0, 140)}…`
      : text
    : "응답이 완료되었습니다.";
  osNotify(
    `${pane.avatar?.alias || pane.avatar?.displayName || "아바타"} · 답변 완료`,
    body,
    `done-${paneId}`,
  );
}

/* ---------- background phase (SDK keeps running after the visible turn) ---------- */

// done{background:true}: push the finalized turn's message, keep the live
// activity tree mounted (its rows keep updating until bg_end), and flip the
// pane into its background phase — the chip renders and the send button stays
// a stop button (killing the run kills the background work).
function finalizeBackgroundTurn(paneId: string, data: any): void {
  updatePane(paneId, (pane) => {
    const message = data?.message as StoredMessage | undefined;
    if (
      message?.role === "assistant" &&
      !(message.id && pane.messages.some((m) => m.id === message.id))
    ) {
      attachPlan(message.response, pane.livePlan);
      attachThinking(message.response, pane.liveThinking);
      pane.messages.push(message);
      pane.usage = message.response?.usage ?? pane.usage;
    }
    pane.backgroundMessageId = message?.id || null;
    pane.backgroundPhase = true;
    if (Array.isArray(data?.tasks)) pane.backgroundTasks = data.tasks;
    // Clear only the text-ish live state (it moved into the pushed message);
    // agents/tools/tasks/plugins stay so the running rows remain visible.
    pane.liveText = "";
    pane.liveAttachments = [];
    pane.liveTextBreakPending = false;
    pane.liveThinking = "";
    pane.thinkingActive = false;
    pane.livePlan = "";
    pane.planPending = false;
    pane.liveStatus = "백그라운드 작업 진행 중…";
  });
  notifyTurnComplete(paneId);
}

// A background wake-up turn was persisted server-side: append it as its own
// assistant bubble. Dedupe by id — a reattach replays the whole event log.
function appendBackgroundMessage(paneId: string, message: StoredMessage): void {
  let appended = false;
  updatePane(paneId, (pane) => {
    if (message.id && pane.messages.some((m) => m.id === message.id)) return;
    pane.messages.push(message);
    pane.usage = message.response?.usage ?? pane.usage;
    // The wake-up turn's streamed tail (text/thinking/attachments) is embodied
    // in the pushed message — reset the live state for the next wake-up so the
    // same content doesn't render twice (live cards + message cards).
    pane.liveText = "";
    pane.liveTextBreakPending = false;
    pane.liveThinking = "";
    pane.thinkingActive = false;
    pane.liveAttachments = [];
    appended = true;
  });
  if (!appended) return;
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const name = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  const text = (message.content || "").replace(/\s+/g, " ").trim();
  osNotify(
    `${name} · 백그라운드 작업 보고`,
    text ? (text.length > 140 ? `${text.slice(0, 140)}…` : text) : "백그라운드 작업이 완료되었습니다.",
    `bg-${paneId}`,
  );
}

// The background phase ended — naturally (bg_end → terminal "done") or by a
// kill (cancelled/error → "failed"). Seal the live tree onto the finalized
// turn's message with that terminal status, persist the snapshot, and drop the
// live rows. A kill keeps the streamed text tail: the caller's finalizePane /
// finalizeError persists it as the terminal bubble right after this.
function finalizeBackgroundPhase(
  paneId: string,
  terminal: "done" | "failed",
): void {
  let patchId: string | null = null;
  let patchActivity: AgentActivity | undefined;
  updatePane(paneId, (pane) => {
    if (!pane.backgroundPhase) return;
    const activity = snapshotActivity(pane, terminal);
    if (activity && pane.backgroundMessageId) {
      const target = pane.messages.find(
        (m) => m.id === pane.backgroundMessageId,
      );
      if (target?.response) target.response.activity = activity;
      patchId = pane.backgroundMessageId;
      patchActivity = activity;
    }
    pane.backgroundPhase = false;
    pane.backgroundTasks = [];
    pane.backgroundMessageId = null;
    pane.liveAgents = [];
    pane.liveTools = [];
    pane.liveTasks = [];
    pane.livePlugins = [];
    if (terminal === "done") clearLive(pane);
  });
  if (patchId && patchActivity) {
    // Best effort, like finalizeDone: display already works without it — this
    // only adds reload durability for the sealed tree.
    api(`/api/messages/${encodeURIComponent(patchId)}/activity`, {
      method: "PUT",
      body: JSON.stringify({ activity: patchActivity }),
    }).catch(() => {});
  }
}

// Build a client-side terminal (stop/error) assistant message: a text
// AgentResponse carrying the snapshot activity + live plan, push it, then clear the
// live state. Callers compute their own summary/text/content.
function pushTerminalMessage(
  pane: ChatPane,
  { summary, text, content }: { summary: string; text: string; content: string },
): void {
  const response: AgentResponse = {
    kind: "text",
    runtime: "claude",
    summary,
    text,
  };
  attachActivity(response, snapshotActivity(pane));
  attachPlan(response, pane.livePlan);
  attachThinking(response, pane.liveThinking);
  pane.messages.push({
    id: newId(),
    conversationId: pane.conversationId,
    role: "assistant",
    content,
    attachments: pane.liveAttachments.length ? [...pane.liveAttachments] : undefined,
    response,
    createdAt: new Date().toISOString(),
  });
  clearLive(pane);
}

function finalizePane(paneId: string, message: string, stopped: boolean): void {
  updatePane(paneId, (pane) => {
    pushTerminalMessage(pane, {
      summary: stopped ? "중지됨" : "오류",
      text: pane.liveText,
      content: pane.liveText || (stopped ? "(중지됨)" : message),
    });
  });
}

function finalizeError(paneId: string, message: string): void {
  updatePane(paneId, (pane) => {
    pushTerminalMessage(pane, {
      summary: "오류",
      text: pane.liveText || message,
      content: pane.liveText ? `${pane.liveText}\n\n${message}` : message,
    });
  });
  notify(`메시지를 보내지 못했습니다: ${message}`);
}

function clearLive(pane: ChatPane): void {
  resetLive(pane);
  pane.streaming = false;
}

/* ---------- visual canvas (experimental, #50) ---------- */

// A canvas artifact arrived over SSE: upsert by artifact id and bring it to the
// front. `pending` (the run is parked, awaiting the user) is true ONLY for a
// BLOCKING canvas — an async canvas's controls render but don't park the run.
// Browser bridge: the run is PARKED on this operation. Hand it to the
// extension and POST whatever comes back — including failures, so the run
// resumes with a usable reason instead of waiting out its TTL. Replayed frames
// are deduped on requestId: reattaching to a run replays the whole event log,
// and re-executing a click would act on the page twice.
const handledBrowserOps = new Set<string>();

function handleBrowserOp(paneId: string, data: any): void {
  const requestId = String(data.requestId);
  if (handledBrowserOps.has(requestId)) return;
  handledBrowserOps.add(requestId);
  if (handledBrowserOps.size > 500) {
    // Bound the dedupe set; ids are consumed in order, so the oldest is safe to drop.
    handledBrowserOps.delete(handledBrowserOps.values().next().value as string);
  }

  const BROWSER_OP_LABELS: Record<string, string> = {
    navigate: "브라우저를 이동하는 중…",
    navigate_back: "이전 페이지로 돌아가는 중…",
    click: "브라우저를 클릭하는 중…",
    type: "브라우저에 입력하는 중…",
    press_key: "브라우저에 키를 입력하는 중…",
    hover: "브라우저에서 마우스를 올리는 중…",
    scroll: "브라우저를 스크롤하는 중…",
    wait_for: "페이지 변화를 기다리는 중…",
    handle_dialog: "브라우저 대화상자에 응답하는 중…",
    list_tabs: "브라우저 탭을 확인하는 중…",
    new_tab: "새 탭을 여는 중…",
    select_tab: "탭을 전환하는 중…",
    close_tab: "탭을 닫는 중…",
  };
  const label = BROWSER_OP_LABELS[String(data.op)] ?? "브라우저 화면을 읽는 중…";
  setStatus(paneId, label, false);

  void sendToExtension({
    op: data.op,
    url: data.url,
    uid: data.uid,
    text: data.text,
    submit: Boolean(data.submit),
    keystrokes: Boolean(data.keystrokes),
    key: data.key,
    modifiers: data.modifiers,
    repeat: data.repeat,
    direction: data.direction,
    pixels: data.pixels,
    accept: data.accept,
    promptText: data.promptText,
    textGone: data.textGone,
    timeoutS: data.timeoutS,
    tabId: data.tabId,
  })
    .then((reply) =>
      api("/api/chat/respond", {
        method: "POST",
        body: JSON.stringify({ runId: data.runId, requestId, value: reply }),
      }),
    )
    .catch(() => {
      // The answer POST itself failed (run ended, network). Nothing to retry —
      // the server's park TTL settles the run on its own.
    });
}

function handleCanvas(paneId: string, data: any): void {
  const controls = Array.isArray(data.controls) ? data.controls : undefined;
  const interaction =
    data.interaction === "blocking" || data.interaction === "async"
      ? data.interaction
      : undefined;
  updatePane(paneId, (pane) => {
    const prev = pane.canvases.find((c) => c.id === data.artifactId);
    const entry: PaneCanvas = {
      id: data.artifactId,
      title: data.title || "캔버스",
      content: typeof data.content === "string" ? data.content : "",
      contentType: data.contentType || "markdown",
      controls,
      interaction,
      editable: Boolean(data.editable),
      runId: data.runId || pane.liveRunId || undefined,
      requestId: data.requestId || undefined,
      // Blocking only: an async canvas shows controls but the run isn't parked.
      pending: Boolean(controls && controls.length && interaction !== "async"),
      // Refining in place bumps the version client-side too so the version-history
      // button (gated on versionCount > 1) appears WITHOUT a reload. The server is
      // authoritative on reload and may dedup an unchanged re-show, so this can
      // briefly over-count; loadMessages re-hydrates the exact numbers.
      currentVersion: prev ? (prev.currentVersion || 1) + 1 : 1,
      versionCount: prev ? (prev.versionCount || 1) + 1 : 1,
    };
    const idx = pane.canvases.findIndex((c) => c.id === entry.id);
    if (idx >= 0) pane.canvases[idx] = entry;
    else pane.canvases.push(entry);
    pane.activeCanvasId = entry.id;
  });
}

export function setActiveCanvas(paneId: string, canvasId: string): void {
  updatePane(paneId, (pane) => {
    pane.activeCanvasId = canvasId;
  });
}

// Submit the user's response to a canvas's controls. Two paths:
// - BLOCKING (the run is parked, awaiting this answer): POST /api/chat/respond to
//   unblock the parked run, exactly as before.
// - ASYNC / re-submit / post-reload (no live parked run): deliver the answer as a
//   NEW chat turn via sendMessage(canvasSubmission) — naturally double-submit safe.
export async function submitCanvas(
  paneId: string,
  canvasId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  if (!canvas) return;
  const blocking = Boolean(canvas.pending && canvas.requestId && canvas.runId);
  if (blocking) {
    updatePane(paneId, (p) => {
      const c = p.canvases.find((x) => x.id === canvasId);
      if (c) c.submitting = true;
    });
    try {
      await api("/api/chat/respond", {
        method: "POST",
        body: JSON.stringify({
          runId: canvas.runId,
          requestId: canvas.requestId,
          value: { values },
        }),
      });
      updatePane(paneId, (p) => {
        const c = p.canvases.find((x) => x.id === canvasId);
        if (c) {
          c.pending = false;
          c.submitting = false;
          c.submittedValues = values;
        }
      });
    } catch (err) {
      updatePane(paneId, (p) => {
        const c = p.canvases.find((x) => x.id === canvasId);
        if (c) c.submitting = false;
      });
      notify(
        `캔버스 응답을 전송하지 못했습니다: ${(err as Error).message}`,
        "warn",
      );
    }
    return;
  }
  // Async / re-submit: a new turn. Record the answer optimistically so the panel
  // shows "응답 완료"; sendMessage manages the streaming lifecycle.
  if (pane?.streaming) return;
  updatePane(paneId, (p) => {
    const c = p.canvases.find((x) => x.id === canvasId);
    if (c) c.submittedValues = values;
  });
  await sendMessage(paneId, "", { canvasSubmission: { canvasId, values } });
}

// Send the user's edited canvas content back to the avatar as a new turn (#50).
export async function submitCanvasEdit(
  paneId: string,
  canvasId: string,
  editedContent: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane || pane.streaming) return;
  const canvas = pane.canvases.find((c) => c.id === canvasId);
  if (!canvas || !editedContent.trim()) return;
  await sendMessage(paneId, "", {
    canvasSubmission: { canvasId, editedContent },
  });
}

// Cancel a parked BLOCKING canvas's run (so it can proceed past awaitResponse).
// No-op for a non-blocking/display-only canvas. Best-effort: swallows failures
// (the run may have already ended).
async function cancelParkedCanvas(
  canvas: PaneCanvas,
  opts: { deleteCanvas?: boolean } = {},
): Promise<void> {
  if (!(canvas.pending && canvas.requestId && canvas.runId)) return;
  await api("/api/chat/respond", {
    method: "POST",
    body: JSON.stringify({
      runId: canvas.runId,
      requestId: canvas.requestId,
      value: opts.deleteCanvas
        ? { cancelled: true, deleteCanvas: true }
        : { cancelled: true },
    }),
  }).catch(() => {});
}

// Dismiss a canvas's prompt without answering (sends a cancellation so the parked
// run can proceed). For a non-blocking/display-only canvas this just hides locally.
export async function dismissCanvas(
  paneId: string,
  canvasId: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  if (canvas) await cancelParkedCanvas(canvas);
  updatePane(paneId, (p) => {
    const c = p.canvases.find((x) => x.id === canvasId);
    if (c) c.pending = false;
  });
}

function isMissingCanvasError(err: unknown): boolean {
  return (
    (err as Error)?.message?.includes("캔버스를 찾을 수 없습니다.") ?? false
  );
}

// Close a canvas tab. A still-pending BLOCKING canvas must cancel its parked run
// FIRST (else the run hangs on awaitResponse); a persisted canvas is hard-deleted
// server-side; then it's removed locally and the active tab recomputed.
export async function closeCanvas(
  paneId: string,
  canvasId: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const canvas = pane?.canvases.find((c) => c.id === canvasId);
  if (!canvas) return;
  // Cancel a parked blocking run before removal.
  await cancelParkedCanvas(canvas, { deleteCanvas: true });
  // Hard-delete if it has been persisted. Greeting-only ephemeral canvases were
  // never stored, so a 404 here is expected and should still close locally.
  try {
    await api(`/api/chat/canvases/${encodeURIComponent(canvasId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (!isMissingCanvasError(err)) {
      notify(`캔버스를 삭제하지 못했습니다: ${(err as Error).message}`, "warn");
      return;
    }
  }
  updatePane(paneId, (p) => {
    const idx = p.canvases.findIndex((c) => c.id === canvasId);
    if (idx < 0) return;
    p.canvases.splice(idx, 1);
    if (p.activeCanvasId === canvasId) {
      const next =
        p.canvases[idx] ||
        p.canvases[idx - 1] ||
        p.canvases[p.canvases.length - 1];
      p.activeCanvasId = next ? next.id : null;
    }
  });
}

// Fetch a canvas's version history for the rollback UI.
export async function fetchCanvasVersions(
  canvasId: string,
): Promise<{ version: number; createdAt: string }[]> {
  try {
    const res = await api<{
      versions: { version: number; createdAt: string }[];
    }>(`/api/chat/canvases/${encodeURIComponent(canvasId)}/versions`);
    return res.versions || [];
  } catch {
    return [];
  }
}

// Roll back a canvas to an earlier version (non-destructive) and update the panel.
export async function rollbackCanvas(
  paneId: string,
  canvasId: string,
  version: number,
): Promise<void> {
  try {
    const res = await api<{ canvas: PaneCanvas }>(
      `/api/chat/canvases/${encodeURIComponent(canvasId)}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    );
    updatePane(paneId, (p) => {
      const idx = p.canvases.findIndex((c) => c.id === canvasId);
      if (idx >= 0) p.canvases[idx] = { ...p.canvases[idx], ...res.canvas };
    });
  } catch (err) {
    notify(`캔버스를 되돌리지 못했습니다: ${(err as Error).message}`, "warn");
  }
}

/* ---------- interactive prompts (permission / question) ---------- */

// requestIds already resolved server-side (replay/prompt_resolved) — skip showing.
const resolvedRequestIds = new Set<string>();

function enqueuePrompt(
  paneId: string,
  kind: "permission" | "question",
  data: any,
): void {
  const requestId = data?.requestId;
  if (!requestId || resolvedRequestIds.has(requestId)) return;
  if (readState().promptQueue.some((p) => p.id === requestId)) return;
  updateState((state) => {
    if (state.promptQueue.some((p) => p.id === requestId)) return;
    state.promptQueue.push({
      id: requestId,
      runId: data.runId || "",
      paneId,
      kind,
      data,
    });
  });
  notifyPrompt(paneId, kind, data);
}

// OS notification when the avatar needs the owner's input (an AskUserQuestion-style
// question or a permission request). Like answer-complete, this only fires while the
// app is backgrounded; in the foreground the prompt modal itself is visible.
function notifyPrompt(
  paneId: string,
  kind: "permission" | "question",
  data: any,
): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const who = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  if (kind === "question") {
    const questions = Array.isArray(data?.payload?.questions)
      ? data.payload.questions
      : null;
    const first =
      questions?.[0]?.question ||
      questions?.[0]?.header ||
      "확인이 필요한 질문이 있습니다.";
    osNotify(`${who} · 질문`, String(first), `prompt-${data.requestId}`);
  } else {
    const tool = humanTool(data?.toolName);
    osNotify(
      `${who} · 확인 필요`,
      `"${tool}" 실행을 승인해 주세요.`,
      `prompt-${data.requestId}`,
    );
  }
}

// OS notification when the avatar's proposed plan is waiting on the owner's
// approval. Like the prompt notifications, only meaningful while backgrounded.
function notifyPlanReview(paneId: string): void {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const who = pane?.avatar?.alias || pane?.avatar?.displayName || "아바타";
  osNotify(
    `${who} · 계획 승인 필요`,
    "제안한 계획을 검토해 주세요.",
    `plan-${paneId}`,
  );
}

function resolvePrompt(requestId: string): void {
  resolvedRequestIds.add(requestId);
  updateState((state) => {
    state.promptQueue = state.promptQueue.filter((p) => p.id !== requestId);
  });
}

function dropRunPrompts(paneId: string): void {
  updateState((state) => {
    state.promptQueue = state.promptQueue.filter((p) => p.paneId !== paneId);
  });
}

// Submit the owner's response to a prompt. Removes it from the queue on success;
// on failure, surfaces a toast (the run may have already ended).
export async function answerPrompt(
  requestId: string,
  value: unknown,
): Promise<void> {
  const request = readState().promptQueue.find((p) => p.id === requestId);
  if (!request) return;
  try {
    await api("/api/chat/respond", {
      method: "POST",
      body: JSON.stringify({
        runId: request.runId,
        requestId: request.id,
        value,
      }),
    });
    resolvedRequestIds.add(requestId);
    updateState((state) => {
      state.promptQueue = state.promptQueue.filter((p) => p.id !== requestId);
    });
  } catch (err) {
    notify(`응답을 전송하지 못했습니다: ${(err as Error).message}`, "warn");
    throw err;
  }
}

// Submit the owner's plan-approval decision for the pane's pending ExitPlanMode
// review. Unlike answerPrompt, a plan review lives on the pane (inline on the
// plan card), not in the prompt queue. Approve → the avatar implements; reject
// → the optional feedback is fed back to the model so it revises the plan.
export async function respondPlanReview(
  paneId: string,
  behavior: "approved" | "rejected",
  feedback?: string,
): Promise<void> {
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  const review = pane?.planReview;
  if (!review || pane?.planReviewSubmitting) return;
  updatePane(paneId, (pane) => {
    pane.planReviewSubmitting = true;
  });
  try {
    await api("/api/chat/respond", {
      method: "POST",
      body: JSON.stringify({
        runId: review.runId,
        requestId: review.requestId,
        value:
          behavior === "approved"
            ? { behavior: "approved" }
            : { behavior: "rejected", feedback: feedback?.trim() || undefined },
      }),
    });
    resolvedRequestIds.add(review.requestId);
    updatePane(paneId, (pane) => {
      pane.planReview = null;
      pane.planReviewSubmitting = false;
    });
    setStatus(
      paneId,
      behavior === "approved"
        ? "계획을 승인했습니다."
        : "계획 수정을 요청했습니다.",
      true,
    );
  } catch (err) {
    updatePane(paneId, (pane) => {
      pane.planReviewSubmitting = false;
    });
    notify(`응답을 전송하지 못했습니다: ${(err as Error).message}`, "warn");
    throw err;
  }
}

/* ---------- helpers ---------- */

/** Rebuild the pane's canvas list from persisted assistant-message responses. */
// Rebuild the panel from the server's canvas artifacts (current version of each),
// the authoritative source on reload (the dedicated canvas tables). On reload there
// is no live run, so pending/runId/requestId stay unset and the form re-enables for
// async/editable canvases (which submit as a new turn, not via a parked run).
function paneCanvasesFromArtifacts(
  canvases: CanvasArtifact[] | undefined,
): PaneCanvas[] {
  const out: PaneCanvas[] = [];
  for (const canvas of canvases || []) {
    const existing = out.findIndex((c) => c.id === canvas.id);
    const entry: PaneCanvas = { ...canvas, pending: false };
    if (existing >= 0) out[existing] = entry;
    else out.push(entry);
  }
  return out;
}

function lastUsage(messages: StoredMessage[]): ChatPane["usage"] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.response?.usage;
    if (usage && (Number(usage.inputTokens) || Number(usage.outputTokens)))
      return usage;
  }
  return null;
}

function updatePane(paneId: string, mutator: (pane: ChatPane) => void): void {
  updateState((state) => {
    const pane = state.chatPanes.find((item) => item.id === paneId);
    if (pane) mutator(pane);
  });
}

// Apply a loadMessages() result onto a pane/draft target: messages, the
// per-conversation picker selections (falling back to defaults), canvases, and the
// usage snapshot. Shared by the four load sites (select / split / attachActiveRun /
// attachRun-404) so they stay in lockstep.
function applyLoadedConversation(
  target: ChatPane,
  loaded: Awaited<ReturnType<typeof loadMessages>>,
): void {
  target.messages = loaded.messages;
  target.groupKnowledgeOff = loaded.groupKnowledgeOff || [];
  target.modelTier = loaded.selectedModel || undefined;
  target.effort = loaded.selectedEffort || undefined;
  target.mcpToolGroups = loaded.selectedMcpToolGroups ?? [
    ...DEFAULT_MCP_TOOL_GROUPS,
  ];
  target.canvases = paneCanvasesFromArtifacts(loaded.canvases);
  target.usage = lastUsage(loaded.messages);
}
