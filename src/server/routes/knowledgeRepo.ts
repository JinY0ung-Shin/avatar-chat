import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { inspectRepoContents } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { isInternalGitSource } from "../gitCredentials.js";
import { ensureClone, knowledgeRepoContextFor, readFile } from "../knowledgeRepo.js";
import { buildKnowledgeGraph, isVaultNotePath } from "../knowledgeGraph.js";
import { generateSshKeyPair, deriveSshPublicKey } from "../sshIdentity.js";
import { isShellExposableSecret } from "../secretPolicy.js";
import {
  apiError,
  looksLikeRepo,
  respondNoteFsError,
  safeString,
  type RouterDeps,
} from "./_shared.js";
import type { Response } from "express";
import type { KnowledgeRepoContext } from "../knowledgeRepo.js";

/**
 * ensureClone → inspectRepoContents → res.json, shared by the personal repo's
 * GET /contents and POST /refresh (functionally identical bodies; only the
 * Korean catch label differs). User-facing Korean — `errorLabel` carries it.
 */
async function respondRepoContents(
  res: Response,
  ctx: KnowledgeRepoContext,
  errorLabel: string,
): Promise<void> {
  try {
    const repoRoot = await ensureClone(ctx);
    const contents = await inspectRepoContents(repoRoot);
    res.json({ contents });
  } catch (error) {
    apiError(res, 502, `${errorLabel}: ${scrubGitError(error)}`);
  }
}

