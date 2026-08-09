import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sanitizeName } from "./marketplace.js";
import {
  SKILL_DIR,
  ensureClone,
  ensureMarketplaceManifest,
  commitAndPush,
  resolveInRepo,
  realpathContained,
  type KnowledgeRepoContext,
} from "./knowledgeRepo.js";
import { skillMdMeta } from "./agent/skillDiscovery.js";
import type { SharedSkillManifest } from "./types.js";

// Skill transfer between knowledge repos (#skill-share): the "learn" half of
// skill sharing. The share rows (store/avatars.ts) are metadata only; THIS
// module materializes a learned skill by copying `skills/<slug>/` from the
// sharer's clone into the learner's repo, registering it in the learner's
// marketplace manifest (like scaffoldSkill), and committing with the learner's
// identity. All path handling goes through knowledgeRepo's resolveInRepo +
// realpathContained so the git-safety rules stay single-sourced.
//
// The copied tree is TEACHING MATERIAL authored by a teammate: symlinks are
// never followed (skipped + counted), sizes are capped, and everything lands
// inside the learner's own repo where their avatar can inspect and adapt it.

/** Per-file cap — mirrors knowledgeRepo's MAX_FILE_BYTES for repo writes. */
const MAX_SKILL_FILE_BYTES = 512 * 1024;
/** Whole-skill cap: a skill directory bigger than this refuses to transfer. */
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024;
/** File-count + depth bounds so a pathological tree can't wedge the copy. */
const MAX_SKILL_FILES = 200;
const MAX_SKILL_DEPTH = 8;
/**
 * Cap on the owner's custom share INTRODUCTION (소개 문구). The frontmatter
 * description it falls back to is unbounded by nature (one YAML line), but this
 * one is free-form user text that rides listings and MCP tool results, so both
 * entry points (the route and share_skill) REJECT past this rather than clip —
 * silently truncating someone's intro is worse than telling them to shorten it.
 */
export const MAX_SKILL_INTRO_CHARS = 500;

/** One shareable skill directory in a repo working tree. */
export interface RepoSkillEntry {
  /** The `skills/<slug>` directory name — the share identity. */
  slug: string;
  /** Frontmatter name (falls back to the slug). */
  name: string;
  description: string;
}

/**
 * Normalize a human-entered skill name into a `skills/<slug>` directory name.
 * Byte-for-byte the slug rule scaffoldSkill uses, so learned and scaffolded
 * skills live under the same naming scheme. Returns "" for an unusable name
 * (callers decide the error).
 */
export function normalizeSkillSlug(name: string): string {
  return sanitizeName(name.trim()).toLowerCase().replace(/^-+|-+$/g, "");
}

/**
 * Enumerate the skills of one repo working tree by scanning
 * `skills/<dir>/SKILL.md` (the shareable set — bundled/plugin skills are
 * deliberately NOT included; everyone already has the bundles, and plugins are
 * shared by installing the same plugin). Tolerant: no skills dir → [].
 */
