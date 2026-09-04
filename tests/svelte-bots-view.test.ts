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

import BotTaskCard from "../src/client/src/components/BotTaskCard.svelte";
import BotsView from "../src/client/src/views/BotsView.svelte";
import { cancelBotTask, openBotThreadPane, sendMessage } from "../src/client/src/lib/chat.js";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
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
    browserSecrets: [],
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
    seenAt: null,
    routineJobId: null,
    delegatedByAgentId: null,
    delegationDepth: 0,
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

afterEach(async () => {
  // The confirm queue is a module singleton: a request left open would be
  // handed to the NEXT test's click, which then acts on the wrong bot.
  for (let guard = 0; guard < 5 && get(confirmation); guard += 1) {
    resolveConfirmation(false);
    await Promise.resolve();
  }
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
/* task card — chips, detail line, the one control                     */
/* ------------------------------------------------------------------ */

// The card itself moved out of this view in stage 2: it now renders INSIDE the
// transcript (see svelte-bots-thread.test.ts for the anchoring), so what it says
// on its own is pinned against the component, not against 봇 오피스.
describe("BotTaskCard", () => {
  it("speaks the Korean status vocabulary and shows the one line that status makes actionable", () => {
    const cases: [Partial<BotTask>, string, string | null][] = [
      [{ status: "queued" }, "대기 중", null],
      [{ status: "running" }, "실행 중", null],
      [{ status: "waiting_input", pendingQuestion: "스테이징에 먼저 올릴까요?" }, "입력 대기", "스테이징에 먼저 올릴까요?"],
      [{ status: "done", resultSummary: "3건 정리 완료" }, "완료", "3건 정리 완료"],
      [{ status: "failed", error: "권한이 없습니다" }, "실패", "권한이 없습니다"],
      [{ status: "cancelled" }, "취소됨", null],
    ];
    for (const [over, chip, detail] of cases) {
      const { container, unmount } = render(BotTaskCard, { props: { task: taskOf(over) } });
      expect(container.querySelector(".bots-task-chip")?.textContent?.trim()).toBe(chip);
      expect(container.querySelector(".bots-task-detail")?.textContent ?? null).toBe(detail);
      unmount();
    }
  });

  it("stops work under way, cancels work not yet started, and leaves finished work alone", () => {
    const labels = (["running", "queued", "waiting_input", "done", "failed", "cancelled"] as const).map(
      (status) => {
        const { container, unmount } = render(BotTaskCard, { props: { task: taskOf({ status }) } });
        const label = container.querySelector(".bots-task-actions button")?.textContent?.trim() ?? null;
        unmount();
        return [status, label];
      },
    );
    expect(labels).toEqual([
      ["running", "중지"],
      ["queued", "취소"],
      ["waiting_input", "취소"],
      ["done", null],
      ["failed", null],
      ["cancelled", null],
    ]);
  });

  it("marks a task a schedule fired as 예약, and leaves a task the owner typed unmarked", () => {
    for (const compact of [false, true]) {
      const fired = render(BotTaskCard, {
        props: { task: taskOf({ id: "t-sched", routineJobId: "routine-1" }), compact },
      });
      const chip = fired.container.querySelector(".bots-task-sched");
      // 두 글자 칩만으로는 무엇의 예약인지 모른다 — 눈에 보이는 라벨과 낭독
      // 텍스트가 따로 있고, 상태 칩은 그대로 자기 자리를 지킨다.
      expect(chip?.querySelector("[aria-hidden='true']")?.textContent?.trim()).toBe("예약");
      expect(chip?.querySelector(".sr-only")?.textContent?.trim()).toBe("예약 작업이 자동으로 맡긴 작업");
      expect(chip?.getAttribute("title")).toBe("예약 작업이 자동으로 맡긴 작업");
      expect(fired.container.querySelector(".bots-task-chip")?.textContent?.trim()).toBe("대기 중");
      fired.unmount();

      const typed = render(BotTaskCard, { props: { task: taskOf({ id: "t-typed" }), compact } });
      expect(typed.container.querySelector(".bots-task-sched")).toBeNull();
      typed.unmount();
    }
  });

  it("names the bot that handed a task off, and leaves work the owner typed unmarked", () => {
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-9", "수집 봇"), botSummary("bot-7", "빌드 도우미")],
    });

    const handed = render(BotTaskCard, {
      props: { task: taskOf({ id: "t-deleg", delegatedByAgentId: "bot-9", delegationDepth: 1 }) },
    });
    const chip = handed.container.querySelector(".bots-task-delegated");
    // "위임" 두 글자로는 누가 넘겼는지 알 수 없으므로 낭독 텍스트와 툴팁이 출처를
    // 이름으로 댄다. 상태 칩은 그대로 자기 자리를 지킨다.
    expect(chip?.querySelector("[aria-hidden='true']")?.textContent?.trim()).toBe("위임");
    expect(chip?.querySelector(".sr-only")?.textContent?.trim()).toBe("수집 봇이 위임한 작업");
    expect(chip?.getAttribute("title")).toBe("수집 봇이 위임한 작업");
    expect(handed.container.querySelector(".bots-task-chip")?.textContent?.trim()).toBe("대기 중");
    handed.unmount();

    // 이름이 "봇"으로 끝나지 않는 봇에게만 호칭을 붙인다 — 위의 "수집 봇"에까지
    // 붙였다면 "수집 봇 봇이"가 됐을 것이다.
    const plainName = render(BotTaskCard, {
      props: { task: taskOf({ id: "t-plain", delegatedByAgentId: "bot-7", delegationDepth: 1 }) },
    });
    expect(plainName.container.querySelector(".bots-task-delegated")?.getAttribute("title")).toBe(
      "빌드 도우미 봇이 위임한 작업",
    );
    plainName.unmount();

    const typed = render(BotTaskCard, { props: { task: taskOf({ id: "t-typed" }) } });
    expect(typed.container.querySelector(".bots-task-delegated")).toBeNull();
    typed.unmount();
  });

  it("credits the main avatar for a source-less hand-off, and still marks one whose bot it cannot name", () => {
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")] });

    // 깊이는 1인데 출처 봇이 없다 = 주인의 메인 아바타가 넘긴 일.
    const fromAvatar = render(BotTaskCard, {
      props: { task: taskOf({ id: "t-avatar", delegatedByAgentId: null, delegationDepth: 1 }) },
    });
    expect(fromAvatar.container.querySelector(".bots-task-delegated")?.getAttribute("title")).toBe(
      "아바타가 위임한 작업",
    );
    fromAvatar.unmount();

    // 로스터가 아직 없거나 그 봇이 지워졌어도 "내가 시킨 게 아니다"까지는 말한다.
    seed({ avatars: [] });
    const unnamed = render(BotTaskCard, {
      props: { task: taskOf({ id: "t-unknown", delegatedByAgentId: "bot-gone", delegationDepth: 2 }) },
    });
    expect(unnamed.container.querySelector(".bots-task-delegated")?.getAttribute("title")).toBe(
      "다른 봇이 위임한 작업",
    );
    unnamed.unmount();
  });

  it("picks the delegating bot's name up when the roster arrives after the card", async () => {
    seed({ avatars: [] });
    const { container } = render(BotTaskCard, {
      props: { task: taskOf({ id: "t-late", delegatedByAgentId: "bot-9", delegationDepth: 1 }) },
    });
    expect(container.querySelector(".bots-task-delegated")?.getAttribute("title")).toBe("다른 봇이 위임한 작업");

    // 이름 맵을 헬퍼 안에서 읽었다면 여기서 값이 굳는다 — 바뀐 것이 스토어뿐이라
    // task prop은 그대로이고, 카드는 그래도 따라가야 한다.
    replaceState({ avatars: [botSummary("bot-9", "수집 봇")] });

    await waitFor(() =>
      expect(container.querySelector(".bots-task-delegated")?.getAttribute("title")).toBe("수집 봇이 위임한 작업"),
    );
  });

  it("names the task in the control's accessible name and keeps that name stable while busy", async () => {
    const task = taskOf({ id: "t-q", status: "queued", title: "PR 42 리뷰" });
    const onCancel = vi.fn();
    const { container, rerender } = render(BotTaskCard, { props: { task, busy: false, onCancel } });

    const button = container.querySelector(".bots-task-actions button")!;
    expect(button.getAttribute("aria-label")).toBe("PR 42 리뷰 취소");
    expect(button.getAttribute("aria-busy")).toBe("false");
    await fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledWith(task);

    // Busy rides aria-busy + the visible label; the accessible NAME must not move
    // under a screen reader mid-press.
    await rerender({ task, busy: true, onCancel });
    expect(button.getAttribute("aria-label")).toBe("PR 42 리뷰 취소");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("취소하는 중…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* summary bar, 입력 대기 인박스, roster secondary line + unseen chip    */
/* ------------------------------------------------------------------ */

describe("BotsView board", () => {
  it("summarizes only the states that are actually in play for the selected bot", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      botTasks: [
        taskOf({ id: "t-run", status: "running" }),
        taskOf({ id: "t-q1", status: "queued" }),
        taskOf({ id: "t-q2", status: "queued" }),
        // Terminal work is not "in play", and another bot's queue is not mine.
        taskOf({ id: "t-done", status: "done" }),
        taskOf({ id: "t-other", agentId: "bot-2", status: "queued" }),
      ],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelector(".bots-summary-text")).not.toBeNull());
    expect(container.querySelector(".bots-summary-text")?.textContent?.trim()).toBe("실행 중 1 · 대기열 2");
  });

  it("says nothing about counts when nothing is in play, but keeps the header row", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-done", status: "done" })],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    // The row doubles as the selected bot's header (it carries 삭제), so it stays
    // — but it must still not invent a count line out of terminal work alone.
    expect(container.querySelector(".bots-summary-text")).toBeNull();
    expect(container.querySelector(".bots-summary-delete")).not.toBeNull();
  });

  it("collects every bot's waiting question into the inbox and selects that bot on click", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      botTasks: [
        taskOf({ id: "t-ask-2", agentId: "bot-2", status: "waiting_input", pendingQuestion: "어느 폴더에 쓸까요?" }),
        taskOf({ id: "t-ask-1", agentId: "bot-1", status: "waiting_input", pendingQuestion: "스테이징 먼저?" }),
        // Anything not waiting on ME stays out of the inbox.
        taskOf({ id: "t-run", agentId: "bot-1", status: "running" }),
      ],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-inbox-row").length).toBe(2));

    expect(
      [...container.querySelectorAll(".bots-inbox-row")].map((row) => [
        row.querySelector(".bots-inbox-bot")?.textContent?.trim(),
        row.querySelector(".bots-inbox-question")?.textContent?.trim(),
      ]),
    ).toEqual([
      ["문서 봇", "어느 폴더에 쓸까요?"],
      ["리뷰 봇", "스테이징 먼저?"],
    ]);

    await fireEvent.click(container.querySelectorAll(".bots-inbox-row")[0]);
    expect(readState().botsAgentId).toBe("bot-2");
    expect(location.hash).toBe("#/bots/bot-2");
  });

  it("keeps the inbox out of the DOM entirely when no bot is waiting", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-run", status: "running" })],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-roster-row").length).toBe(1));
    expect(container.querySelector(".bots-inbox")).toBeNull();
  });

  it("carries each bot's latest task and its unseen count on the roster row", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      botTasks: [
        // botTasks is newest-first, so the head of a bot's rows IS its latest.
        taskOf({ id: "t-new", agentId: "bot-1", status: "done", title: "회의록 정리", seenAt: null }),
        taskOf({ id: "t-old", agentId: "bot-1", status: "failed", title: "지난 일", seenAt: null }),
        // A running row is never "unseen" — its own motion is the signal — and a
        // settled row the owner already looked at drops out too.
        taskOf({ id: "t-run", agentId: "bot-2", status: "running", title: "빌드" }),
        taskOf({ id: "t-seen", agentId: "bot-2", status: "done", title: "봤음", seenAt: "2026-08-19T01:00:00.000Z" }),
      ],
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(container.querySelectorAll(".bots-roster-row").length).toBe(2));

    expect([...container.querySelectorAll(".bots-roster-row")].map((row) => [
      row.querySelector(".bots-roster-task")?.textContent?.trim() ?? null,
      row.querySelector(".bots-roster-unseen")?.textContent?.trim() ?? null,
    ])).toEqual([
      ["회의록 정리 · 완료", "2"],
      ["빌드 · 실행 중", null],
    ]);
  });

  it("marks the selected bot's lane seen once its thread is open, then re-reads the rows", async () => {
    const calls = stubFetch((url, method) => {
      if (url.includes("/bot-tasks/seen") && method === "POST") return { total: 0, agents: {} };
      return undefined;
    });
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-done", status: "done", seenAt: null })],
    });

    render(BotsView);

    await waitFor(() =>
      expect(calls.some((call) => call.url === "/api/me/bot-tasks/seen" && call.method === "POST")).toBe(true),
    );
    // Narrowed to the bot whose lane the owner is actually looking at.
    expect(JSON.parse(calls.find((call) => call.url === "/api/me/bot-tasks/seen")!.body!)).toEqual({
      agentId: "bot-1",
    });
    // The stamp lands server-side, so the board is re-read rather than patched.
    await waitFor(() =>
      expect(calls.filter((call) => call.url.startsWith("/api/me/bot-tasks?")).length).toBeGreaterThan(1),
    );
  });

  it("offers the conversational path to a first bot alongside the settings one", async () => {
    stubFetch();
    seed({ avatars: [] });

    render(BotsView);
    await screen.findByText("아직 만든 봇이 없습니다");

    await fireEvent.click(screen.getByRole("button", { name: "대화로 봇 만들기" }));

    // A bot is minted CONVERSATIONALLY: the CTA only seeds my own avatar's
    // composer and hands the send back to me.
    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(readState().view).toBe("chat");
    expect(readState().chatPanes[0].draft).toContain("내 봇을 새로 만들고 싶어");
    expect(get(toasts).at(-1)?.message).toContain("보내기를 누르면");
  });
});

