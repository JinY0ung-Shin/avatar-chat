import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { inspectRepoContents } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { isInternalGitSource } from "../gitCredentials.js";
import { ensureGroupClone, groupKnowledgeRepoContextFor } from "../groupKnowledgeRepo.js";
import { readFile } from "../knowledgeRepo.js";
import { buildKnowledgeGraph, isVaultNotePath } from "../knowledgeGraph.js";
import { apiError, looksLikeRepo, safeString, type RouterDeps } from "./_shared.js";

// ---- Groups (membership roster + group-admin self-service) -----------
// Members of a group auto-trust each other (store.isTrustedFor) and share one
// knowledge repo only group admins may edit. System admins create groups +
// assign group admins via the admin API; group admins self-serve here.
export function createGroupsRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  const isGroupMember = (userId: string, groupId: string) =>
    store.groupRoleFor(userId, groupId) !== null;
  /** A group admin OR a system admin may manage a group's members/repo. */
  const canManageGroup = (userId: string, groupId: string) =>
    store.isAdmin(userId) || store.isGroupAdmin(userId, groupId);

  // The current user's groups, each with its member roster — members discover &
  // chat with teammates' avatars (now auto-trusted via group co-membership).
  router.get("/api/me/groups", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groups = store.listUserGroups(req.user!.id).map((g) => {
      const repo = store.getGroupKnowledgeRepo(g.id);
      return {
        ...g,
        knowledgeRepo: repo.repo,
        knowledgeBranch: repo.branch,
        knowledgeSelected: repo.selected,
        members: store.listGroupMembers(g.id),
      };
    });
    res.json({ groups });
  });

  // Group admin (or system admin) adds a member by username.
  router.post("/api/me/groups/:id/members", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다. (그룹 관리자 전용)");
      return;
    }
    const username = safeString(req.body?.username);
    if (!username) {
      apiError(res, 400, "username이 필요합니다.");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.addGroupMemberByUsername(groupId, username, role);
    if (!member) {
      apiError(res, 404, "해당 사용자를 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "group_member_add", `group=${groupId} +${member.userId} (${role})`);
    res.json({ member });
  });

  // Change a member's role within the group (promote/demote group admin).
  router.patch("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다.");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.setGroupMemberRole(groupId, req.params.userId, role);
    if (!member) {
      apiError(res, 404, "멤버를 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "group_member_role", `group=${groupId} ${req.params.userId} -> ${role}`);
    res.json({ member });
  });

  // Remove a member from the group.
  router.delete("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 멤버를 관리할 권한이 없습니다.");
      return;
    }
    const removed = store.removeGroupMember(groupId, req.params.userId);
    auditAs(req, "group_member_remove", `group=${groupId} -${req.params.userId}`);
    res.json({ ok: removed });
  });

  // Connect/clear the group's shared knowledge repo (group admin only). Validated
  // like the personal repo: a real owner/repo|URL on the internal GitHub host.
  router.put("/api/me/groups/:id/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 공용 지식 저장소를 설정할 수 있습니다.");
      return;
    }
    const repoRaw = req.body?.repo;
    if (repoRaw === null || repoRaw === "") {
      const group = store.setGroupKnowledgeRepo(groupId, null, null);
      res.json({ group });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `그룹 지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    const group = store.setGroupKnowledgeRepo(groupId, repo, branch);
    auditAs(req, "group_repo_set", `group=${groupId} repo=${repo}`);
    res.json({ group });
  });

  // Choose which group-repo plugins members' avatars load; null = load all.
  router.put("/api/me/groups/:id/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 설정할 수 있습니다.");
      return;
    }
    if (!store.getGroupKnowledgeRepo(groupId).repo) {
      apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
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
    const group = store.setGroupKnowledgeSelected(groupId, selected);
    res.json({ group });
  });

  // List the group repo's plugins (any member may view). Clones with the viewer's token.
  router.get(
    "/api/me/groups/:id/knowledge-repo/contents",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ contents: await inspectRepoContents(repoRoot) });
      } catch (error) {
        apiError(res, 502, `저장소를 가져오지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  // Build the group brain's `[[wikilink]]` graph (any member may view).
  router.get(
    "/api/me/groups/:id/knowledge-repo/graph",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ graph: await buildKnowledgeGraph(repoRoot) });
      } catch (error) {
        apiError(res, 502, `지식 그래프를 만들지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  // Read one note from the group brain's vault for the graph view's content
  // panel (any member may view). Mirrors the personal note endpoint.
  router.get(
    "/api/me/groups/:id/knowledge-repo/note",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const path = req.query.path;
      if (!isVaultNotePath(path)) {
        apiError(res, 400, "유효한 노트 경로가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        const content = await readFile(repoRoot, path);
        res.json({ note: { path, content } });
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT" || err.message === "INVALID_PATH" || err.message === "NOT_A_FILE") {
          apiError(res, 404, "노트를 찾을 수 없습니다.");
          return;
        }
        if (err.message === "FILE_TOO_LARGE") {
          apiError(res, 413, "노트가 너무 커서 표시할 수 없습니다.");
          return;
        }
        apiError(res, 502, `노트를 불러오지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  router.post(
    "/api/me/groups/:id/knowledge-repo/refresh",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!isGroupMember(req.user!.id, groupId) && !store.isAdmin(req.user!.id)) {
        apiError(res, 403, "이 그룹의 멤버가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ contents: await inspectRepoContents(repoRoot) });
      } catch (error) {
        apiError(res, 502, `새로고침 실패: ${scrubGitError(error)}`);
      }
    },
  );

  return router;
}
