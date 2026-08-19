// 봇 오피스's messenger shape: a delegated task card lives INSIDE the transcript,
// next to the turn that spawned it, rather than on a separate board. What is
// pinned here is the part that cannot be seen from either component alone — the
// time anchor (a card follows the last USER message it postdates), and the guard
// that keeps every one of those cards out of ordinary chat, where this same
// snippet re-runs once per streamed token.
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { AvatarDetail, BotTask, ChatPane, StoredMessage } from "../src/client/src/lib/types.js";

const OWNER_ID = "owner-1";

function botAvatar(agentId = "bot-1"): AvatarDetail {
  return {
    id: `personal:${OWNER_ID}:${agentId}`,
    username: `personal-agent-${agentId}`,
    displayName: "리뷰 봇",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    isOwn: true,
    elevated: true,
    plugins: [],
    personalAgent: { agentId, defaultModel: null },
  } as unknown as AvatarDetail;
}

/** A plain avatar — the pane shape ordinary chat uses. */
function plainAvatar(): AvatarDetail {
  const avatar = botAvatar();
  delete (avatar as unknown as Record<string, unknown>).personalAgent;
  return { ...avatar, id: "avatar-1", displayName: "아바타" } as AvatarDetail;
}

function messageOf(role: "user" | "assistant", id: string, createdAt: string, text: string): StoredMessage {
  return {
    id,
    conversationId: "conv-1",
    role,
    content: text,
    createdAt,
    response: role === "assistant" ? { kind: "text", runtime: "claude", summary: "완료", text } : undefined,
  } as unknown as StoredMessage;
}

function taskOf(over: Partial<BotTask> = {}): BotTask {
  return {
    id: "task-1",
    ownerUserId: OWNER_ID,
    agentId: "bot-1",
    conversationId: "conv-1",
    runId: null,
    title: "작업",
    requestText: "해줘",
    status: "queued",
    reportedOutcome: null,
    resultSummary: null,
    pendingQuestion: null,
    error: null,
    model: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    seenAt: null,
    ...over,
  };
}

function paneOf(avatar: AvatarDetail, messages: StoredMessage[]): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    groupKnowledgeOff: [],
  } as unknown as ChatPane;
}

/** The transcript's top-level flow, as message/card labels in DOM order. */
function transcriptFlow(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".transcript-inner > *")]
    .map((node) => {
      if (node.classList.contains("bots-task-card"))
        return `task:${node.querySelector(".bots-task-title")?.textContent?.trim()}`;
      if (node.classList.contains("message"))
        return `msg:${node.querySelector(".bubble")?.textContent?.trim()}`;
      return "";
    })
    .filter(Boolean);
}

/** Four turns an hour apart, so a task's timestamp lands unambiguously. */
function conversation(): StoredMessage[] {
  return [
    messageOf("user", "m-1", "2026-08-19T10:00:00.000Z", "PR 42 봐줘"),
    messageOf("assistant", "m-2", "2026-08-19T10:01:00.000Z", "볼게요"),
    messageOf("user", "m-3", "2026-08-19T10:10:00.000Z", "테스트도 돌려줘"),
    messageOf("assistant", "m-4", "2026-08-19T10:11:00.000Z", "돌릴게요"),
  ];
}

beforeEach(() => {
  history.replaceState(null, "", "#/bots/bot-1");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  replaceState({
    view: "bots",
    avatars: [],
    conversations: [],
    chatPanes: [paneOf(botAvatar(), conversation())],
    activePaneId: "pane-1",
    botTasks: [],
  });
});

function stubFetch(routes: (url: string, method: string) => unknown = () => undefined): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      const answered = routes(url, method);
      if (answered !== undefined) return { ok: true, status: 200, json: async () => answered } as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ avatars: [], conversations: [], messages: [], skills: [], run: null }),
      } as Response;
    }),
  );
  return calls;
}

