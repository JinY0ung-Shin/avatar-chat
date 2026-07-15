import type {
  AdminExternalAgent,
  AdminExternalAgentInput,
  AvatarDetail,
  AvatarSummary,
  ExternalAgentConfig,
  ExternalAgentSource,
} from "./types.js";

const EXTERNAL_AVATAR_PREFIX = "external:";
export const MAX_EXTERNAL_AGENTS = 50;
const MAX_VISIBLE_GROUPS = 50;
const MAX_CONNECT_TIMEOUT_SECONDS = 300;
const MAX_IDLE_TIMEOUT_SECONDS = 3_600;
const MAX_TOTAL_TIMEOUT_SECONDS = 86_400;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;
// Gateway model ids a viewer may pick per conversation (e.g. "claude-sonnet-5",
// "us.anthropic.claude-..."). Stricter than the admin-config `model` field: the
// value comes from arbitrary client input and is persisted + echoed to the
// gateway, so keep it to a conservative id charset.
const EXTERNAL_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Whether a client-sent gateway model id is safe to persist and forward. */
export function isSafeExternalModelId(value: string): boolean {
  return EXTERNAL_MODEL_ID_RE.test(value);
}
const EXTERNAL_AGENT_FIELDS = new Set([
  "id",
  "displayName",
  "alias",
  "bio",
  "persona",
  "intro",
  "hashtags",
  "endpoint",
  "baseUrl",
  "agent",
  "enabled",
  "model",
  "system",
  "apiKeyEnv",
  "apiKey",
  "visibleToGroupIds",
  "connectTimeoutSeconds",
  "idleTimeoutSeconds",
  "totalTimeoutSeconds",
]);

const ADMIN_EXTERNAL_AGENT_FIELDS = new Set([
  "id",
  "displayName",
  "alias",
  "bio",
  "persona",
  "intro",
  "hashtags",
  "endpoint",
  "agent",
  "enabled",
  "model",
  "system",
  "visibleToGroupIds",
  "connectTimeoutSeconds",
  "idleTimeoutSeconds",
  "totalTimeoutSeconds",
  "apiKeyMode",
  "apiKey",
]);

/** Encrypted app_config key used for UI-managed external avatars. */
export const MANAGED_EXTERNAL_AGENTS_KEY = "external_agents_registry_v1";

type EnvLookup = (name: string) => string | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(
  value: unknown,
  field: string,
  index: number,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field} must be a string.`);
  }
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].${field} exceeds ${max} characters.`,
    );
  }
  return text;
}

function requiredText(
  value: unknown,
  field: string,
  index: number,
  max: number,
): string {
  const text = optionalText(value, field, index, max);
  if (!text) {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field} is required.`);
  }
  return text;
}

function optionalBoolean(
  value: unknown,
  field: string,
  index: number,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field} must be a boolean.`);
  }
  return value;
}

function optionalDurationMs(
  value: unknown,
  field: string,
  index: number,
  maxSeconds: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maxSeconds
  ) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].${field} must be a positive number up to ${maxSeconds} seconds.`,
    );
  }
  return Math.max(1, Math.round(value * 1_000));
}

function endpointFor(raw: Record<string, unknown>, index: number): string {
  const exact = optionalText(raw.endpoint, "endpoint", index, 2_048);
  const base = optionalText(raw.baseUrl, "baseUrl", index, 2_048);
  if (exact && base) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] must use endpoint or baseUrl, not both.`,
    );
  }
  if (!exact && !base) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] requires endpoint or baseUrl.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(exact ?? base!);
  } catch {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}] has an invalid endpoint URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint must use http or https.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint must not contain credentials.`,
    );
  }
  if (parsed.hash) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint must not contain a URL fragment.`,
    );
  }
  if (parsed.search) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint must not contain a query string.`,
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (base) {
    parsed.pathname = normalizedPath.endsWith("/v1/agents/messages")
      ? normalizedPath
      : `${normalizedPath}/v1/agents/messages`;
  } else {
    if (!normalizedPath.endsWith("/v1/agents/messages")) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].endpoint must end with /v1/agents/messages.`,
      );
    }
    parsed.pathname = normalizedPath;
  }
  return parsed.toString();
}

