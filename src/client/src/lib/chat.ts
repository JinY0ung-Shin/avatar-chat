import { tick } from "svelte";
import { get } from "svelte/store";
import { api } from "./api";
import { loadConversations, loadMessages } from "./loaders";
import { syncHash } from "./nav";
import { consumeSse, type SseFrame } from "./sse";
import { appState, newId, notify, readState, updateState } from "./state";
import { resolveTypedSlashCommand, slashPrompt } from "./slash";
import type { AgentResponse, AvatarDetail, AvatarSummary, ChatPane, LiveActivity, StoredMessage } from "./types";

const MAX_CHAT_PANES = 4;

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
    liveEvents: [],
    groupKnowledgeOff: avatar.isOwn ? [...(readState().user?.groupKnowledgeOffDefault || [])] : [],
    abortController: null,
  };
}

export async function startChatWith(summary: AvatarSummary, split = false): Promise<void> {
  if (readState().chatPanes.some((pane) => pane.streaming) && !window.confirm("응답 생성 중입니다. 새 대화로 전환할까요?")) {
    return;
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
  updateState((s) => {
    s.currentAvatar = avatarRes.avatar;
    s.chatPanes = [pane];
    s.activePaneId = pane.id;
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
    target.streaming = true;
    target.liveText = "";
    target.liveStatus = "응답 준비 중…";
    target.liveRunId = null;
    target.liveEvents = [];
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
      updatePane(paneId, (target) => {
        if (!target.liveText && userMessage) {
          const last = target.messages[target.messages.length - 1];
          if (last?.id === userMessage.id) target.messages.pop();
          target.draft = rawMessage;
        } else {
          target.messages.push({
            id: newId(),
            conversationId: target.conversationId,
            role: "assistant",
            content: target.liveText ? `${target.liveText}\n\n${error.message}` : error.message,
            response: null,
            createdAt: new Date().toISOString(),
          });
        }
      });
      notify(`메시지를 보내지 못했습니다: ${error.message}`);
    }
  } finally {
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
  updatePane(paneId, (target) => {
    target.greetingStarted = true;
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
      });
    }
  } catch {
    /* best effort */
  }
}

export async function attachRun(paneId: string, runId: string): Promise<void> {
  const controller = new AbortController();
  updatePane(paneId, (target) => {
    target.streaming = true;
    target.liveText = "";
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
        });
      }
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await consumeSse(response.body, (frame) => handleSseEvent(paneId, frame));
  } catch (err) {
    if ((err as Error).name !== "AbortError") notify("진행 중인 응답에 다시 연결하지 못했습니다.", "warn");
  } finally {
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

function handleSseEvent(paneId: string, frame: SseFrame): void {
  const { event, data } = frame;
  if (event === "delta" && typeof data?.text === "string") {
    updatePane(paneId, (pane) => {
      pane.liveText += data.text;
    });
    return;
  }
  if (event === "open") {
    updatePane(paneId, (pane) => {
      if (data?.conversationId) pane.conversationId = data.conversationId;
      if (data?.runId) pane.liveRunId = data.runId;
      pane.liveStatus = "응답 준비 중…";
    });
    syncHash(true);
    return;
  }
  if (event === "status" && data?.label) {
    addActivity(paneId, { kind: "status", label: data.label });
    updatePane(paneId, (pane) => {
      pane.liveStatus = data.label;
    });
    return;
  }
  if (event === "done") {
    finalizeDone(paneId, data);
    return;
  }
  if (event === "cancelled") {
    finalizePane(paneId, "중지됨", true);
    return;
  }
  if (event === "error") {
    finalizePane(paneId, data?.error || "오류가 발생했습니다.", false);
    return;
  }
  if (event === "permission") {
    addActivity(paneId, {
      kind: "permission",
      label: "권한 확인",
      detail: data?.toolName || data?.description || "도구 실행 요청",
      runId: data?.runId,
      requestId: data?.requestId,
      payload: data,
    });
    void answerPermission(data);
    return;
  }
  if (event === "question") {
    addActivity(paneId, {
      kind: "question",
      label: "추가 질문",
      detail: questionLabel(data),
      runId: data?.runId,
      requestId: data?.requestId,
      payload: data,
    });
    void answerQuestion(data);
    return;
  }
  if (event === "prompt_resolved") {
    addActivity(paneId, { kind: "status", label: "요청 응답 처리됨", status: "done" });
    return;
  }
  const label = activityLabel(event, data);
  if (label) addActivity(paneId, label);
}

function finalizeDone(paneId: string, data: any): void {
  updatePane(paneId, (pane) => {
    const message = data?.message as StoredMessage | undefined;
    if (message?.role === "assistant") {
      pane.messages.push(message);
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
    }
    pane.liveText = "";
    pane.liveStatus = "";
    pane.streaming = false;
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
      response: null,
      createdAt: new Date().toISOString(),
    });
    pane.liveText = "";
    pane.liveStatus = "";
    pane.streaming = false;
  });
}

