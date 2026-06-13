import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  hashPassword,
  hashToken,
  verifyPassword,
} from "./auth.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  HEX_SSH_POLICY_CONFIG_KEY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "./hexSshPolicy.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  type GitTokenSet,
} from "./gitCredentials.js";
import logger from "./logger.js";
import type {
  AdminGroupSummary,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AgentResponse,
  AppConfig,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  AvatarVisibility,
  ConversationSummary,
  GitRepository,
  Group,
  GroupMember,
  GroupRole,
  KnowledgeRequest,
  Plugin,
  RoutineJob,
  SignupMode,
  StoredMessage,
  User,
  UserGroupMembership,
} from "./types.js";

const SESSION_DAYS = 14;

function now(): string {
  return new Date().toISOString();
}

/**
 * Parse a stored JSON array of plugin-name strings (used for both a plugin's
 * `selected` subset and a user's `knowledge_selected`). Returns null — meaning
 * "load all" — for null/blank/malformed values.
 */
function parseNameList(raw: string | null): string[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Max capability hashtags stored per avatar, and max length of each tag. */
export const MAX_HASHTAGS = 12;
const MAX_HASHTAG_LEN = 30;
/** Default number of avatars a capability search returns when no limit is given. */
const DEFAULT_SEARCH_LIMIT = 12;

/**
 * Normalize capability hashtags ("역량 해시태그") to a clean, deduped, capped list
 * of BARE tags (no leading "#" — the UI renders that). Shared by the PATCH save
 * path and the auto-generate endpoint so a hand-edited chip list and a parsed
 * agent response produce identical storage. Accepts either an array (chip
 * editor) or a raw string (agent text, split on whitespace/commas).
 */
export function normalizeHashtags(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.filter((s): s is string => typeof s === "string")
    : typeof input === "string"
      ? input.split(/[\s,，、]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // Strip leading list/bullet markers and "#", collapse inner whitespace to a
    // hyphen (a hashtag carries no spaces), and trim trailing punctuation. Only
    // the LEADING "#" is removed, so "C#"/"C++" survive intact.
    let tag = item
      .trim()
      .replace(/^[#*\-•·\s]+/u, "")
      .replace(/\s+/g, "-")
      .replace(/[.,!?。·…、，]+$/u, "")
      .trim();
    if (!tag) continue;
    if (tag.length > MAX_HASHTAG_LEN) tag = tag.slice(0, MAX_HASHTAG_LEN);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/** Parse the stored hashtags JSON array, defaulting to an empty list. */
function parseHashtags(raw: string | null): string[] {
  return parseNameList(raw) ?? [];
}

// Routine times are interpreted in Seoul time (KST). Korea observes no DST, so
// KST is a fixed UTC+9 offset — the arithmetic below is independent of the
// server's own timezone.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "HH:MM" (KST wall-clock) for minutes-from-midnight (0..1439). */
function formatMinuteOfDay(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The next instant (ISO, UTC) a daily job fires after `from`, where
 * `minuteOfDay` is minutes from midnight in **Seoul time (KST)**. If today's
 * KST slot has already passed, returns tomorrow's.
 */
function nextDailyRunIso(minuteOfDay: number, from = new Date()): string {
  const fromMs = from.getTime();
  // Shift into "KST space" where flooring to a day boundary yields KST midnight.
  const kstMs = fromMs + KST_OFFSET_MS;
  const kstMidnight = Math.floor(kstMs / DAY_MS) * DAY_MS;
  let candidate = kstMidnight + minuteOfDay * 60_000;
  if (candidate <= kstMs) {
    candidate += DAY_MS;
  }
  // Shift back to the real UTC instant.
  return new Date(candidate - KST_OFFSET_MS).toISOString();
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  avatar_ext: string | null;
  published: number;
  visibility: string | null;
  auto_approve: number;
  suspended: number;
  created_at: string;
  last_seen_at: string | null;
  git_token_enc: string | null;
  git_identity_name: string | null;
  git_identity_email: string | null;
  knowledge_repo: string | null;
  knowledge_branch: string | null;
  knowledge_selected: string | null;
  ssh_public_key: string | null;
  hashtags: string | null;
}

interface KnowledgeRequestRow {
  id: string;
  avatar_user_id: string;
  asker_user_id: string | null;
  asker_name: string | null;
  question: string;
  status: string;
  created_at: string;
}

interface AvatarNotificationRow {
  id: string;
  owner_user_id: string;
  avatar_user_id: string;
  title: string;
  message: string;
  conversation_id: string | null;
  read_at: string | null;
  created_at: string;
  avatar_display_name?: string | null;
}

interface GitRepositoryRow {
  user_id: string;
  name: string;
  repo: string;
  branch: string | null;
  last_synced_at: string | null;
  created_at: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  knowledge_repo: string | null;
  knowledge_branch: string | null;
  knowledge_selected: string | null;
  created_by: string | null;
  created_at: string;
}

interface RoutineJobRow {
  id: string;
  avatar_user_id: string;
  conversation_id: string;
  prompt: string;
  minute_of_day: number;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * app_config key under which the Claude subscription OAuth token (from
 * `claude setup-token`) is stored. Injected as CLAUDE_CODE_OAUTH_TOKEN into the
 * agent subprocess when no ANTHROPIC_API_KEY is configured (see claudeAgent.ts).
 */
export const CLAUDE_OAUTH_TOKEN_KEY = "claude_oauth_token";

/** app_config key: how self-service signups are gated ("open" | "closed" | "approval"). */
export const SIGNUP_MODE_KEY = "signup_mode";
/** app_config key: admin-selected agent model, overriding nothing when an env
 *  ANTHROPIC_MODEL is set (env wins, mirroring the API-key/subscription rule). */
export const MODEL_OVERRIDE_KEY = "agent_model_override";

export class Store {
  private readonly db: Database.Database;
  /** Key secret for at-rest token encryption (from config.sessionSecret). */
  private readonly secret: string;

  constructor(config: AppConfig) {
    this.secret = config.sessionSecret;
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seedRoles();
    logger.info({ dbPath: config.dbPath }, "database opened");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        alias TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        persona TEXT DEFAULT '',
        avatar_ext TEXT,
        published INTEGER DEFAULT 1,
        visibility TEXT NOT NULL DEFAULT 'group',
        auto_approve INTEGER DEFAULT 0,
        ssh_public_key TEXT,
        created_at TEXT,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT,
        role_id INTEGER,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS avatar_plugins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        ref TEXT,
        label TEXT,
        enabled INTEGER DEFAULT 1,
        selected TEXT,
        last_synced_at TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        avatar_user_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        response_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        actor_name TEXT,
        action TEXT,
        status TEXT,
        detail TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_requests (
        id TEXT PRIMARY KEY,
        avatar_user_id TEXT NOT NULL,
        asker_user_id TEXT,
        asker_name TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS avatar_notifications (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        avatar_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        conversation_id TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_secrets (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS git_repositories (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        last_synced_at TEXT,
        created_at TEXT,
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        knowledge_repo TEXT,
        knowledge_branch TEXT,
        knowledge_selected TEXT,
        created_by TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS routine_jobs (
        id TEXT PRIMARY KEY,
        avatar_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        minute_of_day INTEGER NOT NULL,
        enabled INTEGER DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_avatar_plugins_user ON avatar_plugins(user_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_requests_avatar ON knowledge_requests(avatar_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_avatar_notifications_owner ON avatar_notifications(owner_user_id, read_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_avatar ON routine_jobs(avatar_user_id);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_due ON routine_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_user_secrets_user ON user_secrets(user_id);
      CREATE INDEX IF NOT EXISTS idx_git_repositories_user ON git_repositories(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
    `);
    // Additive column migrations for pre-existing DBs (CREATE TABLE above only
    // applies to fresh installs). Each is a no-op once the column exists.
    this.addColumnIfMissing("avatar_plugins", "selected", "TEXT");
    this.addColumnIfMissing("avatar_plugins", "last_synced_at", "TEXT");
    this.addColumnIfMissing("users", "auto_approve", "INTEGER DEFAULT 0");
    // Account suspension: blocks login and kills active sessions. Also the
    // "pending approval" state for signups created while signup mode = approval.
    this.addColumnIfMissing("users", "suspended", "INTEGER DEFAULT 0");
    // Avatar self-name (별칭): how the avatar refers to ITSELF in chat, distinct
    // from display_name (how humans see it in lists). Injected into the system prompt.
    this.addColumnIfMissing("users", "alias", "TEXT DEFAULT ''");
    // Avatar self-introduction: a longer first-person blurb the avatar writes
    // about what it can do, shown atop the chat capabilities panel. Distinct
    // from bio (one-liner in lists) and persona (system-prompt behavior).
    this.addColumnIfMissing("users", "intro", "TEXT DEFAULT ''");
    // Per-user git credentials/identity + personal knowledge-repo location. The
    // token is stored AES-256-GCM-encrypted (see crypto.ts), never plaintext.
    this.addColumnIfMissing("users", "git_token_enc", "TEXT");
    this.addColumnIfMissing("users", "git_identity_name", "TEXT");
    this.addColumnIfMissing("users", "git_identity_email", "TEXT");
    this.addColumnIfMissing("users", "knowledge_repo", "TEXT");
    this.addColumnIfMissing("users", "knowledge_branch", "TEXT");
    // JSON array of plugin names to load from the knowledge repo; null = all.
    this.addColumnIfMissing("users", "knowledge_selected", "TEXT");
    // Public half of an app-generated SSH keypair. The private half is stored
    // only as the encrypted SSH_PRIVATE_KEY user secret.
    this.addColumnIfMissing("users", "ssh_public_key", "TEXT");
    // SDK session id of the conversation's last turn, used to resume context on
    // the next turn (see claudeAgent resume). Null until the first turn completes.
    this.addColumnIfMissing("conversations", "agent_session_id", "TEXT");
    // Capability hashtags (역량 해시태그): a JSON array of short searchable tags the
    // avatar generates from its skills/persona, shown in discovery (탐색) and queried
    // by the cross-avatar `mcp__avatars__search_avatars` tool. Null/[] = none.
    this.addColumnIfMissing("users", "hashtags", "TEXT");
    // Three-state avatar visibility (public / group / private) replacing the
    // binary `published` flag. Added nullable on existing DBs, then backfilled
    // from `published` below (1→public, 0→group). The `published` column is kept
    // for migration only and is no longer read by any visibility decision.
    this.addColumnIfMissing("users", "visibility", "TEXT");
    this.migrateGitTokenSecrets();
    this.migrateVisibility();
    // Trust is now derived purely from group co-membership; the old per-(avatar,
    // viewer) trust table is dropped (its grants don't survive the migration).
    this.db.exec("DROP TABLE IF EXISTS avatar_trusted_users");
  }

  /** Backfill the visibility enum from the legacy `published` flag. Idempotent:
   *  only touches rows where visibility hasn't been set yet. */
  private migrateVisibility(): void {
    this.db
      .prepare(
        "UPDATE users SET visibility = CASE WHEN published = 1 THEN 'public' ELSE 'group' END " +
          "WHERE visibility IS NULL OR visibility = ''",
      )
      .run();
  }

  private migrateGitTokenSecrets(): void {
    const createdAt = now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO user_secrets (user_id, name, value_enc, created_at) " +
          "SELECT id, ?, git_token_enc, ? FROM users WHERE git_token_enc IS NOT NULL",
      )
      .run(INTERNAL_GIT_TOKEN_SECRET_NAME, createdAt);
    this.db.prepare("UPDATE users SET git_token_enc = NULL WHERE git_token_enc IS NOT NULL").run();
  }

  /** Add a column to a table if it isn't already present (idempotent). */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private seedRoles(): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO roles (name) VALUES (?)");
    insert.run("admin");
    insert.run("member");
  }

  // ---- Users ------------------------------------------------------------

  /** Resolve a row's avatar visibility, falling back to the legacy `published`
   *  flag for any row that predates the backfill (defensive — migrate() backfills
   *  all rows on startup, so this normally just reads the column). */
  private rowVisibility(row: { visibility?: string | null; published?: number }): AvatarVisibility {
    const v = row.visibility;
    if (v === "public" || v === "group" || v === "private") {
      return v;
    }
    return row.published === 1 ? "public" : "group";
  }

  private toUser(row: UserRow): User {
    const roles = this.rolesFor(row.id);
    const secretNames = this.listUserSecretNames(row.id);
    const pluginCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ?")
        .get(row.id) as { c: number }
    ).c;
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
      // Only the names — the encrypted values never leave the server.
      secretNames,
      sshPublicKey: row.ssh_public_key ?? null,
      groups: this.listUserGroups(row.id),
    };
  }

  private getRoleId(name: string): number | null {
    const row = this.db.prepare("SELECT id FROM roles WHERE name = ?").get(name) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  private userRowById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  private userRowByUsername(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | UserRow
      | undefined;
  }

  createUser(input: { username: string; displayName: string; password: string }): User {
    const username = input.username.trim();
    if (this.userRowByUsername(username)) {
      throw new Error("DUPLICATE_USERNAME");
    }
    const timestamp = now();
    const id = crypto.randomUUID();
    const isFirstUser =
      (this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c === 0;

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
    return (this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c > 0;
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
    this.db
      .prepare(
        "UPDATE users SET display_name = ?, alias = ?, bio = ?, persona = ?, intro = ?, hashtags = ?, visibility = ? WHERE id = ?",
      )
      .run(displayName, alias, bio, persona, intro, hashtags, visibility, userId);
    return this.toUser(this.userRowById(userId)!);
  }

  setAvatarExt(userId: string, ext: string | null): void {
    this.db.prepare("UPDATE users SET avatar_ext = ? WHERE id = ?").run(ext, userId);
  }

  getAvatarExt(userId: string): string | null {
    const row = this.userRowById(userId);
    return row?.avatar_ext ?? null;
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
    const secretToken = this.getUserSecretValue(userId, INTERNAL_GIT_TOKEN_SECRET_NAME);
    if (secretToken !== null) {
      return secretToken;
    }
    const row = this.userRowById(userId);
    if (!row?.git_token_enc) {
      return null;
    }
    return decryptSecret(row.git_token_enc, this.secret);
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
    this.db
      .prepare(
        "INSERT INTO user_secrets (user_id, name, value_enc, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc",
      )
      .run(userId, name, enc, new Date().toISOString());
    if (name === "SSH_PRIVATE_KEY") {
      this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
    }
  }

  /** Store a generated SSH keypair: private key encrypted, public key visible. */
  setSshKeyPair(userId: string, privateKey: string, publicKey: string): User {
    if (!this.userRowById(userId)) {
      throw new Error("USER_NOT_FOUND");
    }
    const enc = encryptSecret(privateKey, this.secret);
    const createdAt = new Date().toISOString();
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

  /** Remove a named secret. No-op if it doesn't exist. */
  deleteUserSecret(userId: string, name: string): void {
    this.db.prepare("DELETE FROM user_secrets WHERE user_id = ? AND name = ?").run(userId, name);
    if (name === "SSH_PRIVATE_KEY") {
      this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
    }
  }

  /** Names of the user's stored secrets (for the settings UI; values omitted). */
  listUserSecretNames(userId: string): string[] {
    const rows = this.db
      .prepare("SELECT name FROM user_secrets WHERE user_id = ? ORDER BY name")
      .all(userId) as { name: string }[];
    return rows.map((r) => r.name);
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
      .run(key, enc, new Date().toISOString());
  }

  /** Decrypt an app-wide secret. Null if unset or undecryptable (e.g. SESSION_SECRET changed). */
  getAppSecret(key: string): string | null {
    const row = this.db.prepare("SELECT value_enc FROM app_config WHERE key = ?").get(key) as
      | { value_enc: string }
      | undefined;
    if (!row) {
      return null;
    }
    return decryptSecret(row.value_enc, this.secret);
  }

  /** Remove an app-wide secret. No-op if it doesn't exist. */
  deleteAppSecret(key: string): void {
    this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
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

  /**
   * Point the user at a personal knowledge repo (`null` repo clears it).
   * Clears any plugin selection too: the old subset names don't apply to a
   * different repo, and a fresh repo should default to "load all".
   */
  setKnowledgeRepo(userId: string, repo: string | null, branch: string | null): User {
    if (!this.userRowById(userId)) {
      throw new Error("USER_NOT_FOUND");
    }
    this.db
      .prepare(
        "UPDATE users SET knowledge_repo = ?, knowledge_branch = ?, knowledge_selected = NULL WHERE id = ?",
      )
      .run(repo?.trim() || null, branch?.trim() || null, userId);
    return this.toUser(this.userRowById(userId)!);
  }

  /** Set which knowledge-repo plugins the avatar loads; `null` = load all. */
  setKnowledgeSelected(userId: string, selected: string[] | null): User {
    if (!this.userRowById(userId)) {
      throw new Error("USER_NOT_FOUND");
    }
    this.db
      .prepare("UPDATE users SET knowledge_selected = ? WHERE id = ?")
      .run(selected ? JSON.stringify(selected) : null, userId);
    return this.toUser(this.userRowById(userId)!);
  }

  /** The configured knowledge repo + branch + plugin selection for a user. */
  getKnowledgeRepo(userId: string): {
    repo: string | null;
    branch: string | null;
    selected: string[] | null;
  } {
    const row = this.userRowById(userId);
    return {
      repo: row?.knowledge_repo ?? null,
      branch: row?.knowledge_branch ?? null,
      selected: parseNameList(row?.knowledge_selected ?? null),
    };
  }

  // ---- General git repositories ----------------------------------------

  private toGitRepository(row: GitRepositoryRow): GitRepository {
    return {
      userId: row.user_id,
      name: row.name,
      repo: row.repo,
      branch: row.branch ?? null,
      lastSyncedAt: row.last_synced_at ?? null,
      createdAt: row.created_at,
    };
  }

  /** Register or update a user-scoped general git repo by short name. */
  upsertGitRepo(userId: string, name: string, repo: string, branch: string | null): GitRepository {
    if (!this.userRowById(userId)) {
      throw new Error("USER_NOT_FOUND");
    }
    const cleanName = name.trim();
    const cleanRepo = repo.trim();
    if (!cleanName || !cleanRepo) {
      throw new Error("INVALID_GIT_REPO");
    }
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO git_repositories (user_id, name, repo, branch, last_synced_at, created_at) VALUES (?, ?, ?, ?, NULL, ?) " +
          "ON CONFLICT(user_id, name) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, last_synced_at = NULL",
      )
      .run(userId, cleanName, cleanRepo, branch?.trim() || null, createdAt);
    return this.getGitRepo(userId, cleanName)!;
  }

  listGitRepos(userId: string): GitRepository[] {
    const rows = this.db
      .prepare("SELECT * FROM git_repositories WHERE user_id = ? ORDER BY name")
      .all(userId) as GitRepositoryRow[];
    return rows.map((row) => this.toGitRepository(row));
  }

  getGitRepo(userId: string, name: string): GitRepository | null {
    const row = this.db
      .prepare("SELECT * FROM git_repositories WHERE user_id = ? AND name = ?")
      .get(userId, name.trim()) as GitRepositoryRow | undefined;
    return row ? this.toGitRepository(row) : null;
  }

  deleteGitRepo(userId: string, name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM git_repositories WHERE user_id = ? AND name = ?")
      .run(userId, name.trim());
    return result.changes > 0;
  }

  markGitRepoSynced(userId: string, name: string): GitRepository | null {
    this.db
      .prepare("UPDATE git_repositories SET last_synced_at = ? WHERE user_id = ? AND name = ?")
      .run(new Date().toISOString(), userId, name.trim());
    return this.getGitRepo(userId, name);
  }

  // ---- Plugins ----------------------------------------------------------

  private toPlugin(row: {
    id: string;
    repo: string;
    ref: string | null;
    label: string | null;
    enabled: number;
    selected: string | null;
    last_synced_at: string | null;
    created_at: string;
  }): Plugin {
    return {
      id: row.id,
      repo: row.repo,
      ref: row.ref,
      label: row.label,
      enabled: row.enabled === 1,
      selected: parseNameList(row.selected),
      lastSyncedAt: row.last_synced_at ?? null,
      createdAt: row.created_at,
    };
  }

  listPlugins(userId: string): Plugin[] {
    const rows = this.db
      .prepare("SELECT * FROM avatar_plugins WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as Parameters<Store["toPlugin"]>[0][];
    return rows.map((r) => this.toPlugin(r));
  }

  listEnabledPlugins(userId: string): Plugin[] {
    return this.listPlugins(userId).filter((p) => p.enabled);
  }

  addPlugin(userId: string, input: { repo: string; ref?: string; label?: string }): Plugin {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO avatar_plugins (id, user_id, repo, ref, label, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, userId, input.repo.trim(), input.ref?.trim() || null, input.label?.trim() || null, now());
    return this.toPlugin(
      this.db.prepare("SELECT * FROM avatar_plugins WHERE id = ?").get(id) as Parameters<
        Store["toPlugin"]
      >[0],
    );
  }

  deletePlugin(userId: string, id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM avatar_plugins WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return result.changes > 0;
  }

  getPlugin(userId: string, id: string): Plugin | null {
    const row = this.db
      .prepare("SELECT * FROM avatar_plugins WHERE id = ? AND user_id = ?")
      .get(id, userId) as Parameters<Store["toPlugin"]>[0] | undefined;
    return row ? this.toPlugin(row) : null;
  }

  setPluginEnabled(userId: string, id: string, enabled: boolean): Plugin | null {
    const result = this.db
      .prepare("UPDATE avatar_plugins SET enabled = ? WHERE id = ? AND user_id = ?")
      .run(enabled ? 1 : 0, id, userId);
    if (result.changes === 0) {
      return null;
    }
    return this.getPlugin(userId, id);
  }

  /** Update which marketplace plugins are loaded; `null` means "load all". */
  setPluginSelected(userId: string, id: string, selected: string[] | null): Plugin | null {
    const result = this.db
      .prepare("UPDATE avatar_plugins SET selected = ? WHERE id = ? AND user_id = ?")
      .run(selected ? JSON.stringify(selected) : null, id, userId);
    if (result.changes === 0) {
      return null;
    }
    return this.getPlugin(userId, id);
  }

  /** Update the ref (branch/tag/commit) a plugin tracks. */
  setPluginRef(userId: string, id: string, ref: string | null): Plugin | null {
    const result = this.db
      .prepare("UPDATE avatar_plugins SET ref = ? WHERE id = ? AND user_id = ?")
      .run(ref, id, userId);
    if (result.changes === 0) {
      return null;
    }
    return this.getPlugin(userId, id);
  }

  /** Stamp the last successful git sync time. */
  markPluginSynced(userId: string, id: string): Plugin | null {
    const result = this.db
      .prepare("UPDATE avatar_plugins SET last_synced_at = ? WHERE id = ? AND user_id = ?")
      .run(now(), id, userId);
    if (result.changes === 0) {
      return null;
    }
    return this.getPlugin(userId, id);
  }

  // ---- Knowledge: the owner's gap inbox (colleague questions) ----------

  private toKnowledgeRequest(row: KnowledgeRequestRow): KnowledgeRequest {
    return {
      id: row.id,
      avatarUserId: row.avatar_user_id,
      askerUserId: row.asker_user_id,
      askerName: row.asker_name,
      question: row.question,
      status: row.status as KnowledgeRequest["status"],
      createdAt: row.created_at,
    };
  }

  /**
   * Queue a knowledge gap for the avatar's owner. If an identical question is
   * already open we return that one instead of duplicating it.
   */
  addKnowledgeRequest(
    avatarUserId: string,
    input: { question: string; askerUserId?: string | null; askerName?: string | null },
  ): KnowledgeRequest {
    const question = input.question.trim();
    const existing = this.db
      .prepare(
        "SELECT * FROM knowledge_requests WHERE avatar_user_id = ? AND status = 'open' AND question = ?",
      )
      .get(avatarUserId, question) as KnowledgeRequestRow | undefined;
    if (existing) {
      return this.toKnowledgeRequest(existing);
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO knowledge_requests (id, avatar_user_id, asker_user_id, asker_name, question, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, avatarUserId, input.askerUserId ?? null, input.askerName ?? null, question, now());
    return this.toKnowledgeRequest(
      this.db.prepare("SELECT * FROM knowledge_requests WHERE id = ?").get(id) as KnowledgeRequestRow,
    );
  }

  listKnowledgeRequests(avatarUserId: string, status?: KnowledgeRequest["status"]): KnowledgeRequest[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM knowledge_requests WHERE avatar_user_id = ? AND status = ? ORDER BY created_at DESC",
            )
            .all(avatarUserId, status)
        : this.db
            .prepare("SELECT * FROM knowledge_requests WHERE avatar_user_id = ? ORDER BY created_at DESC")
            .all(avatarUserId)
    ) as KnowledgeRequestRow[];
    return rows.map((r) => this.toKnowledgeRequest(r));
  }

  countOpenKnowledgeRequests(avatarUserId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM knowledge_requests WHERE avatar_user_id = ? AND status = 'open'",
        )
        .get(avatarUserId) as { c: number }
    ).c;
  }

  /**
   * Resolve (close) an open request. There is no stored answer: the avatar's
   * persistent knowledge lives in plugins, so the owner just clears the gap
   * from the inbox once handled. Returns false if it isn't an open request of
   * this avatar's.
   */
  resolveKnowledgeRequest(avatarUserId: string, id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE knowledge_requests SET status = 'resolved' WHERE id = ? AND avatar_user_id = ? AND status = 'open'",
      )
      .run(id, avatarUserId);
    return result.changes > 0;
  }

  // ---- Avatar notifications (in-app alarms for the owner) --------------

  private toAvatarNotification(row: AvatarNotificationRow): AvatarNotification {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      avatarUserId: row.avatar_user_id,
      avatarDisplayName: row.avatar_display_name ?? "(삭제된 아바타)",
      title: row.title,
      message: row.message,
      conversationId: row.conversation_id,
      readAt: row.read_at,
      createdAt: row.created_at,
    };
  }

  addAvatarNotification(
    ownerUserId: string,
    input: { avatarUserId: string; title?: string | null; message: string; conversationId?: string | null },
  ): AvatarNotification {
    const message = input.message.trim();
    if (!message) {
      throw new Error("EMPTY_NOTIFICATION");
    }
    const title = (input.title || "").trim().slice(0, 80) || "아바타 알림";
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO avatar_notifications (id, owner_user_id, avatar_user_id, title, message, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerUserId, input.avatarUserId, title, message.slice(0, 4000), input.conversationId ?? null, now());
    return this.listAvatarNotifications(ownerUserId).find((n) => n.id === id)!;
  }

  listAvatarNotifications(ownerUserId: string, unreadOnly = false): AvatarNotification[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, u.display_name AS avatar_display_name
         FROM avatar_notifications n LEFT JOIN users u ON u.id = n.avatar_user_id
         WHERE n.owner_user_id = ? ${unreadOnly ? "AND n.read_at IS NULL" : ""}
         ORDER BY n.created_at DESC
         LIMIT 100`,
      )
      .all(ownerUserId) as AvatarNotificationRow[];
    return rows.map((r) => this.toAvatarNotification(r));
  }

  markAvatarNotificationRead(ownerUserId: string, id: string): boolean {
    const result = this.db
      .prepare("UPDATE avatar_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND owner_user_id = ?")
      .run(now(), id, ownerUserId);
    return result.changes > 0;
  }

  markAllAvatarNotificationsRead(ownerUserId: string): number {
    const result = this.db
      .prepare("UPDATE avatar_notifications SET read_at = COALESCE(read_at, ?) WHERE owner_user_id = ? AND read_at IS NULL")
      .run(now(), ownerUserId);
    return result.changes;
  }

  // ---- Routine jobs (owner-scheduled recurring runs) -------------------

  private toRoutineJob(row: RoutineJobRow): RoutineJob {
    return {
      id: row.id,
      avatarUserId: row.avatar_user_id,
      conversationId: row.conversation_id,
      prompt: row.prompt,
      minuteOfDay: row.minute_of_day,
      time: formatMinuteOfDay(row.minute_of_day),
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastStatus: (row.last_status as RoutineJob["lastStatus"]) ?? null,
      lastError: row.last_error,
      createdAt: row.created_at,
    };
  }

  private routineJobRow(id: string): RoutineJobRow | undefined {
    return this.db.prepare("SELECT * FROM routine_jobs WHERE id = ?").get(id) as
      | RoutineJobRow
      | undefined;
  }

  listRoutineJobs(avatarUserId: string): RoutineJob[] {
    const rows = this.db
      .prepare("SELECT * FROM routine_jobs WHERE avatar_user_id = ? ORDER BY created_at ASC")
      .all(avatarUserId) as RoutineJobRow[];
    return rows.map((r) => this.toRoutineJob(r));
  }

  /** Enabled jobs whose next run is at or before `nowIso`. Used by the scheduler. */
  listDueRoutineJobs(nowIso: string): RoutineJob[] {
    // Skip jobs whose owner is suspended: a suspended account's avatar must not
    // keep running headless, elevated routines (with its stored secrets/tokens).
    const rows = this.db
      .prepare(
        `SELECT rj.* FROM routine_jobs rj
         JOIN users u ON u.id = rj.avatar_user_id
         WHERE rj.enabled = 1 AND rj.next_run_at IS NOT NULL AND rj.next_run_at <= ?
           AND u.suspended = 0
         ORDER BY rj.next_run_at ASC`,
      )
      .all(nowIso) as RoutineJobRow[];
    return rows.map((r) => this.toRoutineJob(r));
  }

  getRoutineJob(avatarUserId: string, id: string): RoutineJob | null {
    const row = this.routineJobRow(id);
    if (!row || row.avatar_user_id !== avatarUserId) {
      return null;
    }
    return this.toRoutineJob(row);
  }

  createRoutineJob(
    avatarUserId: string,
    input: { prompt: string; minuteOfDay: number; enabled?: boolean },
  ): RoutineJob {
    const id = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const enabled = input.enabled !== false;
    const prompt = input.prompt.trim();
    const nextRunAt = enabled ? nextDailyRunIso(input.minuteOfDay) : null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO routine_jobs (id, avatar_user_id, conversation_id, prompt, minute_of_day, enabled, next_run_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, avatarUserId, conversationId, prompt, input.minuteOfDay, enabled ? 1 : 0, nextRunAt, now());
      // Create the dedicated conversation eagerly so the client can always
      // open it (and so its title comes from the prompt, not from whatever
      // message lands in it first).
      this.touchConversation(avatarUserId, conversationId, avatarUserId, `[루틴] ${prompt}`);
    });
    tx();
    return this.toRoutineJob(this.routineJobRow(id)!);
  }

  updateRoutineJob(
    avatarUserId: string,
    id: string,
    patch: { prompt?: string; minuteOfDay?: number; enabled?: boolean },
  ): RoutineJob | null {
    const row = this.routineJobRow(id);
    if (!row || row.avatar_user_id !== avatarUserId) {
      return null;
    }
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : row.prompt;
    const minuteOfDay = patch.minuteOfDay !== undefined ? patch.minuteOfDay : row.minute_of_day;
    const wasEnabled = row.enabled === 1;
    const enabled = patch.enabled !== undefined ? patch.enabled : wasEnabled;
    // Recompute the next firing only when timing or enablement actually
    // changes. A prompt-only edit must keep an overdue (missed) run intact —
    // recomputing would silently push it to tomorrow.
    const timeChanged = patch.minuteOfDay !== undefined && patch.minuteOfDay !== row.minute_of_day;
    let nextRunAt: string | null;
    if (!enabled) {
      nextRunAt = null;
    } else if (timeChanged || !wasEnabled || !row.next_run_at) {
      nextRunAt = nextDailyRunIso(minuteOfDay);
    } else {
      nextRunAt = row.next_run_at;
    }
    this.db
      .prepare(
        "UPDATE routine_jobs SET prompt = ?, minute_of_day = ?, enabled = ?, next_run_at = ? WHERE id = ?",
      )
      .run(prompt, minuteOfDay, enabled ? 1 : 0, nextRunAt, id);
    return this.toRoutineJob(this.routineJobRow(id)!);
  }

  deleteRoutineJob(avatarUserId: string, id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM routine_jobs WHERE id = ? AND avatar_user_id = ?")
      .run(id, avatarUserId);
    return result.changes > 0;
  }

  /**
   * Record the outcome of a firing and schedule the next one. An enabled job
   * rolls forward to tomorrow's slot; a job disabled mid-run stays parked.
   */
  markRoutineRun(id: string, outcome: { status: "success" | "error"; error?: string | null }): void {
    const row = this.routineJobRow(id);
    if (!row) {
      return;
    }
    const nextRunAt = row.enabled === 1 ? nextDailyRunIso(row.minute_of_day) : null;
    this.db
      .prepare(
        "UPDATE routine_jobs SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ? WHERE id = ?",
      )
      .run(now(), outcome.status, outcome.error ?? null, nextRunAt, id);
  }

  // ---- Avatars (discovery) ---------------------------------------------

  private avatarUpdatedAt(userId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT MAX(updated_at) AS m FROM conversations WHERE avatar_user_id = ? AND owner_user_id = ?",
      )
      .get(userId, userId) as { m: string | null };
    return row.m;
  }

  /** User ids that share at least one group with `viewerId` (excludes self). */
  private groupTeammateIds(viewerId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m2.user_id AS id FROM group_members m1
         JOIN group_members m2 ON m1.group_id = m2.group_id
         WHERE m1.user_id = ? AND m2.user_id != ?`,
      )
      .all(viewerId, viewerId) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  listPublishedAvatars(viewerId: string): AvatarSummary[] {
    // Visibility model: `public` avatars are visible to everyone; `group`
    // avatars only to group teammates; `private` only to the owner. The viewer's
    // own avatar always shows regardless of visibility. (Group co-membership is
    // also what makes teammates mutually elevated — see isTrustedFor.)
    const rows = this.db
      .prepare(
        `SELECT * FROM users
         WHERE suspended = 0
           AND (visibility = 'public' OR id = ?
            OR (visibility = 'group' AND id IN (
              SELECT m2.user_id FROM group_members m1
              JOIN group_members m2 ON m1.group_id = m2.group_id
              WHERE m1.user_id = ?
            )))
         ORDER BY display_name COLLATE NOCASE ASC`,
      )
      .all(viewerId, viewerId) as UserRow[];
    const teammates = this.groupTeammateIds(viewerId);
    return rows.map((row) => ({
      ...this.toAvatarSummary(row),
      sharesGroup: teammates.has(row.id),
    }));
  }

  private toAvatarSummary(row: UserRow): AvatarSummary {
    const pluginCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ? AND enabled = 1")
        .get(row.id) as { c: number }
    ).c;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      alias: row.alias ?? "",
      bio: row.bio ?? "",
      hashtags: parseHashtags(row.hashtags),
      hasImage: Boolean(row.avatar_ext),
      pluginCount,
      visibility: this.rowVisibility(row),
      updatedAt: this.avatarUpdatedAt(row.id),
    };
  }

  /**
   * Find avatars visible to the viewer (public + own + group teammates') whose capabilities match a
   * free-text query, ranked. Matches across hashtags, bio, intro, name, alias,
   * and username; a hashtag hit outranks a body hit. An empty query lists all
   * (capped). Backs the cross-avatar `mcp__avatars__search_avatars` tool, so an
   * avatar can point the user at a teammate avatar that specializes in something
   * it can't do. `excludeId` drops the current avatar from its own results.
   */
  searchAvatars(
    viewerId: string,
    query: string,
    opts: { excludeId?: string; limit?: number } = {},
  ): AvatarSummary[] {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1), 50);
    // Visibility mirrors listPublishedAvatars: `public` avatars, the viewer's
    // own, and `group` avatars of group teammates (`private` ones stay
    // owner-only). Suspended users are never discoverable. Keeping this in sync
    // with listPublishedAvatars is what the avatar-directory MCP tool relies on
    // to surface the same teammates the viewer can browse.
    const rows = this.db
      .prepare(
        `SELECT * FROM users
         WHERE suspended = 0
           AND (visibility = 'public' OR id = ?
            OR (visibility = 'group' AND id IN (
              SELECT m2.user_id FROM group_members m1
              JOIN group_members m2 ON m1.group_id = m2.group_id
              WHERE m1.user_id = ?
            )))`,
      )
      .all(viewerId, viewerId) as UserRow[];
    const teammates = this.groupTeammateIds(viewerId);
    const tokens = query
      .toLowerCase()
      .split(/[\s,，、]+/)
      .map((t) => t.replace(/^#+/, "").trim())
      .filter(Boolean);
    const scored = rows
      .filter((row) => row.id !== opts.excludeId)
      .map((row) => {
        const tags = parseHashtags(row.hashtags);
        const tagHay = tags.join(" ").toLowerCase();
        const bodyHay = [row.display_name, row.alias, row.username, row.bio, row.intro]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        let score = 0;
        // Per token, one tier only: exact hashtag (5) > partial hashtag (3) > body (1).
        for (const token of tokens) {
          if (tags.some((tag) => tag.toLowerCase() === token)) score += 5;
          else if (tagHay.includes(token)) score += 3;
          else if (bodyHay.includes(token)) score += 1;
        }
        return { row, score };
      });
    const matches = tokens.length ? scored.filter((s) => s.score > 0) : scored;
    matches.sort(
      (a, b) =>
        b.score - a.score || a.row.display_name.localeCompare(b.row.display_name),
    );
    return matches
      .slice(0, limit)
      .map((s) => ({ ...this.toAvatarSummary(s.row), sharesGroup: teammates.has(s.row.id) }));
  }

  getAvatar(viewerId: string, id: string): AvatarDetail | null {
    const row = this.userRowById(id);
    if (!row) {
      return null;
    }
    // A suspended owner's avatar is not discoverable/viewable by others (the
    // owner can't log in to view their own either, so the self-exception is moot).
    if (row.suspended === 1 && id !== viewerId) {
      return null;
    }
    const isOwn = id === viewerId;
    const trusted = !isOwn && this.isTrustedFor(viewerId, id);
    if (!isOwn && !this.isVisibleTo(row, viewerId)) {
      return null;
    }
    const plugins = (
      this.db
        .prepare(
          "SELECT repo, label FROM avatar_plugins WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC",
        )
        .all(id) as { repo: string; label: string | null }[]
    ).map((p) => ({ repo: p.repo, label: p.label }));
    return {
      ...this.toAvatarSummary(row),
      persona: row.persona ?? "",
      intro: row.intro ?? "",
      isOwn,
      elevated: isOwn || trusted,
      plugins,
    };
  }

  /**
   * Resolve a chat target avatar: reachable if it's the viewer's own, or visible
   * to the viewer per its visibility — `public` (anyone), `group` (group
   * teammates), or `private` (owner only). See `isVisibleTo`.
   */
  resolveChatAvatar(
    viewerId: string,
    id: string,
  ): { id: string; displayName: string; alias: string; persona: string } | null {
    const row = this.userRowById(id);
    if (!row) {
      return null;
    }
    // A suspended owner's avatar is unreachable for chat (and the scheduler skips
    // suspended owners' routines via listDueRoutineJobs). Self is moot — a
    // suspended user has no session.
    if (row.suspended === 1 && id !== viewerId) {
      return null;
    }
    if (id !== viewerId && !this.isVisibleTo(row, viewerId)) {
      return null;
    }
    return { id: row.id, displayName: row.display_name, alias: row.alias ?? "", persona: row.persona ?? "" };
  }

  // ---- Trust & visibility ----------------------------------------------
  // Trust (elevated tool access) is derived PURELY from group co-membership:
  // members of the same group are mutually + symmetrically elevated. A trusted
  // viewer chats with someone else's avatar at the OWNER's tool-permission level
  // (write/Bash run, not just read-only) — but it does NOT grant the owner-only
  // knowledge inbox or greeting.

  /**
   * True when `viewerId` may use tools at the owner's level on `avatarId`'s
   * avatar. The ONLY source is sharing at least one group (see `shareAnyGroup`).
   * This is THE single point every trust/elevated check flows through, so all
   * elevation derives from group membership — manage trust by managing groups.
   */
  isTrustedFor(viewerId: string, avatarId: string): boolean {
    if (!viewerId || !avatarId || viewerId === avatarId) {
      return false;
    }
    return this.shareAnyGroup(viewerId, avatarId);
  }

  /**
   * Whether an avatar row is discoverable/reachable by `viewerId` (NOT counting
   * the self-exception, which callers handle). `public` → everyone; `group` →
   * group teammates only; `private` → no one. Suspended owners are filtered by
   * the callers before this is consulted.
   */
  private isVisibleTo(row: UserRow, viewerId: string): boolean {
    const visibility = this.rowVisibility(row);
    if (visibility === "public") {
      return true;
    }
    if (visibility === "group") {
      return this.shareAnyGroup(viewerId, row.id);
    }
    return false; // private
  }

  /**
   * True when two distinct users share at least one group. Group co-membership
   * is the second source of trust (members of the same group are mutually
   * elevated), OR'd into `isTrustedFor`. Indexed on group_members(user_id).
   */
  private shareAnyGroup(userA: string, userB: string): boolean {
    if (!userA || !userB || userA === userB) {
      return false;
    }
    const row = this.db
      .prepare(
        `SELECT 1 FROM group_members m1
         JOIN group_members m2 ON m1.group_id = m2.group_id
         WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`,
      )
      .get(userA, userB);
    return Boolean(row);
  }

  /**
   * Names of the groups two distinct users share. Explains WHY a viewer is
   * auto-trusted (group co-membership) for the prompt — the trust DECISION
   * itself still goes through `isTrustedFor`/`shareAnyGroup`.
   */
  sharedGroupNames(userA: string, userB: string): string[] {
    if (!userA || !userB || userA === userB) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT g.name AS name FROM groups g
         JOIN group_members m1 ON m1.group_id = g.id AND m1.user_id = ?
         JOIN group_members m2 ON m2.group_id = g.id AND m2.user_id = ?
         ORDER BY g.name COLLATE NOCASE ASC`,
      )
      .all(userA, userB) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * Search users by username OR display name (case-insensitive substring) to
   * populate the group member-add picker. `searcherId` is excluded. Prefix
   * matches sort first, then by display name. Returns [] for a blank query.
   * Capped at `limit`.
   */
  searchUsers(
    query: string,
    searcherId: string,
    limit = 8,
  ): { id: string; username: string; displayName: string }[] {
    const q = query.trim();
    if (!q) {
      return [];
    }
    // Escape LIKE wildcards so a literal %, _ or \ in the query stays literal.
    const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${esc}%`;
    const prefix = `${esc}%`;
    const rows = this.db
      .prepare(
        `SELECT u.id AS id, u.username AS username, u.display_name AS display_name
         FROM users u
         WHERE u.id != ?
           AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
         ORDER BY
           CASE WHEN u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
           u.display_name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .all(searcherId, like, like, prefix, prefix, limit) as {
      id: string;
      username: string;
      display_name: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
    }));
  }

  // ---- Conversations & messages ----------------------------------------

  listConversations(
    ownerId: string,
    avatarId?: string,
    kind: "chat" | "routine" | "all" = "chat",
  ): ConversationSummary[] {
    const params: string[] = [ownerId];
    const where = ["c.owner_user_id = ?"];
    if (avatarId) {
      where.push("c.avatar_user_id = ?");
      params.push(avatarId);
    }
    if (kind === "chat") {
      where.push("r.id IS NULL");
    } else if (kind === "routine") {
      where.push("r.id IS NOT NULL");
    }
    const rows = this.db
      .prepare(
        `SELECT c.id, c.avatar_user_id, c.title, c.updated_at, u.display_name AS avatar_display_name,
                r.id AS routine_id, r.prompt AS routine_prompt
         FROM conversations c
         LEFT JOIN users u ON u.id = c.avatar_user_id
         LEFT JOIN routine_jobs r ON r.conversation_id = c.id
         WHERE ${where.join(" AND ")}
         ORDER BY c.updated_at DESC`,
      )
      .all(...params) as {
      id: string;
      avatar_user_id: string;
      title: string;
      updated_at: string;
      avatar_display_name: string | null;
      routine_id: string | null;
      routine_prompt: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      avatarUserId: r.avatar_user_id,
      avatarDisplayName: r.avatar_display_name ?? "(삭제된 아바타)",
      title: r.title,
      updatedAt: r.updated_at,
      isRoutine: Boolean(r.routine_id),
      routineId: r.routine_id,
      routinePrompt: r.routine_prompt,
    }));
  }

  private ownsConversation(ownerId: string, conversationId: string): boolean {
    const row = this.db
      .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
      .get(conversationId) as { owner_user_id: string } | undefined;
    return Boolean(row && row.owner_user_id === ownerId);
  }

  getConversationAvatarId(ownerId: string, conversationId: string): string | null {
    const row = this.db
      .prepare("SELECT avatar_user_id FROM conversations WHERE id = ? AND owner_user_id = ?")
      .get(conversationId, ownerId) as { avatar_user_id: string } | undefined;
    return row?.avatar_user_id ?? null;
  }

  /** The owner of a conversation regardless of caller (null if it doesn't exist). */
  conversationOwner(conversationId: string): string | null {
    const row = this.db
      .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
      .get(conversationId) as { owner_user_id: string } | undefined;
    return row?.owner_user_id ?? null;
  }

  touchConversation(
    ownerId: string,
    conversationId: string,
    avatarUserId: string,
    firstUserText: string,
  ): void {
    const timestamp = now();
    // Look up by id ALONE so a conversation id that already exists under a
    // DIFFERENT owner is detected here, rather than falling through to the INSERT
    // below and hitting the PRIMARY KEY constraint (which would throw and, on
    // Express 4, escape the async handler as an unhandled rejection). The chat
    // route also rejects a foreign supplied id up front with a 409.
    const existing = this.db
      .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
      .get(conversationId) as { owner_user_id: string } | undefined;
    if (existing) {
      if (existing.owner_user_id !== ownerId) {
        throw new Error("CONVERSATION_OWNER_MISMATCH");
      }
      this.db
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(timestamp, conversationId);
      return;
    }
    const rawTitle = firstUserText.trim().replace(/\s+/g, " ");
    const title = rawTitle.length > 0 ? rawTitle.slice(0, 40) : "새 대화";
    this.db
      .prepare(
        `INSERT INTO conversations (id, owner_user_id, avatar_user_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, ownerId, avatarUserId, title, timestamp, timestamp);
  }

  /** The SDK session to resume for this conversation's next turn (null if none). */
  getAgentSessionId(ownerId: string, conversationId: string): string | null {
    const row = this.db
      .prepare("SELECT agent_session_id FROM conversations WHERE id = ? AND owner_user_id = ?")
      .get(conversationId, ownerId) as { agent_session_id: string | null } | undefined;
    return row?.agent_session_id ?? null;
  }

  /**
   * Record (or clear, when sessionId is null) the SDK session id produced by this
   * conversation's latest turn. Owner-scoped so a guessed conversation id can't
   * point another owner's conversation at a different session.
   */
  setAgentSessionId(ownerId: string, conversationId: string, sessionId: string | null): void {
    this.db
      .prepare("UPDATE conversations SET agent_session_id = ? WHERE id = ? AND owner_user_id = ?")
      .run(sessionId, conversationId, ownerId);
  }

  /**
   * Parse a persisted response_json column, tolerating corruption: a single bad
   * row must not throw and brick listMessages for an entire conversation.
   */
  private parseResponseJson(json: string | null): AgentResponse | null {
    if (!json) {
      return null;
    }
    try {
      return JSON.parse(json) as AgentResponse;
    } catch {
      logger.warn("skipping corrupt response_json on a stored message");
      return null;
    }
  }

  listMessages(ownerId: string, conversationId: string): StoredMessage[] {
    if (!this.ownsConversation(ownerId, conversationId)) {
      return [];
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC",
      )
      .all(conversationId) as {
      id: string;
      conversation_id: string;
      role: string;
      content: string;
      response_json: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as StoredMessage["role"],
      content: r.content,
      response: this.parseResponseJson(r.response_json),
      createdAt: r.created_at,
    }));
  }

  addMessage(
    conversationId: string,
    input: { role: "user" | "assistant" | "system"; content: string; response?: AgentResponse | null },
  ): StoredMessage {
    const id = crypto.randomUUID();
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        input.role,
        input.content,
        input.response ? JSON.stringify(input.response) : null,
        createdAt,
      );
    return {
      id,
      conversationId,
      role: input.role,
      content: input.content,
      response: input.response ?? null,
      createdAt,
    };
  }

  renameConversation(ownerId: string, id: string, title: string): ConversationSummary | null {
    if (!this.ownsConversation(ownerId, id)) {
      return null;
    }
    const trimmed = title.trim().slice(0, 80);
    const finalTitle = trimmed.length > 0 ? trimmed : "새 대화";
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(finalTitle, now(), id);
    return this.listConversations(ownerId, undefined, "all").find((c) => c.id === id) ?? null;
  }

  deleteConversation(ownerId: string, id: string): boolean {
    if (!this.ownsConversation(ownerId, id)) {
      return false;
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  /** Remove the trailing assistant reply so a regenerate can replace it. */
  dropLastAssistant(ownerId: string, conversationId: string): boolean {
    if (!this.ownsConversation(ownerId, conversationId)) {
      return false;
    }
    const last = this.db
      .prepare(
        "SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(conversationId) as { id: string; role: string } | undefined;
    if (last && last.role === "assistant") {
      this.db.prepare("DELETE FROM messages WHERE id = ?").run(last.id);
      return true;
    }
    return false;
  }

  // ---- Audit ------------------------------------------------------------

  audit(event: { actorUserId?: string | null; actorName?: string | null; action: string; status: string; detail: string }): void {
    this.db
      .prepare(
        `INSERT INTO audit (id, actor_user_id, actor_name, action, status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        event.actorUserId ?? null,
        event.actorName ?? null,
        event.action,
        event.status,
        event.detail,
        now(),
      );
  }

  listAudit(userId: string, isAdmin: boolean, limit = 200): AuditEvent[] {
    const rows = (
      isAdmin
        ? this.db
            .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT ?")
            .all(limit)
        : this.db
            .prepare(
              "SELECT * FROM audit WHERE actor_user_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(userId, limit)
    ) as {
      id: string;
      actor_user_id: string | null;
      actor_name: string | null;
      action: string;
      status: string;
      detail: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      action: r.action,
      status: r.status,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  // ---- Admin ------------------------------------------------------------

  private toAdminSummary(row: UserRow): AdminUserSummary {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      roles: this.rolesFor(row.id),
      visibility: this.rowVisibility(row),
      suspended: row.suspended === 1,
      hasImage: Boolean(row.avatar_ext),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  listUsers(): AdminUserSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map((row) => this.toAdminSummary(row));
  }

  private count(sql: string, ...params: unknown[]): number {
    return (this.db.prepare(sql).get(...params) as { c: number }).c;
  }

  /** True once more than one admin exists — used to block locking out the last one. */
  countAdmins(): number {
    return this.count(
      `SELECT COUNT(*) AS c FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'`,
    );
  }

  /** Deployment-wide counts for the admin dashboard. */
  adminStats(): AdminStats {
    const current = now();
    return {
      users: this.count("SELECT COUNT(*) AS c FROM users"),
      admins: this.countAdmins(),
      suspended: this.count("SELECT COUNT(*) AS c FROM users WHERE suspended = 1"),
      publicAvatars: this.count("SELECT COUNT(*) AS c FROM users WHERE visibility = 'public'"),
      conversations: this.count("SELECT COUNT(*) AS c FROM conversations"),
      messages: this.count("SELECT COUNT(*) AS c FROM messages"),
      openRequests: this.count("SELECT COUNT(*) AS c FROM knowledge_requests WHERE status = 'open'"),
      activeRoutines: this.count("SELECT COUNT(*) AS c FROM routine_jobs WHERE enabled = 1"),
      activeSessions: this.count("SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?", current),
      groups: this.count("SELECT COUNT(*) AS c FROM groups"),
    };
  }

  /** Per-user breakdown for the expandable admin row. Null if the user is gone. */
  adminUserDetail(id: string): AdminUserDetail | null {
    const row = this.userRowById(id);
    if (!row) {
      return null;
    }
    return {
      ...this.toAdminSummary(row),
      conversationsStarted: this.count(
        "SELECT COUNT(*) AS c FROM conversations WHERE owner_user_id = ?",
        id,
      ),
      conversationsReceived: this.count(
        "SELECT COUNT(*) AS c FROM conversations WHERE avatar_user_id = ?",
        id,
      ),
      pluginCount: this.count("SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ?", id),
      secretCount: this.count("SELECT COUNT(*) AS c FROM user_secrets WHERE user_id = ?", id),
      routinesTotal: this.count("SELECT COUNT(*) AS c FROM routine_jobs WHERE avatar_user_id = ?", id),
      routinesActive: this.count(
        "SELECT COUNT(*) AS c FROM routine_jobs WHERE avatar_user_id = ? AND enabled = 1",
        id,
      ),
      openRequests: this.countOpenKnowledgeRequests(id),
      activeSessions: this.count(
        "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?",
        id,
        now(),
      ),
      gitTokenSet: this.listUserSecretNames(id).includes(INTERNAL_GIT_TOKEN_SECRET_NAME),
      knowledgeRepoSet: Boolean(row.knowledge_repo),
    };
  }

  /** Admin password reset. Returns false if the user doesn't exist. */
  setPassword(userId: string, password: string): boolean {
    if (!this.userRowById(userId)) {
      return false;
    }
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), userId);
    return true;
  }

  /** Force-logout: drop every active session for a user. Returns count removed. */
  revokeAllSessions(userId: string): number {
    const info = this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    return info.changes;
  }

  /** Suspend/un-suspend an account. Suspending also kills the user's sessions so
   *  the lockout is immediate. Returns the updated summary, or null if not found. */
  setSuspended(userId: string, suspended: boolean): AdminUserSummary | null {
    if (!this.userRowById(userId)) {
      return null;
    }
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE users SET suspended = ? WHERE id = ?")
        .run(suspended ? 1 : 0, userId);
      if (suspended) {
        this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      }
    });
    tx();
    return this.toAdminSummary(this.userRowById(userId)!);
  }

  /** Admin override of an avatar's visibility (content moderation). Null if not found. */
  setVisibilityByAdmin(userId: string, visibility: AvatarVisibility): AdminUserSummary | null {
    if (!this.userRowById(userId)) {
      return null;
    }
    this.db.prepare("UPDATE users SET visibility = ? WHERE id = ?").run(visibility, userId);
    return this.toAdminSummary(this.userRowById(userId)!);
  }

  // ---- App-wide settings (signup gating, model override) ----------------

  getSignupMode(): SignupMode {
    const raw = this.getAppSecret(SIGNUP_MODE_KEY);
    return raw === "closed" || raw === "approval" ? raw : "open";
  }

  setSignupMode(mode: SignupMode): void {
    this.setAppSecret(SIGNUP_MODE_KEY, mode);
  }

  /** Admin-selected agent model (UI), or null if unset. Env ANTHROPIC_MODEL wins. */
  getModelOverride(): string | null {
    const raw = this.getAppSecret(MODEL_OVERRIDE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  }

  setModelOverride(model: string): void {
    this.setAppSecret(MODEL_OVERRIDE_KEY, model.trim());
  }

  clearModelOverride(): void {
    this.deleteAppSecret(MODEL_OVERRIDE_KEY);
  }

  /** Close the underlying SQLite handle. Called on graceful shutdown. */
  close(): void {
    this.db.close();
  }

  deleteUser(id: string): boolean {
    if (!this.userRowById(id)) {
      return false;
    }
    const tx = this.db.transaction(() => {
      // Delete conversations owned by or targeting this user (+ their messages).
      const convRows = this.db
        .prepare(
          "SELECT id FROM conversations WHERE owner_user_id = ? OR avatar_user_id = ?",
        )
        .all(id, id) as { id: string }[];
      const delMsgs = this.db.prepare("DELETE FROM messages WHERE conversation_id = ?");
      for (const c of convRows) {
        delMsgs.run(c.id);
      }
      this.db
        .prepare("DELETE FROM conversations WHERE owner_user_id = ? OR avatar_user_id = ?")
        .run(id, id);
      this.db.prepare("DELETE FROM avatar_plugins WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM routine_jobs WHERE avatar_user_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(id);
      // Personal secret vault (AES-encrypted at rest) + logged knowledge gaps —
      // honour the UI's "permanently deleted" promise, leaving nothing behind.
      this.db.prepare("DELETE FROM user_secrets WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM knowledge_requests WHERE avatar_user_id = ?").run(id);
      // Group memberships (the group itself survives; created_by may dangle).
      this.db.prepare("DELETE FROM group_members WHERE user_id = ?").run(id);
      // Registered work repos + notifications in either direction — otherwise
      // these orphan rows outlive the "permanently deleted" account.
      this.db.prepare("DELETE FROM git_repositories WHERE user_id = ?").run(id);
      this.db
        .prepare("DELETE FROM avatar_notifications WHERE owner_user_id = ? OR avatar_user_id = ?")
        .run(id, id);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  // ---- Groups -----------------------------------------------------------
  // A group is created by a SYSTEM admin. Members of a group auto-trust each
  // other (via `shareAnyGroup` → `isTrustedFor`) and share one knowledge repo
  // that only group admins (role='admin') may edit. Group admins manage their
  // own group's membership; the system admin manages all groups.

  private toGroup(row: GroupRow): Group {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      knowledgeRepo: row.knowledge_repo ?? null,
      knowledgeBranch: row.knowledge_branch ?? null,
      knowledgeSelected: parseNameList(row.knowledge_selected),
      createdBy: row.created_by ?? null,
      createdAt: row.created_at,
    };
  }

  private groupRowById(id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  }

  private normalizeRole(role: string | null | undefined): GroupRole {
    return role === "admin" ? "admin" : "member";
  }

  /** Create a group (system-admin action). `createdBy` is the acting admin. */
  createGroup(input: { name: string; description?: string; createdBy?: string | null }): Group {
    const name = input.name.trim();
    if (!name) {
      throw new Error("INVALID_GROUP_NAME");
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, (input.description ?? "").trim(), input.createdBy ?? null, now());
    return this.toGroup(this.groupRowById(id)!);
  }

  getGroup(id: string): Group | null {
    const row = this.groupRowById(id);
    return row ? this.toGroup(row) : null;
  }

  /** All groups with member/admin counts, for the admin dashboard. */
  listGroups(): AdminGroupSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM groups ORDER BY name COLLATE NOCASE ASC")
      .all() as GroupRow[];
    return rows.map((row) => ({
      ...this.toGroup(row),
      memberCount: this.count("SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?", row.id),
      adminCount: this.count(
        "SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND role = 'admin'",
        row.id,
      ),
    }));
  }

  updateGroup(id: string, patch: { name?: string; description?: string }): Group | null {
    const row = this.groupRowById(id);
    if (!row) {
      return null;
    }
    const name = patch.name !== undefined ? patch.name.trim() || row.name : row.name;
    const description =
      patch.description !== undefined ? patch.description.trim() : (row.description ?? "");
    this.db.prepare("UPDATE groups SET name = ?, description = ? WHERE id = ?").run(name, description, id);
    return this.toGroup(this.groupRowById(id)!);
  }

  /** Delete a group and all its memberships. Returns false if it didn't exist. */
  deleteGroup(id: string): boolean {
    if (!this.groupRowById(id)) {
      return false;
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
      this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  // ---- Group membership -------------------------------------------------

  private toGroupMember(row: {
    id: string;
    username: string;
    display_name: string;
    avatar_ext: string | null;
    visibility: string | null;
    published: number;
    role: string;
    created_at: string | null;
  }): GroupMember {
    return {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      hasImage: Boolean(row.avatar_ext),
      role: this.normalizeRole(row.role),
      visibility: this.rowVisibility(row),
      joinedAt: row.created_at,
    };
  }

  /**
   * Add a user to a group (or update their role if already a member). Returns
   * the member, or null if the group/user doesn't exist.
   */
  addGroupMember(groupId: string, userId: string, role: GroupRole = "member"): GroupMember | null {
    if (!this.groupRowById(groupId) || !this.userRowById(userId)) {
      return null;
    }
    this.db
      .prepare(
        "INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role",
      )
      .run(groupId, userId, this.normalizeRole(role), now());
    return this.getGroupMember(groupId, userId);
  }

  /** Add a member by username. Returns null if the user/group doesn't exist. */
  addGroupMemberByUsername(
    groupId: string,
    username: string,
    role: GroupRole = "member",
  ): GroupMember | null {
    const target = this.userRowByUsername(username.trim());
    if (!target) {
      return null;
    }
    return this.addGroupMember(groupId, target.id, role);
  }

  /** Change a member's role within a group. Null if they aren't a member. */
  setGroupMemberRole(groupId: string, userId: string, role: GroupRole): GroupMember | null {
    if (!this.getGroupMember(groupId, userId)) {
      return null;
    }
    this.db
      .prepare("UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?")
      .run(this.normalizeRole(role), groupId, userId);
    return this.getGroupMember(groupId, userId);
  }

  /** Remove a member from a group. Returns true if a row was removed. */
  removeGroupMember(groupId: string, userId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
      .run(groupId, userId);
    return res.changes > 0;
  }

  getGroupMember(groupId: string, userId: string): GroupMember | null {
    const row = this.db
      .prepare(
        `SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
                u.avatar_ext AS avatar_ext, u.visibility AS visibility, u.published AS published,
                m.role AS role, m.created_at AS created_at
         FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ? AND m.user_id = ?`,
      )
      .get(groupId, userId) as Parameters<Store["toGroupMember"]>[0] | undefined;
    return row ? this.toGroupMember(row) : null;
  }

  /** Members of a group (admins first, then by display name), for the roster UI. */
  listGroupMembers(groupId: string): GroupMember[] {
    const rows = this.db
      .prepare(
        `SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
                u.avatar_ext AS avatar_ext, u.visibility AS visibility, u.published AS published,
                m.role AS role, m.created_at AS created_at
         FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ?
         ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END,
                  u.display_name COLLATE NOCASE ASC`,
      )
      .all(groupId) as Parameters<Store["toGroupMember"]>[0][];
    return rows.map((r) => this.toGroupMember(r));
  }

  /** A user's role within a group, or null if they aren't a member. */
  groupRoleFor(userId: string, groupId: string): GroupRole | null {
    const row = this.db
      .prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
      .get(groupId, userId) as { role: string } | undefined;
    return row ? this.normalizeRole(row.role) : null;
  }

  isGroupAdmin(userId: string, groupId: string): boolean {
    return this.groupRoleFor(userId, groupId) === "admin";
  }

  /** Groups a user belongs to, with role + repo-configured flag (for `User`/roster). */
  listUserGroups(userId: string): UserGroupMembership[] {
    const rows = this.db
      .prepare(
        `SELECT g.id AS id, g.name AS name, m.role AS role, g.knowledge_repo AS knowledge_repo
         FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE ASC`,
      )
      .all(userId) as { id: string; name: string; role: string; knowledge_repo: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: this.normalizeRole(r.role),
      knowledgeRepoConfigured: Boolean(r.knowledge_repo),
    }));
  }

  // ---- Group knowledge repo --------------------------------------------

  /** The group's shared knowledge repo + branch + plugin selection. */
  getGroupKnowledgeRepo(groupId: string): {
    repo: string | null;
    branch: string | null;
    selected: string[] | null;
  } {
    const row = this.groupRowById(groupId);
    return {
      repo: row?.knowledge_repo ?? null,
      branch: row?.knowledge_branch ?? null,
      selected: parseNameList(row?.knowledge_selected ?? null),
    };
  }

  /** Connect/clear the group's shared knowledge repo (clears selection, like the user one). */
  setGroupKnowledgeRepo(groupId: string, repo: string | null, branch: string | null): Group | null {
    if (!this.groupRowById(groupId)) {
      return null;
    }
    this.db
      .prepare(
        "UPDATE groups SET knowledge_repo = ?, knowledge_branch = ?, knowledge_selected = NULL WHERE id = ?",
      )
      .run(repo?.trim() || null, branch?.trim() || null, groupId);
    return this.toGroup(this.groupRowById(groupId)!);
  }

  /** Set which group-repo plugins members' avatars load; `null` = load all. */
  setGroupKnowledgeSelected(groupId: string, selected: string[] | null): Group | null {
    if (!this.groupRowById(groupId)) {
      return null;
    }
    this.db
      .prepare("UPDATE groups SET knowledge_selected = ? WHERE id = ?")
      .run(selected ? JSON.stringify(selected) : null, groupId);
    return this.toGroup(this.groupRowById(groupId)!);
  }

  /**
   * Group knowledge repos to load as plugin roots for a user's avatar chats:
   * every group the user is in that has a repo connected. Members read these
   * skills; group admins edit them. Excludes groups with no repo.
   */
  listGroupKnowledgeReposForUser(userId: string): {
    groupId: string;
    groupName: string;
    repo: string;
    branch: string | null;
    selected: string[] | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT g.id AS id, g.name AS name, g.knowledge_repo AS repo,
                g.knowledge_branch AS branch, g.knowledge_selected AS selected
         FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = ? AND g.knowledge_repo IS NOT NULL
         ORDER BY g.name COLLATE NOCASE ASC`,
      )
      .all(userId) as {
      id: string;
      name: string;
      repo: string;
      branch: string | null;
      selected: string | null;
    }[];
    return rows.map((r) => ({
      groupId: r.id,
      groupName: r.name,
      repo: r.repo,
      branch: r.branch,
      selected: parseNameList(r.selected),
    }));
  }
}
