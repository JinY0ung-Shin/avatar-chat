import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { forgetClone, inspectRepoContents, pluginClonePath, syncPluginRepo } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { apiError, looksLikeRepo, safeString, type RouterDeps } from "./_shared.js";

// ---- Plugins ---------------------------------------------------------
export function createPluginsRouter({ config, store }: RouterDeps): Router {
  const router = Router();

  router.get("/api/me/plugins", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ plugins: store.listPlugins(req.user!.id) });
  });

  router.post("/api/me/plugins", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const repo = safeString(req.body?.repo);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    const ref = safeString(req.body?.ref) || undefined;
    const label = safeString(req.body?.label) || undefined;
    const plugin = store.addPlugin(req.user!.id, { repo, ref, label });
    logger.info({ userId: req.user!.id, pluginId: plugin.id, repo }, "plugin added");
    res.json({ plugin });
  });

  router.patch("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const id = req.params.id;
    const body = req.body ?? {};
    const hasEnabled = typeof body.enabled === "boolean";
    const hasSelected = "selected" in body;
    const hasRef = "ref" in body;
    if (!hasEnabled && !hasSelected && !hasRef) {
      apiError(res, 400, "enabled(boolean), selected(배열|null), 또는 ref(문자열|null) 중 하나가 필요합니다.");
      return;
    }
    // Validate `selected`: null (= load all) or an array of plugin-name strings.
    let selected: string[] | null | undefined;
    if (hasSelected) {
      const raw = body.selected;
      if (raw === null) {
        selected = null;
      } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
        selected = raw as string[];
      } else {
        apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
        return;
      }
    }
    if (!store.getPlugin(userId, id)) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    let plugin = store.getPlugin(userId, id);
    if (hasEnabled) {
      plugin = store.setPluginEnabled(userId, id, body.enabled);
    }
    if (hasSelected) {
      plugin = store.setPluginSelected(userId, id, selected ?? null);
    }
    if (hasRef) {
      plugin = store.setPluginRef(userId, id, safeString(body.ref) || null);
      // Drop the clone cache so the next sync checks out the new ref.
      forgetClone(pluginClonePath(userId, plugin!.repo, config));
    }
    res.json({ plugin });
  });

  // List the plugins a repo contains (clones/caches it), for the selection UI.
  router.get("/api/me/plugins/:id/contents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const plugin = store.getPlugin(req.user!.id, req.params.id);
    if (!plugin) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    try {
      const dir = await syncPluginRepo(req.user!.id, plugin, config, false, store.getGitTokens(req.user!.id));
      store.markPluginSynced(req.user!.id, req.params.id);
      const contents = await inspectRepoContents(dir);
      res.json({ contents });
    } catch (error) {
      const detail = scrubGitError(error);
      apiError(res, 502, `저장소를 가져오지 못했습니다: ${detail}`);
    }
  });

  // Force-refresh a plugin's clone (git fetch + checkout), bypassing the cache.
  router.post("/api/me/plugins/:id/refresh", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const plugin = store.getPlugin(req.user!.id, req.params.id);
    if (!plugin) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    try {
      await syncPluginRepo(req.user!.id, plugin, config, true, store.getGitTokens(req.user!.id));
      const updated = store.markPluginSynced(req.user!.id, req.params.id);
      res.json({ plugin: updated });
    } catch (error) {
      const detail = scrubGitError(error);
      apiError(res, 502, `새로고침 실패: ${detail}`);
    }
  });

  router.delete("/api/me/plugins/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.deletePlugin(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "플러그인을 찾을 수 없습니다.");
      return;
    }
    logger.info({ userId: req.user!.id, pluginId: req.params.id }, "plugin removed");
    res.json({ ok: true });
  });

  return router;
}
