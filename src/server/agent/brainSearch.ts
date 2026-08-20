// Shared retrieval/ranking for the second-brain search tools (`brainTools.ts` =
// the owner's personal vault, `groupBrainTools.ts` = a group's shared vault).
//
// Pure read over a cloned working tree: walk `wiki/**/*.md`, parse a minimal
// frontmatter block, and rank by keyword hits weighted title/aliases > tags >
// body. No embeddings, no index server, no git/network — the caller hands in an
// already-cloned `repoRoot`. Keyword ranking keeps the no-new-infra philosophy
// (open decision #2); recency/importance can be layered on later via frontmatter.
//
// The vault normally sits at the repo root (`wiki/` + `raw/`), but a caller may
// pass a `root` to move the whole scope into a subtree — that is how a personal
// agent's OWN memory (`agents/<dir>/wiki|raw`) lives inside the owner's single
// knowledge repo without ever reaching the owner's root vault.

import path from "node:path";
import { listTree, readFile } from "../knowledgeRepo.js";

/**
 * Outcome of a scope check: the normalized (repo-relative) path to act on, or a
 * refusal the caller turns into its own message.
 */
export type ScopedPathCheck = { ok: true; norm: string } | { ok: false };

/** Historical name of `ScopedPathCheck`, kept for the `get_note` call sites. */
export type WikiPathCheck = ScopedPathCheck;

/**
 * Normalize a model-supplied path and confirm it is `prefix` or lives under
 * `prefix/`, so `<prefix>/../CLAUDE.md` can't step outside the scope.
 */
function underPrefix(rawPath: string, prefix: string): ScopedPathCheck {
  const norm = path.posix.normalize(rawPath.replace(/^[/]+/, ""));
  if (norm !== prefix && !norm.startsWith(`${prefix}/`)) {
    return { ok: false };
  }
  return { ok: true, norm };
}

/**
 * Normalize a scope ROOT (a repo-relative directory like `agents/bot-a1b2c3d4`).
 * The root is always server-derived, never model input, so this is purely
 * defensive — but it fails CLOSED (null): a broken root must refuse every path
 * rather than silently widen the scope back to the whole repo.
 */
function scopeBase(root: string): string | null {
  const base = root.replace(/^[/]+/, "").replace(/[/]+$/, "");
  if (!base) {
    return null;
  }
  const segments = base.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    return null;
  }
  return base;
}

/** The `wiki`/`raw` pair a search scope covers — at the repo root, or under `root`. */
function vaultScope(root?: string): { wiki: string; raw: string } | null {
  if (root === undefined) {
    return { wiki: "wiki", raw: "raw" };
  }
  const base = scopeBase(root);
  return base ? { wiki: `${base}/wiki`, raw: `${base}/raw` } : null;
}

/** True when a repo-relative entry path IS `dir` or lives under `dir/`. */
function isUnder(entryPath: string, dir: string): boolean {
  return entryPath === dir || entryPath.startsWith(`${dir}/`);
}

/**
 * The shared path guard for a run confined to ONE repo subtree (a personal
 * agent's memory folder): normalize the model-supplied path and require it to be
 * `root` or live under `root/`. The repo tools run this BEFORE their file ops, so
 * `<root>/../../CLAUDE.md` is refused with a redirect; `resolveInRepo` /
 * `realpathContained` inside `knowledgeRepo` remain the second layer.
 */
export function normalizeScopedPath(rawPath: string, root: string): ScopedPathCheck {
  const base = scopeBase(root);
  return base ? underPrefix(rawPath, base) : { ok: false };
}

/**
 * The shared wiki-path guard both `get_note` handlers (`brainTools.ts` /
 * `groupBrainTools.ts`) run before reading: strip leading slashes, normalize, and
 * confirm the result is `wiki` or lives under `wiki/` (so `wiki/../CLAUDE.md`
 * can't escape the vault). On success returns the normalized path to read with;
 * on failure the caller emits its own (repo vs group) refusal message. With
 * `opts.root` the guard moves to `<root>/wiki` — a bot's own memory vault — so a
 * path outside that subtree (including another bot's) is refused.
 */
export function normalizeWikiPath(rawPath: string, opts?: { root?: string }): WikiPathCheck {
  const vault = vaultScope(opts?.root);
  return vault ? underPrefix(rawPath, vault.wiki) : { ok: false };
}

// Hard cap on `wiki/` notes scanned per search. NOTE: `listTree` orders entries
// alphabetically by path (dir-before-file), NOT by recency, so this keeps the
// first 200 notes by path order — in a vault with >200 notes a late-sorting
// match (e.g. `wiki/zzz.md`) is silently not scored. Acceptable at expected
// scale; raise the cap or add mtime-desc ordering here if vaults grow larger.
const SCAN_CAP = 200;
/** Default / max number of ranked hits returned. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** Characters of context around the first query hit in a note's body. */
const SNIPPET_RADIUS = 90;

export interface BrainNoteHit {
  /** Repo-relative path, e.g. `wiki/concepts/deploy.md`. */
  path: string;
  /** Frontmatter `title`, or the filename stem when absent. */
  title: string;
  tags: string[];
  /** Short body excerpt around the first query hit (or the note's opening). */
  snippet: string;
  score: number;
}