function hashtagsFor(value: unknown, index: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].hashtags must be an array.`);
  }
  return [
    ...new Set(
      value.map((tag, tagIndex) => {
        if (typeof tag !== "string") {
          throw new Error(
            `EXTERNAL_AGENTS_JSON[${index}].hashtags[${tagIndex}] must be a string.`,
          );
        }
        return tag.trim().replace(/^#+/, "").slice(0, 40);
      }).filter(Boolean),
    ),
  ].slice(0, 20);
}

function visibleToGroupIdsFor(value: unknown, index: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds must be an array.`,
    );
  }
  if (value.length === 0) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds must not be empty; omit it for public access.`,
    );
  }
  if (value.length > MAX_VISIBLE_GROUPS) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds supports at most ${MAX_VISIBLE_GROUPS} groups.`,
    );
  }
  const groupIds = value.map((groupId, groupIndex) => {
    if (typeof groupId !== "string") {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds[${groupIndex}] must be a string.`,
      );
    }
    const normalized = groupId.trim();
    if (!normalized || normalized.length > 128) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds[${groupIndex}] must contain a group id of at most 128 characters.`,
      );
    }
    return normalized;
  });
  return [...new Set(groupIds)];
}

/**
 * Parse the server-only static registry. `apiKeyEnv` is preferred so the JSON
 * contains only a secret variable name; inline `apiKey` remains supported for
 * small deployments. Errors identify the field but never echo secret values.
 */
