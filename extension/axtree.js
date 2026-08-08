/**
 * Rendering a CDP accessibility tree into the text an agent reads.
 *
 * Kept apart from background.js so it can be unit tested: it is the one piece
 * of the bridge that is pure, and the one whose output size the agent pays for
 * on every single snapshot.
 */

/** Roles that get a uid, because an agent can act on them. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "spinbutton",
  // A canvas is where canvas APPS (diagram editors, maps) live; without a uid
  // there is no way to click or focus one, and keyboard shortcuts silently go
  // nowhere because the canvas never holds focus.
  "canvas",
]);

/**
 * Roles that are not natively interactive but are CLICKABLE SURFACES in real
 * apps — menus built from table rows (draw.io's submenu <tr>s surface only as
 * LayoutTableCell), tree views, data grids. They get a uid only when they
 * carry a name: a nameless layout cell is structure, and minting it would
 * flood the snapshot with unactionable refs.
 */
export const NAMED_CLICKABLE_ROLES = new Set([
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "LayoutTableCell",
  "LayoutTableRow",
  "treeitem",
]);

/**
 * Containers that are not controls but ARE the drawn surface itself — a map
 * body, an embedded app. Nothing inside them has an accessibility entry, so
 * the container's own uid is the only handle click_at's uid mode (and
 * read_text's uid scoping) can aim at; without it a map surfaced as a bare
 * `region "Map"` line that named a target no tool could reach. Named only:
 * a nameless region is page structure and minting it would flood the snapshot.
 * They stay in OPAQUE_NAME_ROLES — a uid says "actionable", not "my name
 * describes my children".
 */
export const NAMED_CONTAINER_UID_ROLES = new Set(["region", "application"]);

/**
 * Roles whose accessible name does NOT come from their contents. A descendant
 * that repeats a word from one of these is saying something new, so they must
 * never suppress it — letting RootWebArea cover the page would delete every
 * mention of the title from the body text.
 */
const OPAQUE_NAME_ROLES = new Set([
  "RootWebArea",
  "main",
  "region",
  "navigation",
  "form",
  "article",
  "banner",
  "contentinfo",
  "complementary",
  "dialog",
  "tabpanel",
  "table",
  "rowgroup",
  "row",
  "list",
  "listitem",
  "group",
  "figure",
]);

/** One AX property's value, or undefined. Shared with background.js. */
export function axProp(node, name) {
  const hit = (node?.properties || []).find((prop) => prop?.name === name);
  return hit ? hit.value?.value : undefined;
}

/** Cap for a printed link href — enough to identify and open, never a dump. */
const LINK_URL_MAX = 150;

/**
 * A link's destination, straight from the AX node's `url` property — Chrome
 * already resolved and delivered it, so printing it costs no extra CDP round
 * trip. This is what lets an agent compare several search results or hand a
 * URL to read-only tools without paying a full click-and-load per candidate.
 * Same-document fragments and javascript: pseudo-links say nothing useful.
 *
 * Returned UNTRUNCATED: it doubles as the identity duplicate links are folded
 * on, and two destinations differing only past the print cap are not the same
 * link.
 */
function linkHref(node, role) {
  if (role !== "link") return "";
  const url = String(axProp(node, "url") || "");
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return "";
  return url;
}

/** The printed form of a destination: identifiable, never a dump. */
function printableUrl(url) {
  return url.length > LINK_URL_MAX ? `${url.slice(0, LINK_URL_MAX)}…` : url;
}

/** A character that ENDS a token: whitespace, punctuation, or a symbol. */
const TOKEN_BOUNDARY = /[\s\p{P}\p{S}]/u;

/**
 * True when `needle` appears in `hay` as a whole token — each end sitting at a
 * string edge, whitespace, punctuation, or a symbol. A hit INSIDE a larger word
 * or number does not count: plain `includes` let an ancestor label like
 * "달력 2026.08.08" swallow every calendar cell named "2", "8", "20" or "26",
 * silently deleting the page's day numbers from the output.
 */
function containsAsToken(hay, needle) {
  if (!hay || !needle) return false;
  const boundary = (ch) => !ch || TOKEN_BOUNDARY.test(ch);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    if (boundary(hay[i - 1]) && boundary(hay[i + needle.length])) return true;
    from = i + 1;
  }
}

