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
 */
function linkUrl(node, role) {
  if (role !== "link") return "";
  const url = String(axProp(node, "url") || "");
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return "";
  return url.length > LINK_URL_MAX ? `${url.slice(0, LINK_URL_MAX)}…` : url;
}

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
 * `emit(node, role, name, value, covered)` fires once per printable candidate;
 * each renderer decides what (if anything) that node becomes. When
 * `startBackendNodeId` is given, only that node's subtree is walked; returns
 * false when no node carries that id (a stale uid).
 */
function walkAxNodes(nodes, startBackendNodeId, emit) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();

  const visit = (node, covered) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value;
    const structural = !role || role === "none" || role === "generic" || role === "InlineTextBox";
    let inherited = covered;
    if (!node.ignored && !structural) {
      const name = (node.name?.value || "").trim();
      const value = (node.value?.value || "").trim();
      emit(node, role, name, value, covered);
      if (name && !OPAQUE_NAME_ROLES.has(role)) inherited = name;
    }
    for (const childId of node.childIds || []) visit(byId.get(childId), inherited);
  };

  if (startBackendNodeId != null) {
    const start = nodes.find((node) => node.backendDOMNodeId === startBackendNodeId);
    if (!start) return false;
    visit(start, "");
    return true;
  }

  const claimed = new Set();
  for (const node of nodes) for (const childId of node.childIds || []) claimed.add(childId);
  for (const node of nodes) if (!claimed.has(node.nodeId)) visit(node, "");
  // Anything left is detached from every root (a mid-walk DOM change, a cycle).
  // Print it rather than silently losing page content.
  for (const node of nodes) visit(node, "");
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
  walkAxNodes(nodes, undefined, (node, role, name, value, covered) => {
    const interactive =
      INTERACTIVE_ROLES.has(role) ||
      // Clickable-in-practice surfaces: named table/tree rows and cells, plus
      // anything the page marked focusable (accordion headers, custom
      // widgets). Opaque containers are excluded — RootWebArea and friends
      // report focusable without being a target anyone means to click.
      (Boolean(name || value) &&
        (NAMED_CLICKABLE_ROLES.has(role) ||
          (axProp(node, "focusable") === true && !OPAQUE_NAME_ROLES.has(role))));
    // Nameless NON-interactive nodes are noise, but a nameless interactive
    // element (an unlabeled rich-text editor, an icon-only button) still
    // needs a uid — dropping those made such editors unreachable entirely.
    const worthPrinting = Boolean(name || value || interactive);
    // An echo of an ancestor's label. Interactive nodes are exempt: their
    // line carries the uid, which nothing else can supply.
    const echoed = !interactive && !value && Boolean(name) && covered.includes(name);
    if (!worthPrinting || echoed) return;
    const uid = interactive && node.backendDOMNodeId != null ? mintUid(node.backendDOMNodeId) : null;
    const url = linkUrl(node, role);
    if (uid) {
      lines.push(`[${uid}] ${role} "${name}"${value ? ` = "${value}"` : ""}${url ? ` → ${url}` : ""}`);
    } else {
      lines.push(`${role} "${name || value}"${url ? ` → ${url}` : ""}`);
    }
  });
  return lines;
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
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered) => {
    const echoed = !value && Boolean(name) && covered.includes(name);
    if ((!name && !value) || echoed) return;
    lines.push(name && value ? `${name}: ${value}` : name || value);
  });
  return found ? lines : null;
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
