/**
 * The PURE half of the bridge: rendering a CDP accessibility tree into the text
 * an agent reads, plus the decisions taken on values read back out of it.
 *
 * Kept apart from background.js so it can be unit tested — background.js reaches
 * `chrome.*` and CDP and cannot be. Everything here is a function of its
 * arguments, so every rule that silently deleted, drowned, or MISREAD real page
 * content has a test instead of a field report.
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
  // nowhere because the canvas never holds focus. BOTH spellings, because they
  // come from different places: Chrome COMPUTES a plain <canvas> as CamelCase
  // "Canvas" (the same convention as RootWebArea/StaticText/LayoutTableCell),
  // while only an explicit role="canvas" arrives lowercase. Matching lowercase
  // alone meant every real canvas was nameless AND non-interactive, so it
  // vanished from the snapshot entirely and click_at's uid mode had nothing on
  // the page to aim at.
  "canvas",
  "Canvas",
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

/**
 * The THREE answers one AX node gives about the text it holds. Keeping them
 * apart is what makes a clearing write verifiable at all:
 *
 *   "text"  the field holds that text (RAW — callers trim where they compare);
 *   ""      the field is genuinely EMPTY;
 *   null    nothing readable here — this node exposes no text value at all.
 *
 * Chrome OMITS the `value` property entirely on an EMPTY text field, so "no value
 * property" cannot mean "empty" on its own. Reading it that way is exactly how
 * clear verification disarmed itself in the field: a `role="combobox"` WRAPPER,
 * whose text lives in a descendant <input>, answered "" — and an empty `before`
 * makes `clearFailed` give up, so a silent append shipped as success three times
 * running. The `editable` property is what separates the two: Chrome sets it
 * (`plaintext`/`richtext`) on every textbox/textarea/contenteditable whether or
 * not it holds text, and never on such a wrapper. Both facts are measured in
 * `tests/visual/clear-ladder.spec.ts`.
 */
export function axValueAnswer(node) {
  if (!node) return null;
  if (node.value != null) return String(node.value.value ?? "");
  return axProp(node, "editable") === undefined ? null : "";
}

/**
 * True when the OLD value survived a clearing write at one END of the field — the
 * signature of a select-all the page ignored, which turns a replacement into an
 * insert. BOTH ends, because the surviving text sits wherever the caret was not:
 * "광교" + "카페거리" read back as "광교카페거리" in the field report (caret at the
 * end) and as "카페거리광교" on a freshly focused input (caret at 0). A hit in the
 * MIDDLE is not counted — that is where a short old value collides with a page's
 * own reformatting by coincidence, and a false alarm here costs a real error
 * message on a page that worked.
 *
 * Decidable only when both reads succeeded; a null read means verification was
 * unavailable and must never read as failure. A field that now holds EXACTLY the
 * requested value is a success whatever it held before, which is what keeps
 * replacing "광교" with "광교역" from looking like a survival.
 */
export function clearFailed(before, after, value) {
  if (before === null || after === null) return false;
  const old = String(before).trim();
  const now = String(after).trim();
  if (!old) return false;
  if (now === String(value).trim()) return false;
  return now.startsWith(old) || now.endsWith(old);
}

/**
 * Cap for a printed link href. A printed URL is meant to be OPENED — handed to
 * a read-only fetch, compared against another result — and 150 chopped the tail
 * off ordinary real-world links (a search query with its tracking parameters, a
 * doc anchor), leaving a string that identifies the target but that no tool can
 * follow: worse than printing nothing. 500 covers those whole while still
 * bounding the dumps the cap exists for (data: URIs, tracker payloads).
 */
const LINK_URL_MAX = 500;

/** A url with its fragment removed — the identity of the DOCUMENT it points at. */
const stripFragment = (url) => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

/**
 * The url of the document being rendered, read off its RootWebArea — the only
 * place a pure renderer can learn it, and what makes a same-document link
 * recognizable at all. Resolved ONCE per render, not per link.
 *
 * Its own fragment is stripped: a page LOADED at an anchor reports its url with
 * `#intro` attached, which would make every in-page link look cross-document
 * again.
 */
