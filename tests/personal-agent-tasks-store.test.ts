import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("personal-agent-tasks-store");

function services(dir: string) {
  return createServices({
    dataDir: path.join(tempDir(), dir),
    agentRuntime: "local",
    sessionSecret: "t",
  });
}

function makeUser(store: ReturnType<typeof services>["store"], username: string) {
  return store.createUser({ username, displayName: username, password: "password123" });
}

/** One owner + one bot + a `task()` factory defaulting every field to that pair. */
function fixture(dir: string) {
  const { store } = services(dir);
  const owner = makeUser(store, "owner");
  const bot = store.createPersonalAgent(owner.id, { displayName: "일하는 봇" });
  const task = (
    opts: {
      agentId?: string;
      conversationId?: string;
      title?: string;
      status?: "queued" | "running";
      runId?: string;
      routineJobId?: string;
    } = {},
  ) => {
    const title = opts.title ?? "작업";
    return store.createBotTask({
      ownerUserId: owner.id,
      agentId: opts.agentId ?? bot.id,
      conversationId: opts.conversationId ?? "c1",
      title,
      requestText: `${title} 해줘`,
      status: opts.status ?? "queued",
      runId: opts.runId,
      routineJobId: opts.routineJobId,
    });
  };
  return { store, owner, bot, task };
}

