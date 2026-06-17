import crypto from "node:crypto";
import { hashPassword, hashToken, verifyPassword } from "../auth.js";
import { INTERNAL_GIT_TOKEN_SECRET_NAME } from "../gitCredentials.js";
import { normalizeExperimentalFeatures } from "../experimentalFeatures.js";
import type { AvatarVisibility, User } from "../types.js";
import {
  type Constructor,
  type StoreBase,
  type UserRow,
  normalizeHashtags,
  now,
  parseHashtags,
  parseNameList,
  SESSION_DAYS,
} from "./internal.js";

export function withUsers<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Users extends Base {
    // ---- Users ------------------------------------------------------------

    toUser(row: UserRow): User {
      const roles = this.rolesFor(row.id);
      const secretNames = this.listUserSecretNames(row.id);
      const pluginCount = this.count(
        "SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ?",
        row.id,
      );
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        alias: row.alias ?? "",
        bio: row.bio ?? "",
        persona: row.persona ?? "",
        intro: row.intro ?? "",
        hashtags: parseHashtags(row.hashtags),
        hasImage: Boolean(row.avatar_ext),
        visibility: this.rowVisibility(row),
        roles,
        pluginCount,
        // Never expose the token itself — only whether one is set.
        gitTokenSet: Boolean(row.git_token_enc) || secretNames.includes(INTERNAL_GIT_TOKEN_SECRET_NAME),
        gitIdentityName: row.git_identity_name ?? null,
        gitIdentityEmail: row.git_identity_email ?? null,
        knowledgeRepo: row.knowledge_repo ?? null,
        knowledgeBranch: row.knowledge_branch ?? null,
        knowledgeSelected: parseNameList(row.knowledge_selected),
        // OFF-set seeding new conversations/greetings ([] = every group on).
        groupKnowledgeOffDefault: parseNameList(row.group_knowledge_off_default) ?? [],
        // Only the names — the encrypted values never leave the server.
        secretNames,
        sshPublicKey: row.ssh_public_key ?? null,
        groups: this.listUserGroups(row.id),
        experimentalFeatures: normalizeExperimentalFeatures(parseNameList(row.experimental_features)),
        onboardedAt: row.onboarded_at ?? null,
      };
    }

    /** Mark first-run onboarding as completed (idempotent — only sets it once, so
     *  re-dismissing keeps the original timestamp). Returns the refreshed user. */
    markOnboarded(userId: string): User {
      this.db
        .prepare("UPDATE users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL")
        .run(now(), userId);
      const row = this.userRowById(userId);
      if (!row) throw new Error("USER_NOT_FOUND");
      return this.toUser(row);
    }

    /** The KNOWN experimental-feature keys the owner has enabled (drops stale). */
    getExperimentalFeatures(userId: string): string[] {
      const row = this.userRowById(userId);
      return row ? normalizeExperimentalFeatures(parseNameList(row.experimental_features)) : [];
    }

    createUser(input: { username: string; displayName: string; password: string }): User {
      const username = input.username.trim();
      if (this.userRowByUsername(username)) {
        throw new Error("DUPLICATE_USERNAME");
      }
      const timestamp = now();
      const id = crypto.randomUUID();
      const isFirstUser = this.count("SELECT COUNT(*) AS c FROM users") === 0;

      const insertUser = this.db.prepare(`
        INSERT INTO users (id, username, password_hash, display_name, bio, persona, avatar_ext, published, visibility, created_at, last_seen_at)
        VALUES (@id, @username, @password_hash, @display_name, '', '', NULL, 1, 'group', @created_at, @created_at)
      `);
      const grantRole = this.db.prepare(
        "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)",
      );

      const tx = this.db.transaction(() => {
        insertUser.run({
          id,
          username,
          password_hash: hashPassword(input.password),
          display_name: input.displayName.trim() || username,
          created_at: timestamp,
        });
        const memberId = this.getRoleId("member");
        if (memberId) grantRole.run(id, memberId);
        if (isFirstUser) {
          const adminId = this.getRoleId("admin");
          if (adminId) grantRole.run(id, adminId);
        }
      });
      tx();

      return this.toUser(this.userRowById(id)!);
    }

    getUserByUsername(username: string): User | null {
      const row = this.userRowByUsername(username);
      return row ? this.toUser(row) : null;
    }

    getUserById(id: string): User | null {
      const row = this.userRowById(id);
      return row ? this.toUser(row) : null;
    }

    /** True once at least one account exists. False only on a fresh install. */
    hasAnyUser(): boolean {
      return this.count("SELECT COUNT(*) AS c FROM users") > 0;
    }

    verifyLogin(username: string, password: string): User | "suspended" | null {
      const row = this.userRowByUsername(username.trim());
      if (!row) {
        return null;
      }
      if (!verifyPassword(password, row.password_hash)) {
        return null;
      }
      // Verify the password first so a wrong password can't probe suspension state.
      if (row.suspended === 1) {
        return "suspended";
      }
      return this.toUser(row);
    }

    // ---- Roles ------------------------------------------------------------

    rolesFor(userId: string): string[] {
      const rows = this.db
        .prepare(
          `SELECT r.name AS name FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = ? ORDER BY r.name`,
        )
        .all(userId) as { name: string }[];
      return rows.map((r) => r.name);
    }

    isAdmin(userId: string): boolean {
      return this.rolesFor(userId).includes("admin");
    }

    setRole(userId: string, role: string, grant: boolean): User | null {
      const roleId = this.getRoleId(role);
      if (!roleId || !this.userRowById(userId)) {
        return null;
      }
      if (grant) {
        this.db
          .prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)")
          .run(userId, roleId);
      } else {
        this.db
          .prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?")
          .run(userId, roleId);
      }
      return this.getUserById(userId);
    }

    // ---- Sessions ---------------------------------------------------------

    createSession(userId: string): string {
      const token = crypto.randomBytes(32).toString("base64url");
      const createdAt = now();
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      this.db
        .prepare(
          `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), hashToken(token), userId, createdAt, expiresAt);
      return token;
    }

    getUserBySessionToken(token: string | undefined): User | null {
      if (!token) {
        return null;
      }
      const current = now();
      // Prune expired sessions opportunistically.
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(current);
      const session = this.db
        .prepare("SELECT user_id FROM sessions WHERE token_hash = ?")
        .get(hashToken(token)) as { user_id: string } | undefined;
      if (!session) {
        return null;
      }
      const row = this.userRowById(session.user_id);
      if (!row) {
        return null;
      }
      // A suspension can land mid-session; drop the session so it takes effect even
      // if the explicit revoke (setSuspended) raced or missed this token.
      if (row.suspended === 1) {
        this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
        return null;
      }
      this.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(current, row.id);
      return this.toUser(row);
    }

    revokeSession(token: string | undefined): void {
      if (!token) {
        return;
      }
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    }

    // ---- Profile ----------------------------------------------------------

    updateProfile(
      userId: string,
      patch: {
        displayName?: string;
        alias?: string;
        bio?: string;
        persona?: string;
        intro?: string;
        hashtags?: string[];
        visibility?: AvatarVisibility;
        experimentalFeatures?: string[];
      },
    ): User {
      const row = this.userRowById(userId);
      if (!row) {
        throw new Error("USER_NOT_FOUND");
      }
      const displayName =
        patch.displayName !== undefined ? patch.displayName.trim() || row.display_name : row.display_name;
      const alias = patch.alias !== undefined ? patch.alias.trim() : row.alias;
      const bio = patch.bio !== undefined ? patch.bio : row.bio;
      const persona = patch.persona !== undefined ? patch.persona : row.persona;
      const intro = patch.intro !== undefined ? patch.intro : row.intro;
      // Normalize on write so storage is always a clean JSON array (the column is
      // read back through parseHashtags, which tolerates null/legacy values).
      const hashtags =
        patch.hashtags !== undefined ? JSON.stringify(normalizeHashtags(patch.hashtags)) : row.hashtags;
      const visibility =
        patch.visibility !== undefined ? patch.visibility : this.rowVisibility(row);
      // Normalize on write to known keys only (same discipline as hashtags).
      const experimentalFeatures =
        patch.experimentalFeatures !== undefined
          ? JSON.stringify(normalizeExperimentalFeatures(patch.experimentalFeatures))
          : row.experimental_features;
      this.db
        .prepare(
          "UPDATE users SET display_name = ?, alias = ?, bio = ?, persona = ?, intro = ?, hashtags = ?, visibility = ?, experimental_features = ? WHERE id = ?",
        )
        .run(displayName, alias, bio, persona, intro, hashtags, visibility, experimentalFeatures, userId);
      return this.toUser(this.userRowById(userId)!);
    }

    setAvatarExt(userId: string, ext: string | null): void {
      this.db.prepare("UPDATE users SET avatar_ext = ? WHERE id = ?").run(ext, userId);
    }

    getAvatarExt(userId: string): string | null {
      const row = this.userRowById(userId);
      return row?.avatar_ext ?? null;
    }
  };
}