function documentUrl(nodes) {
  const root = nodes.find((node) => node.role?.value === "RootWebArea");
  return stripFragment(String(axProp(root, "url") || ""));
}

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
function linkHref(node, role, docUrl) {
  if (role !== "link") return "";
  const url = String(axProp(node, "url") || "");
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return "";
  // Chrome hands the url ALREADY RESOLVED, so `href="#edit"` arrives as
  // https://site/page#edit and walks straight past the literal `#` test above.
  // Every row of a ten-row table then shared ONE href, folded onto a single
  // uid, and rows 2-10 lost their edit/delete links SILENTLY — the snapshot
  // simply had no line for them. Recognized by comparing against the document's
  // own url, so a `#sec` on ANOTHER page stays a real destination and still
  // folds and decorates as before.
  if (url.includes("#") && docUrl && stripFragment(url) === docUrl) return "";
  return url;
}

/** The printed form of a destination: identifiable, never a dump. */
function printableUrl(url) {
  return url.length > LINK_URL_MAX ? `${url.slice(0, LINK_URL_MAX)}…` : url;
}

/**
 * One AX state property, normalized to true / false / "mixed" / undefined.
 * Chrome delivers a state as a real BOOLEAN on some builds and properties and
 * as the STRING "true"/"false"/"mixed" on the tristate ones, so a `=== true`
 * read prints half the checked boxes on a page as unchecked.
 */
function axStateFlag(node, name) {
  const raw = axProp(node, name);
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  if (raw === "mixed") return "mixed";
  return undefined;
}

/**
 * The state markers appended to a control's snapshot line. Deployed pages
 * printed `checkbox ""` identically whether the box was ticked or not, so an
 * agent could neither read a form back nor tell whether the click it just made
 * toggled anything — a verification that always passed.
 *
 * checked/pressed/expanded print BOTH ways, because "not checked" is exactly
 * the fact a verifying read is after. selected/disabled print only when true:
 * every option in a listbox is unselected and every control on the page is
 * enabled, so the false form is pure noise. `[disabled]` is worth its width on
 * its own — it is what stops an agent spending a click on a dead button.
 */