/** Whitespace-free form, for comparing text a markup split MID-word. */
const stripSpaces = (s) => s.replace(/\s+/g, "");

/** Cell roles whose row grouping the reading view restores. */
const CELL_ROLES = new Set([
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "LayoutTableCell",
]);

/** Row roles that own those cells. */
const ROW_ROLES = new Set(["row", "LayoutTableRow"]);

/**
 * The one AX walk both renderers share, so their notion of document order,
 * ancestor-label coverage, and skipped structural nodes can never drift apart.
 *
 * Walks childIds rather than the flat node array Chrome hands back. Two
 * reasons: that array is not reliably in document order, and only a real walk
 * knows a node's ancestors — which is what lets a renderer drop text an
 * ancestor's label already spells out. A link and the StaticText inside it are
 * one thing to a reader, and printing both doubled the size of every snapshot.
 *
 * `emit(node, role, name, value, covered, container)` fires once per printable
 * candidate; each renderer decides what (if anything) that node becomes.
 * `container` is the nearest ancestor that emitted (structural and ignored
 * nodes are transparent), or null at a root — it is how a renderer tells one
 * paragraph's worth of inline text apart from two unrelated blocks. When
 * `startBackendNodeId` is given, only that node's subtree is walked; returns
 * false when no node carries that id (a stale uid).
 */
function walkAxNodes(nodes, startBackendNodeId, emit) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();

  const visit = (node, covered, container) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value;
    const structural = !role || role === "none" || role === "generic" || role === "InlineTextBox";
    let inherited = covered;
    let childContainer = container;
    if (!node.ignored && !structural) {
      // AXValue is not always a string — a slider or spinbutton reports a
      // NUMBER, and calling .trim() on it threw, failing every read tool on
      // any page carrying one. `?? ""` rather than `|| ""` so a numeric 0
      // renders as "0" instead of vanishing.
      const name = String(node.name?.value ?? "").trim();
      const value = String(node.value?.value ?? "").trim();
      emit(node, role, name, value, covered, container);
      if (name && !OPAQUE_NAME_ROLES.has(role)) inherited = name;
      childContainer = node;
    }
    for (const childId of node.childIds || []) visit(byId.get(childId), inherited, childContainer);
  };

  if (startBackendNodeId != null) {
    const start = nodes.find((node) => node.backendDOMNodeId === startBackendNodeId);
    if (!start) return false;
    visit(start, "", null);
    return true;
  }

  const claimed = new Set();
  for (const node of nodes) for (const childId of node.childIds || []) claimed.add(childId);
  for (const node of nodes) if (!claimed.has(node.nodeId)) visit(node, "", null);
  // Anything left is detached from every root (a mid-walk DOM change, a cycle).
  // Print it rather than silently losing page content.
  for (const node of nodes) visit(node, "", null);
  return true;
}

/**
 * Render one session's AX tree as the INTERACTION view: every actionable
 * element gets a uid the agent can pass to click/type.
 *
 * `mintUid(backendNodeId)` is called for each actionable element, in output
 * order, and returns the uid to print. The caller owns the uid counter so that
 * numbering stays continuous across a page's frames.
 */
