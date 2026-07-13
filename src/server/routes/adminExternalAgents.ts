import type { Response, Router } from "express";
import {
  requireAdmin,
  requireAuth,
  type AuthenticatedRequest,
} from "../auth.js";
import { probeExternalAgentGateway } from "../agent/externalAgent.js";
import {
  MAX_EXTERNAL_AGENTS,
  adminExternalAgent,
  externalAvatarId,
  mergeExternalAgentRegistries,
  parseAdminExternalAgentInput,
} from "../externalAgents.js";
import logger from "../logger.js";
import type { ExternalAgentConfig } from "../types.js";
import { apiError, safeString, type RouterDeps } from "./_shared.js";

function inputError(res: Response, error: unknown): void {
  const raw = error instanceof Error ? error.message : "설정 형식이 올바르지 않습니다.";
  const detail = raw
    .replace(/^EXTERNAL_AGENTS_JSON\[0\]\.?/, "")
    .replace(/^EXTERNAL_AGENTS_JSON\[0\]\s+/, "");
  apiError(res, 400, `외부 아바타 설정을 확인해 주세요: ${detail}`);
}

/** Register the external-avatar admin surface without growing the main admin router further. */
export function registerAdminExternalAgentRoutes(
  router: Router,
  { config, store, auditAs }: RouterDeps,
): void {
  const environmentAgents = () => config.externalAgents ?? [];
  const managedState = () => store.getManagedExternalAgentsState();
  const effectiveAgents = () =>
    mergeExternalAgentRegistries(environmentAgents(), managedState().agents);
  const environmentIds = () =>
    new Set(environmentAgents().map((agent) => agent.id));
  const countHistory = (agent: ExternalAgentConfig) =>
    store.countConversationsForAvatar(externalAvatarId(agent));

  const validateGroups = (
    agent: ExternalAgentConfig,
    res: Response,
  ): boolean => {
    const missing = agent.visibleToGroupIds?.find(
      (groupId) => !store.getGroup(groupId),
    );
    if (!missing) return true;
    apiError(res, 400, "선택한 그룹 중 현재 존재하지 않는 그룹이 있습니다.");
    return false;
  };

  const blockCorruptRegistry = (res: Response): boolean => {
    if (!managedState().configError) return false;
    apiError(
      res,
      409,
      "저장된 외부 아바타 설정을 읽을 수 없어 변경을 중단했습니다. SESSION_SECRET과 저장 데이터를 확인해 주세요.",
    );
    return true;
  };

  const replaceRegistry = (
    res: Response,
    expected: readonly ExternalAgentConfig[],
    next: readonly ExternalAgentConfig[],
    rebind?: {
      avatarId: string;
      previousEndpoint: string;
      nextEndpoint: string;
    },
  ): boolean => {
    if (store.replaceManagedExternalAgents(expected, next, rebind)) return true;
    apiError(
      res,
      409,
      "외부 아바타 설정이 다른 관리자 작업으로 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.",
    );
    return false;
  };

  router.get(
    "/api/admin/external-agents",
    requireAuth(store),
    requireAdmin,
    (_req, res) => {
      const state = managedState();
      const envIds = environmentIds();
      const agents = [
        ...environmentAgents().map((agent) =>
          adminExternalAgent(agent, "environment", countHistory(agent)),
        ),
        ...state.agents
          .filter((agent) => !envIds.has(agent.id))
          .map((agent) =>
            adminExternalAgent(agent, "managed", countHistory(agent)),
          ),
      ].sort((a, b) => a.displayName.localeCompare(b.displayName));
      res.json({
        agents,
        configError: state.configError,
        shadowedManagedIds: state.agents
          .filter((agent) => envIds.has(agent.id))
          .map((agent) => agent.id),
      });
    },
  );

  router.post(
    "/api/admin/external-agents",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (blockCorruptRegistry(res)) return;
      let agent: ExternalAgentConfig;
      try {
        agent = parseAdminExternalAgentInput(req.body?.agent);
      } catch (error) {
        inputError(res, error);
        return;
      }
      if (!validateGroups(agent, res)) return;
      const state = managedState();
      if (effectiveAgents().some((item) => item.id === agent.id)) {
        apiError(res, 409, "같은 ID의 외부 아바타가 이미 있습니다.");
        return;
      }
      if (effectiveAgents().length >= MAX_EXTERNAL_AGENTS) {
        apiError(res, 400, `외부 아바타는 최대 ${MAX_EXTERNAL_AGENTS}개까지 등록할 수 있습니다.`);
        return;
      }
      if (!replaceRegistry(res, state.agents, [...state.agents, agent])) return;
      auditAs(req, "external_agent_create", `external agent ${agent.id}`);
      logger.info(
        { actorId: req.user!.id, externalAgentId: agent.id },
        "external agent created",
      );
      res.status(201).json({
        agent: adminExternalAgent(agent, "managed", 0),
      });
    },
  );

  router.put(
    "/api/admin/external-agents/:id",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (blockCorruptRegistry(res)) return;
      if (environmentIds().has(req.params.id)) {
        apiError(res, 409, "환경 변수에서 관리되는 외부 아바타는 UI에서 수정할 수 없습니다.");
        return;
      }
      const state = managedState();
      const index = state.agents.findIndex((item) => item.id === req.params.id);
      if (index < 0) {
        apiError(res, 404, "외부 아바타를 찾을 수 없습니다.");
        return;
      }
      const previous = state.agents[index];
      let agent: ExternalAgentConfig;
      try {
        agent = parseAdminExternalAgentInput(req.body?.agent, previous);
      } catch (error) {
        inputError(res, error);
        return;
      }
      if (agent.id !== req.params.id) {
        apiError(res, 400, "외부 아바타 ID는 생성 후 변경할 수 없습니다.");
        return;
      }
      if (!validateGroups(agent, res)) return;
      const historyCount = countHistory(previous);
      if (
        historyCount > 0 &&
        previous.endpoint !== agent.endpoint &&
        req.body?.confirmEndpointChange !== true
      ) {
        apiError(
          res,
          409,
          "기존 대화 기록이 있는 아바타의 Gateway 주소를 바꾸려면 기록 전송 위험을 확인해야 합니다.",
        );
        return;
      }
      const next = [...state.agents];
      next[index] = agent;
      const endpointRebind =
        historyCount > 0 && previous.endpoint !== agent.endpoint
          ? {
              avatarId: externalAvatarId(previous),
              previousEndpoint: previous.endpoint,
              nextEndpoint: agent.endpoint,
            }
          : undefined;
      if (!replaceRegistry(res, state.agents, next, endpointRebind)) return;
      const action =
        previous.enabled !== false && agent.enabled === false
          ? "external_agent_disable"
          : previous.enabled === false && agent.enabled !== false
            ? "external_agent_enable"
            : "external_agent_update";
      auditAs(req, action, `external agent ${agent.id}`);
      logger.info(
        { actorId: req.user!.id, externalAgentId: agent.id, action },
        "external agent updated",
      );
      res.json({
        agent: adminExternalAgent(agent, "managed", historyCount),
      });
    },
  );

  router.delete(
    "/api/admin/external-agents/:id",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (blockCorruptRegistry(res)) return;
      if (environmentIds().has(req.params.id)) {
        apiError(res, 409, "환경 변수에서 관리되는 외부 아바타는 UI에서 삭제할 수 없습니다.");
        return;
      }
      const state = managedState();
      const agent = state.agents.find((item) => item.id === req.params.id);
      if (!agent) {
        apiError(res, 404, "외부 아바타를 찾을 수 없습니다.");
        return;
      }
      if (countHistory(agent) > 0) {
        apiError(
          res,
          409,
          "기존 대화 기록이 있어 완전히 삭제할 수 없습니다. 대신 비활성화해 주세요.",
        );
        return;
      }
      if (
        !replaceRegistry(
          res,
          state.agents,
          state.agents.filter((item) => item.id !== req.params.id),
        )
      ) {
        return;
      }
      auditAs(req, "external_agent_delete", `external agent ${agent.id}`);
      logger.warn(
        { actorId: req.user!.id, externalAgentId: agent.id },
        "external agent deleted",
      );
      res.json({ ok: true });
    },
  );

  router.post(
    "/api/admin/external-agents/test",
    requireAuth(store),
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const storedId = safeString(req.body?.storedId);
      const environmentStoredId = storedId && environmentIds().has(storedId);
      const existing = storedId
        ? effectiveAgents().find((item) => item.id === storedId)
        : undefined;
      if (storedId && !existing) {
        apiError(res, 404, "연결을 확인할 외부 아바타를 찾을 수 없습니다.");
        return;
      }
      if (environmentStoredId && req.body?.agent !== undefined) {
        apiError(
          res,
          409,
          "환경 변수에서 관리되는 외부 아바타는 저장된 설정 그대로만 확인할 수 있습니다.",
        );
        return;
      }
      let agent = existing;
      if (req.body?.agent !== undefined) {
        try {
          agent = parseAdminExternalAgentInput(req.body.agent, existing);
        } catch (error) {
          inputError(res, error);
          return;
        }
      }
      if (storedId && agent?.id !== storedId) {
        apiError(res, 400, "연결 확인 설정의 외부 아바타 ID가 일치하지 않습니다.");
        return;
      }
      if (!agent) {
        apiError(res, 400, "연결을 확인할 외부 아바타 설정을 입력해 주세요.");
        return;
      }
      try {
        const result = await probeExternalAgentGateway(agent);
        auditAs(req, "external_agent_test", `external agent ${agent.id}`);
        res.json(result);
      } catch (error) {
        auditAs(
          req,
          "external_agent_test",
          `external agent ${agent.id}`,
          "error",
        );
        logger.warn(
          { actorId: req.user!.id, externalAgentId: agent.id },
          "external agent gateway probe failed",
        );
        const message =
          error instanceof Error
            ? error.message
            : "Gateway 연결 확인에 실패했습니다.";
        apiError(res, 502, message);
      }
    },
  );
}