function stateFlags(node) {
  const flags = [];
  const checked = axStateFlag(node, "checked");
  if (checked !== undefined) {
    flags.push(checked === "mixed" ? "[checked=mixed]" : checked ? "[checked]" : "[unchecked]");
  }
  const pressed = axStateFlag(node, "pressed");
  if (pressed !== undefined) {
    flags.push(pressed === "mixed" ? "[pressed=mixed]" : pressed ? "[pressed]" : "[unpressed]");
  }
  const expanded = axStateFlag(node, "expanded");
  if (expanded === true) flags.push("[expanded]");
  else if (expanded === false) flags.push("[collapsed]");
  if (axStateFlag(node, "selected") === true) flags.push("[selected]");
  if (axStateFlag(node, "disabled") === true) flags.push("[disabled]");
  return flags.length ? ` ${flags.join(" ")}` : "";
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

/**
 * Inline TEXT-LEVEL SEMANTIC roles, treated as STRUCTURAL. A `<mark>`,
 * `<strong>` or `<em>` is a phrasing wrapper AROUND a text run: never a
 * container in its own right, never printable content. Left non-structural, a
 * keyword-highlight `<mark>` emitted namelessly (printing nothing) but still
 * became the `container` of the first fragment of a sentence it split, while the
 * rest sat on the real container — so the halves never joined into one run and
 * the run-level suppression below never saw them. `[e82] option "검색어 광교역"`
 * printed with `StaticText "광교"` and `StaticText "역"` under it, re-spelling
 * the option's own label as two extra lines.
 *
 * The strings are Chrome's own, verified against `Accessibility.getFullAXTree`:
 * `<mark>`→mark, `<strong>`→strong, `<em>`→emphasis, `<sup>`→superscript,
 * `<sub>`→subscript, `<del>`/`<s>`→deletion, `<ins>`→insertion. (`<b>`, `<i>`,
 * `<span>` and friends already arrive as `generic`.) `code` and `time` are
 * deliberately absent: `<pre><code>` is a BLOCK, and dissolving it would glue a
 * code listing into the surrounding prose as one run.
 */
const TEXT_LEVEL_ROLES = new Set([
  "mark",
  "strong",
  "emphasis",
  "superscript",
  "subscript",
  "deletion",
  "insertion",
]);

/** Whitespace-free form, for comparing text a markup split MID-word. */
const stripSpaces = (s) => s.replace(/\s+/g, "");

/**
 * Containers whose inline text must NEVER be rejoined into one line. Run
 * joining rebuilds the paragraph a per-word <span> soup had split — but
 * `container` is the nearest EMITTING ancestor, and every plain <div> is
 * `generic` and therefore transparent, so two entirely unrelated page blocks
 * can share nothing but the landmark they both sit under. Joined on that, a
 * counter and a footer credit shipped as `StaticText "0 Powered by"`, a spinner
 * and the same credit as `"Loading… Powered by"` — sentences the page never
 * contained, which an agent cannot tell from real prose.
 *
 * The tradeoff is one-sided, which is why the guard is this blunt: the worst
 * case it causes is a word-split paragraph sitting DIRECTLY under a landmark
 * printing one word per line — ugly, obvious, and LOSSLESS — while a false join
 * fuses two unrelated facts into one and is invisible. Real prose lives in a
 * paragraph/heading/listitem/cell, all of which keep joining.
 */
const NON_JOINING_CONTAINERS = new Set([
  "RootWebArea",
  "main",
  "region",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "dialog",
  "article",
  "tabpanel",
]);

/** True when a run of inline text under this container may be rejoined. */
const joinsRuns = (container) =>
  container != null && !NON_JOINING_CONTAINERS.has(container.role?.value);

/**
 * Stripped length a joined run must reach before a NEIGHBOURING line is allowed
 * to drop it. Two one-character segments occur in order inside almost any line;
 * eight characters of ordered agreement is no longer a coincidence.
 */
const RUN_ECHO_MIN_CHARS = 8;

/**
 * True when every segment of a joined run occurs, IN ORDER, inside `line`.
 *
 * The second shape of the keyword-highlight duplicate, and the one that
 * container-label suppression structurally cannot see: the page holds the
 * sentence TWICE — once whole (arriving as a single StaticText line) and once
 * split around the highlighted words, whose own text nodes never reach the run.
 * So the fragment run is not a SUBSTRING of anything; it is the sentence with
 * HOLES where the keywords were ("저당 시럽이라 달달한 단맛을 …" printed a second
 * time as "저당 이라 달달한 을 …"), which an `includes` test misses and both
 * lines shipped. An advancing-cursor indexOf chain matches through the holes.
 *
 * Whitespace-insensitive because the split loses the spaces too.
 */
function runEchoesLine(segments, line) {
  const hay = stripSpaces(String(line ?? ""));
  if (!hay) return false;
  let cursor = 0;
  let matched = 0;
  for (const segment of segments) {
    const needle = stripSpaces(String(segment ?? ""));
    if (!needle) continue;
    const at = hay.indexOf(needle, cursor);
    if (at < 0) return false;
    cursor = at + needle.length;
    matched += needle.length;
  }
  return matched >= RUN_ECHO_MIN_CHARS;
}

/**
 * The last line actually PRINTED before `index`. Suppressed lines are nulled in
 * place rather than spliced (byHref holds indices that must stay valid), so the
 * slot immediately before a run is not necessarily a line at all.
 */
function precedingLine(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (lines[i] != null) return lines[i];
  return null;
}

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
 * The ROOT of an editable region — the one node in it an agent clicks and types
 * into. Shared by the walk and by isActionableNode so the node that gets a uid
 * and the node that survives structural skipping can never be different ones.
 *
 * `editable` alone does NOT mean root. Measured against real Chromium over CDP
 * (Accessibility.getFullAXTree), Chrome stamps `editable` on every DESCENDANT of
 * an editable region too: inside `<div contenteditable><p>hello <b>world</b></p>`
 * the div, both paragraphs, all three StaticTexts and the InlineTextBoxes each
 * report editable="richtext". Keying on it alone minted a uid per text node —
 * and worse, made StaticText INTERACTIVE, which silently switched off run
 * joining (`inRun` requires `!interactive`) and its duplicate suppression inside
 * every editor on the page.
 *
 * `focusable === true` is what separates them: in those same probes it was true
 * on the contenteditable div, on a designMode frame's RootWebArea, and on a
 * contenteditable <body>, and absent on every descendant and on a textarea's
 * inner generic.
 */
const isEditableRoot = (node) =>
  Boolean(axProp(node, "editable")) && axProp(node, "focusable") === true;

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
    // A bare contenteditable surface has NO role of its own: a `<div
    // contenteditable>` and a contenteditable `<body>` both arrive as `generic`,
    // which is structural — so the only focusable, typeable handle of the whole
    // editor was never emitted, and an iframe rich-text editor had no uid
    // anywhere on the page. (The frame's RootWebArea is not a substitute: with a
    // contenteditable BODY it carries focusable but no `editable` at all.) An
    // editable ROOT therefore stays visible; it prints as a nameless interactive
    // and becomes the container of its own children, which it genuinely is.
    // Every other structural role keeps its meaning — descendants of an editable
    // region carry `editable` too, and isEditableRoot is what tells them apart.
    const structural =
      !role ||
      role === "none" ||
      (role === "generic" && !isEditableRoot(node)) ||
      role === "InlineTextBox" ||
      TEXT_LEVEL_ROLES.has(String(role).toLowerCase());
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
 * Whether an agent can ACT on this node — the ONE predicate that decides which
 * elements mint a uid. Shared with `unlabeledInteractiveIds` so a hint looked up
 * by the caller can never describe a node the renderer does not print, nor miss
 * one it does.
 */
export function isActionableNode(node, role, name, value) {
  if (INTERACTIVE_ROLES.has(role)) return true;
  // An Iframe is almost always NAMELESS, so both of these must be decided
  // BEFORE the nameless gate below or they never fire at all.
  //
  // The Iframe itself: its uid is the handle for a frame-scoped snapshot or
  // screenshot, the only thing that ties a trailing frame block back to a place
  // in the main tree, and a click target of last resort.
  if (role === "Iframe") return true;
  // The ROOT of an editable region — a contenteditable div or body, or the
  // RootWebArea of a designMode frame, which is where a rich-text editor
  // (TinyMCE and friends) puts the caret. Such a root is opaque-named or
  // nameless, so the focusable branch below skips it and these editors had no
  // uid anywhere: visible, and impossible to type into. It must be decided by
  // isEditableRoot and not by `editable` alone — see there for the measurement
  // showing every descendant carries `editable` as well.
  if (isEditableRoot(node)) return true;
  // Clickable-in-practice surfaces: named table/tree rows and cells, named
  // drawn surfaces (map/app containers), plus anything the page marked
  // focusable (accordion headers, custom widgets). Opaque containers are
  // excluded from the FOCUSABLE branch — RootWebArea and friends report
  // focusable without being a target anyone means to click.
  if (!name && !value) return false;
  return (
    NAMED_CLICKABLE_ROLES.has(role) ||
    NAMED_CONTAINER_UID_ROLES.has(role) ||
    (axProp(node, "focusable") === true && !OPAQUE_NAME_ROLES.has(role))
  );
}

/**
 * backendNodeIds of interactive nodes the accessibility tree cannot name AT
 * ALL: no name, no value, and no description either — so even the `title`
 * fallback has nothing to print. These are the `[e48] button ""` lines an agent
 * cannot tell apart. The caller looks up a short DOM identifier for them and
 * passes it back through `renderAxTree`'s `hints`; that lookup stays outside
 * this module because it costs a CDP round trip per node, which a pure
 * renderer has no business spending.
 */
export function unlabeledInteractiveIds(nodes) {
  const ids = new Set();
  walkAxNodes(nodes, undefined, (node, role, name, value) => {
    if (name || value || node.backendDOMNodeId == null) return;
    if (!isActionableNode(node, role, name, value)) return;
    if (String(node.description?.value ?? "").trim()) return;
    ids.add(node.backendDOMNodeId);
  });
  return [...ids];
}

/**
 * Render one session's AX tree as the INTERACTION view: every actionable
 * element gets a uid the agent can pass to click/type.
 *
 * `mintUid(backendNodeId)` is called for each actionable element, in output
 * order, and returns the uid to print. The caller owns the uid counter so that
 * numbering stays continuous across a page's frames.
 *
 * `hints` is an optional Map of backendNodeId → DOM identifier, printed only
 * beside a label that would otherwise be empty (see unlabeledInteractiveIds).
 *
 * `opts.startBackendNodeId` scopes the render to one subtree (a frame body, a
 * dialog), returning null when no node carries that id — the same stale-uid
 * contract renderAxText has. `opts.frameLabels` is a Map of backendNodeId →
 * frame label: a frame's tree is rendered as its own block AFTER the main one,
 * and without a marker on the owning `Iframe` line there was nothing tying a
 * trailing RootWebArea block to the place in the page it came from. Calling
 * with no `opts` at all renders exactly as it did before it existed.
 *
 * Read off `opts` rather than destructured in the parameter list, because a
 * default only covers `undefined`: a caller passing `null` for "no options" —
 * the natural shape of `frameLabels ? { frameLabels } : null` — would otherwise
 * throw here and take out every snapshot on the page, not just the frame part.
 */
export function renderAxTree(nodes, mintUid, hints, opts) {
  const { startBackendNodeId, frameLabels } = opts || {};
  const lines = [];
  /** Full href -> { index, name } of the one line kept for that destination. */
  const byHref = new Map();
  /** Resolved once per render: what makes a link a SAME-DOCUMENT fragment. */
  const docUrl = documentUrl(nodes);
  /** The inline-text run currently open: { container, index, text, segments, covered }. */
  let run = null;
  /** The row whose cells the last PUSHED line holds, or null for anything else. */
  let openRow = null;
  /**
   * Close the open run, dropping it when it only re-spells its own container's
   * label. A `<mark>` keyword highlight splits a sentence MID-word, so the
   * fragments do not sit on token boundaries of the parent label and each one
   * survives `containsAsToken` on its own — the rejoined run then printed the
   * container's sentence a SECOND time, verbatim. Whitespace-insensitive
   * because the split loses the spaces too. This only ever SEES those fragments
   * because `TEXT_LEVEL_ROLES` makes the highlight wrapper structural; while it
   * was a container of its own, the fragments landed in separate runs and walked
   * straight past this check.
   *
   * Only a JOINED run (≥ 2 segments) may be dropped: a lone StaticText that
   * sits inside a longer ancestor label is the calendar case, where "26" under
   * "달력 2026.08.08" is real content the page would otherwise lose.
   *
   * Suppression NULLS the slot instead of splicing — byHref holds line indices
   * that must stay valid for the rest of the walk; the nulls are filtered out
   * once, at the end.
   *
   * The container's label is not the only copy of the sentence to check against:
   * where the page carries the plain sentence as its OWN line, the fragment run
   * matches nothing's label and used to print beside it, garbled. So the run is
   * also tested against the line before it and against `incoming` — the line
   * about to be pushed — which covers the plain copy arriving on either side.
   * See runEchoesLine for why that test is ordered-with-holes, not `includes`.
   */
  const closeRun = (incoming) => {
    if (run && run.segments.length > 1) {
      const joined = stripSpaces(run.text);
      const echoesContainer =
        Boolean(run.covered && joined) && stripSpaces(run.covered).includes(joined);
      if (
        echoesContainer ||
        runEchoesLine(run.segments, precedingLine(lines, run.index)) ||
        runEchoesLine(run.segments, incoming)
      ) {
        lines[run.index] = null;
      }
    }
    run = null;
  };
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered, container) => {
    const interactive = isActionableNode(node, role, name, value);
    // Nameless NON-interactive nodes are noise, but a nameless interactive
    // element (an unlabeled rich-text editor, an icon-only button) still
    // needs a uid — dropping those made such editors unreachable entirely.
    const worthPrinting = Boolean(name || value || interactive);
    // An echo of an ancestor's label. Interactive nodes are exempt: their
    // line carries the uid, which nothing else can supply.
    const echoed = !interactive && !value && Boolean(name) && containsAsToken(covered, name);
    if (!worthPrinting || echoed) return;
    const href = linkHref(node, role, docUrl);
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
      const label = name || described;
      // Nothing in the accessibility tree names this control. The caller's DOM
      // hint (#id, class, input type, icon label) is then the only thing that
      // tells one `button ""` line from the next.
      const hinted = !label && !value ? hints?.get?.(node.backendDOMNodeId) || "" : "";
      const hint = hinted ? ` (dom: ${hinted})` : "";
      const state = stateFlags(node);
      // Last on the line, after everything describing the element itself: this
      // says where the element's CONTENTS were printed, not what it is.
      const frame = frameLabels?.get?.(node.backendDOMNodeId);
      const framed = frame ? ` (frame ${frame})` : "";
      return uid
        ? `[${uid}] ${role} "${label}"${value ? ` = "${value}"` : ""}${state}${hint}${url}${framed}`
        : `${role} "${name || value || described}"${state}${url}${framed}`;
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
    // the run into the paragraph it was; a different container breaks it, and a
    // LANDMARK container never joins at all (see NON_JOINING_CONTAINERS).
    const inRun =
      role === "StaticText" &&
      !interactive &&
      !href &&
      !value &&
      Boolean(name) &&
      joinsRuns(container);
    if (inRun && run && run.container === container) {
      run.text += ` ${name}`;
      run.segments.push(name);
      lines[run.index] = `StaticText "${run.text}"`;
      return;
    }
    // Rendered BEFORE the run closes, so the closing check can see the line
    // about to land beside it. format() mints only a uid counter tick, and it
    // happens at the same point of the walk either way, so the numbering the
    // agent reads is untouched by this ordering.
    const line = format();
    closeRun(line);
    // The reading view has kept a table's rows on one line for a while; the
    // snapshot view printed one line per cell, so a 650-cell finance table made
    // the agent COUNT columns to work out where a row began. Join a row's cells
    // with " | " here too. Each cell keeps its own full rendering, uid
    // INCLUDED, so nothing loses addressability, and the joined line still
    // starts with the first cell's — which is what capSnapshot's uid-first
    // keep classifies it by.
    const inRow = CELL_ROLES.has(role) && ROW_ROLES.has(container?.role?.value);
    if (inRow && openRow === container && lines[lines.length - 1] != null) {
      lines[lines.length - 1] += ` | ${line}`;
      return;
    }
    openRow = inRow ? container : null;
    if (inRun) run = { container, index: lines.length, text: name, segments: [name], covered };
    if (href) byHref.set(href, { index: lines.length, name });
    lines.push(line);
  });
  closeRun();
  return found ? lines.filter((line) => line !== null) : null;
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
  const closeTextRun = (incoming) => {
    if (last?.kind === "text" && last.segments.length > 1) {
      const joined = stripSpaces(lines[last.index] ?? "");
      const echoesContainer =
        Boolean(last.covered && joined) && stripSpaces(last.covered).includes(joined);
      if (
        echoesContainer ||
        runEchoesLine(last.segments, precedingLine(lines, last.index)) ||
        runEchoesLine(last.segments, incoming)
      ) {
        lines[last.index] = null;
      }
    }
  };
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered, container) => {
    const echoed = !value && Boolean(name) && containsAsToken(covered, name);
    if ((!name && !value) || echoed) return;
    const printed = name && value ? `${name}: ${value}` : name || value;
    // Inline prose: consecutive StaticText under ONE container is a single
    // paragraph that a per-word <span> soup had split into a word per line — but
    // never under a LANDMARK, where the shared container means only "same page",
    // not "same block" (see NON_JOINING_CONTAINERS).
    const inTextRun = role === "StaticText" && joinsRuns(container);
    if (inTextRun && last?.kind === "text" && last.container === container) {
      lines[last.index] += ` ${printed}`;
      last.segments.push(printed);
      return;
    }
    // A table read as a vertical list of cells loses the thing that made it a
    // table. Keep each row on one line, its cells separated by " | ".
    const inRow = CELL_ROLES.has(role) && ROW_ROLES.has(container?.role?.value);
    if (inRow && last?.kind === "cell" && last.container === container) {
      lines[lines.length - 1] += ` | ${printed}`;
      return;
    }
    closeTextRun(printed);
    lines.push(printed);
    last = inTextRun
      ? { kind: "text", container, index: lines.length - 1, segments: [printed], covered }
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