describe("store bot tasks", () => {
  it("stamps startedAt + runId only when the task is created RUNNING", () => {
    const { store, owner, bot, task } = fixture("create");

    const queued = task({ title: "대기 작업" });
    expect(queued.id).toBeTruthy();
    expect(queued.createdAt).toBeTruthy();
    expect(queued).toMatchObject({
      ownerUserId: owner.id,
      agentId: bot.id,
      conversationId: "c1",
      title: "대기 작업",
      requestText: "대기 작업 해줘",
      status: "queued",
      runId: null,
      startedAt: null,
      finishedAt: null,
      reportedOutcome: null,
      resultSummary: null,
      pendingQuestion: null,
      error: null,
      model: null,
    });
    expect(store.getBotTask(queued.id)).toEqual(queued);
    expect(store.getBotTask("ghost")).toBeNull();

    // The attended path starts already running: one timestamp for both stamps.
    const running = task({ title: "즉시 작업", status: "running", runId: "run-1" });
    expect(running.status).toBe("running");
    expect(running.runId).toBe("run-1");
    expect(running.startedAt).toBe(running.createdAt);

    // A runId handed to a QUEUED create is dropped — nothing is running yet.
    expect(task({ title: "대기 2", runId: "run-x" }).runId).toBeNull();
  });

  it("lists an owner's tasks newest-first, filtered by bot and capped by limit", () => {
    const { store, owner, bot, task } = fixture("list");
    const other = store.createPersonalAgent(owner.id, { displayName: "다른 봇" });
    const stranger = makeUser(store, "stranger");

    const first = task({ title: "1" });
    const second = task({ agentId: other.id, conversationId: "c2", title: "2" });
    const third = task({ title: "3" });
    store.createBotTask({
      ownerUserId: stranger.id,
      agentId: "s-bot",
      conversationId: "s1",
      title: "남의 작업",
      requestText: "x",
      status: "queued",
    });

    expect(store.listBotTasks(owner.id).map((t) => t.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect(store.listBotTasks(owner.id, { agentId: bot.id }).map((t) => t.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect(store.listBotTasks(owner.id, { agentId: other.id }).map((t) => t.id)).toEqual([
      second.id,
    ]);
    expect(store.listBotTasks(owner.id, { limit: 2 }).map((t) => t.id)).toEqual([
      third.id,
      second.id,
    ]);
    // Owner-scoped: another owner's rows never leak in, either direction.
    expect(store.listBotTasks(stranger.id).map((t) => t.title)).toEqual(["남의 작업"]);
    expect(store.listBotTasks("ghost")).toEqual([]);
    // A non-positive limit falls back to the default, never to SQLite's LIMIT 0.
    expect(store.listBotTasks(owner.id, { limit: 0 })).toHaveLength(3);
  });

  it("lists ONE thread's tasks oldest-first (transcript order)", () => {
    const { store, task } = fixture("list-conv");
    const a = task({ conversationId: "c1", title: "A" });
    task({ conversationId: "c2", title: "B" });
    const c = task({ conversationId: "c1", title: "C" });

    expect(store.listBotTasksForConversation("c1").map((t) => t.id)).toEqual([a.id, c.id]);
    // The limit trims the NEWEST end, keeping the oldest card first.
    expect(store.listBotTasksForConversation("c1", { limit: 1 }).map((t) => t.id)).toEqual([
      a.id,
    ]);
    expect(store.listBotTasksForConversation("c2").map((t) => t.title)).toEqual(["B"]);
    expect(store.listBotTasksForConversation("ghost")).toEqual([]);
  });

  it("drains a thread's queue FIFO, counting only 'queued'", () => {
    const { store, task } = fixture("queue");
    expect(store.nextQueuedBotTask("c1")).toBeNull();
    expect(store.countQueuedBotTasks("c1")).toBe(0);

    const q1 = task({ title: "첫째" });
    const q2 = task({ title: "둘째" });
    const live = task({ title: "실행중", status: "running", runId: "run-1" });
    const elsewhere = task({ conversationId: "c2", title: "다른 방" });

    // A RUNNING task is not backlog, and the queue is per conversation.
    expect(store.countQueuedBotTasks("c1")).toBe(2);
    expect(store.countQueuedBotTasks("c2")).toBe(1);
    expect(store.nextQueuedBotTask("c1")?.id).toBe(q1.id);
    expect(store.nextQueuedBotTask("c2")?.id).toBe(elsewhere.id);

    expect(store.markBotTaskRunning(q1.id, "run-2")?.status).toBe("running");
    expect(store.countQueuedBotTasks("c1")).toBe(1);
    expect(store.nextQueuedBotTask("c1")?.id).toBe(q2.id);

    expect(store.markBotTaskRunning(q2.id, "run-3")).not.toBeNull();
    expect(store.nextQueuedBotTask("c1")).toBeNull();
    expect(store.countQueuedBotTasks("c1")).toBe(0);
    expect(store.getBotTask(live.id)?.status).toBe("running");
  });

  it("carries 봇 루틴 provenance: dedupe by QUEUE, outcome by the newest row", () => {
    const { store, task } = fixture("routine-provenance");

    // Owner-typed work carries no routine id, and an unknown routine reads empty.
    expect(task({ title: "직접 시킨 일" }).routineJobId).toBeNull();
    expect(store.hasQueuedBotTaskForRoutine("rj-1")).toBe(false);
    expect(store.latestBotTaskForRoutine("rj-1")).toBeNull();

    const fired = task({ title: "예약 실행", routineJobId: "rj-1" });
    expect(fired.routineJobId).toBe("rj-1");
    expect(store.getBotTask(fired.id)!.routineJobId).toBe("rj-1");
    // The scheduler's dedupe key: a firing still WAITING blocks the next cycle,
    // so an unattended queue can't grow one identical task per tick...
    expect(store.hasQueuedBotTaskForRoutine("rj-1")).toBe(true);
    expect(store.hasQueuedBotTaskForRoutine("rj-2")).toBe(false);
    // ...but one already RUNNING does not — that is the thread's current work,
    // which the scheduler queues behind rather than skipping.
    store.markBotTaskRunning(fired.id, "run-1");
    expect(store.hasQueuedBotTaskForRoutine("rj-1")).toBe(false);

    // The newest row for a routine is how a firing reads its own outcome back.
    expect(store.latestBotTaskForRoutine("rj-1")!.id).toBe(fired.id);
    const next = task({ title: "다음 회차", routineJobId: "rj-1" });
    expect(store.latestBotTaskForRoutine("rj-1")!.id).toBe(next.id);
    // Another routine's rows never bleed in, in either direction.
    const foreign = task({ title: "남의 예약", routineJobId: "rj-2" });
    expect(store.latestBotTaskForRoutine("rj-1")!.id).toBe(next.id);
    expect(store.latestBotTaskForRoutine("rj-2")!.id).toBe(foreign.id);
  });

  it("runs the queued→running→report→done chain, keeping the reported summary", () => {
    const { store, task } = fixture("chain-done");
    const t = task({ title: "보고서" });

    const running = store.markBotTaskRunning(t.id, "run-1")!;
    expect(running).toMatchObject({ status: "running", runId: "run-1", finishedAt: null });
    expect(running.startedAt).toBeTruthy();

    const reported = store.setBotTaskReport(t.id, {
      outcome: "done",
      summary: "보고서 작성 완료",
    })!;
    // The report never moves status — the turn finalize owns that.
    expect(reported).toMatchObject({
      status: "running",
      reportedOutcome: "done",
      resultSummary: "보고서 작성 완료",
      pendingQuestion: null,
      runId: "run-1",
    });

    // The finalize passes only what it knows; undefined keeps the stored value.
    const finished = store.finishBotTask(t.id, { status: "done", model: "sonnet" })!;
    expect(finished).toMatchObject({
      status: "done",
      resultSummary: "보고서 작성 완료",
      reportedOutcome: "done",
      model: "sonnet",
      runId: null,
      error: null,
    });
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.startedAt).toBe(running.startedAt);

    // An explicit null CLEARS where undefined kept.
    const cleared = task({ title: "요약 없음" });
    store.markBotTaskRunning(cleared.id, "run-2");
    store.setBotTaskReport(cleared.id, { outcome: "done", summary: "지워질 요약" });
    expect(
      store.finishBotTask(cleared.id, { status: "done", resultSummary: null })?.resultSummary,
    ).toBeNull();

    // A failed leg carries its Korean cause and still stamps finished_at.
    const failed = task({ title: "실패", status: "running", runId: "run-3" });
    const dead = store.finishBotTask(failed.id, { status: "failed", error: "실행 중 오류" })!;
    expect(dead).toMatchObject({ status: "failed", error: "실행 중 오류", runId: null });
    expect(dead.finishedAt).toBeTruthy();
  });

  it("parks a need_input task at waiting_input, and a resume clears the question", () => {
    const { store, task } = fixture("chain-waiting");
    const t = task({ title: "질문 작업" });
    const running = store.markBotTaskRunning(t.id, "run-1")!;

    const reported = store.setBotTaskReport(t.id, {
      outcome: "need_input",
      summary: "어느 저장소인가요?",
    })!;
    expect(reported).toMatchObject({
      status: "running",
      reportedOutcome: "need_input",
      pendingQuestion: "어느 저장소인가요?",
      resultSummary: null,
    });

    // Parked, not finished: pendingQuestion is kept (undefined), the partial
    // summary is written, and the card stays open (finishedAt null).
    const parked = store.finishBotTask(t.id, {
      status: "waiting_input",
      resultSummary: "1단계까지 완료",
      model: "sonnet",
    })!;
    expect(parked).toMatchObject({
      status: "waiting_input",
      pendingQuestion: "어느 저장소인가요?",
      resultSummary: "1단계까지 완료",
      model: "sonnet",
      runId: null,
      finishedAt: null,
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const resumed = store.markBotTaskRunning(t.id, "run-2")!;
      expect(resumed).toMatchObject({
        status: "running",
        runId: "run-2",
        // The answer just arrived, so the bot must report again for this leg.
        pendingQuestion: null,
        reportedOutcome: null,
        // Work already reported survives the resume.
        resultSummary: "1단계까지 완료",
      });
      // startedAt is insert-once: a resume years later keeps the original stamp.
      expect(resumed.startedAt).toBe(running.startedAt);
      expect(resumed.startedAt).not.toBe("2030-01-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }

    const done = store.finishBotTask(t.id, { status: "done", resultSummary: "전부 완료" })!;
    expect(done).toMatchObject({ status: "done", resultSummary: "전부 완료", runId: null });
    expect(done.finishedAt).toBeTruthy();
  });

  it("refuses every illegal transition with null, leaving the row untouched", () => {
    const { store, owner, task } = fixture("illegal");

    // QUEUED: never dispatched, so nothing may finalize or report on it.
    const queued = task({ title: "대기" });
    expect(store.finishBotTask(queued.id, { status: "done", resultSummary: "거짓" })).toBeNull();
    expect(store.setBotTaskReport(queued.id, { outcome: "done", summary: "거짓" })).toBeNull();
    expect(store.getBotTask(queued.id)).toEqual(queued);

    // DONE is terminal: no resurrection, no late report, no double finish.
    const ran = task({ title: "완료", status: "running", runId: "run-1" });
    const done = store.finishBotTask(ran.id, { status: "done", resultSummary: "완료" })!;
    expect(store.markBotTaskRunning(ran.id, "run-2")).toBeNull();
    expect(store.setBotTaskReport(ran.id, { outcome: "need_input", summary: "늦은 질문" })).toBeNull();
    expect(store.finishBotTask(ran.id, { status: "failed", error: "늦은 실패" })).toBeNull();
    expect(store.getBotTask(ran.id)).toEqual(done);

    // WAITING_INPUT takes a resume, but not a report or another finalize.
    const parkedTask = task({ title: "대기중 질문", status: "running", runId: "run-3" });
    const parked = store.finishBotTask(parkedTask.id, {
      status: "waiting_input",
      pendingQuestion: "무엇을?",
    })!;
    expect(store.setBotTaskReport(parkedTask.id, { outcome: "done", summary: "x" })).toBeNull();
    expect(store.finishBotTask(parkedTask.id, { status: "done" })).toBeNull();
    expect(store.getBotTask(parkedTask.id)).toEqual(parked);
    expect(store.markBotTaskRunning(parkedTask.id, "run-4")).not.toBeNull();

    // Unknown ids are null on every mutator.
    expect(store.markBotTaskRunning("ghost", "run-9")).toBeNull();
    expect(store.setBotTaskReport("ghost", { outcome: "done", summary: "x" })).toBeNull();
    expect(store.finishBotTask("ghost", { status: "done" })).toBeNull();
    expect(store.cancelQueuedBotTask("ghost", owner.id)).toBeNull();
  });

  it("cancels a queued OR waiting_input task, and only for its owner", () => {
    const { store, owner, task } = fixture("cancel");
    const stranger = makeUser(store, "stranger");

    const queued = task({ title: "취소할 작업" });
    // Not yours → the same null as "gone", so the id is never confirmed.
    expect(store.cancelQueuedBotTask(queued.id, stranger.id)).toBeNull();
    expect(store.getBotTask(queued.id)?.status).toBe("queued");

    const cancelled = store.cancelQueuedBotTask(queued.id, owner.id)!;
    expect(cancelled).toMatchObject({ status: "cancelled", runId: null });
    expect(cancelled.finishedAt).toBeTruthy();
    // Terminal now — a second cancel is a null no-op.
    expect(store.cancelQueuedBotTask(queued.id, owner.id)).toBeNull();

    // A task parked on a question may be ABANDONED instead of answered; the
    // question itself is left standing so the cancelled card still shows it.
    const parkedTask = task({ title: "질문 대기", status: "running", runId: "run-1" });
    store.setBotTaskReport(parkedTask.id, { outcome: "need_input", summary: "어느 쪽인가요?" });
    const parked = store.finishBotTask(parkedTask.id, { status: "waiting_input" })!;
    expect(parked.status).toBe("waiting_input");
    expect(store.cancelQueuedBotTask(parkedTask.id, stranger.id)).toBeNull();

    const abandoned = store.cancelQueuedBotTask(parkedTask.id, owner.id)!;
    expect(abandoned).toMatchObject({
      status: "cancelled",
      pendingQuestion: "어느 쪽인가요?",
      runId: null,
    });
    expect(abandoned.finishedAt).toBeTruthy();
    // A cancelled task can no longer be resumed by the owner's next message.
    expect(store.markBotTaskRunning(parkedTask.id, "run-2")).toBeNull();

    // A RUNNING task is stopped through the run registry, never here.
    const running = task({ title: "실행중", status: "running", runId: "run-3" });
    expect(store.cancelQueuedBotTask(running.id, owner.id)).toBeNull();
    expect(store.getBotTask(running.id)?.status).toBe("running");

    // Neither is a terminal one from any other path.
    const failed = task({ title: "실패", status: "running", runId: "run-4" });
    store.finishBotTask(failed.id, { status: "failed", error: "오류" });
    expect(store.cancelQueuedBotTask(failed.id, owner.id)).toBeNull();
    expect(store.getBotTask(failed.id)?.status).toBe("failed");
  });

  it("fails a QUEUED task the dispatcher can no longer run, and nothing else", () => {
    const { store, task } = fixture("fail-queued");

    const queued = task({ title: "봇이 사라진 작업" });
    const failed = store.failQueuedBotTask(queued.id, "봇이 삭제되었습니다.")!;
    expect(failed).toMatchObject({
      status: "failed",
      error: "봇이 삭제되었습니다.",
      // Never dispatched: no run to attach to and no start to stamp.
      runId: null,
      startedAt: null,
    });
    expect(failed.finishedAt).toBeTruthy();
    // Terminal now — the dispatcher retrying is a null no-op.
    expect(store.failQueuedBotTask(queued.id, "두 번째")).toBeNull();
    expect(store.getBotTask(queued.id)).toEqual(failed);

    // A task that already reached a run fails through finishBotTask instead.
    const running = task({ title: "실행중", status: "running", runId: "run-1" });
    expect(store.failQueuedBotTask(running.id, "늦은 실패")).toBeNull();
    expect(store.getBotTask(running.id)).toEqual(running);

    // Parked on a question, and already cancelled, are both refused too.
    const parkedTask = task({ title: "질문 대기", status: "running", runId: "run-2" });
    const parked = store.finishBotTask(parkedTask.id, { status: "waiting_input" })!;
    expect(store.failQueuedBotTask(parkedTask.id, "늦은 실패")).toBeNull();
    expect(store.getBotTask(parkedTask.id)).toEqual(parked);

    expect(store.failQueuedBotTask("ghost", "없음")).toBeNull();
  });

  it("scans threads with backlog, longest-waiting first, one entry per thread", () => {
    const { store, owner, task } = fixture("queue-scan");
    expect(store.listConversationIdsWithQueuedBotTasks()).toEqual([]);

    vi.useFakeTimers();
    try {
      // c1's backlog starts LATER than c2's, so c2 leads despite c1 being
      // enqueued first and holding more rows.
      vi.setSystemTime(new Date("2030-01-01T00:00:03.000Z"));
      const c1First = task({ conversationId: "c1", title: "c1 첫째" });
      vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z"));
      const c2Only = task({ conversationId: "c2", title: "c2 하나" });
      vi.setSystemTime(new Date("2030-01-01T00:00:05.000Z"));
      task({ conversationId: "c1", title: "c1 둘째" });
      // A thread with no QUEUED row never appears, whatever else it holds.
      task({ conversationId: "c3", title: "실행중", status: "running", runId: "run-1" });

      expect(store.listConversationIdsWithQueuedBotTasks()).toEqual(["c2", "c1"]);

      // Draining c2 drops it from the scan; c1 keeps its slot on its remaining
      // row, and the position follows the OLDEST survivor, not the newest.
      expect(store.cancelQueuedBotTask(c2Only.id, owner.id)).not.toBeNull();
      expect(store.listConversationIdsWithQueuedBotTasks()).toEqual(["c1"]);

      // Every terminal path removes a row from the scan, dispatch included.
      expect(store.markBotTaskRunning(c1First.id, "run-2")).not.toBeNull();
      expect(store.listConversationIdsWithQueuedBotTasks()).toEqual(["c1"]);
      const last = store.nextQueuedBotTask("c1")!;
      expect(store.failQueuedBotTask(last.id, "봇 없음")).not.toBeNull();
      expect(store.listConversationIdsWithQueuedBotTasks()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps interrupted RUNNING tasks to failed, leaving the queue intact", () => {
    const { store, task } = fixture("sweep");
    const r1 = task({ title: "실행 1", status: "running", runId: "run-1" });
    const r2 = task({ conversationId: "c2", title: "실행 2", status: "running", runId: "run-2" });
    const queued = task({ title: "대기" });
    const ran = task({ title: "완료", status: "running", runId: "run-3" });
    store.finishBotTask(ran.id, { status: "done", resultSummary: "완료" });

    expect(store.sweepInterruptedBotTasks("서버가 재시작되어 중단되었습니다.")).toBe(2);
    for (const id of [r1.id, r2.id]) {
      const swept = store.getBotTask(id)!;
      expect(swept).toMatchObject({
        status: "failed",
        error: "서버가 재시작되어 중단되었습니다.",
        runId: null,
      });
      expect(swept.finishedAt).toBeTruthy();
    }
    // Never dispatched / already terminal rows are untouched.
    expect(store.getBotTask(queued.id)?.status).toBe("queued");
    expect(store.getBotTask(ran.id)?.status).toBe("done");
    // The next boot finds nothing running.
    expect(store.sweepInterruptedBotTasks("x")).toBe(0);
  });

  it("counts only SETTLED unseen tasks, per bot and per owner", () => {
    const { store, owner, bot, task } = fixture("unseen-count");
    const other = store.createPersonalAgent(owner.id, { displayName: "다른 봇" });
    const stranger = makeUser(store, "stranger");
    expect(store.countUnseenBotTasks(owner.id)).toEqual({ total: 0, agents: {} });

    // One row per status, so the badge predicate is pinned on the whole matrix.
    const done = task({ title: "완료", status: "running", runId: "run-1" });
    store.finishBotTask(done.id, { status: "done", resultSummary: "끝" });
    const failed = task({ title: "실패", status: "running", runId: "run-2" });
    store.finishBotTask(failed.id, { status: "failed", error: "오류" });
    const parked = task({ title: "질문", status: "running", runId: "run-3" });
    store.finishBotTask(parked.id, { status: "waiting_input", pendingQuestion: "어느 쪽?" });
    // In-flight rows are NEVER unseen — their own motion is the signal, and a
    // badge nobody can clear until the work lands is worse than no badge.
    task({ title: "대기" });
    task({ title: "실행중", status: "running", runId: "run-4" });
    // Neither is a row the owner cancelled themselves.
    const cancelled = task({ title: "취소" });
    store.cancelQueuedBotTask(cancelled.id, owner.id);

    expect(store.countUnseenBotTasks(owner.id)).toEqual({
      total: 3,
      agents: { [bot.id]: 3 },
    });

    // Split per bot — and a bot with nothing unseen is ABSENT, never 0, which
    // is what lets the client replace its whole badge state from one response.
    const otherDone = task({
      agentId: other.id,
      conversationId: "c2",
      title: "다른 봇 완료",
      status: "running",
      runId: "run-5",
    });
    store.finishBotTask(otherDone.id, { status: "done" });
    expect(store.countUnseenBotTasks(owner.id)).toEqual({
      total: 4,
      agents: { [bot.id]: 3, [other.id]: 1 },
    });

    // Owner-scoped: another owner's settled rows never reach my badge.
    const theirs = store.createBotTask({
      ownerUserId: stranger.id,
      agentId: "s-bot",
      conversationId: "s1",
      title: "남의 작업",
      requestText: "x",
      status: "running",
      runId: "run-6",
    });
    store.finishBotTask(theirs.id, { status: "done" });
    expect(store.countUnseenBotTasks(owner.id).total).toBe(4);
    expect(store.countUnseenBotTasks(stranger.id)).toEqual({
      total: 1,
      agents: { "s-bot": 1 },
    });
    expect(store.countUnseenBotTasks("ghost")).toEqual({ total: 0, agents: {} });
  });

  it("stamps unseen tasks seen — narrowed by bot, idempotent, owner-scoped", () => {
    const { store, owner, bot, task } = fixture("mark-seen");
    const other = store.createPersonalAgent(owner.id, { displayName: "다른 봇" });
    const stranger = makeUser(store, "stranger");
    const settle = (title: string, agentId?: string) => {
      const row = task({ title, agentId, status: "running", runId: `run-${title}` });
      return store.finishBotTask(row.id, { status: "done", resultSummary: title })!;
    };
    const a1 = settle("A1");
    settle("A2");
    const b1 = settle("B1", other.id);
    const queued = task({ title: "대기" });
    const theirs = store.createBotTask({
      ownerUserId: stranger.id,
      agentId: "s-bot",
      conversationId: "s1",
      title: "남의 작업",
      requestText: "x",
      status: "running",
      runId: "run-s",
    });
    store.finishBotTask(theirs.id, { status: "done" });

    // Narrowed to one bot's lane, reporting what it actually moved.
    expect(store.markBotTasksSeen(owner.id, { agentId: other.id })).toBe(1);
    const firstStamp = store.getBotTask(b1.id)!.seenAt;
    expect(firstStamp).toBeTruthy();
    expect(store.getBotTask(a1.id)!.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(owner.id)).toEqual({
      total: 2,
      agents: { [bot.id]: 2 },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      // Idempotent: nothing left to move, and the stamp records when the row
      // was FIRST read, not when the board was last open.
      expect(store.markBotTasksSeen(owner.id, { agentId: other.id })).toBe(0);
      expect(store.getBotTask(b1.id)!.seenAt).toBe(firstStamp);
    } finally {
      vi.useRealTimers();
    }

    expect(store.markBotTasksSeen(owner.id)).toBe(2);
    expect(store.countUnseenBotTasks(owner.id)).toEqual({ total: 0, agents: {} });
    expect(store.markBotTasksSeen(owner.id)).toBe(0);
    // An unsettled row is left alone — there is nothing read about it yet.
    expect(store.getBotTask(queued.id)!.seenAt).toBeNull();
    // And clearing my board never clears another owner's.
    expect(store.getBotTask(theirs.id)!.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(stranger.id).total).toBe(1);
    // An unknown owner / an unknown bot both match nothing.
    expect(store.markBotTasksSeen("ghost")).toBe(0);
    expect(store.markBotTasksSeen(owner.id, { agentId: "ghost-bot" })).toBe(0);
  });

  it("re-badges a task every time it settles AGAIN", () => {
    const { store, owner, task } = fixture("seen-lifecycle");
    const t = task({ title: "질문 작업" });
    store.markBotTaskRunning(t.id, "run-1");
    store.setBotTaskReport(t.id, { outcome: "need_input", summary: "어느 쪽인가요?" });

    const parked = store.finishBotTask(t.id, { status: "waiting_input" })!;
    expect(parked.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(owner.id).total).toBe(1);

    // The owner reads the question…
    expect(store.markBotTasksSeen(owner.id)).toBe(1);
    expect(store.getBotTask(t.id)!.seenAt).toBeTruthy();
    expect(store.countUnseenBotTasks(owner.id).total).toBe(0);

    // …answers it, and the resume DROPS the stamp rather than carrying it into
    // the running leg: a restart there sweeps the row to failed, and a failure
    // nobody watched must still badge.
    expect(store.markBotTaskRunning(t.id, "run-2")!.seenAt).toBeNull();

    // The new outcome is unread work again, even though the row was seen once.
    const done = store.finishBotTask(t.id, { status: "done", resultSummary: "완료" })!;
    expect(done.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(owner.id).total).toBe(1);
  });

  it("stamps the owner's OWN cancel, and leaves unwatched failures unseen", () => {
    const { store, owner, bot, task } = fixture("seen-transitions");

    // Cancelling IS the owner looking at the card as it settles, so the stamp
    // rides the same UPDATE and the same timestamp as the finish.
    const queued = task({ title: "취소" });
    const cancelled = store.cancelQueuedBotTask(queued.id, owner.id)!;
    expect(cancelled.seenAt).toBeTruthy();
    expect(cancelled.seenAt).toBe(cancelled.finishedAt);
    expect(store.countUnseenBotTasks(owner.id)).toEqual({ total: 0, agents: {} });

    // Abandoning a parked task stamps too — and it badged until they did.
    const parkedTask = task({ title: "질문 대기", status: "running", runId: "run-1" });
    store.finishBotTask(parkedTask.id, {
      status: "waiting_input",
      pendingQuestion: "어느 쪽?",
    });
    expect(store.countUnseenBotTasks(owner.id).total).toBe(1);
    expect(store.cancelQueuedBotTask(parkedTask.id, owner.id)!.seenAt).toBeTruthy();
    expect(store.countUnseenBotTasks(owner.id)).toEqual({ total: 0, agents: {} });

    // A restart-interrupted run failed while nobody was watching: it badges.
    const interrupted = task({ title: "중단", status: "running", runId: "run-2" });
    expect(store.sweepInterruptedBotTasks("서버가 재시작되어 중단되었습니다.")).toBe(1);
    expect(store.getBotTask(interrupted.id)!.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(owner.id)).toEqual({
      total: 1,
      agents: { [bot.id]: 1 },
    });

    // So does a queued task the dispatcher could no longer run.
    const undispatchable = task({ title: "봇 없음" });
    store.failQueuedBotTask(undispatchable.id, "봇이 삭제되었습니다.");
    expect(store.getBotTask(undispatchable.id)!.seenAt).toBeNull();
    expect(store.countUnseenBotTasks(owner.id).total).toBe(2);
  });

  it("deletePersonalAgent cascades ONE bot's tasks, thread-less rows included", () => {
    const { store, owner, bot, task } = fixture("cascade-bot");
    const sibling = store.createPersonalAgent(owner.id, { displayName: "남는 봇" });
    store.touchConversation(owner.id, "c1", personalAgentAvatarId(owner.id, bot.id), "질문");

    const doomed = task({ conversationId: "c1", title: "지워질 작업" });
    // agent_id — not the conversation list — is the sweep key, so a task whose
    // thread is already gone still dies with the bot.
    const orphan = task({ conversationId: "gone", title: "고아 작업" });
    const kept = task({ agentId: sibling.id, conversationId: "c2", title: "남는 작업" });

    expect(store.deletePersonalAgent(bot.id)).toBe(true);
    expect(store.getBotTask(doomed.id)).toBeNull();
    expect(store.getBotTask(orphan.id)).toBeNull();
    expect(store.listBotTasks(owner.id).map((t) => t.id)).toEqual([kept.id]);
  });

  it("deletePersonalAgent sweeps the bot's ROUTINES and their threads", () => {
    const { store, owner, bot } = fixture("cascade-routines");
    const sibling = store.createPersonalAgent(owner.id, { displayName: "남는 봇" });
    const doomed = store.createRoutineJob(owner.id, {
      prompt: "매일 점검",
      minuteOfDay: 0,
      personalAgentId: bot.id,
    });
    const kept = store.createRoutineJob(owner.id, {
      prompt: "남는 예약",
      minuteOfDay: 0,
      personalAgentId: sibling.id,
    });
    const ownRoutine = store.createRoutineJob(owner.id, {
      prompt: "내 아바타 예약",
      minuteOfDay: 0,
    });

    expect(store.deletePersonalAgent(bot.id)).toBe(true);

    // The SCHEDULE row goes with the bot: left behind it would fire forever at a
    // bot that no longer exists (fail-closed, but noise the owner can't reach).
    expect(store.getRoutineJob(owner.id, doomed.id)).toBeNull();
    expect(store.listRoutineJobs(owner.id).map((r) => r.id).sort()).toEqual(
      [kept.id, ownRoutine.id].sort(),
    );
    // Its thread died through the composite avatar_user_id arm, not this sweep.
    expect(
      store.listConversations(owner.id, undefined, "routine").map((c) => c.id),
    ).not.toContain(doomed.conversationId);
  });

  it("deleteUser drops the owner's tasks, sparing another owner's", () => {
    const { store, owner, task } = fixture("cascade-user");
    const survivor = makeUser(store, "survivor");
    const survivorBot = store.createPersonalAgent(survivor.id, { displayName: "남의 봇" });
    const doomed = task({ title: "지워질 작업" });
    const kept = store.createBotTask({
      ownerUserId: survivor.id,
      agentId: survivorBot.id,
      conversationId: "s1",
      title: "남는 작업",
      requestText: "x",
      status: "queued",
    });

    expect(store.deleteUser(owner.id)).toBe(true);
    expect(store.getBotTask(doomed.id)).toBeNull();
    expect(store.listBotTasks(owner.id)).toEqual([]);
    expect(store.getBotTask(kept.id)).not.toBeNull();
  });

  it("deleteConversation cascades that thread's tasks, and only inside the owner guard", () => {
    const { store, owner, bot, task } = fixture("cascade-conv");
    const stranger = makeUser(store, "stranger");
    const avatarId = personalAgentAvatarId(owner.id, bot.id);
    store.touchConversation(owner.id, "c1", avatarId, "질문");
    store.touchConversation(owner.id, "c2", avatarId, "질문");
    const doomed = task({ conversationId: "c1", title: "c1 작업" });
    const kept = task({ conversationId: "c2", title: "c2 작업" });

    expect(store.deleteConversation(owner.id, "c1")).toBe(true);
    expect(store.getBotTask(doomed.id)).toBeNull();
    expect(store.getBotTask(kept.id)).not.toBeNull();
    // A refused delete cascades nothing.
    expect(store.deleteConversation(stranger.id, "c2")).toBe(false);
    expect(store.getBotTask(kept.id)).not.toBeNull();
  });

  it("deleteChatConversations cascades every swept thread's tasks", () => {
    const { store, owner, bot, task } = fixture("cascade-bulk");
    const avatarId = personalAgentAvatarId(owner.id, bot.id);
    store.touchConversation(owner.id, "c1", avatarId, "질문");
    store.touchConversation(owner.id, "c2", avatarId, "질문");
    const t1 = task({ conversationId: "c1", title: "1" });
    const t2 = task({ conversationId: "c2", title: "2" });

    expect(store.deleteChatConversations(owner.id).sort()).toEqual(["c1", "c2"]);
    expect(store.getBotTask(t1.id)).toBeNull();
    expect(store.getBotTask(t2.id)).toBeNull();
    expect(store.listBotTasks(owner.id)).toEqual([]);
  });
});
