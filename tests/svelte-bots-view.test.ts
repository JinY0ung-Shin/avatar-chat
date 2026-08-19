// 봇 오피스 (#/bots) — the messenger view over 내 봇 delegated tasks. What is
// pinned here is what the view alone owns: the roster's status dot is DERIVED
// from the task rows in state (not from anything the avatar row carries), the
// task strip speaks the Korean status vocabulary and cancels through
// POST /api/me/bot-tasks/:id/cancel, and the #/bots/<agentId> route keeps its
// argument — currentRoute() is re-run by syncHash(true) on every send, so a
// missing branch there would silently drop the selected bot from the URL.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ChatView is mounted by this view as its thread column, but it is covered by
// its own suites and drags in the whole canvas/markdown stack. A Svelte 5
// component is just a function ($$anchor, $$props), so a no-op renders nothing
// and keeps this file about 봇 오피스.
vi.mock("../src/client/src/views/ChatView.svelte", () => ({
  default: function ChatViewStub() {},
}));

import BotsView from "../src/client/src/views/BotsView.svelte";
import { openBotThreadPane, sendMessage } from "../src/client/src/lib/chat.js";
import { applyInitialRoute, currentRoute, goView } from "../src/client/src/lib/nav.js";
import { readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import type {
  AvatarDetail,
  AvatarSummary,
  BootstrapInfo,
  BotTask,
  ConversationSummary,
  User,
} from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const OWNER_ID = "owner-1";

function avatarIdOf(agentId: string): string {
  return `personal:${OWNER_ID}:${agentId}`;
}

function userOf(over: Partial<User> = {}): User {
  return {
    id: OWNER_ID,
    username: "owner",
    displayName: "나",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    roles: ["admin"],
    pluginCount: 0,
    gitTokenSet: false,
    gitIdentityName: null,
    gitIdentityEmail: null,
    knowledgeRepo: null,
    knowledgeBranch: null,
    knowledgeSelected: null,
    groupKnowledgeOffDefault: [],
    modelDefault: null,
    effortDefault: null,
    mcpToolGroupsDefault: null,
    allowedMcpToolGroups: null,
    secretNames: [],
    shellExposedSecretNames: [],
    sshPublicKey: null,
    groups: [],
    experimentalFeatures: [],
    sharedAccount: false,
    onboardedAt: "2026-08-01T00:00:00.000Z",
    lastSeenRelease: null,
    ...over,
  } as unknown as User;
}

function bootstrapOf(): BootstrapInfo {
  return {
    needsSetup: false,
    githubHost: "github.com",
    signupMode: "closed",
    confluenceConfigured: false,
  };
}

/** The shape the server tags onto the owner's own bots in GET /api/avatars. */
function botSummary(agentId: string, displayName: string): AvatarSummary {
  return {
    id: avatarIdOf(agentId),
    username: `personal-agent-${agentId}`,
    displayName,
    alias: "",
    bio: "",
    hashtags: [],
    hasImage: false,
    pluginCount: 0,
    visibility: "group",
    updatedAt: null,
    runtime: "native",
    personalAgent: { agentId, defaultModel: null },
  };
}

function detailOf(summary: AvatarSummary): AvatarDetail {
  return { ...summary, persona: "", intro: "", isOwn: true, elevated: true, plugins: [] };
}

function conversationOf(agentId: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: `conv-${agentId}`,
    avatarUserId: avatarIdOf(agentId),
    avatarDisplayName: agentId,
    title: "지난 대화",
    updatedAt: "2026-08-18T00:00:00.000Z",
    isRoutine: false,
    routineId: null,
    routinePrompt: null,
    ...over,
  };
}

function taskOf(over: Partial<BotTask> = {}): BotTask {
  return {
    id: "task-1",
    ownerUserId: OWNER_ID,
    agentId: "bot-1",
    conversationId: "conv-bot-1",
    runId: null,
    title: "PR 42 리뷰 정리",
    requestText: "PR 42를 먼저 읽고 정리해 줘",
    status: "queued",
    reportedOutcome: null,
    resultSummary: null,
    pendingQuestion: null,
    error: null,
    model: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

/**
 * Records every request; `routes` answers by URL substring. Every endpoint the
 * view's boot path touches has a default here so a test only states what it
 * cares about.
 */
function stubFetch(routes: (url: string, method: string) => unknown = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      const answered = routes(url, method);
      // A route may answer with a whole Response (SSE body / a non-200 status)
      // instead of just the JSON body it wants wrapped.
      if (answered && typeof answered === "object" && "ok" in answered) return answered as Response;
      if (answered !== undefined) return { ok: true, status: 200, json: async () => answered } as Response;
      let body: unknown = {};
      if (url.includes("/api/me/bot-tasks")) body = { tasks: [] };
      else if (url.includes("/api/conversations")) body = { conversations: [] };
      else if (url.includes("/api/avatars/")) body = { avatar: detailOf(botSummary("bot-1", "봇")) };
      else if (url.includes("/api/messages")) body = { messages: [], groupKnowledgeOff: [] };
      else if (url.includes("/api/chat/runs")) body = { run: null };
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return calls;
}

/** An SSE response body built from [event, data] pairs. */
function sseRes(frames: Array<[string, unknown]>): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      },
    }),
    json: async () => ({}),
  } as unknown as Response;
}