export type BrainSearchResult =
  | { kind: "no_vault" }
  | { kind: "ok"; hits: BrainNoteHit[] };

interface NoteFrontmatter {
  title: string;
  tags: string[];
  aliases: string[];
}

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, "").trim();
}

function parseInlineList(v: string): string[] {
  // `[a, b, "c"]` → ["a","b","c"]
  const inner = v.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((x) => unquote(x.trim()))
    .filter(Boolean);
}

/**
 * Minimal, self-contained frontmatter parse — NOT a full YAML parser. Handles a
 * leading `---\n…\n---` block with `key: value`, inline lists `key: [a, b]`, and
 * block lists (`key:` then `  - item` lines) for `title`/`tags`/`aliases`. Never
 * throws; a missing/malformed block just yields empty fields (the note still
 * indexes by body). Exported for unit testing.
 */
export function parseNoteFrontmatter(content: string): { fm: NoteFrontmatter; body: string } {
  const fm: NoteFrontmatter = { title: "", tags: [], aliases: [] };
  if (!content.startsWith("---")) {
    return { fm, body: content };
  }
  const close = content.indexOf("\n---", 3);
  if (close === -1) {
    return { fm, body: content };
  }
  const block = content.slice(3, close);
  const afterClose = content.indexOf("\n", close + 1);
  const body = afterClose === -1 ? "" : content.slice(afterClose + 1);
  let listKey: "tags" | "aliases" | null = null;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey) {
      const v = unquote(listItem[1]);
      if (v) fm[listKey].push(v);
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === "title") {
      fm.title = unquote(val);
      listKey = null;
    } else if (key === "tags" || key === "aliases") {
      if (val.startsWith("[")) {
        fm[key] = parseInlineList(val);
        listKey = null;
      } else if (val) {
        fm[key] = [unquote(val)];
        listKey = null;
      } else {
        fm[key] = [];
        listKey = key;
      }
    } else {
      listKey = null;
    }
  }
  return { fm, body };
}

function makeSnippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - SNIPPET_RADIUS);
  const slice = body.slice(start, start + SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET_RADIUS * 2 < body.length ? "…" : ""}`;
}

/**
 * Rank the `wiki/` notes under an already-cloned `repoRoot` against `query`.
 * Returns `{kind:'no_vault'}` when neither `wiki/` nor `raw/` exists (the repo
 * predates the vault layout → the caller points the avatar at `brain-migrate`),
 * distinct from a present-but-unmatched vault (`{kind:'ok', hits:[]}`). A note
 * that fails to read (oversize/unreadable) is skipped, never fatal.
 *
 * With `opts.root` the whole scope moves into that subtree (`<root>/wiki|raw`):
 * only its notes are scanned and the root vault stays invisible. Hit paths remain
 * FULL repo-relative, so `get_note`/`read_file` can open them as returned.
 */
export async function rankBrainNotes(
  repoRoot: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
  opts?: { root?: string },
): Promise<BrainSearchResult> {
  const vault = vaultScope(opts?.root);
  if (!vault) {
    return { kind: "no_vault" };
  }
  const entries = await listTree(repoRoot);
  const hasVault = entries.some((e) => isUnder(e.path, vault.wiki) || isUnder(e.path, vault.raw));
  if (!hasVault) {
    return { kind: "no_vault" };
  }
  const noteFiles = entries
    .filter(
      (e) =>
        e.type === "file" &&
        e.path.startsWith(`${vault.wiki}/`) &&
        e.path.endsWith(".md") &&
        !e.path.endsWith("_template.md") &&
        e.path !== `${vault.wiki}/index.md` &&
        e.path !== `${vault.wiki}/log.md`,
    )
    .slice(0, SCAN_CAP);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: BrainNoteHit[] = [];
  for (const f of noteFiles) {
    let content: string;
    try {
      content = await readFile(repoRoot, f.path);
    } catch {
      // FILE_TOO_LARGE / unreadable — skip this note, never abort the scan.
      continue;
    }
    const { fm, body } = parseNoteFrontmatter(content);
    const stem = f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path;
    const title = fm.title || stem;
    const titleHay = `${title} ${fm.aliases.join(" ")}`.toLowerCase();
    const tagHay = fm.tags.join(" ").toLowerCase();
    const bodyHay = body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (titleHay.includes(t)) score += 5;
      if (tagHay.includes(t)) score += 3;
      if (bodyHay.includes(t)) score += 1;
    }
    if (score === 0) continue;
    hits.push({ path: f.path, title, tags: fm.tags, snippet: makeSnippet(body, terms), score });
  }
  // Stable: higher score first, ties broken by path so results are deterministic.
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const capped = Math.min(Math.max(1, limit), MAX_LIMIT);
  return { kind: "ok", hits: hits.slice(0, capped) };
}

/** Render ranked hits as the agent-facing list body both brain servers return. */
export function formatBrainHits(hits: BrainNoteHit[]): string {
  return hits
    .map((h) => `- ${h.path}${h.tags.length ? ` [${h.tags.join(", ")}]` : ""}: ${h.title}\n  ${h.snippet}`)
    .join("\n");
}
