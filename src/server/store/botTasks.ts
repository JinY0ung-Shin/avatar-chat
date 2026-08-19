import crypto from "node:crypto";
import type { BotTask, BotTaskStatus } from "../types.js";
import {
  type BotTaskRow,
  type Constructor,
  type StoreBase,
  now,
} from "./internal.js";

/** Newest-first owner/board listing default. */
const DEFAULT_TASK_LIMIT = 100;
/** Oldest-first thread listing default (a bot thread holds more cards than a board page). */
const DEFAULT_CONVERSATION_TASK_LIMIT = 200;

export function withBotTasks<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class BotTasks extends Base {
    // ---- Delegated bot tasks (내 봇 작업) ------------------------------------
    // One row per executed user turn in a personal-agent thread. BOOKKEEPING
    // ONLY — a row never widens or narrows a run's capability. The status
    // machine is enforced HERE (every transition is a guarded UPDATE returning
    // null on an illegal move, never a throw) so the chat route, the queue
    // dispatcher and the task API decode ONE rule:
    //
    //   queued ──► running ──► done | failed | cancelled   (terminal)
    //                  └────► waiting_input ──► running    (owner answers)
    //   queued | waiting_input ──► cancelled               (owner gives up)
    //   queued ──► failed                                  (undispatchable bot)
    //
    // Cascades are manual and live at the deletion sites: deletePersonalAgent
    // (store/personalAgents.ts), deleteUser (store/admin.ts), and the
    // conversation deletes (store/conversations.ts).

    private botTaskRow(taskId: string): BotTaskRow | undefined {
      return this.db
        .prepare("SELECT * FROM bot_tasks WHERE id = ?")
        .get(taskId) as BotTaskRow | undefined;
    }

    private toBotTask(row: BotTaskRow): BotTask {
      return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        agentId: row.agent_id,
        conversationId: row.conversation_id,
        runId: row.run_id ?? null,
        title: row.title,
        requestText: row.request_text,
        // This mixin is the only writer of both enum columns, so the stored
        // values are always in-contract; the casts carry no normalization.
        status: row.status as BotTaskStatus,
        reportedOutcome: (row.reported_outcome ?? null) as
          | "done"
          | "need_input"
          | null,
        resultSummary: row.result_summary ?? null,
        pendingQuestion: row.pending_question ?? null,
        error: row.error ?? null,
        model: row.model ?? null,
        createdAt: row.created_at,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
      };
    }

    /** Re-read after a guarded UPDATE; null when the guard matched nothing. */
    private botTaskIfChanged(taskId: string, changes: number): BotTask | null {
      if (changes === 0) {
        return null;
      }
      const row = this.botTaskRow(taskId);
      return row ? this.toBotTask(row) : null;
    }

    /**
     * Record a delegated turn. `running` is the ATTENDED path (the chat route
     * starts the run immediately, so started_at + run_id are stamped up front);
     * `queued` is the unattended path, where the dispatcher later calls
     * markBotTaskRunning once the conversation's active run frees up.
     */
    createBotTask(input: {
      ownerUserId: string;
      agentId: string;
      conversationId: string;
      title: string;
      requestText: string;
      status: "queued" | "running";
      runId?: string | null;
    }): BotTask {
      const timestamp = now();
      const id = crypto.randomUUID();
      const running = input.status === "running";
      this.db
        .prepare(
          `INSERT INTO bot_tasks (id, owner_user_id, agent_id, conversation_id, run_id, title, request_text, status, created_at, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.ownerUserId,
          input.agentId,
          input.conversationId,
          running ? (input.runId ?? null) : null,
          input.title,
          input.requestText,
          input.status,
          timestamp,
          running ? timestamp : null,
        );
      return this.toBotTask(this.botTaskRow(id)!);
    }

    getBotTask(taskId: string): BotTask | null {
      const row = this.botTaskRow(taskId);
      return row ? this.toBotTask(row) : null;
    }

    /**
     * One owner's tasks, NEWEST first (the 작업 보드 order), optionally narrowed
     * to a single bot. created_at is an ISO string that can collide inside one
     * millisecond, so rowid breaks ties into stable insertion order.
     */
    listBotTasks(
      ownerUserId: string,
      opts: { agentId?: string; limit?: number } = {},
    ): BotTask[] {
      const limit =
        opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_TASK_LIMIT;
      const params: unknown[] = [ownerUserId];
      let where = "owner_user_id = ?";
      if (opts.agentId) {
        where += " AND agent_id = ?";
        params.push(opts.agentId);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM bot_tasks WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, limit) as BotTaskRow[];
      return rows.map((row) => this.toBotTask(row));
    }

    /** One thread's tasks, OLDEST first — the cards render in transcript order. */
    listBotTasksForConversation(
      conversationId: string,
      opts: { limit?: number } = {},
    ): BotTask[] {
      const limit =
        opts.limit && opts.limit > 0
          ? opts.limit
          : DEFAULT_CONVERSATION_TASK_LIMIT;
      const rows = this.db
        .prepare(
          "SELECT * FROM bot_tasks WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
        )
        .all(conversationId, limit) as BotTaskRow[];
      return rows.map((row) => this.toBotTask(row));
    }

    /** Backlog depth for the thread's queue badge — 'queued' only, never 'running'. */
    countQueuedBotTasks(conversationId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM bot_tasks WHERE conversation_id = ? AND status = 'queued'",
        conversationId,
      );
    }

    /** The task the dispatcher runs next in this thread (FIFO), or null when drained. */
    nextQueuedBotTask(conversationId: string): BotTask | null {
      const row = this.db
        .prepare(
          "SELECT * FROM bot_tasks WHERE conversation_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
        )
        .get(conversationId) as BotTaskRow | undefined;
      return row ? this.toBotTask(row) : null;
    }

    /**
     * Every thread carrying backlog, the thread with the OLDEST queued task
     * first — the boot-time dispatch scan, which walks this list and pops each
     * thread's queue in turn. Ordered by each conversation's own oldest queued
     * created_at (not by row count), so the longest-waiting owner is served
     * first; MIN(rowid) breaks same-millisecond ties into insertion order.
     */
    listConversationIdsWithQueuedBotTasks(): string[] {
      const rows = this.db
        .prepare(
          `SELECT conversation_id FROM bot_tasks WHERE status = 'queued'
           GROUP BY conversation_id
           ORDER BY MIN(created_at) ASC, MIN(rowid) ASC`,
        )
        .all() as { conversation_id: string }[];
      return rows.map((row) => row.conversation_id);
    }

    /**
     * Hand a task to a live run. Legal ONLY from 'queued' (first dispatch) or
     * 'waiting_input' (the owner answered) — any other status returns null
     * WITHOUT touching the row, which is how a double dispatch is a no-op
     * rather than a resurrection. started_at is insert-once (COALESCE), so a
     * resumed task keeps its original start; result_summary survives a resume
     * while pending_question and reported_outcome are cleared, because the
     * answer just arrived and the bot must report again for this leg.
     */
    markBotTaskRunning(taskId: string, runId: string): BotTask | null {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET status = 'running', run_id = ?, started_at = COALESCE(started_at, ?),
                 pending_question = NULL, reported_outcome = NULL
           WHERE id = ? AND status IN ('queued', 'waiting_input')`,
        )
        .run(runId, now(), taskId);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * What the bot itself declared MID-run via mcp__personal_agent__report_task.
     * Legal only while 'running'. Deliberately does NOT move status: the turn
     * finalize owns that, reading reported_outcome to pick done vs
     * waiting_input, so a report that lands without a finalize (crash, abort)
     * never leaves a task falsely terminal.
     */
    setBotTaskReport(
      taskId: string,
      report: { outcome: "done" | "need_input"; summary: string },
    ): BotTask | null {
      const done = report.outcome === "done";
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET reported_outcome = ?,
                 result_summary = CASE WHEN ? = 1 THEN ? ELSE result_summary END,
                 pending_question = CASE WHEN ? = 1 THEN pending_question ELSE ? END
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          report.outcome,
          done ? 1 : 0,
          report.summary,
          done ? 1 : 0,
          report.summary,
          taskId,
        );
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Close out a leg of the run. Legal ONLY from 'running', so a double
     * finalize (stream end racing an abort handler) is a null no-op. Terminal
     * statuses stamp finished_at; 'waiting_input' parks the task with
     * finished_at NULL so the owner's next message can resume it. Either way
     * run_id is cleared — the in-memory registry entry is gone. An `undefined`
     * field KEEPS its stored value (the finalize passes only what it knows,
     * e.g. a report already wrote result_summary); an explicit null clears.
     */
    finishBotTask(
      taskId: string,
      outcome: {
        status: "done" | "failed" | "cancelled" | "waiting_input";
        resultSummary?: string | null;
        pendingQuestion?: string | null;
        error?: string | null;
        model?: string | null;
      },
    ): BotTask | null {
      const terminal = outcome.status !== "waiting_input";
      const keep = (value: string | null | undefined) =>
        value === undefined ? 1 : 0;
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET status = ?,
                 run_id = NULL,
                 finished_at = ?,
                 result_summary = CASE WHEN ? = 1 THEN result_summary ELSE ? END,
                 pending_question = CASE WHEN ? = 1 THEN pending_question ELSE ? END,
                 error = CASE WHEN ? = 1 THEN error ELSE ? END,
                 model = CASE WHEN ? = 1 THEN model ELSE ? END
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          outcome.status,
          terminal ? now() : null,
          keep(outcome.resultSummary),
          outcome.resultSummary ?? null,
          keep(outcome.pendingQuestion),
          outcome.pendingQuestion ?? null,
          keep(outcome.error),
          outcome.error ?? null,
          keep(outcome.model),
          outcome.model ?? null,
          taskId,
        );
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Owner-initiated cancel of work that is not CURRENTLY executing: 'queued'
     * (never dispatched) or 'waiting_input' (parked on a question the owner
     * chose to abandon rather than answer). A 'running' task is stopped through
     * the run registry instead, so it does NOT match here — the method name
     * keeps its original queue framing, the contract is the wider one. Guarded
     * on the owner inside the same UPDATE; pendingQuestion is left standing so
     * the abandoned card still shows what was asked. Null covers "gone", "not
     * yours" and "wrong status" identically ON PURPOSE: the caller is a route,
     * and distinguishing them would confirm another owner's task id exists.
     */
    cancelQueuedBotTask(taskId: string, ownerUserId: string): BotTask | null {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'cancelled', finished_at = ?, run_id = NULL
           WHERE id = ? AND owner_user_id = ? AND status IN ('queued', 'waiting_input')`,
        )
        .run(now(), taskId, ownerUserId);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Kill a task the dispatcher can no longer run: its bot was deleted,
     * disabled or its owner demoted between the enqueue and the dispatch.
     * Legal ONLY from 'queued' — a task that already reached a run fails
     * through finishBotTask instead, so the two paths never race for the same
     * row. run_id is left alone rather than cleared: a queued row never carries
     * one (createBotTask drops the runId unless the task starts running).
     */
    failQueuedBotTask(taskId: string, error: string): BotTask | null {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(error, now(), taskId);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Boot sweep: run_id points into an IN-MEMORY registry that a restart
     * erases, so every row still marked 'running' belongs to a run nothing can
     * finalize any more. Fail them (Korean, user-facing `error`) instead of
     * leaving cards spinning forever. 'queued' rows are untouched — they were
     * never dispatched and the dispatcher can still pick them up.
     */
    sweepInterruptedBotTasks(error: string): number {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'failed', error = ?, finished_at = ?, run_id = NULL
           WHERE status = 'running'`,
        )
        .run(error, now());
      return changes;
    }
  };
}