/** A finished assistant turn, so a streamed test turn terminates cleanly. */
function doneFrame(conversationId: string): [string, unknown] {
  return [
    "done",
    {
      message: {
        id: "assistant-1",
        conversationId,
        role: "assistant",
        content: "네",
        response: { kind: "text", runtime: "claude", text: "네" },
        createdAt: "2026-08-19T00:00:00.000Z",
      },
    },
  ];
}

/** Seed the store as a logged-in admin whose avatar list is already loaded. */
function seed(over: Record<string, unknown> = {}): void {
  replaceState({
    user: userOf(),
    bootstrap: bootstrapOf(),
    avatars: [],
    avatarsLoaded: true,
    avatarsLoading: false,
    conversations: [],
    chatPanes: [],
    activePaneId: null,
    botTasks: [],
    botsAgentId: "",
    view: "bots",
    ...over,
  });
}

/** The roster's rendered rows, as [name, status label, status kind] triples. */
function rosterRows(container: HTMLElement): [string, string, string][] {
  return [...container.querySelectorAll(".bots-roster-row")].map((row) => [
    row.querySelector(".bots-roster-name")?.textContent?.trim() ?? "",
    row.querySelector(".bots-roster-status")?.textContent?.trim() ?? "",
    row.querySelector(".bots-roster-status")?.getAttribute("data-state") ?? "",
  ]);
}

beforeEach(() => {
  history.replaceState(null, "", "#/bots");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* roster — status dots derive from the task rows                      */
/* ------------------------------------------------------------------ */

describe("BotsView roster", () => {
  it("derives each bot's status dot from its own tasks", async () => {
    stubFetch();
    seed({
      avatars: [
        botSummary("bot-1", "리뷰 봇"),
        botSummary("bot-2", "문서 봇"),
        botSummary("bot-3", "배포 봇"),
        botSummary("bot-4", "한가한 봇"),
      ],
      botTasks: [
        taskOf({ id: "t-run", agentId: "bot-1", status: "running" }),
        // A terminal row must not keep a bot looking busy.
        taskOf({ id: "t-done", agentId: "bot-1", status: "done" }),
        taskOf({ id: "t-ask", agentId: "bot-2", status: "waiting_input" }),
        taskOf({ id: "t-q1", agentId: "bot-3", status: "queued" }),
        taskOf({ id: "t-q2", agentId: "bot-3", status: "queued" }),
      ],
      botsAgentId: "bot-1",
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-roster-row").length).toBe(4));

    expect(rosterRows(container)).toEqual([
      ["리뷰 봇", "작업 중", "running"],
      ["문서 봇", "입력 대기", "waiting"],
      ["배포 봇", "대기열 2", "queued"],
      ["한가한 봇", "쉬는 중", "idle"],
    ]);
  });

  it("opens the clicked bot's newest stored thread and puts it in the hash", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/api/conversations")) {
        return {
          conversations: [
            conversationOf("bot-2", { id: "conv-old", updatedAt: "2026-08-01T00:00:00.000Z" }),
            conversationOf("bot-2", { id: "conv-new", updatedAt: "2026-08-18T00:00:00.000Z" }),
          ],
        };
      }
      if (url.includes(`/api/avatars/${encodeURIComponent(avatarIdOf("bot-2"))}`)) {
        return { avatar: detailOf(botSummary("bot-2", "문서 봇")) };
      }
      return undefined;
    });
    seed({ avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")] });

    render(BotsView);
    // bot-1 is auto-selected on boot so the messenger is never blank.
    await waitFor(() => expect(readState().botsAgentId).toBe("bot-1"));

    await fireEvent.click(screen.getByRole("button", { name: /문서 봇/ }));

    await waitFor(() => expect(readState().chatPanes[0]?.avatar.id).toBe(avatarIdOf("bot-2")));
    expect(readState().botsAgentId).toBe("bot-2");
    // The newest thread wins, and the view never navigates away from #/bots.
    expect(calls.some((call) => call.url.includes("conversationId=conv-new"))).toBe(true);
    expect(readState().view).toBe("bots");
    expect(location.hash).toBe("#/bots/bot-2");
  });

  it("points an admin with no bots at the place that creates one", async () => {
    stubFetch();
    seed({ avatars: [] });

    render(BotsView);

    await screen.findByText("아직 만든 봇이 없습니다");
    expect(screen.queryByText("맡긴 작업")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "내 봇 만들러 가기" }));
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("agents");
  });
});

