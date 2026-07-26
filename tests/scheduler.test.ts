import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, AgentResponse, AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// Coverage target: src/server/scheduler.ts failure handling — the abort-cause
// substitution and the partial-output persistence. `runAgentStream` is mocked so a
// run can be made to hang until the scheduler's own deadline aborts it; the real
// local runtime returns immediately and can never reach that path.

type RunImpl = (
  request: AgentRequest,
  pluginRoots: unknown,
  config: AppConfig,
  store: unknown,
  events: AgentEvents,
  abortController?: AbortController,
) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({ impl: null as RunImpl | null }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      request: AgentRequest,
      pluginRoots: unknown,
      config: AppConfig,
      store: unknown,
      events: AgentEvents,
      abortController?: AbortController,
    ): Promise<AgentResponse> => {
      if (H.impl) {
        return H.impl(request, pluginRoots, config, store, events, abortController);
      }
      events.onDelta?.("ok");
      return { kind: "text", runtime: "local", summary: "mock", text: "ok" };
    },
  ),
}));

const { createServices } = await import("../src/server/app.js");
const { executeRoutineJob } = await import("../src/server/scheduler.js");

let tempDir: string;
const getTempDir = withTempDir("scheduler", () => {
  tempDir = getTempDir();
});

/** The deadline the scheduler enforces per unattended run. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Fail the way the SDK does on abort: it labels EVERY abort as user-initiated, and it
 * checks `signal.aborted` up front rather than only listening — the deadline can fire
 * before the run is even entered, so a listen-only mock would hang forever.
 */
function failOnAbort(abortController?: AbortController): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error("Claude Code process aborted by user"));
    if (abortController?.signal.aborted) {
      fail();
      return;
    }
    abortController?.signal.addEventListener("abort", fail);
  });
}

function boot(label: string) {
  const services = createServices({
    dataDir: path.join(tempDir, label),
    agentRuntime: "claude",
    sessionSecret: "t",
  });
  const owner = services.store.createUser({
    username: "owner",
    displayName: "Owner",
    password: "password123",
  });
  const job = services.store.createRoutineJob(owner.id, { prompt: "일일 점검", minuteOfDay: 0 });
  return { services, owner, job };
}

beforeEach(() => {
  H.impl = null;
});

describe("routine failure handling", () => {
  it("reports the run timeout instead of the SDK's 'aborted by user' text", async () => {
    const { services, owner, job } = boot("timeout");
    // Stream something, then hang until the scheduler's deadline aborts us and fail
    // the way the SDK does: it labels EVERY abort as user-initiated.
    H.impl = async (_req, _roots, _cfg, _store, events, abortController) => {
      events.onDelta?.("점검 1단계 완료");
      return failOnAbort(abortController);
    };

    vi.useFakeTimers();
    try {
      const pending = executeRoutineJob(services, job);
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("실행 제한 시간(10분)");
      expect(result.error).not.toContain("aborted by user");

      // The stored lastError (rendered verbatim in RoutinesView) says the same.
      const after = services.store.listRoutineJobs(owner.id)[0];
      expect(after.lastStatus).toBe("error");
      expect(after.lastError).toContain("실행 제한 시간(10분)");
      expect(after.lastError).not.toContain("aborted by user");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the partial output in the routine thread alongside the cause", async () => {
    const { services, owner, job } = boot("partial");
    H.impl = async (_req, _roots, _cfg, _store, events, abortController) => {
      events.onDelta?.("1단계: 저장소 동기화 완료");
      events.onDelta?.("\n2단계: 테스트 실행 중");
      return failOnAbort(abortController);
    };

    vi.useFakeTimers();
    try {
      const pending = executeRoutineJob(services, job);
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    // Before this, a failed run wrote NOTHING to its thread — the only trace was a
    // one-line lastError, so there was no way to see how far it got.
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("일일 점검");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("1단계: 저장소 동기화 완료");
    expect(messages[1].content).toContain("2단계: 테스트 실행 중");
    expect(messages[1].content).toContain("실행 제한 시간(10분)");
  });

  it("records a non-timeout failure with its own message, not the timeout text", async () => {
    const { services, owner, job } = boot("othererror");
    H.impl = async (_req, _roots, _cfg, _store, events) => {
      events.onDelta?.("부분 출력");
      throw new Error("Bad Request: model not found");
    };

    const result = await executeRoutineJob(services, job);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Bad Request: model not found");
    expect(result.error).not.toContain("실행 제한 시간");

    // The partial is still kept, with the real cause appended.
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages[1].content).toBe("부분 출력\n\nBad Request: model not found");
    expect(services.store.listRoutineJobs(owner.id)[0].lastError).toBe(
      "Bad Request: model not found",
    );
  });

  it("persists the cause alone when the run produced no output", async () => {
    const { services, owner, job } = boot("nopartial");
    H.impl = async () => {
      throw new Error("boom");
    };

    await executeRoutineJob(services, job);

    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("boom");
  });

  it("still records a successful run the normal way", async () => {
    const { services, owner, job } = boot("success");

    const result = await executeRoutineJob(services, job);

    expect(result.ok).toBe(true);
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("ok");
    expect(services.store.listRoutineJobs(owner.id)[0].lastStatus).toBe("success");
  });
});