function addActivity(paneId: string, activity: Omit<LiveActivity, "id">): void {
  updatePane(paneId, (pane) => {
    pane.liveEvents = [...pane.liveEvents.slice(-40), { id: newId(), ...activity }];
  });
}

function activityLabel(event: string, data: any): Omit<LiveActivity, "id"> | null {
  switch (event) {
    case "plugin":
      return { kind: "plugin", label: data?.name || "플러그인", status: data?.status };
    case "agent":
      return { kind: "agent", label: [data?.subagentType, data?.description].filter(Boolean).join(" · ") || "하위 작업", status: "running" };
    case "agent_end":
      return { kind: "agent", label: "하위 작업 완료", status: data?.ok === false ? "failed" : "done" };
    case "tool":
      return { kind: "tool", label: humanTool(data?.name), detail: data?.input ? summarizeValue(data.input) : undefined, status: "running" };
    case "tool_end":
      return { kind: "tool", label: humanTool(data?.name), detail: data?.error || summarizeValue(data?.output), status: data?.ok === false ? "failed" : "done" };
    case "task":
      return { kind: "task", label: data?.title || data?.description || "작업 시작", status: "running" };
    case "task_update":
      return { kind: "task", label: data?.title || data?.status || "작업 업데이트", detail: data?.description, status: data?.status };
    case "task_end":
      return { kind: "task", label: data?.title || "작업 완료", status: data?.ok === false ? "failed" : "done" };
    case "blocked":
      return { kind: "blocked", label: "진행 차단", detail: data?.reason || data?.message, status: "blocked" };
    default:
      return null;
  }
}

function humanTool(name: string | undefined): string {
  if (!name) return "도구";
  const map: Record<string, string> = {
    Read: "파일 읽기",
    Glob: "파일 찾기",
    Grep: "내용 검색",
    Bash: "명령 실행",
    Write: "파일 쓰기",
    Edit: "파일 편집",
    WebFetch: "웹 페이지 읽기",
    WebSearch: "웹 검색",
  };
  if (map[name]) return map[name];
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  return (mcp ? mcp[1] : name).replace(/_/g, " ");
}

function summarizeValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function questionLabel(data: any): string {
  const payload = data?.payload;
  if (payload?.questions?.[0]?.question) return payload.questions[0].question;
  if (payload?.message) return payload.message;
  return "응답이 필요합니다";
}

async function answerPermission(data: any): Promise<void> {
  const allowed = window.confirm(`${data?.toolName || "도구"} 실행을 허용할까요?`);
  await api("/api/chat/respond", {
    method: "POST",
    body: JSON.stringify({ runId: data.runId, requestId: data.requestId, value: { behavior: allowed ? "allow" : "deny" } }),
  }).catch((err) => notify(`권한 응답 실패: ${(err as Error).message}`, "warn"));
}

async function answerQuestion(data: any): Promise<void> {
  const payload = data?.payload;
  let result: unknown = null;
  if (payload?.questions?.length) {
    const answers: Record<string, string> = {};
    for (const question of payload.questions) {
      const answer = window.prompt(question.question || question.header || "응답을 입력하세요", "");
      if (answer == null) {
        await api("/api/chat/respond", {
          method: "POST",
          body: JSON.stringify({ runId: data.runId, requestId: data.requestId, value: { cancelled: true } }),
        });
        return;
      }
      answers[question.id || question.header || "answer"] = answer;
    }
    result = { answers };
  } else {
    const answer = window.prompt(payload?.message || "응답을 입력하세요", "");
    if (answer == null) result = { cancelled: true };
    else result = { result: answer };
  }
  await api("/api/chat/respond", {
    method: "POST",
    body: JSON.stringify({ runId: data.runId, requestId: data.requestId, value: result }),
  }).catch((err) => notify(`응답 전송 실패: ${(err as Error).message}`, "warn"));
}

function updatePane(paneId: string, mutator: (pane: ChatPane) => void): void {
  updateState((state) => {
    const pane = state.chatPanes.find((item) => item.id === paneId);
    if (pane) mutator(pane);
  });
}