export function renderAxTree(nodes, mintUid) {
  const lines = [];
  /** Full href -> { index, name } of the one line kept for that destination. */
  const byHref = new Map();
  /** The inline-text run currently open: { container, index, text, segments, covered }. */
  let run = null;
  /**
   * Close the open run, dropping it when it only re-spells its own container's
   * label. A `<mark>` keyword highlight splits a sentence MID-word, so the
   * fragments do not sit on token boundaries of the parent label and each one
   * survives `containsAsToken` on its own — the rejoined run then printed the
   * container's sentence a SECOND time, verbatim. Whitespace-insensitive
   * because the split loses the spaces too.
   *
   * Only a JOINED run (≥ 2 segments) may be dropped: a lone StaticText that
   * sits inside a longer ancestor label is the calendar case, where "26" under
   * "달력 2026.08.08" is real content the page would otherwise lose.
   *
   * Suppression NULLS the slot instead of splicing — byHref holds line indices
   * that must stay valid for the rest of the walk; the nulls are filtered out
   * once, at the end.
   */
  const closeRun = () => {
    if (run && run.segments > 1 && run.covered) {
      const joined = stripSpaces(run.text);
      if (joined && stripSpaces(run.covered).includes(joined)) lines[run.index] = null;
    }
    run = null;
  };
  walkAxNodes(nodes, undefined, (node, role, name, value, covered, container) => {
    const interactive =
      INTERACTIVE_ROLES.has(role) ||
      // Clickable-in-practice surfaces: named table/tree rows and cells, named
      // drawn surfaces (map/app containers), plus anything the page marked
      // focusable (accordion headers, custom widgets). Opaque containers are
      // excluded from the FOCUSABLE branch — RootWebArea and friends report
      // focusable without being a target anyone means to click.
      (Boolean(name || value) &&
        (NAMED_CLICKABLE_ROLES.has(role) ||
          NAMED_CONTAINER_UID_ROLES.has(role) ||
          (axProp(node, "focusable") === true && !OPAQUE_NAME_ROLES.has(role))));
    // Nameless NON-interactive nodes are noise, but a nameless interactive
    // element (an unlabeled rich-text editor, an icon-only button) still
    // needs a uid — dropping those made such editors unreachable entirely.
    const worthPrinting = Boolean(name || value || interactive);
    // An echo of an ancestor's label. Interactive nodes are exempt: their
    // line carries the uid, which nothing else can supply.
    const echoed = !interactive && !value && Boolean(name) && containsAsToken(covered, name);
    if (!worthPrinting || echoed) return;
    const href = linkHref(node, role);
    // An icon-only control usually carries its label in `title`, which Chrome
    // delivers as the AX DESCRIPTION — the only thing that tells a page full of
    // `button ""` lines apart. Read it ONLY as a last resort: it never replaces
    // a real name and never feeds ancestor coverage, since it describes this
    // node alone.
    const described =
      interactive && !name && !value ? String(node.description?.value ?? "").trim() : "";
    const format = () => {
      const uid =
        interactive && node.backendDOMNodeId != null ? mintUid(node.backendDOMNodeId) : null;
      const url = href ? ` → ${printableUrl(href)}` : "";
      return uid
        ? `[${uid}] ${role} "${name || described}"${value ? ` = "${value}"` : ""}${url}`
        : `${role} "${name || value || described}"${url}`;
    };
    // A single search result arrives as four to six links to the SAME
    // destination (thumbnail, title, source, snippet), which buried the result
    // list in repeats. Print the first position once; a later duplicate with a
    // richer label upgrades THAT line in place rather than adding another.
    const kept = href ? byHref.get(href) : undefined;
    if (kept) {
      if (name.length > kept.name.length) {
        lines[kept.index] = format();
        kept.name = name;
      }
      return;
    }
    // Prose split into per-word <span>s emits one StaticText per word. Rejoin
    // the run into the paragraph it was; a different container breaks it.
    const inRun =
      role === "StaticText" && !interactive && !href && !value && Boolean(name) && container != null;
    if (inRun && run && run.container === container) {
      run.text += ` ${name}`;
      run.segments += 1;
      lines[run.index] = `StaticText "${run.text}"`;
      return;
    }
    closeRun();
    const line = format();
    if (inRun) run = { container, index: lines.length, text: name, segments: 1, covered };
    if (href) byHref.set(href, { index: lines.length, name });
    lines.push(line);
  });
  closeRun();
  return lines.filter((line) => line !== null);
}

/**
 * Render one session's AX tree as the READING view: plain text lines with no
 * uids and no role decoration, for read_text. Mints nothing, so the uids of
 * the last snapshot stay valid. When `startBackendNodeId` is given only that
 * subtree is rendered; returns null when the id matches no node (stale uid —
 * the caller owns the model-facing message).
 */
