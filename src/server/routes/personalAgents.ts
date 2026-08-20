import fs from "node:fs";
import { Router, type Response } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import { deleteConversationImages } from "../chatImages.js";
import { deleteConversationFiles } from "../chatFiles.js";
import { ensureClone, knowledgeRepoContextFor } from "../knowledgeRepo.js";
import logger from "../logger.js";
import { scrubGitError } from "../marketplace.js";
import { isModelTier } from "../modelTiers.js";
import { listRepoSkills } from "../skillTransfer.js";
import { MAX_PERSONAL_AGENTS } from "../store.js";
import type { PersonalAgent } from "../types.js";
import {
  normalizePersonalAgentSkills,
  personalAgentAvatarId,
  personalAgentWorkspaceParent,
  MAX_PERSONAL_AGENT_SKILLS,
  PERSONAL_AGENT_DISPLAY_NAME_CAP,
  PERSONAL_AGENT_FIELD_CAPS,
  PERSONAL_AGENT_SKILL_SLUG_CAP,
} from "../personalAgents.js";
import {
  apiError,
  decodeAvatarImage,
  deleteAvatarImageFile,
  safeString,
  saveAvatarImageFile,
  type RouterDeps,
} from "./_shared.js";

// ---- Personal agents (내 봇) ------------------------------------------
// One owner's own chat-contact bots — not users rows, addressed as
// `personal:<ownerUserId>:<agentId>`, reachable by the owner ALONE
// (findChattablePersonalAgent). Phase 1 gates the whole feature on the
// system-admin role, so every route is requireAuth + requireAdmin AND
// re-checks ownership of the row: a miss answers 404, never 403, so one admin
// can't probe another's roster.
export function createPersonalAgentsRouter({
  config,
  store,
  auditAs,
}: RouterDeps): Router {
  const router = Router();

  /** The bot, only when it belongs to the REQUESTING user (404-shape otherwise). */
  const ownedAgent = (
    req: AuthenticatedRequest,
    res: Response,
  ): PersonalAgent | null => {
    const agent = store.getPersonalAgentById(req.params.agentId);
    if (!agent || agent.ownerUserId !== req.user!.id) {
      apiError(res, 404, "봇을 찾을 수 없습니다.");
      return null;
    }
    return agent;
  };

  const agentBodyFields = (body: any) => ({
    alias: typeof body?.alias === "string" ? body.alias : undefined,
    bio: typeof body?.bio === "string" ? body.bio : undefined,
    intro: typeof body?.intro === "string" ? body.intro : undefined,
    persona: typeof body?.persona === "string" ? body.persona : undefined,
    hashtags: Array.isArray(body?.hashtags)
      ? (body.hashtags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : undefined,
    enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
  });
  // Enforce the SAME caps as the MCP writers (create_agent / update_profile) on
  // the HTTP path — one uncapped surface is a cap bypass, and a multi-MB
  // persona/bio would ride into every turn's prompt. Returns false + 400 on the
  // first over-cap field.
  const checkFieldCaps = (body: any, res: Response): boolean => {
    const caps: Record<string, number> = {
      ...PERSONAL_AGENT_FIELD_CAPS,
      displayName: PERSONAL_AGENT_DISPLAY_NAME_CAP,
    };
    for (const [field, cap] of Object.entries(caps)) {
      const value = body?.[field];
      if (typeof value === "string" && value.length > cap) {
        apiError(res, 400, `${field}은(는) 최대 ${cap}자까지 입력할 수 있습니다.`);
        return false;
      }
    }
    return true;
  };
  /**
   * The bot's seed model tier: nothing sent = keep the stored value, null or ""
   * = clear it back to the owner's own remembered default, a known tier applies.
   * Anything else is a 400 — the deployment's tier list is the authority, the
   * same one the composer picker offers.
   */
  const readDefaultModel = (
    body: any,
    res: Response,
  ): { ok: true; value: string | null | undefined } | { ok: false } => {
    const raw = body?.defaultModel;
    if (raw === undefined) return { ok: true, value: undefined };
    if (raw === null || raw === "") return { ok: true, value: null };
    if (isModelTier(raw)) return { ok: true, value: raw };
    apiError(res, 400, "지원하지 않는 모델입니다.");
    return { ok: false };
  };
  /**
   * The bot's skill allowlist: nothing sent = keep the stored list, an array =
   * FULL REPLACE (deduped, blanks dropped). Validation is the shared one every
   * writer runs — the caps and the slug rule live next to the id helpers, not
   * here, so the MCP tools can't diverge from this route.
   */
  const readSelectedSkills = (
    body: any,
    res: Response,
  ): { ok: true; value: string[] | undefined } | { ok: false } => {
    const raw = body?.selectedSkills;
    if (raw === undefined) return { ok: true, value: undefined };
    const parsed = normalizePersonalAgentSkills(raw);
    if (parsed.ok) return { ok: true, value: parsed.slugs };
    if (parsed.reason === "count") {
      apiError(
        res,
        400,
        `스킬은 최대 ${MAX_PERSONAL_AGENT_SKILLS}개까지 지정할 수 있습니다.`,
      );
    } else if (parsed.reason === "length") {
      apiError(
        res,
        400,
        `스킬 이름은 최대 ${PERSONAL_AGENT_SKILL_SLUG_CAP}자까지 지원합니다.`,
      );
    } else if (parsed.reason === "slug") {
      // The owner's own input echoed back, clipped: a slug is a directory name,
      // so anything long here is a mistake, not a name worth repeating in full.
      apiError(res, 400, `사용할 수 없는 스킬 이름입니다: ${parsed.slug.slice(0, 40)}`);
    } else {
      apiError(res, 400, "스킬 목록 형식이 올바르지 않습니다.");
    }
    return { ok: false };
  };
  /** The store's single-enforcement-point throws → their user-facing 400s. */
  const respondWriteError = (error: unknown, res: Response): void => {
    const code = error instanceof Error ? error.message : "";
    if (code === "INVALID_PERSONAL_AGENT_NAME") {
      apiError(res, 400, "봇 이름을 입력해 주세요.");
      return;
    }
    if (code === "PERSONAL_AGENT_LIMIT") {
      apiError(res, 400, `봇은 최대 ${MAX_PERSONAL_AGENTS}개까지 만들 수 있습니다.`);
      return;
    }
    throw error;
  };

  // The owner's full roster, DISABLED included: this list is where a disabled
  // bot gets re-enabled, so it has to stay visible here (discovery hides it).
  // Each row carries `memoryDir` + `selectedSkills` straight off the domain
  // type — the settings card reads both.
  router.get(
    "/api/me/agents",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      res.json({
        agents: store.listPersonalAgents(req.user!.id, {
          includeDisabled: true,
        }),
      });
    },
  );

  // What the owner may GRANT to a bot: the skills in their OWN knowledge repo.
  // Registered before every `/:agentId` route so the literal path can never be
  // captured as a bot id. No repo is a NORMAL state (the card renders a connect
  // guide), and a repo with no `skills/` answers an empty list — only a clone
  // FAILURE is an error, since that one is fixable (address/branch/token).
  router.get(
    "/api/me/agents/skill-catalog",
    requireAuth(store),
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
      if (!ctx) {
        res.json({ repoConfigured: false, skills: [] });
        return;
      }
      let repoRoot: string;
      try {
        repoRoot = await ensureClone(ctx);
      } catch (error) {
        apiError(res, 502, `지식 저장소를 불러오지 못했습니다: ${scrubGitError(error)}`);
        return;
      }
      res.json({
        repoConfigured: true,
        // `intro` is the SKILL.md frontmatter description — written for the
        // model, but it is the only one-liner the repo has for a skill.
        skills: listRepoSkills(repoRoot).map((skill) => ({
          slug: skill.slug,
          intro: skill.description,
        })),
      });
    },
  );

  router.post(
    "/api/me/agents",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const displayName = safeString(req.body?.displayName);
      if (!displayName) {
        apiError(res, 400, "봇 이름을 입력해 주세요.");
        return;
      }
      if (!checkFieldCaps(req.body, res)) return;
      const defaultModel = readDefaultModel(req.body, res);
      if (!defaultModel.ok) return;
      const selectedSkills = readSelectedSkills(req.body, res);
      if (!selectedSkills.ok) return;
      let agent: PersonalAgent;
      try {
        agent = store.createPersonalAgent(req.user!.id, {
          displayName,
          ...agentBodyFields(req.body),
          defaultModel: defaultModel.value,
          selectedSkills: selectedSkills.value,
        });
      } catch (error) {
        respondWriteError(error, res);
        return;
      }
      auditAs(
        req,
        "personal_agent_create",
        `agent=${agent.id} (${agent.displayName})`,
      );
      res.json({ agent });
    },
  );

  // Update one bot (fields incl. enabled — disabling blocks the next turn but
  // preserves the owner's threads).
  router.patch(
    "/api/me/agents/:agentId",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agent = ownedAgent(req, res);
      if (!agent) return;
      const displayNameRaw = req.body?.displayName;
      if (displayNameRaw !== undefined && !safeString(displayNameRaw)) {
        apiError(res, 400, "봇 이름은 비울 수 없습니다.");
        return;
      }
      if (!checkFieldCaps(req.body, res)) return;
      const defaultModel = readDefaultModel(req.body, res);
      if (!defaultModel.ok) return;
      const selectedSkills = readSelectedSkills(req.body, res);
      if (!selectedSkills.ok) return;
      let updated: PersonalAgent | null;
      try {
        updated = store.updatePersonalAgent(agent.id, {
          displayName:
            displayNameRaw !== undefined ? safeString(displayNameRaw) : undefined,
          ...agentBodyFields(req.body),
          defaultModel: defaultModel.value,
          selectedSkills: selectedSkills.value,
        });
      } catch (error) {
        respondWriteError(error, res);
        return;
      }
      auditAs(
        req,
        "personal_agent_update",
        `agent=${agent.id}` +
          // A skill grant is the one field worth naming in the log: it changes
          // what the bot can DO, not just how it reads.
          (selectedSkills.value
            ? ` skills=${selectedSkills.value.length}`
            : ""),
      );
      res.json({ agent: updated });
    },
  );

  // Delete one bot: cascades ITS conversations (the thread-preserving
  // alternative is disabling). The profile image, the workspace tree and every
  // thread's chat image/file dirs are swept from the pre-cascade snapshot.
  router.delete(
    "/api/me/agents/:agentId",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agent = ownedAgent(req, res);
      if (!agent) return;
      const avatarId = personalAgentAvatarId(agent.ownerUserId, agent.id);
      const conversationIds = store.listConversationIdsForAvatar(avatarId);
      const imageExt = store.getPersonalAgentImageExtByAvatarId(avatarId);
      store.deletePersonalAgent(agent.id);
      try {
        deleteAvatarImageFile(config, avatarId, imageExt);
        fs.rmSync(personalAgentWorkspaceParent(config, agent), {
          recursive: true,
          force: true,
        });
        for (const conversationId of conversationIds) {
          deleteConversationImages(config, conversationId);
          deleteConversationFiles(config, conversationId);
        }
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id },
          "personal-agent delete disk cleanup failed",
        );
      }
      auditAs(
        req,
        "personal_agent_delete",
        `agent=${agent.id} (${agent.displayName})`,
      );
      res.json({ ok: true });
    },
  );

  // Bot profile image — the users avatar-image pattern with the namespaced id;
  // bytes on disk under the composite id, ext on the row.
  router.put(
    "/api/me/agents/:agentId/image",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agent = ownedAgent(req, res);
      if (!agent) return;
      const decoded = decodeAvatarImage(req.body?.image);
      if ("error" in decoded) {
        apiError(res, 400, decoded.error);
        return;
      }
      saveAvatarImageFile(
        config,
        personalAgentAvatarId(agent.ownerUserId, agent.id),
        decoded.ext,
        decoded.buffer,
      );
      store.setPersonalAgentImageExt(agent.id, decoded.ext);
      auditAs(req, "personal_agent_image", `agent=${agent.id}`);
      res.json({ ok: true, hasImage: true });
    },
  );

  router.delete(
    "/api/me/agents/:agentId/image",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const agent = ownedAgent(req, res);
      if (!agent) return;
      const avatarId = personalAgentAvatarId(agent.ownerUserId, agent.id);
      deleteAvatarImageFile(
        config,
        avatarId,
        store.getPersonalAgentImageExtByAvatarId(avatarId),
      );
      store.setPersonalAgentImageExt(agent.id, null);
      auditAs(req, "personal_agent_image", `agent=${agent.id} image removed`);
      res.json({ ok: true, hasImage: false });
    },
  );

  return router;
}
