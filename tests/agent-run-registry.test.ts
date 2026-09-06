import type { Response } from "express";
import { describe, expect, it } from "vitest";
import {
  CANCELLED,
  attachRunClient,
  awaitResponse,
  cancelRun,
  closeRun,
  emitRunEvent,
  getRunPrompts,
  openRun,
} from "../src/server/agent/runRegistry.js";

/** Minimal SSE sink: records every chunk `writeSse` emits. */
function sseSink() {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    write: (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    },
    on: () => res,
    end: () => res,
  } as unknown as Response;
  return { chunks, res };
}

describe("runRegistry: prompts that arrive after an abort", () => {
  it("resolves a post-abort prompt VISIBLY so the replay journal never strands a modal", async () => {
    const abort = new AbortController();
    openRun("ab-1", "u", { conversationId: "c-ab", abortController: abort });
    const live = sseSink();
    attachRunClient("ab-1", "u", live.res);

    // Deadline / stop button: the registry releases every parked prompt here.
    abort.abort();
    // The SDK's last hook fires AFTER the abort — chat.ts emits the frame first,
    // then parks. The prompt must resolve at once (no wait for closeRun) …
    emitRunEvent("ab-1", "question", { requestId: "late", payload: {} });
    await expect(awaitResponse("ab-1", "late")).resolves.toBe(CANCELLED);

    // … and its resolution must be a real frame, both for the attached viewer …
    const joined = live.chunks.join("");
    expect(joined).toContain('"requestId":"late"');
    expect(joined).toContain("event: prompt_resolved");
    // … and for anyone replaying the journal later (question, then resolution).
    const late = sseSink();
    attachRunClient("ab-1", "u", late.res, 0);
    const replayed = late.chunks.join("");
    expect(replayed.indexOf("event: question")).toBeGreaterThanOrEqual(0);
    expect(replayed.indexOf("event: question")).toBeLessThan(replayed.indexOf("event: prompt_resolved"));
    // Nothing is outstanding: the external task API's pendingRequests stay empty.
    expect(getRunPrompts("ab-1", "u")).toEqual([]);
    closeRun("ab-1");
  });

  it("treats cancelRun the same way for a run opened without an abort controller", async () => {
    openRun("ab-3", "u", { conversationId: "c-ab3" });
    const live = sseSink();
    attachRunClient("ab-3", "u", live.res);
    expect(cancelRun("ab-3", "u")).toBe(true);
    emitRunEvent("ab-3", "permission", { requestId: "late-perm" });
    await expect(awaitResponse("ab-3", "late-perm")).resolves.toBe(CANCELLED);
    expect(live.chunks.join("")).toContain("event: prompt_resolved");
    expect(getRunPrompts("ab-3", "u")).toEqual([]);
    closeRun("ab-3");
  });

  it("still resolves CANCELLED silently for a run that already ended", async () => {
    openRun("ab-2", "u", { conversationId: "c-ab2" });
    closeRun("ab-2");
    await expect(awaitResponse("ab-2", "gone")).resolves.toBe(CANCELLED);
  });
});
