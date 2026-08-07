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
    const interactive = INTERACTIVE_ROLES.has(role);
    // Nameless NON-interactive nodes are noise, but a nameless interactive
    // element (an unlabeled rich-text editor, an icon-only button) still
    // needs a uid — dropping those made such editors unreachable entirely.
    const worthPrinting = Boolean(name || value || interactive);
    // An echo of an ancestor's label. Interactive nodes are exempt: their
    // line carries the uid, which nothing else can supply.
    const echoed = !interactive && !value && Boolean(name) && covered.includes(name);
    if (!worthPrinting || echoed) return;
    const uid = interactive && node.backendDOMNodeId != null ? mintUid(node.backendDOMNodeId) : null;
    if (uid) {
      lines.push(`[${uid}] ${role} "${name}"${value ? ` = "${value}"` : ""}`);
    } else {
      lines.push(`${role} "${name || value}"`);
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
