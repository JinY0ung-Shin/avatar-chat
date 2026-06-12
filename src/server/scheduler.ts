import fs from "node:fs";
import { loadAvatarPluginRoots, loadDefaultPluginRoots } from "./plugins.js";
import { runAgentStream } from "./agent/index.js";
import type { AppServices } from "./app.js";
import logger from "./logger.js";
import type { PluginRoot, RoutineJob } from "./types.js";
import { workspaceDirFor } from "./workspace.js";

const schedLogger = logger.child({ module: "scheduler" });

const DEFAULT_TICK_MS = 30_000;
/** Hard deadline per unattended run: a hung SDK call must not wedge the job forever. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Jobs currently executing. Module-level on purpose: the scheduler tick and
 * the HTTP "run now" route must share ONE overlap guard, or the same job can
 * run twice concurrently.
 */
const runningJobs = new Set<string>();

export function isRoutineRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

/**
 * Run a single routine job headlessly and append the result to its dedicated
 * conversation. The request is marked `headless`, so questions and permission
 * prompts are still auto-denied. Owner-scheduled routines opt into owner-level
 * tool access explicitly so they can perform the same work an owner chat can.
 *
 * Never throws: every failure (including avatar/plugin/workspace setup) is
 * returned as `{ ok: false }` so async callers can't leak a rejection.
 */
async function runRoutineJobNow(
  services: AppServices,
  job: RoutineJob,
): Promise<{ ok: boolean; error?: string }> {
  const { config, store } = services;
  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), RUN_TIMEOUT_MS);
  try {
    const avatar = store.resolveChatAvatar(job.avatarUserId, job.avatarUserId);
    if (!avatar) {
      return { ok: false, error: "아바타를 찾을 수 없습니다." };
    }

    // Mirror the chat endpoint's plugin loading; tolerate clone/resolve fails
    // but leave a trace — there is no client to stream the warnings to.
    const pluginWarnings: string[] = [];
    const warn = (w: string) => pluginWarnings.push(w);
    const pluginRoots: PluginRoot[] =
      config.agentRuntime === "local"
        ? []
        : [
            ...(await loadDefaultPluginRoots(config, warn)),
            ...(await loadAvatarPluginRoots(avatar.id, store.listEnabledPlugins(avatar.id), config, warn, store.getGitTokens(avatar.id))),
          ];
    if (pluginWarnings.length > 0) {
      schedLogger.warn({ jobId: job.id, warnings: pluginWarnings }, "routine plugin warnings");
    }

    const workspaceDir = workspaceDirFor(config, avatar.id, job.conversationId);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const response = await runAgentStream(
      {
        message: job.prompt,
        avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
        cwd: workspaceDir,
        viewerUserId: avatar.id,
        viewerName: avatar.displayName,
        viewerIsOwner: true,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
        autoApprove: true,
      },
      pluginRoots,
      config,
      store,
      // No callbacks: headless runs cannot ask questions or wait for approvals.
      {},
      abortController,
    );

    store.touchConversation(avatar.id, job.conversationId, avatar.id, `[루틴] ${job.prompt}`);
    store.addMessage(job.conversationId, { role: "user", content: job.prompt });
    store.addMessage(job.conversationId, {
      role: "assistant",
      content: response.text || response.summary,
      response,
    });
    store.audit({
      actorUserId: avatar.id,
      actorName: avatar.displayName,
      action: "routine_run",
      status: "success",
      detail: `routine ${job.id} (${response.runtime})`,
    });
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      store.audit({
        actorUserId: job.avatarUserId,
        actorName: null,
        action: "routine_run",
        status: "error",
        detail: `routine ${job.id}: ${detail}`,
      });
    } catch {
      /* audit must never mask the original failure */
    }
    return { ok: false, error: detail };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The single entry point for firing a routine (used by both the scheduler tick
 * and the "run now" route): takes the shared overlap guard, runs the job, and
 * records the outcome. Never throws.
 */
export async function executeRoutineJob(
  services: AppServices,
  job: RoutineJob,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  if (runningJobs.has(job.id)) {
    return { ok: false, skipped: true, error: "이미 실행 중인 루틴입니다." };
  }
  runningJobs.add(job.id);
  schedLogger.info({ jobId: job.id, avatarUserId: job.avatarUserId }, "routine job started");
  const jobStart = Date.now();
  try {
    const result = await runRoutineJobNow(services, job);
    services.store.markRoutineRun(job.id, {
      status: result.ok ? "success" : "error",
      error: result.error ?? null,
    });
    if (result.ok) {
      schedLogger.info({ jobId: job.id, durationMs: Date.now() - jobStart }, "routine job completed");
    } else {
      schedLogger.error({ jobId: job.id, error: result.error, durationMs: Date.now() - jobStart }, "routine job failed");
    }
    return result;
  } catch (error) {
    // runRoutineJobNow handles its own errors; reaching here means RECORDING
    // the outcome failed (e.g. DB write error). Log it — never let it escape,
    // and don't retry the write that just failed.
    const detail = error instanceof Error ? error.message : String(error);
    schedLogger.error({ jobId: job.id, err: error }, "routine failed to record outcome");
    return { ok: false, error: detail };
  } finally {
    runningJobs.delete(job.id);
  }
}

/**
 * Start the routine-job ticker. Every `tickMs` it fires any due jobs, one at a
 * time. Returns a stop function.
 *
 * Sequential on purpose: daily jobs have no latency requirement, and a burst
 * of due jobs (e.g. after server downtime past many slots) must not fan out
 * into N simultaneous agent runs. Runs missed while the server was down fire
 * once on the next tick, then roll forward; there is no per-missed-day
 * catch-up.
 */
export function startRoutineScheduler(
  services: AppServices,
  options: { tickMs?: number } = {},
): () => void {
  const { store } = services;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  let ticking = false;

  const tick = async (): Promise<void> => {
    let due: RoutineJob[];
    try {
      due = store.listDueRoutineJobs(new Date().toISOString());
    } catch (error) {
      schedLogger.error({ err: error }, "scheduler tick: failed to list due jobs");
      return;
    }
    for (const job of due) {
      await executeRoutineJob(services, job);
    }
  };

  const timer = setInterval(() => {
    if (ticking) {
      return; // previous tick still draining its due list
    }
    ticking = true;
    void tick().finally(() => {
      ticking = false;
    });
  }, tickMs);
  // Don't keep the process alive solely for the scheduler.
  timer.unref?.();
  return () => clearInterval(timer);
}