export function parseExternalAgents(
  value: string | undefined,
  lookupEnv: EnvLookup = (name) => process.env[name],
): ExternalAgentConfig[] {
  if (!value?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("EXTERNAL_AGENTS_JSON must be valid JSON.");
  }
  if (!Array.isArray(decoded)) {
    throw new Error("EXTERNAL_AGENTS_JSON must be a JSON array.");
  }
  if (decoded.length > MAX_EXTERNAL_AGENTS) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON supports at most ${MAX_EXTERNAL_AGENTS} agents.`,
    );
  }

  const seen = new Set<string>();
  return decoded.map((entry, index) => {
    const raw = record(entry);
    if (!raw) {
      throw new Error(`EXTERNAL_AGENTS_JSON[${index}] must be an object.`);
    }
    const unknownField = Object.keys(raw).find(
      (field) => !EXTERNAL_AGENT_FIELDS.has(field),
    );
    if (unknownField) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}] contains unsupported field '${unknownField}'.`,
      );
    }
    const id = requiredText(raw.id, "id", index, 64);
    if (!ID_RE.test(id)) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].id must use letters, numbers, _ or -.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`EXTERNAL_AGENTS_JSON contains duplicate id '${id}'.`);
    }
    seen.add(id);

    const apiKeyEnv = optionalText(raw.apiKeyEnv, "apiKeyEnv", index, 128);
    if (apiKeyEnv && !ENV_NAME_RE.test(apiKeyEnv)) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].apiKeyEnv is not a valid environment variable name.`,
      );
    }
    const inlineApiKey = optionalText(raw.apiKey, "apiKey", index, 8_192);
    const apiKey = apiKeyEnv ? lookupEnv(apiKeyEnv)?.trim() : inlineApiKey;
    if (apiKeyEnv && !apiKey) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].apiKeyEnv points to an unset variable.`,
      );
    }

    const displayName = requiredText(raw.displayName, "displayName", index, 120);
    const connectTimeoutMs = optionalDurationMs(
      raw.connectTimeoutSeconds,
      "connectTimeoutSeconds",
      index,
      MAX_CONNECT_TIMEOUT_SECONDS,
    );
    const idleTimeoutMs = optionalDurationMs(
      raw.idleTimeoutSeconds,
      "idleTimeoutSeconds",
      index,
      MAX_IDLE_TIMEOUT_SECONDS,
    );
    const totalTimeoutMs = optionalDurationMs(
      raw.totalTimeoutSeconds,
      "totalTimeoutSeconds",
      index,
      MAX_TOTAL_TIMEOUT_SECONDS,
    );
    const agent = optionalText(raw.agent, "agent", index, 64) ?? "claude";
    if (agent !== "claude") {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].agent must be claude.`,
      );
    }
    return {
      id,
      displayName,
      alias: optionalText(raw.alias, "alias", index, 120) ?? "",
      bio: optionalText(raw.bio, "bio", index, 500) ?? "",
      persona: optionalText(raw.persona, "persona", index, 4_000) ?? "",
      intro: optionalText(raw.intro, "intro", index, 2_000) ?? "",
      hashtags: hashtagsFor(raw.hashtags, index),
      endpoint: endpointFor(raw, index),
      agent,
      enabled: optionalBoolean(raw.enabled, "enabled", index) ?? true,
      model: optionalText(raw.model, "model", index, 256),
      system: optionalText(raw.system, "system", index, 100_000),
      visibleToGroupIds: visibleToGroupIdsFor(raw.visibleToGroupIds, index),
      ...(apiKey ? { apiKey } : {}),
      ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(totalTimeoutMs !== undefined ? { totalTimeoutMs } : {}),
    };
  });
}

/**
 * Validate one UI-managed definition with explicit write-only credential
 * semantics. The stateless v1 contract deliberately supports only the Claude
 * agent in both managed and environment-backed entries.
 */
export function parseAdminExternalAgentInput(
  value: unknown,
  existing?: ExternalAgentConfig,
): ExternalAgentConfig {
  const raw = record(value);
  if (!raw) {
    throw new Error("외부 아바타 설정은 객체여야 합니다.");
  }
  const unknownField = Object.keys(raw).find(
    (field) => !ADMIN_EXTERNAL_AGENT_FIELDS.has(field),
  );
  if (unknownField) {
    throw new Error(`지원하지 않는 설정 필드입니다: ${unknownField}`);
  }
  if (raw.agent !== undefined && raw.agent !== "claude") {
    throw new Error("현재 외부 아바타 agent는 claude만 지원합니다.");
  }
  const apiKeyMode = raw.apiKeyMode;
  if (
    apiKeyMode !== "keep" &&
    apiKeyMode !== "set" &&
    apiKeyMode !== "clear"
  ) {
    throw new Error("API 키 처리 방식이 올바르지 않습니다.");
  }
  if (apiKeyMode !== "set" && raw.apiKey !== undefined) {
    throw new Error("API 키 값은 교체 모드에서만 보낼 수 있습니다.");
  }
  const nextApiKey =
    apiKeyMode === "set"
      ? typeof raw.apiKey === "string"
        ? raw.apiKey.trim().replace(/^Bearer\s+/i, "")
        : ""
      : apiKeyMode === "keep"
        ? existing?.apiKey
        : undefined;
  if (apiKeyMode === "set" && !nextApiKey) {
    throw new Error("교체할 Gateway API 키를 입력해 주세요.");
  }

  const candidate: Record<string, unknown> = {};
  for (const field of ADMIN_EXTERNAL_AGENT_FIELDS) {
    if (field === "apiKeyMode" || field === "apiKey") continue;
    if (raw[field] !== undefined) candidate[field] = raw[field];
  }
  candidate.agent = "claude";
  if (nextApiKey) candidate.apiKey = nextApiKey;
  const [parsed] = parseExternalAgents(JSON.stringify([candidate]));
  if (
    apiKeyMode === "keep" &&
    existing?.apiKey &&
    parsed.endpoint !== existing.endpoint
  ) {
    throw new Error(
      "Gateway endpoint를 변경할 때는 새 API 키를 등록하거나 저장된 키를 삭제해야 합니다.",
    );
  }
  return parsed;
}

function storageEntry(agent: ExternalAgentConfig): Record<string, unknown> {
  return {
    id: agent.id,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    persona: agent.persona,
    intro: agent.intro,
    hashtags: agent.hashtags,
    endpoint: agent.endpoint,
    agent: agent.agent,
    enabled: agent.enabled !== false,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.system ? { system: agent.system } : {}),
    ...(agent.apiKey ? { apiKey: agent.apiKey } : {}),
    ...(agent.visibleToGroupIds
      ? { visibleToGroupIds: agent.visibleToGroupIds }
      : {}),
    ...(agent.connectTimeoutMs
      ? { connectTimeoutSeconds: agent.connectTimeoutMs / 1_000 }
      : {}),
    ...(agent.idleTimeoutMs
      ? { idleTimeoutSeconds: agent.idleTimeoutMs / 1_000 }
      : {}),
    ...(agent.totalTimeoutMs
      ? { totalTimeoutSeconds: agent.totalTimeoutMs / 1_000 }
      : {}),
  };
}

/** Serialize the encrypted registry with an explicit format version. */
export function serializeManagedExternalAgents(
  agents: readonly ExternalAgentConfig[],
): string {
  return JSON.stringify({
    version: 1,
    agents: agents.map(storageEntry),
  });
}

/** Decode a registry written by serializeManagedExternalAgents. */
export function parseManagedExternalAgents(value: string): ExternalAgentConfig[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("저장된 외부 아바타 설정이 올바른 JSON이 아닙니다.");
  }
  const root = record(decoded);
  if (root?.version !== 1 || !Array.isArray(root.agents)) {
    throw new Error("지원하지 않는 외부 아바타 설정 버전입니다.");
  }
  return parseExternalAgents(JSON.stringify(root.agents));
}

/**
 * Environment entries retain precedence for matching ids while managed entries
 * can be added alongside them. This keeps deployments using
 * EXTERNAL_AGENTS_JSON unchanged and makes those rows read-only in the UI.
 */
export function mergeExternalAgentRegistries(
  environment: readonly ExternalAgentConfig[] | undefined,
  managed: readonly ExternalAgentConfig[] | undefined,
): ExternalAgentConfig[] {
  const environmentIds = new Set((environment ?? []).map((agent) => agent.id));
  return [
    ...(environment ?? []),
    ...(managed ?? []).filter((agent) => !environmentIds.has(agent.id)),
  ];
}

export function adminExternalAgent(
  agent: ExternalAgentConfig,
  source: ExternalAgentSource,
  conversationCount: number,
): AdminExternalAgent {
  return {
    id: agent.id,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    persona: agent.persona,
    intro: agent.intro,
    hashtags: [...agent.hashtags],
    endpoint: agent.endpoint,
    agent: agent.agent,
    enabled: agent.enabled !== false,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.system ? { system: agent.system } : {}),
    ...(agent.visibleToGroupIds
      ? { visibleToGroupIds: [...agent.visibleToGroupIds] }
      : {}),
    ...(agent.connectTimeoutMs
      ? { connectTimeoutSeconds: agent.connectTimeoutMs / 1_000 }
      : {}),
    ...(agent.idleTimeoutMs
      ? { idleTimeoutSeconds: agent.idleTimeoutMs / 1_000 }
      : {}),
    ...(agent.totalTimeoutMs
      ? { totalTimeoutSeconds: agent.totalTimeoutMs / 1_000 }
      : {}),
    source,
    apiKeySet: Boolean(agent.apiKey),
    conversationCount,
    // Images live outside the registry; route code overlays the stored state.
    hasImage: false,
  };
}

export function externalAvatarId(agent: Pick<ExternalAgentConfig, "id">): string {
  return `${EXTERNAL_AVATAR_PREFIX}${agent.id}`;
}

export function findExternalAgent(
  agents: readonly ExternalAgentConfig[] | undefined,
  avatarId: string,
): ExternalAgentConfig | null {
  if (!avatarId.startsWith(EXTERNAL_AVATAR_PREFIX)) return null;
  const id = avatarId.slice(EXTERNAL_AVATAR_PREFIX.length);
  return agents?.find((agent) => agent.id === id) ?? null;
}

export function externalAgentVisibleTo(
  agent: ExternalAgentConfig,
  viewerGroupIds: ReadonlySet<string>,
): boolean {
  if (agent.enabled === false) return false;
  const restrictedTo = agent.visibleToGroupIds;
  return (
    !restrictedTo ||
    restrictedTo.some((groupId) => viewerGroupIds.has(groupId))
  );
}

export function findVisibleExternalAgent(
  agents: readonly ExternalAgentConfig[] | undefined,
  avatarId: string,
  viewerGroupIds: ReadonlySet<string>,
): ExternalAgentConfig | null {
  const agent = findExternalAgent(agents, avatarId);
  return agent && externalAgentVisibleTo(agent, viewerGroupIds) ? agent : null;
}

export function externalAvatarSummary(agent: ExternalAgentConfig): AvatarSummary {
  return {
    id: externalAvatarId(agent),
    username: `external-${agent.id}`,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    hashtags: [...agent.hashtags],
    hasImage: false,
    pluginCount: 0,
    visibility: agent.visibleToGroupIds ? "group" : "public",
    updatedAt: null,
    runtime: "external",
    sharesGroup: false,
  };
}

export function externalAvatarDetail(agent: ExternalAgentConfig): AvatarDetail {
  return {
    ...externalAvatarSummary(agent),
    persona: agent.persona,
    intro: agent.intro,
    isOwn: false,
    elevated: false,
    plugins: [],
  };
}

export function listExternalAvatarSummaries(
  agents: readonly ExternalAgentConfig[] | undefined,
  viewerGroupIds: ReadonlySet<string>,
): AvatarSummary[] {
  return (agents ?? [])
    .filter((agent) => externalAgentVisibleTo(agent, viewerGroupIds))
    .map(externalAvatarSummary)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