export function listRepoSkills(repoRoot: string): RepoSkillEntry[] {
  const dir = resolveInRepo(repoRoot, SKILL_DIR);
  if (!dir) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RepoSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const mdPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(mdPath)) {
      continue;
    }
    const meta = skillMdMeta(mdPath);
    out.push({
      slug: entry.name,
      name: meta.name || entry.name,
      description: meta.description ?? "",
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Read one skill's metadata from a repo, or null when it doesn't exist. */
export function readRepoSkill(repoRoot: string, slug: string): RepoSkillEntry | null {
  return listRepoSkills(repoRoot).find((s) => s.slug === slug) ?? null;
}

/**
 * Provenance marker written into a LEARNED skill (`skills/<slug>/` root, named
 * below): which share it came from and the SOURCE directory's content hash at
 * learn time. Comparing that hash with the share row's CURRENT hash is what
 * detects "the sharer updated this since you learned it", and the (owner,
 * skillName) pair is what authorizes an in-place update overwrite.
 */
export interface SkillOrigin {
  ownerUserId: string;
  ownerUsername: string;
  skillName: string;
  contentHash: string | null;
  /**
   * Hash of the LEARNER's copy right after the learn (post identity-rewrite).
   * Comparing it with the copy's current hash detects local customization —
   * the guard that keeps an update from silently flattening the learner's own
   * edits. Null on markers written before this field existed (treated as
   * "possibly modified": the update path then requires explicit confirmation).
   */
  localHash: string | null;
  learnedAt: string;
}

export const SKILL_ORIGIN_FILE = ".noah-skill-origin.json";

/** One file seen by the shared read-only walk below. */
interface SkillWalkFile {
  abs: string;
  /** Path relative to the skill directory, always POSIX-separated. */
  rel: string;
  bytes: number;
}

/**
 * Read-only traversal of ONE skill directory under copySkillDir's rules —
 * symlinks and specials skipped, depth-capped, entries taken in per-directory
 * name order (that order is what makes hashSkillDir's digest stable, so don't
 * change it). Never reads file CONTENT: callers get sizes and decide.
 *
 * Stops (rather than throwing) when it can't see the whole tree — more than
 * `limit` files, deeper than MAX_SKILL_DEPTH, or an unreadable directory — and
 * reports that as `truncated`. hashSkillDir turns it into a null hash (an
 * untransferable skill has no meaningful fingerprint); listSkillFiles keeps the
 * partial listing and flags it, so a preview says honestly what it saw.
 *
 * `skipName` drops entries with that basename at ANY depth (the origin marker,
 * for the hash).
 */
function walkSkillDir(
  dir: string,
  limit: number,
  skipName?: string,
): { files: SkillWalkFile[]; truncated: boolean } {
  const files: SkillWalkFile[] = [];
  const walk = (current: string, depth: number): boolean => {
    if (depth > MAX_SKILL_DEPTH) {
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (!walk(abs, depth + 1)) {
          return false;
        }
        continue;
      }
      if (!stat.isFile() || entry.name === skipName) {
        continue;
      }
      if (files.length >= limit) {
        return false;
      }
      files.push({
        abs,
        rel: path.relative(dir, abs).split(path.sep).join("/"),
        bytes: stat.size,
      });
    }
    return true;
  };
  return { files, truncated: !walk(dir, 0) };
}

/**
 * Deterministic content hash of one skill directory: sha256 over the sorted
 * repo-relative paths + file bytes, mirroring copySkillDir's traversal
 * (symlinks and specials skipped). Excluding the origin marker is still
 * REQUIRED, for a different reason than re-sharing (which is now refused —
 * assertSkillShareable): every comparison a learned copy takes part in is
 * against a marker-less hash — the SOURCE dir's, for update detection, and its
 * own marker's localHash, for customization detection — so the marker must be
 * invisible on both sides. Null when the dir is missing or blows the transfer
 * caps (such a skill can't transfer anyway).
 */
export function hashSkillDir(repoRoot: string, slug: string): string | null {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}`);
  if (!lexical) {
    return null;
  }
  const dir = realpathContained(repoRoot, lexical, true);
  if (!dir) {
    return null;
  }
  const { files, truncated } = walkSkillDir(dir, MAX_SKILL_FILES, SKILL_ORIGIN_FILE);
  if (truncated) {
    return null;
  }
  const hash = crypto.createHash("sha256");
  let total = 0;
  for (const file of files) {
    if (file.bytes > MAX_SKILL_FILE_BYTES) {
      return null;
    }
    const bytes = fs.readFileSync(file.abs);
    total += bytes.length;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      return null;
    }
    hash.update(file.rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The file manifest of one skill directory — what a learn would ACTUALLY copy.
 * A skill is the whole `skills/<slug>/` tree (aux docs, scripts, templates),
 * not just its SKILL.md, so the preview lists it rather than letting a learner
 * assume one file. Same walk as copySkillDir minus the copying: symlinks and
 * specials never appear, sizes come from lstat (no content is read), and paths
 * are relative to the skill dir with SKILL.md included.
 *
 * A tree past the transfer caps returns what it saw with `truncated` — such a
 * skill would FAIL to learn anyway, and an honest partial listing beats an
 * empty one. A missing/uncontained dir is an empty manifest, not an error.
 */
export function listSkillFiles(repoRoot: string, slug: string): SharedSkillManifest {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}`);
  const dir = lexical ? realpathContained(repoRoot, lexical, true) : null;
  if (!dir) {
    return { files: [], totalBytes: 0, truncated: false };
  }
  const { files, truncated } = walkSkillDir(dir, MAX_SKILL_FILES);
  return {
    // Code-unit order, not localeCompare: a manifest is a stable listing, and
    // this keeps SKILL.md at the top the way `ls` would.
    files: files
      .map((file) => ({ path: file.rel, bytes: file.bytes }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    truncated,
  };
}

/** Read a learned skill's provenance marker, or null when absent/invalid. */
export function readSkillOrigin(repoRoot: string, slug: string): SkillOrigin | null {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}/${SKILL_ORIGIN_FILE}`);
  if (!lexical) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(lexical, "utf8")) as Partial<SkillOrigin>;
    if (
      typeof raw.ownerUserId !== "string" ||
      typeof raw.ownerUsername !== "string" ||
      typeof raw.skillName !== "string"
    ) {
      return null;
    }
    return {
      ownerUserId: raw.ownerUserId,
      ownerUsername: raw.ownerUsername,
      skillName: raw.skillName,
      contentHash: typeof raw.contentHash === "string" ? raw.contentHash : null,
      localHash: typeof raw.localHash === "string" ? raw.localHash : null,
      learnedAt: typeof raw.learnedAt === "string" ? raw.learnedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Refusal thrown by assertSkillShareable. Message-coded like every other error
 * in this module (callers switching on `error.message` keep working); `origin`
 * rides along so they can name the sharer without re-reading the marker.
 */
export class SkillIsLearnedCopyError extends Error {
  constructor(readonly origin: SkillOrigin) {
    super("SKILL_IS_LEARNED_COPY");
    this.name = "SkillIsLearnedCopyError";
  }
}

/**
 * Refuse to publish a skill directory that still carries a provenance marker.
 * A learned copy lives inside the ORIGINAL owner's avatar-discovery boundary:
 * re-sharing it would carry the CONTENT past that boundary, duplicate the
 * listing, and credit the wrong author. Unlinking (구독 해지) is the deliberate
 * ownership claim that lifts the refusal — see unlinkSkillOrigin.
 *
 * The one choke point for both share paths (the share endpoint in
 * routes/skillShare.ts and mcp__skill_exchange__share_skill) and for the SOURCE
 * side of a learn. A corrupt/unreadable marker reads as no marker
 * (readSkillOrigin's null): a copy making no provenance claim is shareable.
 */
export function assertSkillShareable(repoRoot: string, slug: string): void {
  const origin = readSkillOrigin(repoRoot, slug);
  if (origin) {
    throw new SkillIsLearnedCopyError(origin);
  }
}

/**
 * Unlink a learned copy from its share (구독 해지): delete the origin marker
 * and commit. The skill itself stays; update badges/tracking stop, the copy
 * becomes shareable as the owner's own, and a later re-learn of the same share
 * is a NEW copy. Throws NO_ORIGIN when the slug has no marker (never learned,
 * or already unlinked).
 */
export async function unlinkSkillOrigin(opts: {
  learnerCtx: KnowledgeRepoContext;
  slug: string;
  commitMessage: string;
  identity: { name: string; email: string };
}): Promise<{ origin: SkillOrigin; committed: boolean }> {
  const root = await ensureClone(opts.learnerCtx);
  const origin = readSkillOrigin(root, opts.slug);
  if (!origin) {
    throw new Error("NO_ORIGIN");
  }
  const lexical = resolveInRepo(root, `${SKILL_DIR}/${opts.slug}/${SKILL_ORIGIN_FILE}`);
  const abs = lexical ? realpathContained(root, lexical, true) : null;
  if (!abs) {
    throw new Error("NO_ORIGIN");
  }
  await fsp.rm(abs, { force: true });
  const committed = await commitAndPush(opts.learnerCtx, opts.commitMessage, opts.identity);
  return { origin, committed };
}

/**
 * Whether a learned copy was locally customized since the learn: current dir
 * hash vs the origin marker's localHash. Returns null when it cannot tell —
 * no marker, a legacy marker without localHash, or an unhashable dir — which
 * callers treat as "possibly modified" (fail safe).
 */
export function isSkillLocallyModified(repoRoot: string, slug: string): boolean | null {
  const origin = readSkillOrigin(repoRoot, slug);
  if (!origin?.localHash) {
    return null;
  }
  const current = hashSkillDir(repoRoot, slug);
  if (!current) {
    return null;
  }
  return current !== origin.localHash;
}

interface CopyStats {
  files: number;
  bytes: number;
  skippedSymlinks: number;
}

/**
 * Recursively copy one skill directory between repo working trees. Source
 * entries are lstat'ed: symlinks are SKIPPED (never followed — a committed
 * link could point anywhere on the server), regular files are size-capped,
 * anything else (sockets, devices) is skipped. Throws message-coded errors in
 * the knowledgeRepo style: SKILL_NOT_FOUND, SKILL_EXISTS, INVALID_NAME,
 * SKILL_FILE_TOO_LARGE, SKILL_TOO_LARGE, TOO_MANY_FILES.
 */
export async function copySkillDir(
  srcRoot: string,
  srcSlug: string,
  destRoot: string,
  destSlug: string,
): Promise<CopyStats> {
  // Slugs are single path segments by construction; anything else is unsafe.
  if (
    srcSlug !== sanitizeName(srcSlug) ||
    destSlug !== sanitizeName(destSlug) ||
    !srcSlug ||
    !destSlug
  ) {
    throw new Error("INVALID_NAME");
  }
  const srcLex = resolveInRepo(srcRoot, `${SKILL_DIR}/${srcSlug}`);
  const destLex = resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`);
  if (!srcLex || !destLex) {
    throw new Error("INVALID_NAME");
  }
  // Source must exist (realpath containment guards symlinked ancestors) and
  // actually be a skill directory.
  const src = realpathContained(srcRoot, srcLex, true);
  if (!src || !fs.existsSync(path.join(src, "SKILL.md"))) {
    throw new Error("SKILL_NOT_FOUND");
  }
  if (fs.lstatSync(src).isSymbolicLink() || !fs.statSync(src).isDirectory()) {
    throw new Error("SKILL_NOT_FOUND");
  }
  // Destination must not exist yet; its (possibly not-yet-created) path must
  // stay inside the learner's repo after resolving existing ancestors.
  const dest = realpathContained(destRoot, destLex, false);
  if (!dest) {
    throw new Error("INVALID_NAME");
  }
  if (fs.existsSync(dest)) {
    throw new Error("SKILL_EXISTS");
  }
  const stats: CopyStats = { files: 0, bytes: 0, skippedSymlinks: 0 };
  await copyTree(src, dest, stats, 0);
  return stats;
}