describe("delegated task cards inside the bot thread", () => {
  it("puts each card after the last USER message it postdates", () => {
    stubFetch();
    replaceState({
      botTasks: [
        taskOf({ id: "t-late", title: "테스트 재실행", createdAt: "2026-08-19T10:20:00.000Z" }),
        taskOf({ id: "t-mid", title: "PR 42 리뷰", createdAt: "2026-08-19T10:05:00.000Z" }),
        taskOf({ id: "t-old", title: "어제 맡긴 일", createdAt: "2026-08-18T09:00:00.000Z" }),
      ],
    });

    const { container } = render(ChatView);

    // t-old predates every message → above the first bubble. t-late postdates the
    // last ASSISTANT turn but anchors to the last USER one — an assistant reply is
    // never the thing that delegated work.
    expect(transcriptFlow(container)).toEqual([
      "task:어제 맡긴 일",
      "msg:PR 42 봐줘",
      "task:PR 42 리뷰",
      "msg:볼게요",
      "msg:테스트도 돌려줘",
      "task:테스트 재실행",
      "msg:돌릴게요",
    ]);
  });

  it("shows only the tasks belonging to THIS bot", () => {
    stubFetch();
    replaceState({
      botTasks: [
        taskOf({ id: "t-mine", title: "내 작업", createdAt: "2026-08-19T10:05:00.000Z" }),
        taskOf({ id: "t-other", agentId: "bot-2", title: "남의 작업", createdAt: "2026-08-19T10:05:00.000Z" }),
      ],
    });

    const { container } = render(ChatView);

    expect([...container.querySelectorAll(".bots-task-title")].map((el) => el.textContent?.trim())).toEqual([
      "내 작업",
    ]);
    // Inline cards take the dense variant: a card between bubbles is an
    // annotation, and its density must not ride whichever view mounts this
    // transcript.
    expect(container.querySelector(".bots-task-card")?.classList.contains("compact")).toBe(true);
  });

  it("renders nothing extra in ordinary chat, even with tasks in state", () => {
    stubFetch();
    replaceState({
      view: "chat",
      chatPanes: [paneOf(botAvatar(), conversation())],
      botTasks: [taskOf({ id: "t-mine", createdAt: "2026-08-19T10:05:00.000Z" })],
    });

    const { container } = render(ChatView);

    expect(container.querySelectorAll(".bots-task-card").length).toBe(0);
    expect(transcriptFlow(container)).toEqual([
      "msg:PR 42 봐줘",
      "msg:볼게요",
      "msg:테스트도 돌려줘",
      "msg:돌릴게요",
    ]);
  });

  it("renders nothing for a pane that is not a bot, even inside 봇 오피스", () => {
    stubFetch();
    replaceState({
      view: "bots",
      chatPanes: [paneOf(plainAvatar(), conversation())],
      botTasks: [taskOf({ id: "t-mine", createdAt: "2026-08-19T10:05:00.000Z" })],
    });

    const { container } = render(ChatView);

    expect(container.querySelectorAll(".bots-task-card").length).toBe(0);
  });

  it("stops a running task straight from the card in the thread", async () => {
    const running = taskOf({ id: "t-run", status: "running", title: "PR 42 리뷰", createdAt: "2026-08-19T10:05:00.000Z" });
    const calls = stubFetch((url, method) => {
      if (url.includes("/bot-tasks/") && method === "POST") return { task: running, stopping: true };
      return undefined;
    });
    replaceState({ botTasks: [running] });

    const { container } = render(ChatView);
    const button = container.querySelector(".bots-task-card .bots-task-actions button")!;
    expect(button.textContent?.trim()).toBe("중지");

    await fireEvent.click(button);

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/me/bot-tasks/t-run/cancel" && call.method === "POST")).toBe(
        true,
      ),
    );
    // The row is adopted as-is: a stopped run ends on a later frame, not here.
    expect(readState().botTasks[0].status).toBe("running");
  });
});