/* ------------------------------------------------------------------ */
/* 삭제 — the destructive control lives on the SELECTED bot's header    */
/* ------------------------------------------------------------------ */

describe("BotsView 봇 삭제", () => {
  /** The header's delete control, or null when the header offers none. */
  function deleteButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(".bots-summary-delete");
  }

  /**
   * Answer every endpoint the delete path walks: the roster read that carries
   * `memoryDir` (AvatarSummary's bot tag does not), the DELETE itself, the
   * re-read of /api/avatars, and the detail pull for whichever bot takes over.
   */
  function stubDelete(remaining: AvatarSummary[], over: (url: string, method: string) => unknown = () => undefined) {
    return stubFetch((url, method) => {
      const answered = over(url, method);
      if (answered !== undefined) return answered;
      if (url === "/api/me/agents" && method === "GET") {
        return {
          agents: [
            { id: "bot-1", memoryDir: "review-bot-1a2b" },
            { id: "bot-2", memoryDir: "docs-bot-9f0e" },
          ],
        };
      }
      if (url === "/api/avatars") return { avatars: remaining };
      for (const bot of remaining) {
        if (url.includes(`/api/avatars/${encodeURIComponent(bot.id)}`)) return { avatar: detailOf(bot) };
      }
      return undefined;
    });
  }

  it("offers no delete when there is no bot on screen to delete", async () => {
    stubFetch();
    seed({ avatars: [], streaming: false });
    const empty = render(BotsView);
    await screen.findByText("아직 만든 봇이 없습니다");
    expect(deleteButton(empty.container)).toBeNull();
    empty.unmount();

    // A bookmark pointing at an already-deleted bot is the other no-selection
    // state — there is nothing there to act on either.
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-gone", streaming: false });
    const dangling = render(BotsView);
    await screen.findByText("그 봇을 찾을 수 없어요. 왼쪽에서 다른 봇을 선택하세요.");
    expect(deleteButton(dangling.container)).toBeNull();
  });

  it("locks the delete while the bot's turn is running, and says why", async () => {
    stubFetch();
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1", streaming: false });

    const { container } = render(BotsView);
    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    expect(deleteButton(container)!.disabled).toBe(false);
    expect(deleteButton(container)!.getAttribute("title")).toBe("이 봇과의 모든 대화 기록이 함께 삭제됩니다");

    // `streaming` is DERIVED from the panes on every store write, so the flag
    // itself cannot be seeded — the pane has to be the one that is running.
    replaceState({ chatPanes: readState().chatPanes.map((pane) => ({ ...pane, streaming: true })) });
    expect(readState().streaming).toBe(true);

    // A disabled button whose prerequisite is unstated reads as broken.
    await waitFor(() => expect(deleteButton(container)!.disabled).toBe(true));
    expect(deleteButton(container)!.getAttribute("title")).toBe("실행 중인 작업이 끝난 뒤 삭제할 수 있습니다");
  });

  it("locks the delete while a dispatched task runs with no stream attached", async () => {
    stubFetch();
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-run", agentId: "bot-1", status: "running" })],
      streaming: false,
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(deleteButton(container)).not.toBeNull());
    // The dispatcher's unattended run never streams to THIS client, so the
    // pane-derived flag stays false — the running task row is the only signal.
    expect(readState().streaming).toBe(false);
    expect(deleteButton(container)!.disabled).toBe(true);
    expect(deleteButton(container)!.getAttribute("title")).toBe("실행 중인 작업이 끝난 뒤 삭제할 수 있습니다");
  });

  it("refuses the delete when a task starts while the confirm is open", async () => {
    const calls = stubDelete([botSummary("bot-2", "문서 봇")]);
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      streaming: false,
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(deleteButton(container)).not.toBeNull());
    await fireEvent.click(deleteButton(container)!);
    await waitFor(() => expect(get(confirmation)).not.toBeNull());

    // The dispatcher started a queued task while the owner was reading the
    // confirm — the entry check already passed, so the post-confirm re-check
    // is what has to catch it.
    replaceState({ botTasks: [taskOf({ id: "t-run", agentId: "bot-1", status: "running" })] });
    resolveConfirmation(true);

    await waitFor(() => expect(get(toasts).at(-1)?.message).toBe("실행 중인 작업이 끝난 뒤 삭제할 수 있습니다."));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(readState().botsAgentId).toBe("bot-1");
  });

  it("leaves everything in place when the confirm is declined", async () => {
    const calls = stubDelete([botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")]);
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      streaming: false,
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(deleteButton(container)).not.toBeNull());
    await fireEvent.click(deleteButton(container)!);

    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(false);

    await waitFor(() => expect(deleteButton(container)!.disabled).toBe(false));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(readState().botsAgentId).toBe("bot-1");
  });

  it("names the memory folder that SURVIVES the delete before asking", async () => {
    stubDelete([botSummary("bot-2", "문서 봇")]);
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      streaming: false,
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(deleteButton(container)).not.toBeNull());
    await fireEvent.click(deleteButton(container)!);

    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    const request = get(confirmation)!;
    // The folder name is not on the avatar row, so it is read from the owner's
    // bot listing at click time — a wrong path here would be a lie about data.
    expect(request.message).toContain("봇의 기억 폴더(지식 저장소의 agents/review-bot-1a2b/)는 삭제되지 않고 남습니다.");
    expect(request.message).toContain("모든 대화 기록이 함께 삭제되며");
    expect(request.message).toContain("비활성화");
    expect(request.title).toBe("봇을 삭제할까요?");
    expect(request.confirmLabel).toBe("삭제");
    expect(request.tone).toBe("danger");

    resolveConfirmation(false);
    await waitFor(() => expect(deleteButton(container)!.disabled).toBe(false));
  });

  it("deletes the bot, then hands the thread to the next one", async () => {
    const calls = stubDelete([botSummary("bot-2", "문서 봇")]);
    seed({
      avatars: [botSummary("bot-1", "리뷰 봇"), botSummary("bot-2", "문서 봇")],
      botsAgentId: "bot-1",
      botTasks: [taskOf({ id: "t-old", agentId: "bot-1", status: "done" })],
      streaming: false,
    });

    const { container } = render(BotsView);
    await waitFor(() => expect(readState().chatPanes[0]?.avatar.id).toBe(avatarIdOf("bot-1")));
    await fireEvent.click(deleteButton(container)!);
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.method === "DELETE")!.url).toBe("/api/me/agents/bot-1");
    expect(get(toasts).at(-1)?.message).toContain("삭제했습니다");

    // Refreshing the roster alone would leave the DELETED bot's pane rendering,
    // so the next bot has to actually take the thread over.
    await waitFor(() => expect(readState().botsAgentId).toBe("bot-2"));
    await waitFor(() => expect(readState().chatPanes.map((pane) => pane.avatar.id)).toEqual([avatarIdOf("bot-2")]));
    expect(location.hash).toBe("#/bots/bot-2");
    // …and the rows the server just dropped do not linger: the task merge keeps
    // anything a response omits, so they have to go locally too.
    expect(readState().botTasks).toEqual([]);
    expect(calls.some((call) => call.url === "/api/avatars")).toBe(true);
    expect(calls.some((call) => call.url.includes("/bot-tasks/unseen"))).toBe(true);
    await waitFor(() => expect(deleteButton(container)!.disabled).toBe(false));
  });

  it("clears the selection and the thread when the last bot goes", async () => {
    stubDelete([]);
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1", streaming: false });

    const { container } = render(BotsView);
    await waitFor(() => expect(readState().chatPanes.length).toBe(1));
    await fireEvent.click(deleteButton(container)!);
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);

    await waitFor(() => expect(readState().botsAgentId).toBe(""));
    // closePane would rebuild a pane from currentAvatar — i.e. the bot that was
    // just deleted — so the pane list has to be emptied outright.
    expect(readState().chatPanes).toEqual([]);
    await screen.findByText("아직 만든 봇이 없습니다");
    expect(location.hash).toBe("#/bots");
  });

  it("keeps the bot selected when the delete fails", async () => {
    stubDelete([botSummary("bot-1", "리뷰 봇")], (url, method) =>
      url.startsWith("/api/me/agents/") && method === "DELETE"
        ? { ok: false, status: 500, json: async () => ({ error: "서버가 응답하지 않습니다" }) }
        : undefined,
    );
    seed({ avatars: [botSummary("bot-1", "리뷰 봇")], botsAgentId: "bot-1", streaming: false });

    const { container } = render(BotsView);
    await waitFor(() => expect(deleteButton(container)).not.toBeNull());
    await fireEvent.click(deleteButton(container)!);
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);

    await waitFor(() => expect(get(toasts).at(-1)?.message).toContain("봇 삭제 실패"));
    expect(get(toasts).at(-1)?.message).toContain("서버가 응답하지 않습니다");
    expect(readState().botsAgentId).toBe("bot-1");
    await waitFor(() => expect(deleteButton(container)!.disabled).toBe(false));
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

  // Cancel lives in lib/chat because the button that presses it now rides the
  // CARD, which renders inside the transcript rather than in 봇 오피스 itself.
  it("cancels a queued task through the API and adopts the row it returns", async () => {
    const cancelled = taskOf({ id: "t-q", status: "cancelled", finishedAt: "2026-08-19T00:05:00.000Z" });
    const calls = stubFetch((url, method) => {
      if (url.includes("/bot-tasks/") && method === "POST") return { task: cancelled };
      return undefined;
    });
    seed({ botTasks: [taskOf({ id: "t-q", status: "queued" })] });

    await cancelBotTask(taskOf({ id: "t-q", status: "queued" }));

    expect(calls.find((call) => call.method === "POST")!.url).toBe("/api/me/bot-tasks/t-q/cancel");
    // The response REPLACES the row rather than being re-fetched.
    expect(readState().botTasks.find((task) => task.id === "t-q")?.status).toBe("cancelled");
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
    seed({ botTasks: [taskOf({ id: "t-run", status: "running" })] });

    await cancelBotTask(taskOf({ id: "t-run", status: "running" }));

    expect(calls.find((call) => call.method === "POST")!.url).toBe("/api/me/bot-tasks/t-run/cancel");
    // The row is adopted AS-IS — the UI must not pretend the task ended.
    expect(readState().botTasks[0].status).toBe("running");
    expect(get(toasts).at(-1)?.message).toContain("중지 요청을 보냈어요");
  });

  it("leaves the row alone when the stop request fails", async () => {
    stubFetch((url, method) => {
      if (url.includes("/bot-tasks/") && method === "POST")
        return { ok: false, status: 500, json: async () => ({ error: "서버가 응답하지 않습니다" }) };
      return undefined;
    });
    seed({ botTasks: [taskOf({ id: "t-run", status: "running" })] });

    await cancelBotTask(taskOf({ id: "t-run", status: "running" }));

    expect(readState().botTasks[0].status).toBe("running");
    expect(get(toasts).at(-1)?.message).toContain("중지하지 못했습니다");
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
