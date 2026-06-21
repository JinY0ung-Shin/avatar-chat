import type { AvatarDetail, AvatarSummary } from "../types.js";
import {
  type Constructor,
  type StoreBase,
  type UserRow,
  DEFAULT_SEARCH_LIMIT,
  parseHashtags,
} from "./internal.js";

export function withAvatars<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Avatars extends Base {
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
      const pluginCount = this.count(
        "SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ? AND enabled = 1",
        row.id,
      );
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
      const limit = Math.min(
        Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1),
        50,
      );
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
          const bodyHay = [
            row.display_name,
            row.alias,
            row.username,
            row.bio,
            row.intro,
          ]
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
      const matches = tokens.length
        ? scored.filter((s) => s.score > 0)
        : scored;
      matches.sort(
        (a, b) =>
          b.score - a.score ||
          a.row.display_name.localeCompare(b.row.display_name),
      );
      return matches
        .slice(0, limit)
        .map((s) => ({
          ...this.toAvatarSummary(s.row),
          sharesGroup: teammates.has(s.row.id),
        }));
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
    ): {
      id: string;
      displayName: string;
      alias: string;
      persona: string;
    } | null {
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
      return {
        id: row.id,
        displayName: row.display_name,
        alias: row.alias ?? "",
        persona: row.persona ?? "",
      };
    }

    // ---- Trust & visibility ----------------------------------------------
    // Trust (elevated tool access) is derived PURELY from group co-membership:
    // members of the same group are mutually + symmetrically elevated. A trusted
    // viewer chats with someone else's avatar at the OWNER's tool-permission level
    // (write/Bash run, not just read-only) — but it does NOT grant the owner-only
    // knowledge inbox.

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
  };
}