export function renderAxText(nodes, startBackendNodeId) {
  const lines = [];
  /** What the last printed line was, so a run can extend it: {kind, container, …}. */
  let last = null;
  /** Same mid-word-highlight suppression renderAxTree does — see closeRun there. */
  const closeTextRun = () => {
    if (last?.kind === "text" && last.segments > 1 && last.covered) {
      const joined = stripSpaces(lines[last.index] ?? "");
      if (joined && stripSpaces(last.covered).includes(joined)) lines[last.index] = null;
    }
  };
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered, container) => {
    const echoed = !value && Boolean(name) && containsAsToken(covered, name);
    if ((!name && !value) || echoed) return;
    const printed = name && value ? `${name}: ${value}` : name || value;
    // Inline prose: consecutive StaticText under ONE container is a single
    // paragraph that a per-word <span> soup had split into a word per line.
    if (
      role === "StaticText" &&
      container != null &&
      last?.kind === "text" &&
      last.container === container
    ) {
      lines[last.index] += ` ${printed}`;
      last.segments += 1;
      return;
    }
    // A table read as a vertical list of cells loses the thing that made it a
    // table. Keep each row on one line, its cells separated by " | ".
    const inRow = CELL_ROLES.has(role) && ROW_ROLES.has(container?.role?.value);
    if (inRow && last?.kind === "cell" && last.container === container) {
      lines[lines.length - 1] += ` | ${printed}`;
      return;
    }
    closeTextRun();
    lines.push(printed);
    last =
      role === "StaticText" && container != null
        ? { kind: "text", container, index: lines.length - 1, segments: 1, covered }
        : inRow
          ? { kind: "cell", container }
          : null;
  });
  closeTextRun();
  return found ? lines.filter((line) => line !== null) : null;
}

/**
 * Character budget for one snapshot. Uncapped, merely REACHING a long page
 * failed the whole tool call against the model-side token ceiling (a long
 * comment thread renders past 90k chars), which made big pages unreadable
 * AND unactionable. read_text has its own chunking; this cap is for the
 * snapshot every action returns.
 */
export const SNAPSHOT_MAX_CHARS = 30000;

const UID_LINE = /^\[e\d+\] /;

/**
 * Fit a rendered snapshot into `maxChars`, spending the budget on actionable
 * lines first. A cut TEXT line is recoverable — read_text re-reads the page
 * in offset chunks — but a cut `[uid]` line makes its element unreachable, so
 * uid lines are kept preferentially. Output preserves document order; a
 * trailing notice says what was dropped so the model knows the page did not
 * end where the text stops.
 */
export function capSnapshot(text, maxChars = SNAPSHOT_MAX_CHARS) {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const keep = new Array(lines.length).fill(false);
  let remaining = maxChars;
  for (const wantUid of [true, false]) {
    for (let i = 0; i < lines.length; i += 1) {
      if (keep[i] || UID_LINE.test(lines[i]) !== wantUid) continue;
      const cost = lines[i].length + 1;
      if (cost <= remaining) {
        keep[i] = true;
        remaining -= cost;
      }
    }
  }
  const kept = lines.filter((_, i) => keep[i]);
  const dropped = lines.length - kept.length;
  return (
    `${kept.join("\n")}\n\n[snapshot truncated: ${dropped} of ${lines.length} lines omitted to fit. ` +
    "Interactive [uid] elements were kept first. Read the page's full text with " +
    "mcp__browser__read_text, which returns offset-addressed chunks.]"
  );
}

/** Longest overlap considered when merging scroll captures (bounds the cost). */
const MERGE_MAX_OVERLAP = 400;

/**
 * Merge two consecutive text captures of a scrolling page: find the longest
 * suffix of `acc` matching a prefix of `next` and append only the rest.
 * Virtualized feeds REMOVE content that scrolls out of view, so read_text's
 * `expand` must accumulate across scroll steps — one read at the bottom would
 * hold only the tail. When no overlap is found the chunks are concatenated
 * whole: a possible duplicate beats a silent hole.
 */
export function mergeTextLines(acc, next) {
  if (!acc.length) return next.slice();
  if (!next.length) return acc;
  const max = Math.min(acc.length, next.length, MERGE_MAX_OVERLAP);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (acc[acc.length - overlap + i] !== next[i]) {
        match = false;
        break;
      }
    }
    if (match) return acc.concat(next.slice(overlap));
  }
  return acc.concat(next);
}
