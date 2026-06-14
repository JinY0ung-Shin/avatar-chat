import { tick } from "svelte";
import { api } from "./api";
import { loadConversations, loadMessages } from "./loaders";
import { syncHash } from "./nav";
import { consumeSse, type SseFrame } from "./sse";
import { newId, notify, readState, updateState } from "./state";
import { resolveTypedSlashCommand, slashPrompt } from "./slash";
import type { AgentResponse, AvatarDetail, AvatarSummary, ChatPane, LiveToolRow, StoredMessage } from "./types";

const MAX_CHAT_PANES = 4;

// Internal orchestration tools the viewer shouldn't see as activity rows.
const HIDDEN_TOOLS = new Set(["ToolSearch", "TodoWrite", "SlashCommand"]);

// Friendly, human-readable labels for tools shown in the activity tree. Raw
// names (e.g. `mcp__knowledge__request_info`) are an implementation detail.
const TOOL_LABELS: Record<string, string> = {
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

export const PLUGIN_STATUS_LABELS: Record<string, string> = {
  started: "불러오는 중",
  installed: "설치됨",
  completed: "사용 준비됨",
  failed: "불러오기 실패",
};

export function humanTool(name: string | undefined): string {
  if (!name) return "도구";
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  return (mcp ? mcp[1] : name).replace(/_/g, " ");
}

// Intelligent one-line summary of a tool's input: prefer a recognizable key
// (command/file_path/path/pattern/url/query/…) over dumping JSON. Mirrors the
// old summarizeInputForCard().
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input);
  if (typeof input !== "object") return truncate(String(input));
  const obj = input as Record<string, unknown>;
  const keys = ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description", "repo", "name"];
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key]) return truncate(obj[key] as string);
  }
  const firstStr = Object.values(obj).find((v) => typeof v === "string" && v);
  return typeof firstStr === "string" ? truncate(firstStr) : truncate(JSON.stringify(obj));
}

function truncate(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function makePane(avatar: AvatarDetail, conversationId = newId(), messages: StoredMessage[] = []): ChatPane {
  return {
    id: newId(),
    avatar,
    conversationId,
    messages,
    draft: "",
    streaming: false,
    liveText: "",
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    groupKnowledgeOff: avatar.isOwn ? [...(readState().user?.groupKnowledgeOffDefault || [])] : [],
    greetedConversationId: null,
    stickBottom: true,
    usage: null,
    abortController: null,
  };
}

export async function startChatWith(summary: AvatarSummary, split = false): Promise<void> {
  if (readState().chatPanes.some((pane) => pane.streaming) && !window.confirm("응답 생성 중입니다. 새 대화로 전환할까요?")) {
    return;
  }
  // Resume the most recent existing conversation with this avatar instead of
  // spawning a duplicate thread (matches the old explore behavior). Only for a
  // single, non-split open.
  if (!split && readState().chatPanes.length <= 1) {
    const existing = readState().conversations.find((c) => c.avatarUserId === summary.id && !c.isRoutine);
    if (existing) {
      await selectConversation(existing.id);
      return;
    }
  }
  const { avatar } = await api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(summary.id)}`);
  const pane = makePane(avatar);
  updateState((state) => {
    state.currentAvatar = avatar;
    if (split && state.chatPanes.length && state.chatPanes.length < MAX_CHAT_PANES) state.chatPanes.push(pane);
    else state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  syncHash();
  void loadConversations();
  await tick();
  await maybeGreet(pane.id);
}

// Open a fresh chat with the owner's own avatar and seed the composer with text
// (not sent — the owner reviews first). Used by the inbox notification handoff
// and "ask my avatar" actions. Mirrors the old chatAboutTopic().
export async function openSeededChat(seedText: string): Promise<void> {
  const me = readState().user;
  if (!me) return;
  if (readState().chatPanes.some((pane) => pane.streaming) && !window.confirm("응답 생성 중입니다. 새 대화로 전환할까요?")) return;
  const { avatar } = await api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(me.id)}`);
  const pane = makePane(avatar);
  pane.greetingStarted = true; // we already have a topic — skip the auto-greeting
  pane.draft = seedText;
  updateState((state) => {
    state.currentAvatar = avatar;
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    state.view = "chat";
  });
  syncHash();
  void loadConversations();
  notify("입력창에 주제를 채웠습니다. 검토 후 보내기를 누르세요.", "info");
}

