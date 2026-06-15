/**
 * Registry of model TIERS a user can pick per conversation in the chat composer.
 *
 * Each tier `id` is a Claude model ALIAS (`opus`/`sonnet`/`haiku`) passed straight
 * to the SDK as `options.model`. Which concrete model an alias resolves to is the
 * OPERATOR's call, controlled via the `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
 * environment variables (forwarded into the SDK subprocess by `agentSubprocessEnv`,
 * since it starts from `process.env`). So the picker offers tiers; the deployment
 * pins the versions. An unset alias falls back to the account/tier default.
 *
 * Precedence in `claudeAgent.ts`: env pin (`ANTHROPIC_MODEL`) > user tier (this) >
 * admin override > SDK default. The env pin is a HARD lock — when set, the
 * per-conversation choice is ignored (and the client hides the picker).
 *
 * `label`/`description` are shown to the user, so they are KOREAN (the language
 * split: user-facing strings are Korean); the `id` aliases are stable identifiers
 * the model reads and are never localized. This module is intentionally
 * dependency-free so BOTH the server and the Svelte client can import it (it is
 * listed in `tsconfig.client.json` includes), mirroring `experimentalFeatures.ts`
 * / `routineSchedule.ts` — the composer renders the same registry, avoiding drift.
 */
export interface ModelTier {
  /** Claude model alias passed to the SDK as `options.model`. */
  id: string;
  /** User-facing tier name (a proper noun; kept as-is). */
  label: string;
  /** User-facing one-line description (Korean). */
  description: string;
}

export const MODEL_TIERS: ModelTier[] = [
  {
    id: "opus",
    label: "Opus",
    description: "가장 정교한 추론 — 복잡하고 어려운 작업에 적합 (느리고 비쌈)",
  },
  {
    id: "sonnet",
    label: "Sonnet",
    description: "속도와 성능의 균형 — 대부분의 대화에 적합",
  },
  {
    id: "haiku",
    label: "Haiku",
    description: "가장 빠르고 가벼움 — 간단한 작업에 적합",
  },
];

/** All registered tier ids (aliases), for validation + membership checks. */
export const MODEL_TIER_IDS: string[] = MODEL_TIERS.map((t) => t.id);

/**
 * The tier used when no more-specific choice applies (env pin / user pick / admin
 * override all absent). The composer has no "default" option — every conversation
 * resolves to a concrete tier, and this is the floor.
 */
export const DEFAULT_MODEL_TIER = "opus";

/** Type guard: a non-empty string that names a known tier alias. */
export function isModelTier(value: unknown): value is string {
  return typeof value === "string" && MODEL_TIER_IDS.includes(value);
}