// ---- Git credentials & personal knowledge repo ----------------------
// The knowledge repo is browsed/edited/committed by the AVATAR via chat (the
// owner-only `mcp__repo__*` tools), not here — these routes only store the
// token, the commit identity, and the repo location.
export function createKnowledgeRepoRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  // Set (or clear) the user's internal Git token. Write-only: the token is
  // never returned — `user.gitTokenSet` reflects whether GIT_TOKEN is stored.
  router.put("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      apiError(res, 400, "token을 입력해 주세요.");
      return;
    }
    const user = store.setGitToken(req.user!.id, token);
    logger.info({ userId: req.user!.id }, "internal git token set");
    res.json({ user });
  });

  router.delete("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const user = store.setGitToken(req.user!.id, null);
    logger.info({ userId: req.user!.id }, "internal git token cleared");
    res.json({ user });
  });

  // Per-user secrets: named values (e.g. SSH_PRIVATE_KEY) encrypted at rest and
  // injected ONLY into the avatar's MCP subprocess env — never returned to the
  // client or visible to the agent. `user.secretNames` lists which are set.
  // The name must be a valid env-var key so it can be passed through as-is.
  const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

  router.put("/api/me/secrets/:name", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    if (!SECRET_NAME_RE.test(name)) {
      apiError(res, 400, "secret 이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      return;
    }
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    if (!value) {
      apiError(res, 400, "value를 입력해 주세요.");
      return;
    }
    store.setUserSecret(req.user!.id, name, value);
    // Keep the SSH public key queryable: setUserSecret clears ssh_public_key
    // when SSH_PRIVATE_KEY changes, so derive and re-store the public half for a
    // pasted key (best-effort — an unparseable/passphrase key just leaves it unset).
    if (name === "SSH_PRIVATE_KEY") {
      const derived = await deriveSshPublicKey(value, `avatar-chat-${req.user!.username}`);
      if (derived) {
        store.setSshPublicKey(req.user!.id, derived.publicKey);
      } else {
        logger.warn({ userId: req.user!.id }, "could not derive ssh public key from pasted SSH_PRIVATE_KEY");
      }
    }
    logger.info({ userId: req.user!.id, name }, "user secret set");
    res.json({ user: store.getUserById(req.user!.id) });
  });

  router.delete("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    // Validate + 404 like the PATCH sibling, instead of the old always-200 no-op.
    if (!SECRET_NAME_RE.test(name)) {
      apiError(res, 400, "secret 이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      return;
    }
    if (!store.deleteUserSecret(req.user!.id, name)) {
      apiError(res, 404, "등록되지 않은 시크릿입니다.");
      return;
    }
    logger.info({ userId: req.user!.id, name }, "user secret cleared");
    res.json({ user: store.getUserById(req.user!.id) });
  });

  // Per-secret agent-shell exposure toggle (value untouched — the value is
  // write-only via PUT). Reserved git/SSH names have dedicated routing and can
  // never be shell-exposed.
  router.patch("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    if (typeof req.body?.shellExpose !== "boolean") {
      apiError(res, 400, "shellExpose(boolean)를 보내 주세요.");
      return;
    }
    if (!isShellExposableSecret(name)) {
      apiError(res, 400, "이 시크릿은 전용 경로로만 사용되어 셸에 노출할 수 없습니다.");
      return;
    }
    if (!store.setSecretShellExpose(req.user!.id, name, req.body.shellExpose)) {
      apiError(res, 404, "등록되지 않은 시크릿입니다.");
      return;
    }
    logger.info(
      { userId: req.user!.id, name, shellExpose: req.body.shellExpose },
      "user secret shell exposure toggled",
    );
    res.json({ user: store.getUserById(req.user!.id) });
  });

  router.post("/api/me/ssh-key", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const user = store.getUserById(req.user!.id);
    const secretNames = store.listUserSecretNames(req.user!.id);
    if (secretNames.includes("SSH_PRIVATE_KEY") || user?.sshPublicKey) {
      apiError(
        res,
        409,
        user?.sshPublicKey
          ? "이미 SSH 키가 설정되어 있습니다."
          : "이미 SSH_PRIVATE_KEY 시크릿이 설정되어 있습니다.",
      );
      return;
    }
    try {
      const pair = await generateSshKeyPair(`avatar-chat-${req.user!.username}`);
      const updated = store.setSshKeyPair(req.user!.id, pair.privateKey, pair.publicKey);
      auditAs(
        req,
        "ssh_identity_generate_key",
        JSON.stringify({ fingerprint: pair.fingerprint, source: "settings" }),
      );
      logger.info({ userId: req.user!.id }, "ssh key generated");
      res.json({ user: updated, publicKey: pair.publicKey, fingerprint: pair.fingerprint });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiError(res, 500, `SSH 키를 생성하지 못했습니다: ${message}`);
    }
  });

  // Set the commit author identity used for knowledge-repo commits.
  router.put("/api/me/git-identity", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = safeString(req.body?.name) || null;
    const email = safeString(req.body?.email) || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      apiError(res, 400, "email 형식이 올바르지 않습니다.");
      return;
    }
    const user = store.setGitIdentity(req.user!.id, name, email);
    res.json({ user });
  });

  // Point the user at a personal knowledge repo (owner/repo or git URL). The
  // avatar manages the repo's contents itself via chat; this only stores where
  // it lives. An empty/null repo clears it.
  router.put("/api/me/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const repoRaw = req.body?.repo;
    if (repoRaw === null || repoRaw === "") {
      const user = store.setKnowledgeRepo(req.user!.id, null, null);
      res.json({ user });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    const user = store.setKnowledgeRepo(req.user!.id, repo, branch);
    res.json({ user });
  });

  // List the plugins the connected knowledge repo contains, for the selection
  // UI. Clones/fetches the repo (same working tree the agent's repo tools use).
  router.get("/api/me/knowledge-repo/contents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    await respondRepoContents(res, ctx, "저장소를 가져오지 못했습니다");
  });

  // Build the second-brain `[[wikilink]]` graph for the interactive graph view.
  // Same clone the agent's repo tools use; pure read, returns {nodes, edges}.
  router.get("/api/me/knowledge-repo/graph", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    try {
      const repoRoot = await ensureClone(ctx);
      const graph = await buildKnowledgeGraph(repoRoot);
      res.json({ graph });
    } catch (error) {
      apiError(res, 502, `지식 그래프를 만들지 못했습니다: ${scrubGitError(error)}`);
    }
  });

  // Read one vault note's markdown for the graph view's content panel. A graph
  // node id IS the repo-relative path, so the client passes it straight through;
  // we only serve vault markdown and lean on readFile's traversal guard. Pure
  // read over the same clone the graph endpoint uses.
  router.get("/api/me/knowledge-repo/note", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const path = req.query.path;
    if (!isVaultNotePath(path)) {
      apiError(res, 400, "유효한 노트 경로가 아닙니다.");
      return;
    }
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    try {
      const repoRoot = await ensureClone(ctx);
      const content = await readFile(repoRoot, path);
      res.json({ note: { path, content } });
    } catch (error) {
      respondNoteFsError(res, error);
    }
  });

  // Force a re-sync of the connected knowledge repo from its remote. `ensureClone`
  // already does `git fetch --prune` + `checkout -B <branch> origin/<branch>` on
  // every call, so this is simply ensureClone + return the (possibly changed)
  // plugin list. No clone-cache to clear — knowledge repos aren't in `clonedPaths`.
  router.post("/api/me/knowledge-repo/refresh", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    await respondRepoContents(res, ctx, "새로고침 실패");
  });

  // Choose which knowledge-repo plugins the avatar loads. `selected: null`
  // (or all/empty) means "load all" — the repo is the avatar's by default.
  router.put("/api/me/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    if (!store.getKnowledgeRepo(req.user!.id).repo) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    const raw = req.body?.selected;
    let selected: string[] | null;
    if (raw === null || raw === undefined) {
      selected = null;
    } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
      selected = raw as string[];
    } else {
      apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
      return;
    }
    const user = store.setKnowledgeSelected(req.user!.id, selected);
    res.json({ user });
  });

  // ---- Knowledge (owner's gap inbox: colleague questions to handle) ----

  router.get("/api/me/knowledge/requests", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const status = safeString(req.query.status);
    const allowed = ["open", "resolved"] as const;
    const filter = (allowed as readonly string[]).includes(status)
      ? (status as (typeof allowed)[number])
      : undefined;
    res.json({ requests: store.listKnowledgeRequests(req.user!.id, filter) });
  });

  // Resolve (close) a gap once handled. No body: the avatar learns via plugins,
  // so there's no answer to store — clearing the request is the whole action.
  router.delete(
    "/api/me/knowledge/requests/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const resolved = store.resolveKnowledgeRequest(req.user!.id, req.params.id);
      if (!resolved) {
        apiError(res, 404, "정보 요청을 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  // ---- Avatar notifications (owner inbox / alarms) ---------------------

  router.get("/api/me/notifications", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ notifications: store.listAvatarNotifications(req.user!.id, req.query.unread === "1") });
  });

  router.post("/api/me/notifications/read-all", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ changed: store.markAllAvatarNotificationsRead(req.user!.id) });
  });

  router.delete("/api/me/notifications", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ deleted: store.deleteAllAvatarNotifications(req.user!.id) });
  });

  router.patch("/api/me/notifications/:id/read", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.markAvatarNotificationRead(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "알림을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/api/me/notifications/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.deleteAvatarNotification(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "알림을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
