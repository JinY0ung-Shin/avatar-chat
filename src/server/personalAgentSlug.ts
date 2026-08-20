/**
 * Per-bot MEMORY DIRECTORY naming — a deliberate LEAF module: `store/internal.ts`
 * computes the slug inside migrate() and `store/personalAgents.ts` inside the
 * INSERT, while `personalAgents.ts` re-exports these so route/agent callers keep
 * one import path (the "split behind unchanged exports" rule). Nothing here may
 * import the store or any module that does — that latent cycle (store base →
 * personalAgents.ts → store.ts) is exactly what this file exists to avoid.
 */

/**
 * The parent directory, inside the OWNER's knowledge repo, that holds every
 * bot's memory tree: `agents/<memoryDir>/`. One level, so a bot's memory is
 * visibly separate from the owner's own `wiki/`+`raw/` second brain.
 */
export const PERSONAL_AGENT_MEMORY_PARENT = "agents";

/**
 * Cap on the READABLE part of a memory dir name (the id suffix is appended
 * after it). Long enough to recognize a bot at a glance in the repo tree,
 * short enough that the whole segment stays comfortable in a path.
 */
const MEMORY_DIR_READABLE_CAP = 24;

/**
 * The bot's immutable memory folder NAME (one path segment, ASCII-safe).
 *
 * Deterministic from (displayName, agentId) and stable across renames, because
 * the row stores what this returned AT INSERT and never updates it — the
 * function is re-run only to backfill rows that predate the column, where the
 * current display name is the best (and same) answer the migration can give.
 *
 * The readable half is the lowercased display name reduced to `[a-z0-9._-]`;
 * Korean names reduce to nothing and fall back to "bot", which is why the id
 * suffix — not the name — is what makes the segment unique. Appending it also
 * guarantees the result can never be `.` or `..`.
 */
export function personalAgentMemoryDirName(
  displayName: string,
  agentId: string,
): string {
  const readable =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      // Cap BEFORE trimming: cutting mid-name can leave a trailing separator.
      .slice(0, MEMORY_DIR_READABLE_CAP)
      .replace(/^[-._]+|[-._]+$/g, "") || "bot";
  // First 8 chars of the row's uuid. Two bots of one owner colliding here needs
  // a 32-bit birthday collision inside a 20-bot roster, and the alternative
  // (probing existing rows) would make the name non-deterministic.
  const suffix = agentId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bot";
  return `${readable}-${suffix}`;
}

/**
 * Repo-relative root of one bot's memory (POSIX separator, no trailing slash) —
 * the single place that spells the `agents/<memoryDir>` convention, so the
 * memory-scoping side and the metacognition surfaces cannot drift apart.
 */
export function personalAgentMemoryRoot(memoryDir: string): string {
  return `${PERSONAL_AGENT_MEMORY_PARENT}/${memoryDir}`;
}
