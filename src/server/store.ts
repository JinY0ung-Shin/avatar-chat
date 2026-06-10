import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  hashPassword,
  hashToken,
  verifyPassword,
} from "./auth.js";
import type {
  AdminUserSummary,
  AgentResponse,
  AppConfig,
  AuditEvent,
  AvatarDetail,
  AvatarSummary,
  ConversationSummary,
  KnowledgeEntry,
  KnowledgeRequest,
  Plugin,
  RoutineJob,
  StoredMessage,
  User,
} from "./types.js";

const SESSION_DAYS = 14;

function now(): string {
  return new Date().toISOString();
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
  bio: string;
  persona: string;
  avatar_ext: string | null;
  published: number;
  created_at: string;
  last_seen_at: string | null;
}

interface KnowledgeRequestRow {
  id: string;
  avatar_user_id: string;
  asker_user_id: string | null;
  asker_name: string | null;
  question: string;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

interface KnowledgeEntryRow {
  id: string;
  avatar_user_id: string;
  topic: string | null;
  content: string;
  source_request_id: string | null;
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

export class Store {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seedRoles();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        bio TEXT DEFAULT '',
        persona TEXT DEFAULT '',
        avatar_ext TEXT,
        published INTEGER DEFAULT 0,
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
        answer TEXT,
        created_at TEXT,
        answered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        avatar_user_id TEXT NOT NULL,
        topic TEXT,
        content TEXT NOT NULL,
        source_request_id TEXT,
        created_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_avatar_plugins_user ON avatar_plugins(user_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_requests_avatar ON knowledge_requests(avatar_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_knowledge_entries_avatar ON knowledge_entries(avatar_user_id);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_avatar ON routine_jobs(avatar_user_id);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_due ON routine_jobs(enabled, next_run_at);
    `);
  }

  private seedRoles(): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO roles (name) VALUES (?)");
    insert.run("admin");
    insert.run("member");
  }

  // ---- Users ------------------------------------------------------------

  private toUser(row: UserRow): User {
    const roles = this.rolesFor(row.id);
    const pluginCount = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ?")
        .get(row.id) as { c: number }
    ).c;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio ?? "",
      persona: row.persona ?? "",
      hasImage: Boolean(row.avatar_ext),
      published: row.published === 1,
      roles,
      pluginCount,
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
      INSERT INTO users (id, username, password_hash, display_name, bio, persona, avatar_ext, published, created_at, last_seen_at)
      VALUES (@id, @username, @password_hash, @display_name, '', '', NULL, 0, @created_at, @created_at)
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

  verifyLogin(username: string, password: string): User | null {
    const row = this.userRowByUsername(username.trim());
    if (!row) {
      return null;
    }
    if (!verifyPassword(password, row.password_hash)) {
      return null;
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
    patch: { displayName?: string; bio?: string; persona?: string; published?: boolean },
  ): User {
    const row = this.userRowById(userId);
    if (!row) {
      throw new Error("USER_NOT_FOUND");
    }
    const displayName =
      patch.displayName !== undefined ? patch.displayName.trim() || row.display_name : row.display_name;
    const bio = patch.bio !== undefined ? patch.bio : row.bio;
    const persona = patch.persona !== undefined ? patch.persona : row.persona;
    const published =
      patch.published !== undefined ? (patch.published ? 1 : 0) : row.published;
    this.db
      .prepare(
        "UPDATE users SET display_name = ?, bio = ?, persona = ?, published = ? WHERE id = ?",
      )
      .run(displayName, bio, persona, published, userId);
    return this.toUser(this.userRowById(userId)!);
  }

  setAvatarExt(userId: string, ext: string | null): void {
    this.db.prepare("UPDATE users SET avatar_ext = ? WHERE id = ?").run(ext, userId);
  }

  getAvatarExt(userId: string): string | null {
    const row = this.userRowById(userId);
    return row?.avatar_ext ?? null;
  }

  // ---- Plugins ----------------------------------------------------------

  private toPlugin(row: {
    id: string;
    repo: string;
    ref: string | null;
    label: string | null;
    enabled: number;
    created_at: string;
  }): Plugin {
    return {
      id: row.id,
      repo: row.repo,
      ref: row.ref,
      label: row.label,
      enabled: row.enabled === 1,
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

  setPluginEnabled(userId: string, id: string, enabled: boolean): Plugin | null {
    const result = this.db
      .prepare("UPDATE avatar_plugins SET enabled = ? WHERE id = ? AND user_id = ?")
      .run(enabled ? 1 : 0, id, userId);
    if (result.changes === 0) {
      return null;
    }
    return this.toPlugin(
      this.db.prepare("SELECT * FROM avatar_plugins WHERE id = ?").get(id) as Parameters<
        Store["toPlugin"]
      >[0],
    );
  }

  // ---- Knowledge: requests (gaps) & entries (taught facts) -------------

  private toKnowledgeRequest(row: KnowledgeRequestRow): KnowledgeRequest {
    return {
      id: row.id,
      avatarUserId: row.avatar_user_id,
      askerUserId: row.asker_user_id,
      askerName: row.asker_name,
      question: row.question,
      status: row.status as KnowledgeRequest["status"],
      answer: row.answer,
      createdAt: row.created_at,
      answeredAt: row.answered_at,
    };
  }

  private toKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
    return {
      id: row.id,
      avatarUserId: row.avatar_user_id,
      topic: row.topic,
      content: row.content,
      sourceRequestId: row.source_request_id,
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
   * Resolve a request with the owner's answer and turn it into a searchable
   * knowledge entry, atomically. Returns null if the request isn't the avatar's.
   */
  answerKnowledgeRequest(avatarUserId: string, id: string, answer: string): KnowledgeRequest | null {
    const tx = this.db.transaction((): KnowledgeRequest | null => {
      const row = this.db
        .prepare("SELECT * FROM knowledge_requests WHERE id = ? AND avatar_user_id = ?")
        .get(id, avatarUserId) as KnowledgeRequestRow | undefined;
      if (!row) {
        return null;
      }
      const answeredAt = now();
      this.db
        .prepare(
          "UPDATE knowledge_requests SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?",
        )
        .run(answer.trim(), answeredAt, id);
      this.addKnowledgeEntry(avatarUserId, {
        topic: row.question,
        content: answer.trim(),
        sourceRequestId: id,
      });
      return this.toKnowledgeRequest(
        this.db
          .prepare("SELECT * FROM knowledge_requests WHERE id = ?")
          .get(id) as KnowledgeRequestRow,
      );
    });
    return tx();
  }

  dismissKnowledgeRequest(avatarUserId: string, id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE knowledge_requests SET status = 'dismissed' WHERE id = ? AND avatar_user_id = ? AND status = 'open'",
      )
      .run(id, avatarUserId);
    return result.changes > 0;
  }

  addKnowledgeEntry(
    avatarUserId: string,
    input: { topic?: string | null; content: string; sourceRequestId?: string | null },
  ): KnowledgeEntry {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO knowledge_entries (id, avatar_user_id, topic, content, source_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, avatarUserId, input.topic?.trim() || null, input.content.trim(), input.sourceRequestId ?? null, now());
    return this.toKnowledgeEntry(
      this.db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as KnowledgeEntryRow,
    );
  }

  listKnowledgeEntries(avatarUserId: string): KnowledgeEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM knowledge_entries WHERE avatar_user_id = ? ORDER BY created_at DESC")
      .all(avatarUserId) as KnowledgeEntryRow[];
    return rows.map((r) => this.toKnowledgeEntry(r));
  }

  deleteKnowledgeEntry(avatarUserId: string, id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM knowledge_entries WHERE id = ? AND avatar_user_id = ?")
      .run(id, avatarUserId);
    return result.changes > 0;
  }

  /**
   * Find taught facts relevant to a query (case-insensitive substring over
   * topic + content). An empty query returns the most recent entries.
   */
  searchKnowledge(avatarUserId: string, query: string, limit = 10): KnowledgeEntry[] {
    const trimmed = query.trim();
    if (!trimmed) {
      const rows = this.db
        .prepare(
          "SELECT * FROM knowledge_entries WHERE avatar_user_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(avatarUserId, limit) as KnowledgeEntryRow[];
      return rows.map((r) => this.toKnowledgeEntry(r));
    }
    const like = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entries
         WHERE avatar_user_id = ?
           AND (content LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(avatarUserId, like, like, limit) as KnowledgeEntryRow[];
    return rows.map((r) => this.toKnowledgeEntry(r));
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
    const rows = this.db
      .prepare(
        "SELECT * FROM routine_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
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

  listPublishedAvatars(viewerId: string): AvatarSummary[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM users WHERE published = 1 OR id = ? ORDER BY display_name COLLATE NOCASE ASC",
      )
      .all(viewerId) as UserRow[];
    return rows.map((row) => this.toAvatarSummary(row));
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
      bio: row.bio ?? "",
      hasImage: Boolean(row.avatar_ext),
      pluginCount,
      published: row.published === 1,
      updatedAt: this.avatarUpdatedAt(row.id),
    };
  }

  getAvatar(viewerId: string, id: string): AvatarDetail | null {
    const row = this.userRowById(id);
    if (!row) {
      return null;
    }
    const isOwn = id === viewerId;
    if (row.published !== 1 && !isOwn) {
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
      isOwn,
      plugins,
    };
  }

  /** Resolve a chat target avatar: must be published or the viewer's own. */
  resolveChatAvatar(
    viewerId: string,
    id: string,
  ): { id: string; displayName: string; persona: string } | null {
    const row = this.userRowById(id);
    if (!row) {
      return null;
    }
    if (row.published !== 1 && id !== viewerId) {
      return null;
    }
    return { id: row.id, displayName: row.display_name, persona: row.persona ?? "" };
  }

  // ---- Conversations & messages ----------------------------------------

  listConversations(ownerId: string, avatarId?: string): ConversationSummary[] {
    const rows = (
      avatarId
        ? this.db
            .prepare(
              `SELECT c.id, c.avatar_user_id, c.title, c.updated_at, u.display_name AS avatar_display_name
               FROM conversations c LEFT JOIN users u ON u.id = c.avatar_user_id
               WHERE c.owner_user_id = ? AND c.avatar_user_id = ?
               ORDER BY c.updated_at DESC`,
            )
            .all(ownerId, avatarId)
        : this.db
            .prepare(
              `SELECT c.id, c.avatar_user_id, c.title, c.updated_at, u.display_name AS avatar_display_name
               FROM conversations c LEFT JOIN users u ON u.id = c.avatar_user_id
               WHERE c.owner_user_id = ?
               ORDER BY c.updated_at DESC`,
            )
            .all(ownerId)
    ) as {
      id: string;
      avatar_user_id: string;
      title: string;
      updated_at: string;
      avatar_display_name: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      avatarUserId: r.avatar_user_id,
      avatarDisplayName: r.avatar_display_name ?? "(삭제된 아바타)",
      title: r.title,
      updatedAt: r.updated_at,
    }));
  }

  private ownsConversation(ownerId: string, conversationId: string): boolean {
    const row = this.db
      .prepare("SELECT owner_user_id FROM conversations WHERE id = ?")
      .get(conversationId) as { owner_user_id: string } | undefined;
    return Boolean(row && row.owner_user_id === ownerId);
  }

  touchConversation(
    ownerId: string,
    conversationId: string,
    avatarUserId: string,
    firstUserText: string,
  ): void {
    const timestamp = now();
    const existing = this.db
      .prepare("SELECT id FROM conversations WHERE id = ? AND owner_user_id = ?")
      .get(conversationId, ownerId);
    if (existing) {
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
      response: r.response_json ? (JSON.parse(r.response_json) as AgentResponse) : null,
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
    return this.listConversations(ownerId).find((c) => c.id === id) ?? null;
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

  listUsers(): AdminUserSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      roles: this.rolesFor(row.id),
      published: row.published === 1,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
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
      this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    });
    tx();
    return true;
  }
}
