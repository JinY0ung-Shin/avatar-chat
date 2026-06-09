/**
 * In-memory registry of in-flight chat runs that are waiting on the user.
 *
 * The chat stream is one HTTP request (POST /api/chat/stream → SSE response),
 * but interactive tools (permission prompts, AskUserQuestion) need an answer
 * that arrives on a SEPARATE request (POST /api/chat/respond). This registry
 * bridges the two: a blocking SDK callback parks a promise here keyed by
 * (runId, requestId); the respond endpoint resolves it.
 *
 * Single-process only — matches the rest of the app (in-process SQLite). If
 * the server is ever horizontally scaled this must move to a shared store.
 */

/** Returned to a parked caller when the run ends before an answer arrives. */
export const CANCELLED = Symbol("cancelled");

interface Pending {
  resolve: (value: unknown) => void;
}

interface Run {
  userId: string;
  pending: Map<string, Pending>;
  ended: boolean;
}

const runs = new Map<string, Run>();

export function openRun(runId: string, userId: string): void {
  runs.set(runId, { userId, pending: new Map(), ended: false });
}

/**
 * Park until the user answers `requestId` (or the run ends → resolves with
 * CANCELLED). Safe to call even if the run was already closed (resolves
 * CANCELLED immediately).
 */
export function awaitResponse(runId: string, requestId: string): Promise<unknown> {
  const run = runs.get(runId);
  if (!run || run.ended) {
    return Promise.resolve(CANCELLED);
  }
  return new Promise((resolve) => {
    run.pending.set(requestId, { resolve });
  });
}

/**
 * Deliver a user's answer. Returns false if the run is unknown, owned by
 * another user, or the request id isn't outstanding.
 */
export function submitResponse(
  runId: string,
  requestId: string,
  userId: string,
  value: unknown,
): boolean {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return false;
  }
  const pending = run.pending.get(requestId);
  if (!pending) {
    return false;
  }
  run.pending.delete(requestId);
  pending.resolve(value);
  return true;
}

/** End a run: resolve every outstanding request with CANCELLED, then forget it. */
export function closeRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) {
    return;
  }
  run.ended = true;
  for (const pending of run.pending.values()) {
    pending.resolve(CANCELLED);
  }
  run.pending.clear();
  runs.delete(runId);
}
