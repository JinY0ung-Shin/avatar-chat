import { Router } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import { cancelRun } from "../agent/runRegistry.js";
import { apiError, safeString, type RouterDeps } from "./_shared.js";

// ---- Delegated bot tasks (내 봇 작업) ---------------------------------
// The owner's own board over `bot_tasks`: what each of their bots has done, is
// doing, is waiting to do, plus the two writes the owner needs — giving up on a
// task, and marking settled results as read. Gated exactly like /api/me/agents
// (requireAuth + requireAdmin, the phase-1 feature gate) AND scoped to the
// caller's own rows — the reads/stamps take the owner id from the session
// rather than the request, and the cancel re-checks the row, so one admin can
// never see, clear or cancel another's work. A miss answers 404, never 403.

/** Newest-first page size cap for the board (the store's own default is 100). */
const MAX_TASK_LIMIT = 200;

export function createBotTasksRouter({ store }: RouterDeps): Router {
  const router = Router();

  router.get(
    "/api/me/bot-tasks",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agentId = safeString(req.query.agentId) || undefined;
      const rawLimit = Number(req.query.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(MAX_TASK_LIMIT, Math.floor(rawLimit))
          : undefined;
      res.json({ tasks: store.listBotTasks(req.user!.id, { agentId, limit }) });
    },
  );

  /**
   * The unseen-badge counts: settled tasks (done/failed/waiting_input) the
   * owner has not looked at yet, `{ total, agents }` with one entry per bot
   * that has any. Registered ahead of the ':id' routes — a literal segment and
   * a param segment could not collide at this depth anyway (express matches
   * '/:id/cancel' on two trailing segments), but keeping the literals first
   * means a later '/:id' read route can't quietly swallow them.
   */
  router.get(
    "/api/me/bot-tasks/unseen",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      res.json(store.countUnseenBotTasks(req.user!.id));
    },
  );

  /**
   * The owner looked at the board (optionally at ONE bot's lane, `agentId`).
   * Answers the FRESH counts rather than what it changed: the client REPLACES
   * its badge state from this response, so a narrowed call must still report
   * the badges that survive it — and a settle that lands between the stamp and
   * the read is included rather than lost.
   */
  router.post(
    "/api/me/bot-tasks/seen",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agentId = safeString(req.body?.agentId) || undefined;
      store.markBotTasksSeen(req.user!.id, { agentId });
      res.json(store.countUnseenBotTasks(req.user!.id));
    },
  );

  /**
   * Give up on one task. Which mechanism applies is decided by its status, not
   * by the caller: work that never started (or is parked on a question the
   * owner chose not to answer) is cancelled in the row itself, while a RUNNING
   * task is stopped through the run registry — the same path the chat stop
   * button takes, so the turn still persists whatever it had streamed and its
   * own finalize writes the `cancelled` row. That is why the running branch
   * answers `stopping: true` rather than a terminal task.
   */
  router.post(
    "/api/me/bot-tasks/:id/cancel",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const task = store.getBotTask(req.params.id);
      if (!task || task.ownerUserId !== req.user!.id) {
        apiError(res, 404, "작업을 찾을 수 없습니다.");
        return;
      }
      if (task.status === "queued" || task.status === "waiting_input") {
        const cancelled = store.cancelQueuedBotTask(task.id, req.user!.id);
        if (!cancelled) {
          // It moved on between the read and the guarded UPDATE (the dispatcher
          // just started it). Report the state it is in now.
          apiError(res, 409, "이미 종료된 작업입니다.");
          return;
        }
        res.json({ task: cancelled });
        return;
      }
      if (task.status === "running") {
        if (task.runId) {
          cancelRun(task.runId, req.user!.id);
        }
        res.json({ task: store.getBotTask(task.id), stopping: true });
        return;
      }
      apiError(res, 409, "이미 종료된 작업입니다.");
    },
  );

  return router;
}