async function copyTree(
  srcDir: string,
  destDir: string,
  stats: CopyStats,
  depth: number,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) {
    throw new Error("TOO_MANY_FILES");
  }
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const stat = await fsp.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      stats.skippedSymlinks += 1;
      continue;
    }
    if (stat.isDirectory()) {
      await copyTree(srcPath, destPath, stats, depth + 1);
      continue;
    }
    if (!stat.isFile()) {
      continue; // sockets/FIFOs etc. — never part of a skill
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error("SKILL_FILE_TOO_LARGE");
    }
    stats.files += 1;
    stats.bytes += stat.size;
    if (stats.files > MAX_SKILL_FILES) {
      throw new Error("TOO_MANY_FILES");
    }
    if (stats.bytes > MAX_SKILL_TOTAL_BYTES) {
      throw new Error("SKILL_TOO_LARGE");
    }
    // Raw byte copy (binary-safe — skills may bundle small assets/scripts).
    await fsp.copyFile(srcPath, destPath);
  }
}

/**
 * Rewrite the copied skill's IDENTITY files so it loads under `slug`:
 * `.claude-plugin/plugin.json` (created when the source skill lacked one —
 * without it the marketplace entry is not loadable) and, when the frontmatter
 * carries a `name:`, the SKILL.md name line (the CLI prefers frontmatter over
 * the directory name, so a stale name would collide with the source skill).
 */
