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

/**
 * User-facing note stored on a timed-out routine.
 *
 * The SDK labels EVERY abort as "Claude Code process aborted by user" regardless of
 * cause (it just checks `signal.aborted`), so storing its message verbatim told the
 * owner a user cancelled a run that nothing but this deadline touched — routines have
 * no cancel route and are not in the run registry, so `cancelAllRuns()` can't reach
 * them either. Derived from the SAME config value that armed the deadline so the two
 * can't drift.
 */
function routineTimeoutMessage(timeoutMs: number): string {
  return `실행 제한 시간(${Math.round(timeoutMs / 60_000)}분)을 초과해 중단되었습니다. 작업을 더 작은 단계로 나누거나 예약 작업의 프롬프트를 줄여 보세요.`;
}

/**
 * Korean-lead a non-timeout routine failure. The cause is usually a raw English
 * SDK/git error, and this text is persisted BOTH as the assistant message in the
 * routine thread and as `lastError` (rendered verbatim in RoutinesView).
 */
function routineFailureMessage(error: unknown): string {
  const cause = (error instanceof Error ? error.message : String(error)).trim();
  return cause
    ? `예약 작업 실행에 실패했습니다: ${cause}`
    : "예약 작업 실행에 실패했습니다.";
}

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
  // Hard deadline per unattended run: a hung SDK call must not wedge the job forever
  // (nothing else can reach it — routines have no cancel route).
  //
  // NOTE this is a budget for the WHOLE run, including every model-fallback attempt
  // (`modelFallback: true` retries opus→sonnet→haiku INSIDE runClaudeAgent) and the
  // resume self-heal retry — the controller is created here, outside that loop. A
  // slow first attempt therefore starves the rest of the chain.
  const timeoutMs = config.routineRunTimeoutMs;
  // Distinguishes OUR deadline from any other abort, so the catch below can replace
  // the SDK's misleading "aborted by user" with the real cause.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  // Text streamed before a failure. Routines have no live view, but persisting the
  // partial is what makes an interrupted run diagnosable at all — otherwise the only
  // trace is a one-line lastError. Mirrors the chat route's cancel/error paths.
  let streamedText = "";
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
      // Headless runs cannot ask questions or wait for approvals, so there is no
      // onQuestion/onPermission here. onDelta is purely an accumulator: it keeps the
      // partial answer so a timed-out/failed run can still persist what it produced
      // (the success path uses `response.text`, which never arrives on abort).
      {
        onDelta: (text) => {
          streamedText += text;
        },
      },
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
    // Our deadline wins the message: the SDK's abort text names a "user" that was
    // never involved in an unattended run.
    const detail = timedOut
      ? routineTimeoutMessage(timeoutMs)
      : routineFailureMessage(error);
    // Keep whatever the run produced before dying, alongside the cause — otherwise an
    // interrupted routine leaves NOTHING in its thread (this path never wrote a
    // message at all) and the owner can't tell how far it got. Best-effort: a failure
    // here must not mask the original error.
    try {
      const content = streamedText ? `${streamedText}\n\n${detail}` : detail;
      store.touchConversation(
        job.avatarUserId,
        job.conversationId,
        job.avatarUserId,
        `[예약 작업] ${job.prompt}`,
        { isRoutine: true },
      );
      store.addMessage(job.conversationId, { role: "user", content: job.prompt });
      store.addMessage(job.conversationId, { role: "assistant", content });
      store.pruneRoutineMessages(job.conversationId);
    } catch (persistError) {
      schedLogger.error(
        { jobId: job.id, err: persistError },
        "routine failed to persist partial output",
      );
    }
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