/* ------------------------------------------------------------------ */
/* task strip — chips, empty state, cancel                             */
/* ------------------------------------------------------------------ */

describe("BotsView task strip", () => {
  it("renders one card per task of the selected bot with its Korean status chip", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      botTasks: [
        taskOf({ id: "t-run", status: "running", title: "PR 42 리뷰" }),
        taskOf({
          id: "t-ask",
          status: "waiting_input",
          title: "배포 창구 확인",
          pendingQuestion: "스테이징에 먼저 올릴까요?",
        }),
        taskOf({ id: "t-fail", status: "failed", title: "테스트 재실행", error: "권한이 없습니다" }),
        taskOf({ id: "t-done", status: "done", title: "회의록 정리", resultSummary: "3건 정리 완료" }),
        // Another bot's task must not leak into this strip.
        taskOf({ id: "t-other", agentId: "bot-2", status: "running", title: "남의 작업" }),
      ],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-task-card").length).toBe(4));

    expect([...container.querySelectorAll(".bots-task-chip")].map((chip) => chip.textContent?.trim())).toEqual([
      "실행 중",
      "입력 대기",
      "실패",
      "완료",
    ]);
    expect([...container.querySelectorAll(".bots-task-title")].map((el) => el.textContent)).not.toContain(
      "남의 작업",
    );
    // The one detail line is whatever that status makes the owner act on.
    expect([...container.querySelectorAll(".bots-task-detail")].map((el) => el.textContent)).toEqual([
      "스테이징에 먼저 올릴까요?",
      "권한이 없습니다",
      "3건 정리 완료",
    ]);
  });

  it("says nothing is delegated yet when the selected bot has no tasks", async () => {
    stubFetch();
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1" });

    const { container } = render(BotsView);
    await screen.findByText("아직 맡긴 작업이 없어요");
    expect(container.querySelectorAll(".bots-task-card").length).toBe(0);
  });

  it("cancels a queued task through the API and adopts the row it returns", async () => {
    const cancelled = taskOf({ id: "t-q", status: "cancelled", finishedAt: "2026-08-19T00:05:00.000Z" });
    const calls = stubFetch((url, method) => {
      if (url.includes("/bot-tasks/") && method === "POST") return { task: cancelled };
      return undefined;
    });
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-q", status: "queued" })],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-task-card").length).toBe(1));

    await fireEvent.click(screen.getByRole("button", { name: /취소$/ }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")!.url).toBe("/api/me/bot-tasks/t-q/cancel");
    // The response REPLACES the row rather than being re-fetched.
    await waitFor(() => expect(readState().botTasks.find((task) => task.id === "t-q")?.status).toBe("cancelled"));
    expect(container.querySelector(".bots-task-chip")?.textContent?.trim()).toBe("취소됨");
    // A terminal task no longer offers the control.
    expect(screen.queryByRole("button", { name: /취소$/ })).toBeNull();
    expect(get(toasts).at(-1)?.message).toBe("작업을 취소했습니다.");
  });

  it("stops a RUNNING task through the same endpoint and reports it as still winding down", async () => {
    // The server acknowledges the request but the row stays `running` — the
    // terminal state arrives later on a bot_task frame or the next poll.
    const acknowledged = taskOf({ id: "t-run", status: "running", startedAt: "2026-08-19T00:00:01.000Z" });
    const calls = stubFetch((url, method) => {
      if (url.includes("/bot-tasks/") && method === "POST") return { task: acknowledged, stopping: true };
      return undefined;
    });
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-run", status: "running" })],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-task-card").length).toBe(1));

    await fireEvent.click(screen.getByRole("button", { name: /중지$/ }));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")!.url).toBe("/api/me/bot-tasks/t-run/cancel");
    // The row is adopted AS-IS — the UI must not pretend the task ended.
    await waitFor(() => expect(get(toasts).at(-1)?.message).toContain("중지 요청을 보냈어요"));
    expect(readState().botTasks[0].status).toBe("running");
    expect(container.querySelector(".bots-task-chip")?.textContent?.trim()).toBe("실행 중");
  });

  it("labels the card control by status and leaves finished work alone", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [
        taskOf({ id: "t-run", status: "running" }),
        taskOf({ id: "t-q", status: "queued" }),
        taskOf({ id: "t-ask", status: "waiting_input" }),
        taskOf({ id: "t-done", status: "done" }),
        taskOf({ id: "t-fail", status: "failed" }),
      ],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-task-card").length).toBe(5));

    // Work already under way is STOPPED; work not yet started is CANCELLED;
    // a terminal row carries no control at all.
    expect(
      [...container.querySelectorAll(".bots-task-card")].map((card) => [
        card.getAttribute("data-status"),
        card.querySelector(".bots-task-actions button")?.textContent?.trim() ?? null,
      ]),
    ).toEqual([
      ["running", "중지"],
      ["queued", "취소"],
      ["waiting_input", "취소"],
      ["done", null],
      ["failed", null],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* send-while-busy + the `task` event-name collision                   */
/* ------------------------------------------------------------------ */

describe("delegated task wiring in lib/chat", () => {
  /** Open a bot thread the way 봇 오피스 does, and hand back its pane id. */
  async function botPane(): Promise<string> {
    const pane = await openBotThreadPane(botSummary("bot-1", "리뷰 봇"));
    expect(pane).not.toBeNull();
    return pane!.id;
  }

  it("queues the turn instead of streaming it when the server answers 202", async () => {
    const queued = taskOf({ id: "t-queued", status: "queued", title: "PR 42 리뷰" });
    stubFetch((url) => {
      if (url === "/api/chat/stream") {
        // 202 is `ok`, so nothing but an explicit branch keeps this JSON body
        // out of the SSE reader.
        return { ok: true, status: 202, json: async () => ({ queued: true, task: queued }) };
      }
      return undefined;
    });
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1" });
    const paneId = await botPane();

    await sendMessage(paneId, "PR 42 봐줘");

    const pane = readState().chatPanes.find((item) => item.id === paneId)!;
    // The turn is NOT live: no stream ever opened.
    expect(pane.streaming).toBe(false);
    expect(readState().streaming).toBe(false);
    // …but the owner's message stays in the transcript and the composer is clear.
    expect(pane.messages.map((message) => message.content)).toEqual(["PR 42 봐줘"]);
    expect(pane.draft).toBe("");
    expect(readState().botTasks.map((task) => task.id)).toEqual(["t-queued"]);
    expect(get(toasts).at(-1)?.message).toContain("대기열에 추가했어요");
  });

  it("takes the task board off `bot_task` frames, never off the SDK `task` rows", async () => {
    const reported = taskOf({ id: "t-sse", status: "running", startedAt: "2026-08-19T00:00:01.000Z" });
    stubFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv-sse", runId: "run-1" }],
          ["bot_task", { task: reported }],
          // `task`/`task_end` are the SDK ACTIVITY rows (keyed on taskId) — a
          // different record entirely, and none of them may reach the board.
          ["task", { taskId: "sdk-1", agentId: "main", subagentType: "worker" }],
          ["task_end", { taskId: "sdk-1", ok: true }],
          doneFrame("conv-sse"),
        ]);
      }
      return undefined;
    });
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1" });
    const paneId = await botPane();

    await sendMessage(paneId, "안녕");

    expect(readState().botTasks.map((task) => task.id)).toEqual(["t-sse"]);
    expect(readState().botTasks[0].status).toBe("running");
  });

  it("ignores a `bot_task` frame carrying a malformed row", async () => {
    stubFetch((url) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          ["open", { conversationId: "conv-junk", runId: "run-2" }],
          ["bot_task", { task: { title: "id 없음" } }],
          doneFrame("conv-junk"),
        ]);
      }
      return undefined;
    });
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1" });
    const paneId = await botPane();

    await sendMessage(paneId, "안녕");

    expect(readState().botTasks).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* routing — the #/bots/<agentId> argument survives                     */
/* ------------------------------------------------------------------ */

describe("bots route", () => {
  it("keeps the selected bot in currentRoute()", () => {
    seed({ botsAgentId: "bot-1" });
    // This is what syncHash(true) writes on EVERY send (the run stream's `open`
    // frame) — without the bots branch it would rewrite the URL to "#/bots".
    expect(currentRoute()).toBe("#/bots/bot-1");

    replaceState({ botsAgentId: "" });
    expect(currentRoute()).toBe("#/bots");

    replaceState({ botsAgentId: "봇/1" });
    expect(currentRoute()).toBe(`#/bots/${encodeURIComponent("봇/1")}`);
  });

  it("reads the agent id back out of a bookmarked hash", () => {
    seed({ view: "explore", botsAgentId: "" });
    history.replaceState(null, "", `#/bots/${encodeURIComponent("bot-7")}`);

    applyInitialRoute();

    expect(readState().view).toBe("bots");
    expect(readState().botsAgentId).toBe("bot-7");
  });

  it("bounces a non-admin to 탐색 instead of opening the view", () => {
    seed({ user: userOf({ roles: [] }), view: "explore" });

    goView("bots", "bot-1");

    expect(readState().view).toBe("explore");
  });
});