export async function selectConversation(conversationId: string): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find((pane) => pane.conversationId === conversationId);
  if (existingPane?.streaming) {
    updateState((s) => {
      s.activePaneId = existingPane.id;
      s.view = "chat";
    });
    syncHash();
    return;
  }
  const conv = state.conversations.find((item) => item.id === conversationId) ?? (await loadConversations()).find((item) => item.id === conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return;
  }
  const [{ messages, groupKnowledgeOff }, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(conv.avatarUserId)}`),
  ]);
  const pane = makePane(avatarRes.avatar, conversationId, messages);
  pane.groupKnowledgeOff = groupKnowledgeOff || [];
  pane.usage = lastUsage(messages);
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
export async function addConversationToSplit(conversationId: string): Promise<void> {
  const state = readState();
  const existingPane = state.chatPanes.find((pane) => pane.conversationId === conversationId);
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
  const conv = state.conversations.find((item) => item.id === conversationId) ?? (await loadConversations()).find((item) => item.id === conversationId);
  if (!conv) {
    notify("대화를 찾을 수 없습니다.", "warn");
    return;
  }
  const [{ messages, groupKnowledgeOff }, avatarRes] = await Promise.all([
    loadMessages(conversationId),
    api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(conv.avatarUserId)}`),
  ]);
  const pane = makePane(avatarRes.avatar, conversationId, messages);
  pane.groupKnowledgeOff = groupKnowledgeOff || [];
  pane.greetedConversationId = conversationId; // an existing thread — never auto-greet
  pane.usage = lastUsage(messages);
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

export function newChat(paneId?: string): void {
  const pane = paneId ? readState().chatPanes.find((item) => item.id === paneId) : readState().chatPanes.find((item) => item.id === readState().activePaneId);
  if (!pane || pane.streaming) return;
  const next = makePane(pane.avatar);
  updateState((state) => {
    state.chatPanes = state.chatPanes.map((item) => (item.id === pane.id ? next : item));
    state.activePaneId = next.id;
    state.currentAvatar = next.avatar;
  });
  syncHash();
  void maybeGreet(next.id);
}

export function regenerate(paneId: string): void {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming) return;
  const lastUserIndex = [...pane.messages].map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex < 0) return;
  const text = pane.messages[lastUserIndex].content;
  updatePane(paneId, (target) => {
    target.messages = target.messages.slice(0, lastUserIndex + 1);
  });
  void sendMessage(paneId, text, { regenerate: true });
}

