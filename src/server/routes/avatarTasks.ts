import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { cancelRun, getRunPrompts, submitResponse } from "../agent/runRegistry.js";
import type { AvatarTask } from "../../shared/avatarTasks.js";
import { apiError, type RouterDeps } from "./_shared.js";

export function createAvatarTasksRouter({ store, auditAs }: RouterDeps): Router {
  const router = Router();
  router.get("/api/me/avatar-api-keys", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ keys: store.listAvatarApiKeys(req.user!.id) });
  });
  router.post("/api/me/avatar-api-keys", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = req.body?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 80) {
      apiError(res, 400, "API 키 이름을 1~80자로 입력해 주세요."); return;
    }
    if (store.listAvatarApiKeys(req.user!.id).length >= 10) {
      apiError(res, 409, "API 키는 최대 10개까지 발급할 수 있습니다."); return;
    }
    const created = store.createAvatarApiKey(req.user!.id, name.trim());
    auditAs(req, "avatar_api_key_create", `key ${created.key.id}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(created);
  });
  router.delete("/api/me/avatar-api-keys/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    if (!store.revokeAvatarApiKey(req.user!.id, req.params.id)) {
      apiError(res, 404, "API 키를 찾을 수 없습니다."); return;
    }
    auditAs(req, "avatar_api_key_revoke", `key ${req.params.id}`);
    res.json({ ok: true });
  });

  // API credentials are deliberately NOT accepted by any session/admin route.
  const external = Router();
  external.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "");
    const key = match ? store.authenticateAvatarApiKey(match[1]) : null;
    if (!key) { apiError(res, 401, "유효한 개인 API 키가 필요합니다."); return; }
    res.locals.avatarApiKey = key;
    next();
  });
  function present(task: AvatarTask) {
    const pendingRequests = task.runId ? getRunPrompts(task.runId, task.ownerUserId) : [];
    const { apiKeyId: _key, userMessagePersisted: _persisted, ownerUserId: _owner, ...publicTask } = task;
    return { ...publicTask, status: pendingRequests.length ? "waiting_input" : task.status, pendingRequests };
  }
  external.post("/", (req, res) => {
    const key = res.locals.avatarApiKey as { id: string; ownerUserId: string };
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["message", "conversationId"].includes(k)) ||
      typeof body.message !== "string" || !body.message.trim() || Buffer.byteLength(body.message, "utf8") > 64 * 1024 ||
      (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.conversationId)))) {
      apiError(res, 400, "message(최대 64KB)와 선택 사항인 conversationId만 전달해 주세요."); return;
    }
    const idempotencyKey = req.get("Idempotency-Key") ?? null;
    if (idempotencyKey !== null && !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      apiError(res, 400, "Idempotency-Key는 1~128자의 공백 없는 ASCII 문자열이어야 합니다."); return;
    }
    if (body.conversationId && store.getConversationAvatarId(key.ownerUserId, body.conversationId) !== key.ownerUserId) {
      apiError(res, 404, "자신의 아바타 대화를 찾을 수 없습니다."); return;
    }
    try {
      const { task, replayed } = store.acceptAvatarTask(key.ownerUserId, key.id, body.message, body.conversationId ?? null, idempotencyKey);
      if (!replayed) store.audit({ actorUserId: key.ownerUserId, actorName: null, action: "avatar_api_task_accept", status: "success", detail: `task ${task.id}, key ${key.id}` });
      res.location(`/api/v1/avatar/tasks/${task.id}`).status(replayed ? 200 : 202).json({ task: present(task) });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "rate_limit") { res.setHeader("Retry-After", "60"); apiError(res, 429, "요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."); }
      else if (code === "idempotency_conflict") apiError(res, 409, "같은 Idempotency-Key에 다른 요청 내용을 사용할 수 없습니다.");
      else throw error;
    }
  });
  external.get("/", (_req, res) => {
    res.json({ tasks: store.listAvatarTasks(res.locals.avatarApiKey.ownerUserId).map(present) });
  });
  external.use("/:id", (req, res, next) => {
    const task = store.getAvatarTask(res.locals.avatarApiKey.ownerUserId, req.params.id);
    if (!task) { apiError(res, 404, "작업을 찾을 수 없습니다."); return; }
    res.locals.avatarTask = task;
    next();
  });
  external.get("/:id", (_req, res) => res.json({ task: present(res.locals.avatarTask) }));
  external.post("/:id/respond", (req, res) => {
    const task = res.locals.avatarTask as AvatarTask;
    const { requestId, value } = req.body ?? {};
    if (typeof requestId !== "string" || !value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 65536) {
      apiError(res, 400, "requestId와 객체 형식의 value가 필요합니다."); return;
    }
    const prompt = task.runId ? getRunPrompts(task.runId, task.ownerUserId).find(p => (p.data as { requestId: string }).requestId === requestId) : null;
    if (!prompt || !task.runId || !submitResponse(task.runId, requestId, task.ownerUserId, value)) {
      apiError(res, 409, "응답할 요청이 없거나 이미 만료되었습니다."); return;
    }
    res.json({ ok: true });
  });
  external.post("/:id/cancel", (_req, res) => {
    const task = res.locals.avatarTask as AvatarTask;
    if (task.status === "queued") store.updateAvatarTask(task.ownerUserId, task.id, "cancelled");
    else if (!task.runId || !cancelRun(task.runId, task.ownerUserId)) {
      apiError(res, 409, "현재 취소할 수 없는 작업입니다."); return;
    }
    res.json({ ok: true });
  });
  router.use("/api/v1/avatar/tasks", external);
  return router;
}
