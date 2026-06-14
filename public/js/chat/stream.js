// Auto-split from chat.js — submodule: send + live stream + SSE handling. Behavior-preserving relocation only.
import { api, dom, el, enhanceCodeBlocks, icon, notify, renderMarkdown, setAbort, state, triggerSessionExpired } from "../core.js";
import { syncDocumentTitle, syncHash } from "../nav.js";
import { advancePromptModal, dismissRunPrompts, promptQueue, showPromptModal } from "../shell.js";
import { activePane, refreshStreamingState, setActivePane, syncLegacyChatState } from "./panes.js";
import { applySlashCommand, hideSlashMenu, resolveTypedSlashCommand, slashPrompt } from "./slash.js";
import { renderAssistantInto, scrollToBottom } from "./assistant.js";
import {
  buildMessageActions,
  buildMessageNode,
  renderTranscript,
  updateComposerUsage,
  updateSendState,
} from "./composer.js";
import { refreshConversations } from "./conversations.js";

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
  if (activePane()?.id === pane.id) setAbort(pane.abortController);
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
      triggerSessionExpired();
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
  if (activePane()?.id === pane.id) setAbort(pane.abortController);
  let sawEvent = false;
  try {
    const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      credentials: "same-origin",
      signal: pane.abortController.signal,
    });
    if (response.status === 401) {
      triggerSessionExpired();
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

export async function consumeSse(body, onEvent) {
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

export {
  submitMessage,
  maybeGreet,
  beginLiveStream,
  streamChat,
  finishLiveRequest,
  attachActiveRun,
  attachChatRun,
  refreshConversationMessages,
  setComposerState,
  stopStreaming,
};
