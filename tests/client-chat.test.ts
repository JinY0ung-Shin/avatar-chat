// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
  addConversationToSplit,
  answerPrompt,
  clearChatHistory,
  closeCanvas,
  closePane,
  dismissCanvas,
  fetchCanvasVersions,
  humanTool,
  newChat,
  PLUGIN_STATUS_LABELS,
  regenerate,
  respondPlanReview,
  rollbackCanvas,
  selectConversation,
  sendMessage,
  setActiveCanvas,
  startChatWith,
  stopPane,
  submitCanvas,
  submitCanvasEdit,
  summarizeInput,
  attachRun,
  attachActiveRun,
} from "../src/client/src/lib/chat.js";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import { resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* fixtures + fetch stubbing                                           */
/* ------------------------------------------------------------------ */

const PRISTINE = structuredClone(readState());

type FetchHandler = (url: string, init: RequestInit) => unknown;

function useFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A fetch that must never be called (for pure no-op assertions). */
function noFetch() {
  const fn = vi.fn(async () => {
    throw new Error("fetch should not have been called");
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function sseRes(frames: Array<[string, unknown]>, status = 200) {
  const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return { ok: status >= 200 && status < 300, status, body: streamFrom(chunks), json: async () => ({}) };
}

function body(init: RequestInit): any {
  return init.body ? JSON.parse(String(init.body)) : undefined;
}

async function waitFor(cond: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor: condition never met");
}

let paneSeq = 0;
function seedPane(overrides: Partial<ChatPane> = {}): string {
  const id = overrides.id ?? `pane${++paneSeq}`;
  const pane = {
    id,
    avatar: { id: "av1", alias: "노아", displayName: "Noah", isOwn: false } as any,
    conversationId: `conv-${id}`,
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
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
    groupKnowledgeOff: [],
    mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
    canvases: [],
    activeCanvasId: null,
    stickBottom: true,
    usage: null,
    abortController: null,
    ...overrides,
  } as ChatPane;
  updateState((s) => {
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
    s.currentAvatar = pane.avatar;
  });
  return id;
}

function pane(id: string): ChatPane {
  return readState().chatPanes.find((p) => p.id === id)!;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: { id: "owner", roles: [] } as any });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("humanTool / summarizeInput / PLUGIN_STATUS_LABELS", () => {
  it("humanTool prefers a known label, unwraps mcp names, else spaces out underscores", () => {
    expect(humanTool(undefined)).toBe("도구");
    expect(humanTool("Bash")).toBe("명령 실행");
    expect(humanTool("mcp__knowledge__request_info")).toBe("정보 요청 기록");
    expect(humanTool("mcp__custom__do_a_thing")).toBe("do a thing");
    expect(humanTool("Raw_Name")).toBe("Raw Name");
  });

  it("summarizeInput picks a recognizable key, then first string, then JSON", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput(42)).toBe("42");
    expect(summarizeInput("hello")).toBe("hello");
    expect(summarizeInput({ command: "ls -la", other: 1 })).toBe("ls -la");
    expect(summarizeInput({ nokey: "first-string" })).toBe("first-string");
    expect(summarizeInput({ a: 1, b: 2 })).toBe(JSON.stringify({ a: 1, b: 2 }));
    expect(summarizeInput("x".repeat(200))).toHaveLength(181); // 180 + ellipsis
  });

  it("PLUGIN_STATUS_LABELS covers the four load states", () => {
    expect(PLUGIN_STATUS_LABELS).toMatchObject({
      started: "불러오는 중",
      installed: "설치됨",
      completed: "사용 준비됨",
      failed: "불러오기 실패",
    });
  });
});

/* ------------------------------------------------------------------ */
/* sendMessage — the streaming pipeline                                */
/* ------------------------------------------------------------------ */

describe("sendMessage streaming pipeline", () => {
  it("drives a full turn: activity tree, thinking, usage, and a persisted snapshot", async () => {
    const id = seedPane();
    const assistantMsg = {
      id: "msg1",
      conversationId: "conv1",
      role: "assistant",
      content: "최종 답변",
      response: {
        kind: "text",
        runtime: "claude",
        text: "최종 답변",
        usage: { inputTokens: 1000, outputTokens: 50, contextWindow: 1_000_000 },
      },
      createdAt: new Date().toISOString(),
    };
    const seen: string[] = [];
    useFetch((url, init) => {
      seen.push(`${(init as any).method || "GET"} ${url}`);
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv1", runId: "run1" }],
          ["status", { label: "작업 중" }],
          ["plugin", { name: "pluginA", status: "started" }],
          ["plugin", { name: "pluginA", status: "completed" }],
          ["agent", { agentId: "sub1", parentId: "main", subagentType: "researcher", description: "조사" }],
          ["tool", { toolUseId: "t1", name: "Bash", agentId: "sub1", input: { command: "ls -la" } }],
          ["tool_end", { toolUseId: "t1", ok: true, output: "file list" }],
          ["task", { taskId: "k1", agentId: "sub1", subagentType: "worker" }],
          ["task_update", { taskId: "k1", subagentType: "worker", summary: "작업 중" }],
          ["task_end", { taskId: "k1", subagentType: "worker", ok: true }],
          ["agent_end", { agentId: "sub1", ok: true }],
          ["thinking", { text: "생각 중" }],
          ["delta", { text: "최종 답변" }],
          ["done", { message: assistantMsg }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url.startsWith("/api/messages/")) return jsonRes({ ok: true });
      return undefined;
    });

    await sendMessage(id, "안녕");

    const p = pane(id);
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]).toMatchObject({ role: "user", content: "안녕" });
    const last = p.messages[1];
    expect(last).toMatchObject({ role: "assistant", content: "최종 답변" });
    expect(p.usage).toMatchObject({ inputTokens: 1000, outputTokens: 50 });

    // The completed bubble keeps a snapshot of the activity that ran.
    const activity = (last.response as any).activity;
    expect(activity.agents.find((a: any) => a.id === "sub1")).toMatchObject({ status: "done" });
    expect(activity.tools[0]).toMatchObject({ label: "명령 실행", detail: "file list", status: "done" });
    expect(activity.tasks[0]).toMatchObject({ label: "worker", status: "done" });
    // The reasoning text is grafted onto the response so the "생각 과정" view survives.
    expect((last.response as any).thinking).toBe("생각 중");

    // Live scratch state is cleared and the pane is idle again.
    expect(p).toMatchObject({ streaming: false, liveText: "", liveThinking: "" });
    expect(p.liveTools).toEqual([]);
    // The snapshot is best-effort persisted to the server.
    expect(seen).toContain("PUT /api/messages/msg1/activity");
    // The POST carried the composer picks + conversation id.
    const post = seen.find((s) => s.startsWith("POST /api/chat/stream"));
    expect(post).toBeTruthy();
  });

  it("keeps the task label when task_update/task_end frames omit the naming fields", async () => {
    const id = seedPane();
    const assistantMsg = {
      id: "msg-task-label",
      conversationId: "conv-task-label",
      role: "assistant",
      content: "끝",
      response: { kind: "text", runtime: "claude", text: "끝" },
      createdAt: new Date().toISOString(),
    };
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv-task-label", runId: "run-tl" }],
          ["task", { taskId: "k1", agentId: "main", subagentType: "worker" }],
          // Real task_update/task_end frames often carry only ids + progress —
          // an empty recomputed label must not wipe the one from task start.
          ["task_update", { taskId: "k1", summary: "진행 상황" }],
          ["task_end", { taskId: "k1", ok: true }],
          ["done", { message: assistantMsg }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url.startsWith("/api/messages/")) return jsonRes({ ok: true });
      return undefined;
    });

    await sendMessage(id, "라벨 유지 확인");

    const last = pane(id).messages.at(-1)!;
    const activity = (last.response as any).activity;
    expect(activity.tasks[0]).toMatchObject({
      label: "worker",
      detail: "진행 상황",
      status: "done",
    });
  });

  it("keeps a live show_file image on a fallback assistant message", async () => {
    const id = seedPane();
    const attachment = {
      id: "generated-1",
      kind: "image",
      mediaType: "image/png",
      name: "result.png",
      caption: "생성 결과",
    };
    useFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv1", runId: "run-file" }],
          ["file", { attachment }],
          ["done", { response: { kind: "text", runtime: "claude", summary: "완료", text: "완료" } }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });

    await sendMessage(id, "이미지 만들어줘");

    const last = pane(id).messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", attachments: [attachment] });
    expect(pane(id).liveAttachments).toEqual([]);
  });

  it("no-ops on an empty text-only send and on the /new slash action", async () => {
    const id = seedPane();
    const fetchFn = noFetch();
    await sendMessage(id, "   ");
    expect(fetchFn).not.toHaveBeenCalled();

    await sendMessage(id, "/new");
    // /new swapped the pane for a fresh one without hitting the network.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes[0].id).not.toBe(id);
    expect(readState().chatPanes[0].messages).toEqual([]);
  });

  it("prompts for missing args on a requiresArgs slash command", async () => {
    const id = seedPane({ avatar: { id: "owner", isOwn: true } as any });
    const fetchFn = noFetch();
    await sendMessage(id, "/remember");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pane(id).draft).toBe("/remember ");
    expect(get(toasts).some((t) => t.message.includes("/remember"))).toBe(true);
  });

  it("finalizes an aborted turn as a stopped message", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") throw Object.assign(new Error("abort"), { name: "AbortError" });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "안녕");
    const msgs = pane(id).messages;
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "(중지됨)" });
    expect(pane(id).streaming).toBe(false);
  });

  it("undoes the user bubble and restores the draft when nothing streamed", async () => {
    const id = seedPane();
    useFetch((url) => {
      if (url === "/api/chat/stream") return jsonRes({ error: "서버 터짐" }, 500);
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await sendMessage(id, "복구될 텍스트");
    expect(pane(id).messages).toEqual([]);
    expect(pane(id).draft).toBe("복구될 텍스트");
    expect(get(toasts).some((t) => t.message.includes("서버 터짐"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* startChatWith / selectConversation / addConversationToSplit         */
/* ------------------------------------------------------------------ */

describe("opening + resuming conversations", () => {
  it("startChatWith opens a fresh pane for an avatar with no prior conversation", async () => {
    useFetch((url) => {
      if (url === "/api/avatars/av9") return jsonRes({ avatar: { id: "av9", alias: "동료", isOwn: false } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startChatWith({ id: "av9" } as any);
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0].avatar.id).toBe("av9");
    expect(s.activePaneId).toBe(s.chatPanes[0].id);
  });

  it("startChatWith bails out when the owner declines the streaming-switch confirm", async () => {
    seedPane({ streaming: true });
    const fetchFn = noFetch();
    const opening = startChatWith({ id: "av9" } as any);
    resolveConfirmation(false);
    await opening;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toHaveLength(1); // unchanged
  });

  it("startChatWith(split) pushes an extra pane", async () => {
    seedPane();
    useFetch((url) => {
      if (url === "/api/avatars/av2") return jsonRes({ avatar: { id: "av2", alias: "둘째", isOwn: false } });
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await startChatWith({ id: "av2" } as any, true);
    expect(readState().chatPanes).toHaveLength(2);
  });

  it("selectConversation loads a stored conversation into a single pane", async () => {
    replaceState({ conversations: [{ id: "c1", avatarUserId: "av1", isRoutine: false } as any] });
    const assistantMsg = { id: "m", role: "assistant", content: "이전 답변", response: null, conversationId: "c1", createdAt: "t" };
    useFetch((url) => {
      if (url.startsWith("/api/messages")) return jsonRes({ messages: [assistantMsg], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("c1");
    const s = readState();
    expect(s.view).toBe("chat");
    expect(s.chatPanes).toHaveLength(1);
    expect(s.chatPanes[0]).toMatchObject({ conversationId: "c1" });
    expect(s.chatPanes[0].messages).toHaveLength(1);
  });

  it("selectConversation just focuses a pane that is already streaming that conversation", async () => {
    const id = seedPane({ conversationId: "c-live", streaming: true });
    const fetchFn = noFetch();
    // switch active pane away, then reselect
    updateState((s) => {
      s.activePaneId = null;
      s.view = "explore";
    });
    await selectConversation("c-live");
    expect(readState()).toMatchObject({ view: "chat", activePaneId: id });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("selectConversation warns when the conversation cannot be found", async () => {
    // Both lists must come back empty: a miss in the chat list falls through to
    // the routine list before the lookup gives up.
    useFetch((url) =>
      url === "/api/conversations" || url === "/api/conversations?kind=routine"
        ? jsonRes({ conversations: [] })
        : undefined,
    );
    await selectConversation("missing");
    expect(get(toasts).some((t) => t.message.includes("대화를 찾을 수 없습니다"))).toBe(true);
  });

  // Routine threads are fetched with kind:"routine" into a SEPARATE state array,
  // and /api/conversations defaults to kind:"chat" — so a lookup that reads only
  // state.conversations reported "대화를 찾을 수 없습니다" for every routine
  // handoff ("일반 대화로 열기") even though the thread exists.
  it("selectConversation opens a routine thread held in routineConversations", async () => {
    replaceState({
      conversations: [],
      routineConversations: [{ id: "r1", avatarUserId: "av1", isRoutine: true } as any],
    });
    const fetchFn = useFetch((url) => {
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("r1");
    expect(readState()).toMatchObject({ view: "chat" });
    expect(readState().chatPanes[0]).toMatchObject({ conversationId: "r1" });
    // Cached locally, so neither conversation list is refetched.
    expect(fetchFn.mock.calls.every(([url]) => !String(url).startsWith("/api/conversations"))).toBe(true);
  });

  it("selectConversation refetches the routine list when neither cache has the thread", async () => {
    replaceState({ conversations: [], routineConversations: [] });
    useFetch((url) => {
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      if (url === "/api/conversations?kind=routine")
        return jsonRes({ conversations: [{ id: "r2", avatarUserId: "av1", isRoutine: true }] });
      if (url.startsWith("/api/messages"))
        return jsonRes({ messages: [], groupKnowledgeOff: [], canvases: [] });
      if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      return undefined;
    });
    await selectConversation("r2");
    expect(readState().chatPanes[0]).toMatchObject({ conversationId: "r2" });
    expect(get(toasts).some((t) => t.message.includes("대화를 찾을 수 없습니다"))).toBe(false);
  });

  it("addConversationToSplit focuses an already-open pane", async () => {
    const id = seedPane({ conversationId: "c-open" });
    const fetchFn = noFetch();
    updateState((s) => {
      s.activePaneId = null;
    });
    await addConversationToSplit("c-open");
    expect(readState().activePaneId).toBe(id);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("addConversationToSplit refuses beyond the 4-pane maximum", async () => {
    for (let i = 0; i < 4; i++) seedPane({ conversationId: `c${i}` });
    const fetchFn = noFetch();
    await addConversationToSplit("brand-new");
    expect(get(toasts).some((t) => t.message.includes("최대 4개"))).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readState().chatPanes).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* newChat / clearChatHistory / regenerate                             */
/* ------------------------------------------------------------------ */

describe("pane lifecycle", () => {
  it("newChat replaces the active pane, but not while it streams", () => {
    const streamingId = seedPane({ streaming: true, messages: [{ id: "x" } as any] });
    newChat(streamingId);
    expect(pane(streamingId).messages).toHaveLength(1); // untouched

    const id = seedPane({ messages: [{ id: "y" } as any] });
    newChat(id);
    const fresh = readState().chatPanes.find((p) => p.id !== streamingId && p.id !== id)!;
    expect(readState().chatPanes.some((p) => p.id === id)).toBe(false);
    expect(fresh.messages).toEqual([]);
  });

  it("clearChatHistory deletes conversations and resets matching panes", async () => {
    const id = seedPane({ conversationId: "c1", messages: [{ id: "m" } as any] });
    replaceState({ conversations: [{ id: "c1" } as any, { id: "c2" } as any] });
    useFetch((url, init) =>
      url === "/api/conversations" && (init as any).method === "DELETE"
        ? jsonRes({ deleted: 1, conversationIds: ["c1"] })
        : undefined,
    );
    const deleted = await clearChatHistory();
    expect(deleted).toBe(1);
    expect(readState().conversations.map((c) => c.id)).toEqual(["c2"]);
    // The open pane on the cleared conversation was reset to a fresh pane.
    const replaced = readState().chatPanes[0];
    expect(replaced.id).not.toBe(id);
    expect(replaced.messages).toEqual([]);
  });

  it("clearChatHistory returns 0 when nothing was deleted", async () => {
    seedPane({ conversationId: "c1" });
    useFetch(() => jsonRes({ deleted: 0, conversationIds: [] }));
    expect(await clearChatHistory()).toBe(0);
  });

  it("regenerate re-sends the last user turn and streams a new answer", async () => {
    const id = seedPane({
      messages: [
        { id: "u", role: "user", content: "질문", conversationId: "c", response: null, createdAt: "t" } as any,
        { id: "a", role: "assistant", content: "옛 답변", conversationId: "c", response: null, createdAt: "t" } as any,
      ],
    });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([
          ["open", { conversationId: "c", runId: "r" }],
          ["delta", { text: "새 답변" }],
          ["done", { message: { id: "a2", role: "assistant", content: "새 답변", response: { kind: "text", runtime: "claude", text: "새 답변" }, conversationId: "c", createdAt: "t" } }],
        ]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    regenerate(id);
    await waitFor(() => !pane(id).streaming && pane(id).messages.length === 2);
    expect(bodies[0].regenerate).toBe(true);
    expect(pane(id).messages.map((m) => m.content)).toEqual(["질문", "새 답변"]);
  });

  it("regenerate is a no-op without a prior user turn", () => {
    const id = seedPane({ messages: [{ id: "a", role: "assistant", content: "x" } as any] });
    const fetchFn = noFetch();
    regenerate(id);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* stopPane / closePane / setActiveCanvas                              */
/* ------------------------------------------------------------------ */

describe("stop / close", () => {
  it("stopPane cancels the run, aborts the stream, and shows a stopping status", async () => {
    const controller = new AbortController();
    const id = seedPane({ liveRunId: "run5", abortController: controller, streaming: true });
    const fetchFn = useFetch((url) =>
      url.includes("/cancel") ? jsonRes({ ok: true }) : jsonRes({}),
    );
    await stopPane(id);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat/runs/run5/cancel"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(controller.signal.aborted).toBe(true);
    expect(pane(id).liveStatus).toBe("중지 중…");
  });

  it("closePane removes a pane and keeps a fresh one when the last closes", () => {
    const a = seedPane();
    const b = seedPane();
    closePane(b);
    expect(readState().chatPanes.map((p) => p.id)).toEqual([a]);

    closePane(a);
    // currentAvatar remains, so a fresh empty pane replaces the closed one.
    expect(readState().chatPanes).toHaveLength(1);
    expect(readState().chatPanes[0].id).not.toBe(a);
  });

  it("setActiveCanvas swaps the active canvas id", () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any, { id: "cv2" } as any], activeCanvasId: "cv1" });
    setActiveCanvas(id, "cv2");
    expect(pane(id).activeCanvasId).toBe("cv2");
  });
});

/* ------------------------------------------------------------------ */
/* canvas flows                                                        */
/* ------------------------------------------------------------------ */

describe("canvas flows", () => {
  it("submitCanvas unblocks a parked run for a blocking canvas", async () => {
    const id = seedPane({
      canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any],
    });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await submitCanvas(id, "cv1", { color: "red" });
    expect(posted).toMatchObject({ runId: "rn1", requestId: "rq1", value: { values: { color: "red" } } });
    const c = pane(id).canvases[0];
    expect(c).toMatchObject({ pending: false, submitting: false, submittedValues: { color: "red" } });
  });

  it("submitCanvas surfaces a toast when the parked run rejects", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any] });
    useFetch(() => jsonRes({ error: "닫힌 실행" }, 500));
    await submitCanvas(id, "cv1", {});
    expect(get(toasts).some((t) => t.message.includes("닫힌 실행"))).toBe(true);
    expect(pane(id).canvases[0].submitting).toBe(false);
  });

  it("submitCanvas delivers a non-blocking answer as a new turn", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: false } as any] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([["done", { message: { id: "m", role: "assistant", content: "ok", response: { kind: "text", runtime: "claude", text: "ok" }, conversationId: "c", createdAt: "t" } }]]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await submitCanvas(id, "cv1", { pick: "A" });
    expect(bodies[0].canvasSubmission).toMatchObject({ canvasId: "cv1", values: { pick: "A" } });
    expect(pane(id).canvases[0].submittedValues).toMatchObject({ pick: "A" });
  });

  it("submitCanvasEdit sends the edited content as a new turn", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any] });
    const bodies: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        bodies.push(body(init));
        return sseRes([["done", { message: { id: "m", role: "assistant", content: "ok", response: { kind: "text", runtime: "claude", text: "ok" }, conversationId: "c", createdAt: "t" } }]]);
      }
      if (url === "/api/conversations") return jsonRes({ conversations: [] });
      return undefined;
    });
    await submitCanvasEdit(id, "cv1", "고친 내용");
    expect(bodies[0].canvasSubmission).toMatchObject({ canvasId: "cv1", editedContent: "고친 내용" });
  });

  it("dismissCanvas cancels a parked blocking canvas and hides it", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", pending: true, requestId: "rq1", runId: "rn1" } as any] });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await dismissCanvas(id, "cv1");
    expect(posted).toMatchObject({ requestId: "rq1", value: { cancelled: true } });
    expect(pane(id).canvases[0].pending).toBe(false);
  });

  it("closeCanvas deletes the canvas, tolerating a not-found server response", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any, { id: "cv2" } as any], activeCanvasId: "cv1" });
    useFetch((url, init) => {
      if (url.startsWith("/api/chat/canvases/cv1") && (init as any).method === "DELETE") {
        return jsonRes({ error: "캔버스를 찾을 수 없습니다." }, 404);
      }
      return undefined;
    });
    await closeCanvas(id, "cv1");
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv2"]);
    expect(pane(id).activeCanvasId).toBe("cv2");
  });

  it("closeCanvas keeps the canvas when deletion fails for another reason", async () => {
    const id = seedPane({ canvases: [{ id: "cv1" } as any], activeCanvasId: "cv1" });
    useFetch(() => jsonRes({ error: "권한 없음" }, 500));
    await closeCanvas(id, "cv1");
    expect(pane(id).canvases.map((c) => c.id)).toEqual(["cv1"]);
    expect(get(toasts).some((t) => t.message.includes("권한 없음"))).toBe(true);
  });

  it("fetchCanvasVersions returns the versions, or [] on failure", async () => {
    useFetch((url) => (url.includes("/versions") ? jsonRes({ versions: [{ version: 1, createdAt: "t" }] }) : undefined));
    expect(await fetchCanvasVersions("cv1")).toEqual([{ version: 1, createdAt: "t" }]);
    useFetch(() => jsonRes({}, 500));
    expect(await fetchCanvasVersions("cv1")).toEqual([]);
  });

  it("rollbackCanvas merges the returned canvas, and toasts on error", async () => {
    const id = seedPane({ canvases: [{ id: "cv1", title: "old" } as any] });
    useFetch((url) => (url.includes("/rollback") ? jsonRes({ canvas: { id: "cv1", title: "rolled back" } }) : undefined));
    await rollbackCanvas(id, "cv1", 2);
    expect(pane(id).canvases[0].title).toBe("rolled back");

    useFetch(() => jsonRes({ error: "되돌리기 실패" }, 500));
    await rollbackCanvas(id, "cv1", 2);
    expect(get(toasts).some((t) => t.message.includes("되돌리기 실패"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* interactive prompts + plan review                                  */
/* ------------------------------------------------------------------ */

describe("prompts + plan review", () => {
  it("answerPrompt posts the owner's response and dequeues the prompt", async () => {
    updateState((s) => {
      s.promptQueue.push({ id: "rq1", runId: "rn1", paneId: "p", kind: "permission", data: {} });
    });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await answerPrompt("rq1", { behavior: "allow" });
    expect(posted).toMatchObject({ runId: "rn1", requestId: "rq1", value: { behavior: "allow" } });
    expect(readState().promptQueue).toHaveLength(0);
  });

  it("answerPrompt is a no-op for an unknown request id", async () => {
    const fetchFn = noFetch();
    await answerPrompt("nope", {});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("answerPrompt rethrows and toasts when the respond call fails", async () => {
    updateState((s) => {
      s.promptQueue.push({ id: "rq2", runId: "rn2", paneId: "p", kind: "question", data: {} });
    });
    useFetch(() => jsonRes({ error: "이미 종료됨" }, 500));
    await expect(answerPrompt("rq2", {})).rejects.toThrow("이미 종료됨");
    expect(get(toasts).some((t) => t.message.includes("이미 종료됨"))).toBe(true);
  });

  it("respondPlanReview approves and clears the inline review", async () => {
    const id = seedPane({ planReview: { requestId: "pr1", runId: "rn1" } });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await respondPlanReview(id, "approved");
    expect(posted).toMatchObject({ requestId: "pr1", value: { behavior: "approved" } });
    expect(pane(id).planReview).toBeNull();
    expect(pane(id).liveStatus).toBe("계획을 승인했습니다.");
  });

  it("respondPlanReview rejects with trimmed feedback", async () => {
    const id = seedPane({ planReview: { requestId: "pr2", runId: "rn2" } });
    let posted: any;
    useFetch((url, init) => {
      if (url === "/api/chat/respond") {
        posted = body(init);
        return jsonRes({ ok: true });
      }
      return undefined;
    });
    await respondPlanReview(id, "rejected", "  방향을 바꿔줘  ");
    expect(posted.value).toMatchObject({ behavior: "rejected", feedback: "방향을 바꿔줘" });
  });

  it("respondPlanReview is a no-op without a pending review", async () => {
    const id = seedPane({ planReview: null });
    const fetchFn = noFetch();
    await respondPlanReview(id, "approved");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* attachRun / attachActiveRun                                         */
/* ------------------------------------------------------------------ */

describe("reattaching to a live run", () => {
  it("attachRun replays a run's events into the pane", async () => {
    const id = seedPane({ conversationId: "c1" });
    useFetch((url) => {
      if (url.includes("/api/chat/runs/run1/events")) {
        return sseRes([
          ["delta", { text: "재연결 답변" }],
          ["done", { message: { id: "m", role: "assistant", content: "재연결 답변", response: { kind: "text", runtime: "claude", text: "재연결 답변" }, conversationId: "c1", createdAt: "t" } }],
        ]);
      }
      return undefined;
    });
    await attachRun(id, "run1");
    expect(pane(id).messages.at(-1)).toMatchObject({ role: "assistant", content: "재연결 답변" });
    expect(pane(id).streaming).toBe(false);
  });

  it("attachRun falls back to reloading messages on a 404", async () => {
    const id = seedPane({ conversationId: "c1" });
    const reloaded = { id: "old", role: "assistant", content: "저장된 답변", response: null, conversationId: "c1", createdAt: "t" };
    useFetch((url) => {
      if (url.includes("/events")) return { ok: false, status: 404, body: null, json: async () => ({}) };
      if (url.startsWith("/api/messages")) return jsonRes({ messages: [reloaded], groupKnowledgeOff: [], canvases: [] });
      return undefined;
    });
    await attachRun(id, "run404");
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "저장된 답변" });
  });

  it("attachActiveRun reloads messages when a user turn has no active run", async () => {
    const id = seedPane({
      conversationId: "c1",
      messages: [{ id: "u", role: "user", content: "질문", response: null, conversationId: "c1", createdAt: "t" } as any],
    });
    useFetch((url) => {
      if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
      if (url.startsWith("/api/messages")) {
        return jsonRes({
          messages: [
            { id: "u", role: "user", content: "질문", response: null, conversationId: "c1", createdAt: "t" },
            { id: "a", role: "assistant", content: "완료된 답변", response: null, conversationId: "c1", createdAt: "t" },
          ],
          groupKnowledgeOff: [],
          canvases: [],
        });
      }
      return undefined;
    });
    await attachActiveRun(id);
    expect(pane(id).messages).toHaveLength(2);
    expect(pane(id).messages.at(-1)).toMatchObject({ content: "완료된 답변" });
  });
});
