import { Router } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import { cancelRun } from "../agent/runRegistry.js";
import { apiError, safeString, type RouterDeps } from "./_shared.js";

// ---- Delegated bot tasks (내 봇 작업) ---------------------------------
// The owner's own board over `bot_tasks`: what each of their bots has done, is
// doing, is waiting to do, and the one write the owner needs — giving up on a
// task. Gated exactly like /api/me/agents (requireAuth + requireAdmin, the
// phase-1 feature gate) AND re-checked against the row's owner, so one admin
// can never read or cancel another's work. A miss answers 404, never 403.

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
