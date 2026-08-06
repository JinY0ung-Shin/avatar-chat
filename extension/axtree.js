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
 * Render one session's AX tree, walking childIds rather than the flat node
 * array Chrome hands back. Two reasons: that array is not reliably in document
 * order, and only a real walk knows a node's ancestors — which is what lets us
 * drop text an ancestor's label already spells out. A link and the StaticText
 * inside it are one thing to a reader, and printing both doubled the size of
 * every snapshot.
 *
 * `mintUid(backendNodeId)` is called for each actionable element, in output
 * order, and returns the uid to print. The caller owns the uid counter so that
 * numbering stays continuous across a page's frames.
 */
export function renderAxTree(nodes, mintUid) {
  const lines = [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const claimed = new Set();
  for (const node of nodes) for (const childId of node.childIds || []) claimed.add(childId);
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
      const interactive = INTERACTIVE_ROLES.has(role);
      // Nameless NON-interactive nodes are noise, but a nameless interactive
      // element (an unlabeled rich-text editor, an icon-only button) still
      // needs a uid — dropping those made such editors unreachable entirely.
      const worthPrinting = Boolean(name || value || interactive);
      // An echo of an ancestor's label. Interactive nodes are exempt: their
      // line carries the uid, which nothing else can supply.
      const echoed = !interactive && !value && Boolean(name) && covered.includes(name);
      if (worthPrinting && !echoed) {
        const uid = interactive && node.backendDOMNodeId != null ? mintUid(node.backendDOMNodeId) : null;
        if (uid) {
          lines.push(`[${uid}] ${role} "${name}"${value ? ` = "${value}"` : ""}`);
        } else {
          lines.push(`${role} "${name || value}"`);
        }
      }
      if (name && !OPAQUE_NAME_ROLES.has(role)) inherited = name;
    }
    for (const childId of node.childIds || []) visit(byId.get(childId), inherited);
  };

  for (const node of nodes) if (!claimed.has(node.nodeId)) visit(node, "");
  // Anything left is detached from every root (a mid-walk DOM change, a cycle).
  // Print it rather than silently losing page content.
  for (const node of nodes) visit(node, "");
  return lines;
}
