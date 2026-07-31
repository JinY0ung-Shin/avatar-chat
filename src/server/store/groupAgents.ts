import type {
  GroupAgent,
  GroupAgentCaptureScope,
  GroupRole,
} from "../types.js";
import { GROUP_AGENT_AVATAR_PREFIX } from "../groupAgents.js";
import {
  type Constructor,
  type GroupAgentRow,
  type StoreBase,
  normalizeHashtags,
  now,
  parseHashtags,
} from "./internal.js";

/** Stored capture_scope → typed value; anything unknown reads as 'members'. */
function normalizeCaptureScope(raw: string | null): GroupAgentCaptureScope {
  return raw === "admins" ? "admins" : "members";
}

export function withGroupAgents<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class GroupAgents extends Base {
    // ---- Group shared agents ----------------------------------------------
    // At most ONE per group (group_id PK), managed by group admins via the
    // groups router. Not a users row; conversations store its namespaced
    // avatar id ("group:<groupId>"). deleteGroup cascades the row + its
    // conversations (store/groups.ts).

    private groupAgentRowById(groupId: string): GroupAgentRow | undefined {
      return this.db
        .prepare("SELECT * FROM group_agents WHERE group_id = ?")
        .get(groupId) as GroupAgentRow | undefined;
    }

    private toGroupAgent(row: GroupAgentRow): GroupAgent {
      return {
        groupId: row.group_id,
        displayName: row.display_name,
        alias: row.alias ?? "",
        bio: row.bio ?? "",
        intro: row.intro ?? "",
        persona: row.persona ?? "",
        hashtags: parseHashtags(row.hashtags),
        hasImage: Boolean(row.avatar_ext),
        enabled: row.enabled === 1,
        captureScope: normalizeCaptureScope(row.capture_scope),
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? null,
      };
    }

    getGroupAgent(groupId: string): GroupAgent | null {
      const row = this.groupAgentRowById(groupId);
      return row ? this.toGroupAgent(row) : null;
    }

    /**
     * Create or update the group's shared agent (group-admin action; the route
     * gates). Insert seeds created_*; update never touches them. Returns null
     * when the group itself doesn't exist (fail closed on ghost groups).
     */
    upsertGroupAgent(
      groupId: string,
      input: {
        displayName: string;
        alias?: string;
        bio?: string;
        intro?: string;
        persona?: string;
        hashtags?: string[];
        captureScope?: GroupAgentCaptureScope;
        enabled?: boolean;
        createdBy?: string | null;
      },
    ): GroupAgent | null {
      if (!this.groupRowById(groupId)) {
        return null;
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("INVALID_GROUP_AGENT_NAME");
      }
      const timestamp = now();
      const existing = this.groupAgentRowById(groupId);
      const hashtags =
        input.hashtags !== undefined
          ? JSON.stringify(normalizeHashtags(input.hashtags))
          : (existing?.hashtags ?? null);
      const merged = {
        group_id: groupId,
        display_name: displayName,
        alias: (input.alias ?? existing?.alias ?? "").trim(),
        bio: (input.bio ?? existing?.bio ?? "").trim(),
        intro: (input.intro ?? existing?.intro ?? "").trim(),
        persona: input.persona ?? existing?.persona ?? "",
        hashtags,
        enabled:
          (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
        capture_scope: normalizeCaptureScope(
          input.captureScope ?? existing?.capture_scope ?? null,
        ),
        created_by: existing
          ? existing.created_by
          : (input.createdBy ?? null),
        created_at: existing ? existing.created_at : timestamp,
        updated_at: timestamp,
      };
      this.db
        .prepare(
          `INSERT INTO group_agents (group_id, display_name, alias, bio, intro, persona, hashtags, enabled, capture_scope, created_by, created_at, updated_at)
           VALUES (@group_id, @display_name, @alias, @bio, @intro, @persona, @hashtags, @enabled, @capture_scope, @created_by, @created_at, @updated_at)
           ON CONFLICT(group_id) DO UPDATE SET
             display_name = @display_name, alias = @alias, bio = @bio,
             intro = @intro, persona = @persona, hashtags = @hashtags,
             enabled = @enabled, capture_scope = @capture_scope,
             updated_at = @updated_at`,
        )
        .run(merged);
      return this.toGroupAgent(this.groupAgentRowById(groupId)!);
    }

    /** Disable blocks the next turn but preserves threads; there is no delete
     *  short of deleting the group (history-bearing, external precedent). */
    setGroupAgentEnabled(groupId: string, enabled: boolean): GroupAgent | null {
      const row = this.groupAgentRowById(groupId);
      if (!row) {
        return null;
      }
      this.db
        .prepare(
          "UPDATE group_agents SET enabled = ?, updated_at = ? WHERE group_id = ?",
        )
        .run(enabled ? 1 : 0, now(), groupId);
      return this.toGroupAgent(this.groupAgentRowById(groupId)!);
    }

    /** Record the profile-image extension (bytes live on disk, users.avatar_ext pattern). */
    setGroupAgentImageExt(groupId: string, ext: string | null): void {
      this.db
        .prepare("UPDATE group_agents SET avatar_ext = ? WHERE group_id = ?")
        .run(ext, groupId);
    }

    /** Image-ext lookup by PUBLIC avatar id ("group:<gid>") for the image route chain. */
    getGroupAgentImageExtByAvatarId(avatarId: string): string | null {
      if (!avatarId.startsWith(GROUP_AGENT_AVATAR_PREFIX)) return null;
      const groupId = avatarId.slice(GROUP_AGENT_AVATAR_PREFIX.length);
      if (!groupId) return null;
      const row = this.db
        .prepare("SELECT avatar_ext FROM group_agents WHERE group_id = ?")
        .get(groupId) as { avatar_ext: string | null } | undefined;
      return row?.avatar_ext ?? null;
    }

    /**
     * ENABLED group agents of the viewer's groups, for discovery concatenation
     * (GET /api/avatars). Settings reads per-group via getGroupAgent instead
     * (managers must see a disabled agent to re-enable it).
     */
    listGroupAgentsForUser(
      userId: string,
    ): { agent: GroupAgent; groupName: string; viewerRole: GroupRole }[] {
      const rows = this.db
        .prepare(
          `SELECT ga.*, g.name AS group_name, m.role AS viewer_role
           FROM group_agents ga
           JOIN groups g ON g.id = ga.group_id
           JOIN group_members m ON m.group_id = ga.group_id
           WHERE m.user_id = ? AND ga.enabled = 1
           ORDER BY ga.display_name COLLATE NOCASE ASC`,
        )
        .all(userId) as (GroupAgentRow & {
        group_name: string;
        viewer_role: string;
      })[];
      return rows.map((row) => ({
        agent: this.toGroupAgent(row),
        groupName: row.group_name,
        viewerRole: this.normalizeRole(row.viewer_role),
      }));
    }
  };
}