export async function sendMessage(paneId: string, rawMessage: string, opts: { regenerate?: boolean; greeting?: boolean } = {}): Promise<void> {
  let pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.avatar) return;
  let message = rawMessage.trim();
  if (!message && !opts.greeting) return;

  const slash = resolveTypedSlashCommand(pane, message);
  if (slash && !opts.greeting) {
    if (slash.command.action === "new") {
      newChat(pane.id);
      return;
    }
    if (slash.command.requiresArgs && !slash.args) {
      updatePane(pane.id, (target) => {
        target.draft = `/${slash.command.name} `;
      });
      notify(`/${slash.command.name} 뒤에 ${slash.command.argsLabel || "내용"}을 입력해 주세요.`, "warn");
      return;
    }
    message = slash.command.serverExpand ? `/${slash.command.name}${slash.args ? ` ${slash.args}` : ""}` : slashPrompt(slash.command, slash.args).trim();
    if (!message) return;
  }

  const userMessage: StoredMessage | null = opts.greeting
    ? null
    : {
        id: newId(),
        conversationId: pane.conversationId,
        role: "user",
        content: message,
        response: null,
        createdAt: new Date().toISOString(),
      };
  const controller = new AbortController();
  updatePane(pane.id, (target) => {
    if (opts.regenerate) {
      const last = target.messages[target.messages.length - 1];
      if (last?.role === "assistant") target.messages.pop();
    }
    if (userMessage && !opts.regenerate) target.messages.push(userMessage);
    target.draft = "";
    resetLive(target);
    target.streaming = true;
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
        greeting: opts.greeting === true,
        multiSession: readState().chatPanes.length > 1,
        groupKnowledgeOff: pane.groupKnowledgeOff || [],
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
        // Nothing arrived for a normal send — undo it cleanly and restore the draft.
        updatePane(paneId, (target) => {
          const last = target.messages[target.messages.length - 1];
          if (last?.id === userMessage.id) target.messages.pop();
          target.draft = rawMessage;
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

export async function maybeGreet(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  const state = readState();
  if (!pane || pane.streaming || pane.greetingStarted || state.chatPanes.length > 1) return;
  if (!state.user || pane.avatar.id !== state.user.id || pane.messages.length) return;
  if (pane.greetedConversationId === pane.conversationId) return;
  updatePane(paneId, (target) => {
    target.greetingStarted = true;
    target.greetedConversationId = target.conversationId;
  });
  await sendMessage(paneId, "", { greeting: true });
  updatePane(paneId, (target) => {
    target.greetingStarted = false;
  });
}

export async function attachActiveRun(paneId: string): Promise<void> {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.streaming || !pane.conversationId) return;
  try {
    const result = await api<{ run: { runId: string } | null }>(`/api/chat/runs?conversationId=${encodeURIComponent(pane.conversationId)}`);
    if (result.run?.runId) {
      await attachRun(paneId, result.run.runId);
      return;
    }
    if (pane.messages[pane.messages.length - 1]?.role === "user") {
      const { messages, groupKnowledgeOff } = await loadMessages(pane.conversationId);
      updatePane(paneId, (target) => {
        target.messages = messages;
        target.groupKnowledgeOff = groupKnowledgeOff || [];
        target.usage = lastUsage(messages);
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
    const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (response.status === 404) {
      const pane = readState().chatPanes.find((item) => item.id === paneId);
      if (pane) {
        const { messages, groupKnowledgeOff } = await loadMessages(pane.conversationId);
        updatePane(paneId, (target) => {
          target.messages = messages;
          target.groupKnowledgeOff = groupKnowledgeOff || [];
          target.usage = lastUsage(messages);
        });
      }
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await consumeSse(response.body, (frame) => handleSseEvent(paneId, frame));
  } catch (err) {
    if ((err as Error).name !== "AbortError") notify("진행 중인 응답에 다시 연결하지 못했습니다.", "warn");
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
    api(`/api/chat/runs/${encodeURIComponent(pane.liveRunId)}/cancel`, { method: "POST" }).catch(() => {});
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
    if (!s.chatPanes.length && s.currentAvatar) s.chatPanes = [makePane(s.currentAvatar)];
    s.activePaneId = s.chatPanes[0]?.id || null;
  });
}

/* ---------- SSE handling ---------- */

function handleSseEvent(paneId: string, frame: SseFrame): void {
  const { event, data } = frame;
  switch (event) {
    case "delta":
      if (typeof data?.text === "string") updatePane(paneId, (pane) => (pane.liveText += data.text));
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
          else pane.livePlugins.push({ name: data.name, status: data.status || "started" });
        });
      }
      return;
    case "agent":
      if (data?.agentId) {
        const label = [data.subagentType, data.description].filter(Boolean).join(" · ") || "하위 작업";
        ensureAgent(paneId, data.agentId, data.parentId || "main", label, "running");
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
      if (!data?.toolUseId || !data?.name || HIDDEN_TOOLS.has(data.name)) return;
      ensureAgent(paneId, data.agentId || "main");
      const label = humanTool(data.name);
      const detail = data.inputSummary || summarizeInput(data.input) || undefined;
      upsertTool(paneId, { id: data.toolUseId, agentId: data.agentId || "main", kind: "tool", label, detail, status: "running" });
      setStatus(paneId, `${label}${detail ? ` · ${detail}` : ""}`, true);
      return;
    }
    case "tool_end":
      if (data?.toolUseId) {
        updatePane(paneId, (pane) => {
          const row = pane.liveTools.find((t) => t.id === data.toolUseId);
          if (!row || row.status === "blocked") return;
          row.status = data.ok === false ? "failed" : "done";
          const detail = data.error || data.inputSummary || (data.output ? summarizeInput(data.output) : "");
          if (detail) row.detail = detail;
        });
      }
      return;
    case "task":
    case "task_update":
    case "task_end": {
      if (!data?.taskId) return;
      const label = taskLabel(data);
      const detail = taskDetail(data) || undefined;
      const status = event === "task_end" ? (data.ok === false ? "failed" : "done") : "running";
      upsertTool(paneId, { id: data.taskId, agentId: "main", kind: "task", label, detail, status });
      if (event !== "task_end") setStatus(paneId, `${label}${detail ? ` · ${detail}` : ""}`, true);
      else setStatus(paneId, data.ok === false ? "태스크가 완료되지 못했습니다." : "태스크 완료", true);
      return;
    }
    case "blocked":
      if (data?.toolName) handleBlocked(paneId, data);
      return;
    case "permission":
      enqueuePrompt(paneId, "permission", data);
      return;
    case "question":
      enqueuePrompt(paneId, "question", data);
      return;
    case "prompt_resolved":
      if (data?.requestId) resolvePrompt(data.requestId);
      return;
    case "done":
      finalizeDone(paneId, data);
      return;
    case "cancelled":
      finalizePane(paneId, "중지됨", true);
      return;
    case "error":
      finalizeError(paneId, data?.error || "오류가 발생했습니다.");
      return;
    default:
      return;
  }
}

function handleBlocked(paneId: string, data: any): void {
  const reason = data.reason ? `차단됨 · ${data.reason}` : "읽기 전용이라 차단됨";
  updatePane(paneId, (pane) => {
    const existing = data.toolUseId ? pane.liveTools.find((t) => t.id === data.toolUseId) : null;
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

function taskLabel(data: any): string {
  if (data?.workflowName) return `워크플로 ${data.workflowName}`;
  if (data?.subagentType) return data.subagentType;
  if (data?.taskType) return String(data.taskType).replace(/_/g, " ");
  return "태스크";
}
function taskDetail(data: any): string {
  return data?.summary || data?.description || data?.prompt || data?.lastToolName || data?.error || data?.status || "";
}

/* ---------- activity-tree mutation helpers ---------- */

function ensureAgent(paneId: string, agentId: string, parentId = "main", label?: string, status?: "running" | "done" | "failed"): void {
  updatePane(paneId, (pane) => {
    if (!pane.liveAgents.some((a) => a.id === "main")) {
      pane.liveAgents.push({ id: "main", parentId: "", label: "", status: "running", isMain: true });
    }
    if (agentId === "main") return;
    const existing = pane.liveAgents.find((a) => a.id === agentId);
    if (existing) {
      if (label) existing.label = label;
      if (status) existing.status = status;
      return;
    }
    pane.liveAgents.push({ id: agentId, parentId: parentId || "main", label: label || "하위 작업", status: status || "running", isMain: false });
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

function setStatus(paneId: string, label: string, sticky: boolean): void {
  updatePane(paneId, (pane) => {
    const now = Date.now();
    if (!sticky && pane.liveStatusStickyUntil && now < pane.liveStatusStickyUntil) return;
    pane.liveStatus = label;
    pane.liveStatusStickyUntil = sticky ? now + 1500 : 0;
  });
}

function resetLive(pane: ChatPane): void {
  pane.liveText = "";
  pane.liveStatus = "";
  pane.liveAgents = [];
  pane.liveTools = [];
  pane.livePlugins = [];
  pane.liveStatusStickyUntil = 0;
}

/* ---------- finalizers ---------- */

function finalizeDone(paneId: string, data: any): void {
  updatePane(paneId, (pane) => {
    const message = data?.message as StoredMessage | undefined;
    if (message?.role === "assistant") {
      pane.messages.push(message);
      pane.usage = message.response?.usage ?? pane.usage;
    } else if (pane.liveText || data?.response) {
      const response = data?.response as AgentResponse | undefined;
      pane.messages.push({
        id: newId(),
        conversationId: pane.conversationId,
        role: "assistant",
        content: response?.text || response?.summary || pane.liveText,
        response: response || null,
        createdAt: new Date().toISOString(),
      });
      pane.usage = response?.usage ?? pane.usage;
    }
    clearLive(pane);
  });
}

function finalizePane(paneId: string, message: string, stopped: boolean): void {
  updatePane(paneId, (pane) => {
    const content = pane.liveText || (stopped ? "(중지됨)" : message);
    pane.messages.push({
      id: newId(),
      conversationId: pane.conversationId,
      role: "assistant",
      content,
      response: { kind: "text", runtime: "claude", summary: stopped ? "중지됨" : "오류", text: pane.liveText },
      createdAt: new Date().toISOString(),
    });
    clearLive(pane);
  });
}

function finalizeError(paneId: string, message: string): void {
  updatePane(paneId, (pane) => {
    pane.messages.push({
      id: newId(),
      conversationId: pane.conversationId,
      role: "assistant",
      content: pane.liveText ? `${pane.liveText}\n\n${message}` : message,
      response: { kind: "text", runtime: "claude", summary: "오류", text: pane.liveText || message },
      createdAt: new Date().toISOString(),
    });
    clearLive(pane);
  });
  notify(`메시지를 보내지 못했습니다: ${message}`);
}

function clearLive(pane: ChatPane): void {
  pane.liveText = "";
  pane.liveStatus = "";
  pane.liveAgents = [];
  pane.liveTools = [];
  pane.livePlugins = [];
  pane.streaming = false;
}

/* ---------- interactive prompts (permission / question) ---------- */

// requestIds already resolved server-side (replay/prompt_resolved) — skip showing.
const resolvedRequestIds = new Set<string>();

function enqueuePrompt(paneId: string, kind: "permission" | "question", data: any): void {
  const requestId = data?.requestId;
  if (!requestId || resolvedRequestIds.has(requestId)) return;
  updateState((state) => {
    if (state.promptQueue.some((p) => p.id === requestId)) return;
    state.promptQueue.push({ id: requestId, runId: data.runId || "", paneId, kind, data });
  });
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
export async function answerPrompt(requestId: string, value: unknown): Promise<void> {
  const request = readState().promptQueue.find((p) => p.id === requestId);
  if (!request) return;
  try {
    await api("/api/chat/respond", {
      method: "POST",
      body: JSON.stringify({ runId: request.runId, requestId: request.id, value }),
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

/* ---------- helpers ---------- */

function lastUsage(messages: StoredMessage[]): ChatPane["usage"] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.response?.usage;
    if (usage && (Number(usage.inputTokens) || Number(usage.outputTokens))) return usage;
  }
  return null;
}

function updatePane(paneId: string, mutator: (pane: ChatPane) => void): void {
  updateState((state) => {
    const pane = state.chatPanes.find((item) => item.id === paneId);
    if (pane) mutator(pane);
  });
}
