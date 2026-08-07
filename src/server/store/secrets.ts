import { decryptSecret, encryptSecret } from "../crypto.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  type GitTokenSet,
} from "../gitCredentials.js";
import {
  HEX_SSH_POLICY_CONFIG_KEY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../hexSshPolicy.js";
import {
  SKILL_DISCOVERY_CACHE_KEY,
  TOOL_SKILL_POLICY_CONFIG_KEY,
  normalizeSkillDiscoveryCache,
  normalizeToolSkillPolicy,
  type SkillDiscoveryCache,
  type ToolSkillPolicy,
} from "../toolSkillPolicy.js";
import {
  MODEL_VISION_POLICY_CONFIG_KEY,
  normalizeModelVisionPolicy,
  type ModelVisionPolicy,
} from "../modelVisionPolicy.js";
import type { User } from "../types.js";
import { now, type Constructor, type StoreBase } from "./internal.js";

export type AppSecretState =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "ok"; value: string };

export function withSecrets<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Secrets extends Base {
    /**
     * Ciphertext-aware cache: DB is still checked on every read so another Store
     * instance or direct recovery write is observed immediately, but expensive
     * synchronous scrypt/AES work only repeats when the ciphertext changes.
     */
    private readonly appSecretStateCache = new Map<
      string,
      { ciphertext: string | null; state: AppSecretState }
    >();

    override close(): void {
      this.appSecretStateCache.clear();
      super.close();
    }

    // ---- Git credentials / personal knowledge repo -----------------------

    /** Store (encrypted) or clear the user's internal GitHub token as GIT_TOKEN. */
    setGitToken(userId: string, token: string | null): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      if (token) {
        this.setUserSecret(userId, INTERNAL_GIT_TOKEN_SECRET_NAME, token);
      } else {
        this.deleteUserSecret(userId, INTERNAL_GIT_TOKEN_SECRET_NAME);
      }
      // Legacy column retained for old DB compatibility; new writes use user_secrets.
      this.db.prepare("UPDATE users SET git_token_enc = NULL WHERE id = ?").run(userId);
      return this.toUser(this.userRowById(userId)!);
    }

    private getUserSecretValue(userId: string, name: string): string | null {
      const row = this.db
        .prepare("SELECT value_enc FROM user_secrets WHERE user_id = ? AND name = ?")
        .get(userId, name) as { value_enc: string } | undefined;
      if (!row?.value_enc) {
        return null;
      }
      return decryptSecret(row.value_enc, this.secret);
    }

    /**
     * Decrypt and return the user's internal GitHub token for server-side git auth.
     * Returns null if unset or undecryptable (e.g. SESSION_SECRET changed). This
     * is the ONLY path the plaintext token leaves the DB — never via `toUser`.
     */
    getGitToken(userId: string): string | null {
      // The legacy users.git_token_enc column is migrated into user_secrets and
      // NULLed at Store construction (migrateGitTokenSecrets), so the vault is
      // the only live source.
      return this.getUserSecretValue(userId, INTERNAL_GIT_TOKEN_SECRET_NAME);
    }

    getExternalGitToken(userId: string): string | null {
      return this.getUserSecretValue(userId, EXTERNAL_GIT_TOKEN_SECRET_NAME);
    }

    getGitTokens(userId: string): GitTokenSet {
      return {
        internal: this.getGitToken(userId),
        external: this.getExternalGitToken(userId),
      };
    }

    // ---- Per-user secrets (encrypted env injected into avatar MCP tools) --

    /**
     * Store (encrypted) a named secret for the user. Values are AES-256-GCM
     * encrypted at rest like git tokens; they're only ever decrypted into the
     * env of an avatar's MCP subprocess (e.g. hex-ssh's SSH_PRIVATE_KEY), never
     * exposed to the agent or serialized via `toUser`.
     */
    setUserSecret(userId: string, name: string, value: string): void {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      const enc = encryptSecret(value, this.secret);
      // Transactional like setSshKeyPair: a failure between the two statements
      // must not leave a stale public key advertised for a replaced private key.
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO user_secrets (user_id, name, value_enc, created_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc",
          )
          .run(userId, name, enc, now());
        if (name === "SSH_PRIVATE_KEY") {
          this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
        }
      });
      tx();
    }

    /** Store a generated SSH keypair: private key encrypted, public key visible. */
    setSshKeyPair(userId: string, privateKey: string, publicKey: string): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      const enc = encryptSecret(privateKey, this.secret);
      const createdAt = now();
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO user_secrets (user_id, name, value_enc, created_at) VALUES (?, 'SSH_PRIVATE_KEY', ?, ?) " +
              "ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc",
          )
          .run(userId, enc, createdAt);
        this.db.prepare("UPDATE users SET ssh_public_key = ? WHERE id = ?").run(publicKey, userId);
      });
      tx();
      return this.toUser(this.userRowById(userId)!);
    }

    /**
     * Set (or clear) the stored SSH public key without touching the private-key
     * secret. Used to keep the public half queryable when the owner pastes their
     * own `SSH_PRIVATE_KEY` (the route derives the public key and stores it here).
     */
    setSshPublicKey(userId: string, publicKey: string | null): void {
      this.db.prepare("UPDATE users SET ssh_public_key = ? WHERE id = ?").run(publicKey, userId);
    }

    /** Remove a named secret. Returns whether a row was actually deleted. */
    deleteUserSecret(userId: string, name: string): boolean {
      let removed = false;
      const tx = this.db.transaction(() => {
        const res = this.db
          .prepare("DELETE FROM user_secrets WHERE user_id = ? AND name = ?")
          .run(userId, name);
        removed = res.changes > 0;
        if (name === "SSH_PRIVATE_KEY") {
          this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
        }
      });
      tx();
      return removed;
    }

    /** Names of the user's stored secrets (for the settings UI; values omitted). */
    listUserSecretNames(userId: string): string[] {
      const rows = this.db
        .prepare("SELECT name FROM user_secrets WHERE user_id = ? ORDER BY name")
        .all(userId) as { name: string }[];
      return rows.map((r) => r.name);
    }

    /**
     * Names of the secrets the user opted into AGENT-SHELL exposure for
     * (per-secret `shell_expose` toggle). The injection site additionally
     * filters through `mcpInjectableSecretEnv`, so a reserved git/SSH name
     * never ships even if its flag were somehow set.
     */
    listShellExposedSecretNames(userId: string): string[] {
      const rows = this.db
        .prepare(
          "SELECT name FROM user_secrets WHERE user_id = ? AND shell_expose = 1 ORDER BY name",
        )
        .all(userId) as { name: string }[];
      return rows.map((r) => r.name);
    }

    /**
     * Toggle a stored secret's agent-shell exposure. Returns false when the
     * secret doesn't exist (the flag rides the secret row; value untouched).
     */
    setSecretShellExpose(userId: string, name: string, expose: boolean): boolean {
      const result = this.db
        .prepare(
          "UPDATE user_secrets SET shell_expose = ? WHERE user_id = ? AND name = ?",
        )
        .run(expose ? 1 : 0, userId, name);
      return result.changes > 0;
    }

    /**
     * Decrypt all of the user's secrets into a name→value map for server-side use
     * (injected as MCP subprocess env). Undecryptable entries (e.g. after a
     * SESSION_SECRET change) are skipped. This is the ONLY path the plaintext
     * values leave the DB — never via `toUser`.
     */
    getUserSecrets(userId: string): Record<string, string> {
      const rows = this.db
        .prepare("SELECT name, value_enc FROM user_secrets WHERE user_id = ?")
        .all(userId) as { name: string; value_enc: string }[];
      const out: Record<string, string> = {};
      for (const r of rows) {
        const value = decryptSecret(r.value_enc, this.secret);
        if (value !== null) {
          out[r.name] = value;
        }
      }
      return out;
    }

    // ---- App-wide config (encrypted, not user-scoped) --------------------

    /**
     * Store (encrypted) an app-wide secret keyed by name. Unlike user_secrets
     * this is global to the deployment — e.g. the Claude subscription OAuth token
     * (`claude setup-token`) the admin pastes in, injected as CLAUDE_CODE_OAUTH_TOKEN
     * into the agent subprocess. AES-256-GCM at rest like every other secret; only
     * decrypted server-side (`getAppSecret`), never returned to clients.
     */
    setAppSecret(key: string, value: string): void {
      const enc = encryptSecret(value, this.secret);
      this.db
        .prepare(
          "INSERT INTO app_config (key, value_enc, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
        )
        .run(key, enc, now());
      this.appSecretStateCache.delete(key);
    }

    /** Decrypt an app-wide secret. Null if unset or undecryptable (e.g. SESSION_SECRET changed). */
    getAppSecret(key: string): string | null {
      const state = this.getAppSecretState(key);
      return state.status === "ok" ? state.value : null;
    }

    /** Distinguish an absent app setting from ciphertext that can no longer be decrypted. */
    getAppSecretState(
      key: string,
    ): AppSecretState {
      const row = this.db.prepare("SELECT value_enc FROM app_config WHERE key = ?").get(key) as
        | { value_enc: string }
        | undefined;
      const ciphertext = row?.value_enc ?? null;
      const cached = this.appSecretStateCache.get(key);
      if (cached?.ciphertext === ciphertext) {
        return cached.state;
      }
      let state: AppSecretState;
      if (ciphertext === null) {
        state = Object.freeze({ status: "missing" });
      } else {
        const value = decryptSecret(ciphertext, this.secret);
        state = Object.freeze(
          value === null
            ? { status: "unreadable" as const }
            : { status: "ok" as const, value },
        );
      }
      this.appSecretStateCache.set(key, { ciphertext, state });
      return state;
    }

    /** Remove an app-wide secret. No-op if it doesn't exist. */
    deleteAppSecret(key: string): void {
      this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
      this.appSecretStateCache.delete(key);
    }

    /** Deployment-wide hex-ssh tool allowlist, grouped by viewer class. */
    getHexSshToolPolicy(): HexSshToolPolicy {
      const raw = this.getAppSecret(HEX_SSH_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeHexSshToolPolicy(null);
      }
      try {
        return normalizeHexSshToolPolicy(JSON.parse(raw));
      } catch {
        return normalizeHexSshToolPolicy(null);
      }
    }

    setHexSshToolPolicy(policy: HexSshToolPolicy): HexSshToolPolicy {
      const normalized = normalizeHexSshToolPolicy(policy);
      this.setAppSecret(HEX_SSH_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /**
     * Deployment-wide built-in tool/skill on-off policy (admin-managed).
     * Missing/corrupt/unreadable (SESSION_SECRET rotated) → empty policy,
     * i.e. nothing disabled — the safe pre-feature behavior.
     */
    getToolSkillPolicy(): ToolSkillPolicy {
      const raw = this.getAppSecret(TOOL_SKILL_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeToolSkillPolicy(null);
      }
      try {
        return normalizeToolSkillPolicy(JSON.parse(raw));
      } catch {
        return normalizeToolSkillPolicy(null);
      }
    }

    setToolSkillPolicy(policy: ToolSkillPolicy): ToolSkillPolicy {
      const normalized = normalizeToolSkillPolicy(policy);
      this.setAppSecret(TOOL_SKILL_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /**
     * Admin-managed per-model-tier vision policy (`{tierId: boolean}`; absent
     * tier = inherit the MODEL_VISION deployment default). Missing/corrupt/
     * unreadable → empty map, i.e. everything inherits — the safe pre-feature
     * behavior.
     */
    getModelVisionPolicy(): ModelVisionPolicy {
      const raw = this.getAppSecret(MODEL_VISION_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeModelVisionPolicy(null);
      }
      try {
        return normalizeModelVisionPolicy(JSON.parse(raw));
      } catch {
        return normalizeModelVisionPolicy(null);
      }
    }

    setModelVisionPolicy(policy: ModelVisionPolicy): ModelVisionPolicy {
      const normalized = normalizeModelVisionPolicy(policy);
      this.setAppSecret(MODEL_VISION_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /**
     * Cached global skill-discovery result (one preflight `supportedCommands()`
     * per bundled CLI version). Null when absent, malformed, or unreadable —
     * callers treat null as "discover again" (admin panel) or fall back to
     * `skills: "all"` (agent run), never as an error.
     */
    getSkillDiscoveryCache(): SkillDiscoveryCache | null {
      const raw = this.getAppSecret(SKILL_DISCOVERY_CACHE_KEY);
      if (!raw) {
        return null;
      }
      try {
        return normalizeSkillDiscoveryCache(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    setSkillDiscoveryCache(cache: SkillDiscoveryCache): void {
      this.setAppSecret(SKILL_DISCOVERY_CACHE_KEY, JSON.stringify(cache));
    }

    /** Set the commit author identity used for knowledge-repo commits. */
    setGitIdentity(userId: string, name: string | null, email: string | null): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      this.db
        .prepare("UPDATE users SET git_identity_name = ?, git_identity_email = ? WHERE id = ?")
        .run(name?.trim() || null, email?.trim() || null, userId);
      return this.toUser(this.userRowById(userId)!);
    }
  };
}
