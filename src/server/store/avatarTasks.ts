import crypto from "node:crypto";
import { hashToken } from "../auth.js";
import type { AvatarApiKey, AvatarTask, AvatarTaskStatus } from "../../shared/avatarTasks.js";
import { type StoreBase, type Constructor, now } from "./internal.js";

const KEY_COLUMNS = "id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt";
const TASK_COLUMNS = `id, owner_user_id AS ownerUserId, api_key_id AS apiKeyId,
  conversation_id AS conversationId, message, status, run_id AS runId, result_json AS result,
  error, created_at AS createdAt, updated_at AS updatedAt, user_message_persisted AS userMessagePersisted`;
function decode(row: AvatarTask | undefined): AvatarTask | null {
  return row ? { ...row, result: row.result ? JSON.parse(String(row.result)) : null,
    userMessagePersisted: Boolean(row.userMessagePersisted) } : null;
}

export function withAvatarTasks<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class extends Base {
    listAvatarApiKeys(ownerId: string): AvatarApiKey[] {
      return this.db.prepare(`SELECT ${KEY_COLUMNS} FROM avatar_api_keys WHERE owner_user_id = ? ORDER BY created_at DESC`).all(ownerId) as AvatarApiKey[];
    }

    createAvatarApiKey(ownerId: string, name: string): { key: AvatarApiKey; token: string } {
      if (this.listAvatarApiKeys(ownerId).length >= 10) throw new Error("API 키는 최대 10개까지 발급할 수 있습니다.");
      const token = `noah_${crypto.randomBytes(32).toString("base64url")}`;
      const key: AvatarApiKey = { id: crypto.randomUUID(), name, prefix: token.slice(0, 13), createdAt: now(), lastUsedAt: null };
      this.db.prepare("INSERT INTO avatar_api_keys (id, owner_user_id, name, prefix, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(key.id, ownerId, name, key.prefix, hashToken(token), key.createdAt);
      return { key, token };
    }

    revokeAvatarApiKey(ownerId: string, id: string): boolean {
      return this.db.prepare("DELETE FROM avatar_api_keys WHERE owner_user_id = ? AND id = ?").run(ownerId, id).changes > 0;
    }

    authenticateAvatarApiKey(token: string): { id: string; ownerUserId: string } | null {
      if (!/^noah_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const key = this.db.prepare(`SELECT k.id, k.owner_user_id AS ownerUserId FROM avatar_api_keys k
        JOIN users u ON u.id = k.owner_user_id WHERE k.token_hash = ? AND u.suspended = 0`).get(hashToken(token)) as { id: string; ownerUserId: string } | undefined;
      if (!key) return null;
      this.db.prepare("UPDATE avatar_api_keys SET last_used_at = ? WHERE id = ?").run(now(), key.id);
      return key;
    }

    avatarTaskKeyActive(ownerId: string, keyId: string): boolean {
      return this.count(`SELECT COUNT(*) AS c FROM avatar_api_keys k JOIN users u ON u.id = k.owner_user_id
        WHERE k.id = ? AND k.owner_user_id = ? AND u.suspended = 0`, keyId, ownerId) > 0;
    }

    getAvatarTask(ownerId: string, id: string): AvatarTask | null {
      return decode(this.db.prepare(`SELECT ${TASK_COLUMNS} FROM avatar_tasks WHERE owner_user_id = ? AND id = ?`).get(ownerId, id) as AvatarTask | undefined);
    }

    listAvatarTasks(ownerId: string): AvatarTask[] {
      return (this.db.prepare(`SELECT ${TASK_COLUMNS} FROM avatar_tasks WHERE owner_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(ownerId) as AvatarTask[]).map(row => decode(row)!);
    }

    acceptAvatarTask(ownerId: string, keyId: string, message: string, conversationId: string | null, idempotencyKey: string | null): { task: AvatarTask; replayed: boolean } {
      return this.db.transaction(() => {
        const fingerprint = hashToken(JSON.stringify({ message, conversationId }));
        if (idempotencyKey) {
          const previous = this.db.prepare("SELECT id, fingerprint FROM avatar_tasks WHERE owner_user_id = ? AND idempotency_key = ?").get(ownerId, idempotencyKey) as { id: string; fingerprint: string } | undefined;
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new Error("idempotency_conflict");
            return { task: this.getAvatarTask(ownerId, previous.id)!, replayed: true };
          }
        }
        if (this.count("SELECT COUNT(*) AS c FROM avatar_tasks WHERE owner_user_id = ? AND status IN ('queued', 'running')", ownerId) >= 20 ||
          this.count("SELECT COUNT(*) AS c FROM avatar_tasks WHERE owner_user_id = ? AND created_at >= ?", ownerId, new Date(Date.now() - 60_000).toISOString()) >= 60) throw new Error("rate_limit");
        const id = crypto.randomUUID();
        const threadId = conversationId ?? crypto.randomUUID();
        const timestamp = now();
        this.touchConversation(ownerId, threadId, ownerId, message.slice(0, 80));
        this.db.prepare(`INSERT INTO avatar_tasks (id, owner_user_id, api_key_id, conversation_id, message, status, idempotency_key, fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, ownerId, keyId, threadId, message, idempotencyKey, fingerprint, timestamp, timestamp);
        return { task: this.getAvatarTask(ownerId, id)!, replayed: false };
      })();
    }

    queuedAvatarTasks(): AvatarTask[] {
      return (this.db.prepare(`SELECT ${TASK_COLUMNS} FROM avatar_tasks WHERE status = 'queued' ORDER BY created_at, rowid`).all() as AvatarTask[]).map(row => decode(row)!);
    }

    claimAvatarTask(ownerId: string, id: string): boolean {
      return this.db.prepare("UPDATE avatar_tasks SET status = 'running', updated_at = ? WHERE owner_user_id = ? AND id = ? AND status = 'queued'").run(now(), ownerId, id).changes > 0;
    }

    updateAvatarTask(ownerId: string, id: string, status: AvatarTaskStatus, options: { runId?: string | null; result?: unknown; error?: string | null; userMessagePersisted?: boolean } = {}): void {
      this.db.prepare(`UPDATE avatar_tasks SET status = ?, updated_at = ?, run_id = COALESCE(?, run_id),
        result_json = COALESCE(?, result_json), error = ?, user_message_persisted = COALESCE(?, user_message_persisted)
        WHERE owner_user_id = ? AND id = ? AND status IN ('queued', 'running')`).run(status, now(), options.runId ?? null,
        options.result === undefined ? null : JSON.stringify(options.result), options.error ?? null,
        options.userMessagePersisted === undefined ? null : Number(options.userMessagePersisted), ownerId, id);
    }

    recoverAvatarTasks(): void {
      this.db.prepare("UPDATE avatar_tasks SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'")
        .run("서버가 재시작되어 실행이 중단되었습니다. 대화의 부분 결과를 확인한 뒤 다시 요청해 주세요.", now());
    }
  };
}
