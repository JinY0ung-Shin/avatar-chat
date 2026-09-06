import type { AppServices } from "./app.js";
import type { AvatarTask, AvatarTaskStatus } from "../shared/avatarTasks.js";
import { getActiveRunForConversation } from "./agent/runRegistry.js";
import { executeChatTurn, resolveChatTarget } from "./routes/chat.js";
import logger from "./logger.js";

const states = new WeakMap<AppServices, { owners: Set<string>; stopped: boolean }>();
function stateFor(services: AppServices) {
  let state = states.get(services);
  if (!state) {
    state = { owners: new Set(), stopped: false };
    states.set(services, state);
  }
  return state;
}

async function runTask(services: AppServices, task: AvatarTask): Promise<void> {
  const { store, config, observedModel } = services;
  const update = (status: AvatarTaskStatus, options: Parameters<typeof store.updateAvatarTask>[3] = {}) =>
    store.updateAvatarTask(task.ownerUserId, task.id, status, options);
  try {
    // Revalidate the authorization and thread at dispatch, after any queue delay.
    const owner = store.getUserById(task.ownerUserId);
    if (!owner || !store.avatarTaskKeyActive(task.ownerUserId, task.apiKeyId)) {
      update("failed", { error: "API 키가 폐기되었거나 계정을 사용할 수 없습니다." });
      return;
    }
    if (store.getConversationAvatarId(owner.id, task.conversationId) !== owner.id) {
      update("failed", { error: "대화가 삭제되었거나 자신의 아바타 대화가 아닙니다." });
      return;
    }
    const target = resolveChatTarget({ store, externalAgents: [], viewerGroupIds: new Set(),
      viewerUserId: owner.id, avatarId: owner.id, hasImages: false, ownerOnlyCommand: false });
    if (!target.ok) {
      update("failed", { error: target.refusal.message });
      return;
    }
    // Keep completion separate from HTTP acceptance: executeChatTurn also returns
    // ok after persisting an SDK failure/cancellation. Its terminal events decide.
    const terminal: { status: AvatarTaskStatus; result?: unknown; error?: string } = { status: "failed", error: "작업이 결과 없이 종료되었습니다." };
    const outcome = await executeChatTurn({ config, store, observedModel }, {
      ownerUserId: owner.id, ownerDisplayName: owner.displayName, target: target.target,
      conversationId: task.conversationId, agentMessage: task.message, displayMessage: task.message,
      images: [], regenerate: false, skipUserMessagePersist: task.userMessagePersisted,
      unattendedDeadlineMs: config.botTaskRunTimeoutMs,
      audit: entry => store.audit({ actorUserId: owner.id, actorName: owner.displayName,
        action: "avatar_api_task", status: entry.status ?? "success", detail: `task ${task.id}: ${entry.detail}` }),
    }, {
      onRunOpen: runId => { update("running", { runId, userMessagePersisted: true }); return true; },
      onEvent: (event, data) => {
        const payload = data as { response?: unknown; error?: string };
        if (event === "done") {
          terminal.status = "succeeded"; terminal.result = payload.response; terminal.error = undefined;
        } else if (event === "error" || event === "cancelled") {
          terminal.status = event === "error" ? "failed" : "cancelled";
          terminal.error = payload.error; terminal.result = payload.response;
        }
      },
    });
    if (!outcome.ok) {
      // A chat may have acquired the thread/repo during asynchronous setup.
      // Preserve the prelude's already-written user bubble before retrying.
      update(outcome.refusal.status === 409 ? "queued" : "failed", {
        error: outcome.refusal.status === 409 ? null : outcome.refusal.message,
        userMessagePersisted: task.userMessagePersisted || outcome.refusal.userMessagePersisted === true,
      });
      return;
    }
    update(terminal.status, { result: terminal.result, error: terminal.error });
  } catch {
    // Do not persist raw setup errors: these may include credentials in argv.
    update("failed", { error: "작업 실행을 시작하지 못했습니다. 연결 설정과 대화를 확인해 주세요." });
    logger.error({ taskId: task.id }, "avatar API task failed");
  }
}

/** One run per API owner, at most four API runs process-wide per service. */
export function dispatchAvatarTasks(services: AppServices): void {
  const state = stateFor(services);
  if (state.stopped) return;
  for (const task of services.store.queuedAvatarTasks()) {
    if (state.owners.size >= 4) break;
    if (state.owners.has(task.ownerUserId) || getActiveRunForConversation(task.ownerUserId, task.conversationId)) continue;
    if (!services.store.claimAvatarTask(task.ownerUserId, task.id)) continue;
    state.owners.add(task.ownerUserId);
    void runTask(services, task).catch(() => {
      logger.error({ taskId: task.id }, "avatar API task bookkeeping failed");
    }).finally(() => { state.owners.delete(task.ownerUserId); });
  }
}

export function startAvatarTaskDispatcher(services: AppServices): () => void {
  const state = stateFor(services);
  state.stopped = false;
  services.store.recoverAvatarTasks();
  const tick = () => {
    try { dispatchAvatarTasks(services); }
    catch { logger.error("avatar API task dispatcher failed"); }
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => { state.stopped = true; clearInterval(timer); };
}
