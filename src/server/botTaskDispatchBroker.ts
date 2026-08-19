/**
 * One-slot broker between whoever ENQUEUES a delegated bot task and the
 * dispatcher that runs it (`botTaskRunner.ts`).
 *
 * It exists purely to break an import cycle. `routes/chat.ts` imports
 * `agent/index.js`, so nothing under `agent/` may import `routes/chat.js` —
 * and `botTaskRunner.ts` imports `executeChatTurn` from that very route. The
 * 봇 간 위임 tool (`agent/personalAgentProfileTools.ts`) still has to poke the
 * dispatcher after it queues a hand-off, so it pokes THIS module instead: a
 * bare function slot with no imports of its own, which `startBotTaskDispatcher`
 * fills at boot.
 *
 * Deliberately module-level state (the server layer otherwise threads
 * dependencies through `deps`): the dispatcher is a process-wide singleton
 * exactly like `botTaskRunner`'s own `dispatching` guard, and an MCP tool
 * handler deep inside a run has no `deps` bag to reach it through.
 *
 * Fire-and-forget by contract — the poke returns `void`, never a promise, so a
 * caller can never accidentally await a whole agent run. Unregistered (tests
 * that never boot `index.ts`, an enqueue during shutdown) it is a silent no-op:
 * the task stays `queued` and the next settle or the boot backlog drain picks
 * it up, which is the same recovery path a missed poke has always had.
 */

export type BotTaskDispatcher = (
  ownerUserId: string,
  conversationId: string,
) => void;

let dispatcher: BotTaskDispatcher | null = null;

/**
 * Install the process's dispatcher. Returns a disposer that only clears the
 * slot while THIS registration is still the current one, so a test that
 * registers a spy can restore the previous state without stomping a later
 * registration.
 */
export function registerBotTaskDispatcher(fn: BotTaskDispatcher): () => void {
  dispatcher = fn;
  return () => {
    if (dispatcher === fn) {
      dispatcher = null;
    }
  };
}

/** Ask the dispatcher to drain this thread's queue. No-op until registered. */
export function requestBotTaskDispatch(
  ownerUserId: string,
  conversationId: string,
): void {
  dispatcher?.(ownerUserId, conversationId);
}
