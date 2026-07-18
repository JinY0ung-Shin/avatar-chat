import fs from "node:fs";
import { loadAgentPluginRoots, loadKnowledgeRepoMemory } from "./plugins.js";
import { runAgentStream } from "./agent/index.js";
import type { AppServices } from "./app.js";
import logger from "./logger.js";
import type { PluginRoot, RoutineJob } from "./types.js";
import { workspaceDirFor } from "./workspace.js";
import { resolveActiveWorkspaceRepo } from "./activeRepoResolve.js";
import { getActiveRunForConversation } from "./agent/runRegistry.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../shared/mcpToolGroups.js";

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
  // Frees the per-clone serialization lock if this run opened a working repo.
  let releaseActiveRepoLock: (() => void) | null = null;
  try {
    const avatar = store.resolveChatAvatar(job.avatarUserId, job.avatarUserId);
    if (!avatar) {
      return { ok: false, error: "아바타를 찾을 수 없습니다." };
    }

    // Mirror the chat endpoint's plugin loading via the shared helper (default +
    // avatar plugins + personal & group knowledge-repo skill roots) so routines
    // can USE the same skills an owner chat would; tolerate clone/resolve fails
    // but leave a trace — there is no client to stream the warnings to.
    const pluginWarnings: string[] = [];
    const pluginRoots: PluginRoot[] = await loadAgentPluginRoots(store, avatar.id, config, (w) =>
      pluginWarnings.push(w),
    );
    if (pluginWarnings.length > 0) {
      schedLogger.warn({ jobId: job.id, warnings: pluginWarnings }, "routine plugin warnings");
    }

    // Standing CLAUDE.md memory, same as an owner chat. Routines have no
    // per-conversation toggle UI, so every group is included (no disabled set).
    const knowledgeMemory = await loadKnowledgeRepoMemory(store, avatar.id, config);

    const workspaceDir = workspaceDirFor(config, avatar.id, job.conversationId);
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Working repository: a routine may open one registered git repo as its cwd
    // via `mcp__git_repo__open_repo`. The selection persists on the conversation
    // (conversations.working_repo), so it survives between spaced-out scheduled
    // runs and restarts — and an interactive open in the routine's thread carries
    // here. Resolve it the SAME way the chat route does (shared resolver). On any
    // failure, log and fall back to the scratch workspace — the routine still runs.
    const repoResolution = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias },
      conversationId: job.conversationId,
      elevated: true,
      // Routines have no composer, so every tool group is on — capped by the
      // admin per-group tool policy for the owner (claudeAgent clamps the run
      // itself the same way; this gate mirrors the chat route's repo gating).
      gitRepoToolsEnabled: (
        store.allowedMcpToolGroupsForUser(avatar.id) ?? DEFAULT_MCP_TOOL_GROUPS
      ).includes("git_repo"),
    });
    let activeRepoCwd: string | null = null;
    let activeRepoName: string | null = null;
    if (repoResolution.kind === "ok") {
      activeRepoCwd = repoResolution.cwd;
      activeRepoName = repoResolution.repoName;
      releaseActiveRepoLock = repoResolution.release;
    } else if (repoResolution.kind === "error") {
      schedLogger.warn(
        { jobId: job.id, reason: repoResolution.reason, detail: repoResolution.detail },
        "routine working repo unavailable; running in scratch workspace",
      );
    }

    const response = await runAgentStream(
      {
        message: job.prompt,
        avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
        // Lets in-process tools (open_repo/close_repo) key the working-repo
        // selection to this routine's conversation, persisted for the next run.
        conversationId: job.conversationId,
        // Working repository: the opened repo's clone becomes the cwd; the scratch
        // dir stays exposed as an additional writable dir (mirrors the chat route).
        cwd: activeRepoCwd ?? workspaceDir,
        additionalDirs: activeRepoCwd ? [workspaceDir] : undefined,
        activeRepoName: activeRepoName ?? undefined,
        viewerUserId: avatar.id,
        viewerName: avatar.displayName,
        viewerIsOwner: true,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
        autoApprove: true,
        // Routines run unattended on a schedule: if the chosen model is
        // overloaded/erroring server-side, fall back down the tier chain
        // (opus→sonnet→haiku) rather than failing the whole run.
        modelFallback: true,
        knowledgeMemory,
      },
      pluginRoots,
      config,
      store,
      // No callbacks: headless runs cannot ask questions or wait for approvals.
      {},
      abortController,
    );

    store.touchConversation(avatar.id, job.conversationId, avatar.id, `[예약 작업] ${job.prompt}`, { isRoutine: true });
    store.addMessage(job.conversationId, { role: "user", content: job.prompt });
    store.addMessage(job.conversationId, {
      role: "assistant",
      content: response.text || response.summary,
      response,
    });
    // Cap the routine thread so long-lived routines don't grow their history without bound.
    store.pruneRoutineMessages(job.conversationId);
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
    releaseActiveRepoLock?.();
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
    return { ok: false, skipped: true, error: "이미 실행 중인 예약 작업입니다." };
  }
  // A routine and an interactive chat share ONE conversation id (a routine's thread
  // is openable in the client). If the owner is mid-turn there, skip this tick: both
  // runs would point the SDK cwd at the SAME working-repo clone / scratch dir and
  // stomp each other (activeRepoLock is re-entrant by conversation id, so it won't
  // catch this). It retries on the next tick once the chat turn is done.
  if (getActiveRunForConversation(job.avatarUserId, job.conversationId)) {
    return { ok: false, skipped: true, error: "대화에서 응답을 생성 중이라 예약 작업을 건너뜁니다." };
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
