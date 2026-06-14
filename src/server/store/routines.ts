import crypto from "node:crypto";
import {
  formatMinuteOfDay,
  nextRunIso,
  type RoutineSchedule,
  type ScheduleKind,
} from "../routineSchedule.js";
import type { RoutineJob } from "../types.js";
import { type Constructor, type RoutineJobRow, type StoreBase, now } from "./internal.js";

export function withRoutines<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Routines extends Base {
    // ---- Routine jobs (owner-scheduled recurring runs) -------------------

    private toRoutineJob(row: RoutineJobRow): RoutineJob {
      const schedule = this.scheduleFromRow(row);
      return {
        id: row.id,
        avatarUserId: row.avatar_user_id,
        conversationId: row.conversation_id,
        name: row.name ?? null,
        prompt: row.prompt,
        scheduleKind: schedule.kind,
        minuteOfDay: schedule.minuteOfDay,
        time: formatMinuteOfDay(schedule.minuteOfDay),
        daysOfWeek: schedule.daysOfWeek,
        intervalMinutes: schedule.intervalMinutes,
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus: (row.last_status as RoutineJob["lastStatus"]) ?? null,
        lastError: row.last_error,
        createdAt: row.created_at,
      };
    }

    /** Decode the stored days_of_week JSON, tolerating a corrupt value (→ null) so
     *  one bad row can't throw and abort a scheduler tick. */
    private parseDaysOfWeek(raw: string | null): number[] | null {
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as number[]) : null;
      } catch {
        return null;
      }
    }

    /** Reconstruct a RoutineSchedule from a stored row (legacy NULL kind → daily). */
    private scheduleFromRow(row: RoutineJobRow): RoutineSchedule {
      return {
        kind: (row.schedule_kind as ScheduleKind) ?? "daily",
        minuteOfDay: row.minute_of_day,
        daysOfWeek: this.parseDaysOfWeek(row.days_of_week),
        intervalMinutes: row.interval_minutes ?? null,
      };
    }

    private routineJobRow(id: string): RoutineJobRow | undefined {
      return this.db.prepare("SELECT * FROM routine_jobs WHERE id = ?").get(id) as
        | RoutineJobRow
        | undefined;
    }

    listRoutineJobs(avatarUserId: string): RoutineJob[] {
      const rows = this.db
        .prepare("SELECT * FROM routine_jobs WHERE avatar_user_id = ? ORDER BY created_at ASC")
        .all(avatarUserId) as RoutineJobRow[];
      return rows.map((r) => this.toRoutineJob(r));
    }

    /** Enabled jobs whose next run is at or before `nowIso`. Used by the scheduler. */
    listDueRoutineJobs(nowIso: string): RoutineJob[] {
      // Skip jobs whose owner is suspended: a suspended account's avatar must not
      // keep running headless, elevated routines (with its stored secrets/tokens).
      const rows = this.db
        .prepare(
          `SELECT rj.* FROM routine_jobs rj
           JOIN users u ON u.id = rj.avatar_user_id
           WHERE rj.enabled = 1 AND rj.next_run_at IS NOT NULL AND rj.next_run_at <= ?
             AND u.suspended = 0
           ORDER BY rj.next_run_at ASC`,
        )
        .all(nowIso) as RoutineJobRow[];
      return rows.map((r) => this.toRoutineJob(r));
    }

    getRoutineJob(avatarUserId: string, id: string): RoutineJob | null {
      const row = this.routineJobRow(id);
      if (!row || row.avatar_user_id !== avatarUserId) {
        return null;
      }
      return this.toRoutineJob(row);
    }

    createRoutineJob(
      avatarUserId: string,
      input: {
        name?: string | null;
        prompt: string;
        /** Pre-validated schedule (from parseRoutineSchedule); takes precedence over
         *  the legacy individual schedule fields below when provided. */
        schedule?: RoutineSchedule;
        scheduleKind?: ScheduleKind;
        minuteOfDay?: number;
        daysOfWeek?: number[] | null;
        intervalMinutes?: number | null;
        enabled?: boolean;
      },
    ): RoutineJob {
      const id = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const enabled = input.enabled !== false;
      const prompt = input.prompt.trim();
      const name = input.name?.trim() || null;
      // A validated RoutineSchedule object fully defines the schedule when present;
      // otherwise fall back to the legacy individual fields (scheduleKind/
      // minuteOfDay/...) for backward-compat callers.
      const schedule = input.schedule;
      const kind: ScheduleKind = schedule?.kind ?? input.scheduleKind ?? "daily";
      const minuteOfDay = schedule ? schedule.minuteOfDay : (input.minuteOfDay ?? 0);
      const daysOfWeek = schedule ? schedule.daysOfWeek : (input.daysOfWeek ?? null);
      const intervalMinutes = schedule ? schedule.intervalMinutes : (input.intervalMinutes ?? null);
      const nextRunAt = enabled
        ? nextRunIso({ kind, minuteOfDay, daysOfWeek, intervalMinutes })
        : null;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO routine_jobs (id, avatar_user_id, conversation_id, name, prompt, minute_of_day, schedule_kind, days_of_week, interval_minutes, enabled, next_run_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            avatarUserId,
            conversationId,
            name,
            prompt,
            minuteOfDay,
            kind,
            daysOfWeek ? JSON.stringify(daysOfWeek) : null,
            intervalMinutes,
            enabled ? 1 : 0,
            nextRunAt,
            now(),
          );
        // Create the dedicated conversation eagerly so the client can always
        // open it (and so its title comes from the name/prompt, not from whatever
        // message lands in it first).
        this.touchConversation(avatarUserId, conversationId, avatarUserId, `[루틴] ${name || prompt}`, { isRoutine: true });
      });
      tx();
      return this.toRoutineJob(this.routineJobRow(id)!);
    }

    updateRoutineJob(
      avatarUserId: string,
      id: string,
      patch: {
        name?: string | null;
        prompt?: string;
        /** Pre-validated schedule (from parseRoutineSchedule); when provided it
         *  replaces the whole schedule, equivalent to supplying every individual
         *  schedule field below. */
        schedule?: RoutineSchedule;
        scheduleKind?: ScheduleKind;
        minuteOfDay?: number;
        daysOfWeek?: number[] | null;
        intervalMinutes?: number | null;
        enabled?: boolean;
      },
    ): RoutineJob | null {
      const row = this.routineJobRow(id);
      if (!row || row.avatar_user_id !== avatarUserId) {
        return null;
      }
      // name === null clears the label; undefined leaves it as-is.
      const name =
        patch.name !== undefined ? (patch.name?.trim() || null) : (row.name ?? null);
      const prompt = patch.prompt !== undefined ? patch.prompt.trim() : row.prompt;
      // A validated RoutineSchedule replaces the whole schedule; otherwise the
      // legacy per-field patch values apply. Either way `schedule*` below is what
      // the existing diff/recompute logic compares against the stored row.
      const scheduleKind = patch.schedule?.kind ?? patch.scheduleKind;
      const patchMinuteOfDay = patch.schedule ? patch.schedule.minuteOfDay : patch.minuteOfDay;
      const patchDaysOfWeek = patch.schedule ? patch.schedule.daysOfWeek : patch.daysOfWeek;
      const patchIntervalMinutes = patch.schedule
        ? patch.schedule.intervalMinutes
        : patch.intervalMinutes;
      const existing = this.scheduleFromRow(row);
      const kind: ScheduleKind = scheduleKind ?? existing.kind;
      const minuteOfDay = patchMinuteOfDay !== undefined ? patchMinuteOfDay : existing.minuteOfDay;
      const daysOfWeek = patchDaysOfWeek !== undefined ? patchDaysOfWeek : existing.daysOfWeek;
      const intervalMinutes =
        patchIntervalMinutes !== undefined ? patchIntervalMinutes : existing.intervalMinutes;
      const wasEnabled = row.enabled === 1;
      const enabled = patch.enabled !== undefined ? patch.enabled : wasEnabled;
      // The schedule changed if any schedule field was supplied AND differs from
      // the stored value. A name/prompt-only edit must keep an overdue (missed)
      // run intact — recomputing would silently push it forward.
      const scheduleChanged =
        (scheduleKind !== undefined && scheduleKind !== existing.kind) ||
        (patchMinuteOfDay !== undefined && patchMinuteOfDay !== existing.minuteOfDay) ||
        (patchDaysOfWeek !== undefined &&
          JSON.stringify(patchDaysOfWeek ?? null) !== JSON.stringify(existing.daysOfWeek)) ||
        (patchIntervalMinutes !== undefined && patchIntervalMinutes !== existing.intervalMinutes);
      let nextRunAt: string | null;
      if (!enabled) {
        nextRunAt = null;
      } else if (scheduleChanged || !wasEnabled || !row.next_run_at) {
        nextRunAt = nextRunIso({ kind, minuteOfDay, daysOfWeek, intervalMinutes });
      } else {
        nextRunAt = row.next_run_at;
      }
      this.db
        .prepare(
          "UPDATE routine_jobs SET name = ?, prompt = ?, schedule_kind = ?, minute_of_day = ?, days_of_week = ?, interval_minutes = ?, enabled = ?, next_run_at = ? WHERE id = ?",
        )
        .run(
          name,
          prompt,
          kind,
          minuteOfDay,
          daysOfWeek ? JSON.stringify(daysOfWeek) : null,
          intervalMinutes,
          enabled ? 1 : 0,
          nextRunAt,
          id,
        );
      return this.toRoutineJob(this.routineJobRow(id)!);
    }

    deleteRoutineJob(avatarUserId: string, id: string): boolean {
      const result = this.db
        .prepare("DELETE FROM routine_jobs WHERE id = ? AND avatar_user_id = ?")
        .run(id, avatarUserId);
      return result.changes > 0;
    }

    /**
     * Record the outcome of a firing and schedule the next one. An enabled job
     * rolls forward to its next slot; a job disabled mid-run stays parked.
     */
    markRoutineRun(id: string, outcome: { status: "success" | "error"; error?: string | null }): void {
      const row = this.routineJobRow(id);
      if (!row) {
        return;
      }
      const nextRunAt = row.enabled === 1 ? nextRunIso(this.scheduleFromRow(row)) : null;
      this.db
        .prepare(
          "UPDATE routine_jobs SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ? WHERE id = ?",
        )
        .run(now(), outcome.status, outcome.error ?? null, nextRunAt, id);
    }
  };
}