async function rewriteSkillIdentity(
  destRoot: string,
  slug: string,
  description: string,
): Promise<void> {
  const dir = resolveInRepo(destRoot, `${SKILL_DIR}/${slug}`)!;
  const pluginJsonPath = path.join(dir, ".claude-plugin", "plugin.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fsp.readFile(pluginJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    manifest = {};
  }
  manifest.name = slug;
  if (description && !manifest.description) {
    manifest.description = description;
  }
  await fsp.mkdir(path.dirname(pluginJsonPath), { recursive: true });
  await fsp.writeFile(pluginJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const mdPath = path.join(dir, "SKILL.md");
  try {
    const raw = await fsp.readFile(mdPath, "utf8");
    if (raw.startsWith("---")) {
      const end = raw.indexOf("\n---", 3);
      if (end > 0) {
        const frontmatter = raw.slice(0, end);
        const rewritten = frontmatter.replace(/^name:\s*.+$/m, `name: ${slug}`);
        if (rewritten !== frontmatter) {
          await fsp.writeFile(mdPath, rewritten + raw.slice(end), "utf8");
        }
      }
    }
  } catch {
    // SKILL.md unreadable — copy already validated it exists; leave as-is.
  }
}

/** Everything the learn flow needs to report back to its caller. */
export interface LearnResult {
  /** The slug the skill landed under in the learner's repo. */
  slug: string;
  /** Repo-relative path of the learned SKILL.md (UI deep-link / tool text). */
  skillPath: string;
  /** False when the commit found a clean tree (should not happen in practice). */
  committed: boolean;
  /** Symlinks in the source tree that were skipped rather than followed. */
  skippedSymlinks: number;
  /**
   * True when the learner restricts loaded marketplace plugins to a subset
   * (`selected`) — the learned skill won't LOAD until they enable it there.
   */
  needsSelection: boolean;
  /** The SOURCE directory's content hash recorded in the origin marker. */
  contentHash: string | null;
  /** True when this learn replaced an existing provenance-matched copy. */
  updated: boolean;
}

/**
 * Learn one shared skill: refresh both clones, copy the skill directory,
 * rewrite its identity, record provenance, advertise it in the learner's
 * marketplace manifest, and commit+push with the learner's git identity.
 *
 * `updateSlug` switches to UPDATE mode: the learner's existing
 * `skills/<updateSlug>/` is replaced with the sharer's current version —
 * allowed ONLY when that directory carries an origin marker for the SAME
 * (sharer, skillName) pair (fail closed: NOT_LEARNED_FROM_SHARE otherwise).
 *
 * Message-coded errors from copySkillDir propagate, plus SKILL_IS_LEARNED_COPY
 * when the SOURCE is itself a linked copy (a legacy row — prune it); clone/push
 * failures throw raw git errors (callers scrub via scrubGitError).
 */
export async function learnSkillIntoRepo(opts: {
  sharerCtx: KnowledgeRepoContext;
  learnerCtx: KnowledgeRepoContext;
  /** The sharer's `skills/<slug>` directory name (share row's skillName). */
  skillName: string;
  /** Optional different name to learn under (conflict resolution / rebrand). */
  newName?: string;
  /** UPDATE mode: replace this existing learner slug in place (see above). */
  updateSlug?: string;
  /**
   * Overwrite even a LOCALLY CUSTOMIZED copy (update mode only). Without it a
   * copy whose current hash differs from the origin marker's localHash — or
   * whose marker predates localHash — throws SKILL_LOCALLY_MODIFIED so the
   * caller can get explicit user confirmation first.
   */
  allowModified?: boolean;
  /** The sharer's @username, recorded in the origin marker for display. */
  sharerUsername: string;
  commitMessage: string;
  identity: { name: string; email: string };
}): Promise<LearnResult> {
  const destSlug = opts.updateSlug
    ? opts.updateSlug
    : opts.newName
      ? normalizeSkillSlug(opts.newName)
      : opts.skillName;
  if (!destSlug) {
    throw new Error("INVALID_NAME");
  }
  // Refresh the SHARER's clone so the learner gets the current version, then
  // the learner's own working tree (also creates it on first use).
  const srcRoot = await ensureClone(opts.sharerCtx);
  const destRoot = await ensureClone(opts.learnerCtx);
  const source = readRepoSkill(srcRoot, opts.skillName);
  if (!source) {
    throw new Error("SKILL_NOT_FOUND");
  }
  // A share row pointing at a still-linked LEARNED copy predates the
  // no-re-share rule: refuse rather than extend the chain (callers prune the
  // stale row, the same way they prune a share whose directory is gone).
  assertSkillShareable(srcRoot, opts.skillName);
  const sourceHash = hashSkillDir(srcRoot, opts.skillName);
  if (opts.updateSlug) {
    // Only a copy that PROVABLY came from this share may be replaced — the
    // origin marker is the authorization, not the matching directory name.
    const origin = readSkillOrigin(destRoot, destSlug);
    if (
      !origin ||
      origin.ownerUserId !== opts.sharerCtx.userId ||
      origin.skillName !== opts.skillName
    ) {
      throw new Error("NOT_LEARNED_FROM_SHARE");
    }
    // A locally customized copy (or one we can't judge — legacy marker) is
    // only replaced with the caller's explicit go-ahead: the learner's own
    // edits must never silently flatten under an update.
    if (!opts.allowModified && isSkillLocallyModified(destRoot, destSlug) !== false) {
      throw new Error("SKILL_LOCALLY_MODIFIED");
    }
    const lexical = resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`)!;
    const abs = realpathContained(destRoot, lexical, true);
    if (!abs) {
      throw new Error("SKILL_NOT_FOUND");
    }
    await fsp.rm(abs, { recursive: true, force: true });
  }
  const stats = await copySkillDir(srcRoot, opts.skillName, destRoot, destSlug);
  await rewriteSkillIdentity(destRoot, destSlug, source.description);
  // Provenance marker LAST so it overwrites any origin file that reached the
  // destination (a marker-carrying source is refused above, and update mode
  // wipes the dir first — this just keeps the invariant local). localHash is
  // the DEST dir hash post-rewrite (marker file excluded), so a later mismatch
  // means the learner customized the copy.
  const originAbs = path.join(
    resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`)!,
    SKILL_ORIGIN_FILE,
  );
  const origin: SkillOrigin = {
    ownerUserId: opts.sharerCtx.userId,
    ownerUsername: opts.sharerUsername,
    skillName: opts.skillName,
    contentHash: sourceHash,
    localHash: hashSkillDir(destRoot, destSlug),
    learnedAt: new Date().toISOString(),
  };
  await fsp.writeFile(originAbs, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
  await ensureMarketplaceManifest(destRoot, destSlug);
  const committed = await commitAndPush(opts.learnerCtx, opts.commitMessage, opts.identity);
  return {
    slug: destSlug,
    skillPath: `${SKILL_DIR}/${destSlug}/SKILL.md`,
    committed,
    skippedSymlinks: stats.skippedSymlinks,
    needsSelection: opts.learnerCtx.selected !== null,
    contentHash: sourceHash,
    updated: Boolean(opts.updateSlug),
  };
}
