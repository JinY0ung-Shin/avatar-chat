# Browser bridge — snapshot and reading-view rendering

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> Atom budgeting, state flags, table rows, respacing, links and images, and the nine `axtree.js` rules.

- **Snapshots are budgeted uid-first, and the budget unit is an ATOM, not a physical line.**
  `capSnapshot` (extension side, `axtree.js`) fits every snapshot into its character budget
  (`SNAPSHOT_MAX_CHARS` 30000 by default, tightenable per call — next bullet) by keeping `[uid]` atoms
  before prose — cut TEXT is recoverable via offset-chunked `read_text`, a cut uid is unreachable — and
  says what it dropped. The builders hand it the renderer's lines ARRAY (one entry per element; a
  textbox value can hold newlines): under a tightened `maxChars`, per-physical-line keeping cut a
  GitHub blob's 44.7 KB textbox value into NON-contiguous pieces with no marker and no closing quote,
  different on every call. An atom is kept or dropped whole; a uid atom too big to keep whole is
  HEAD-kept AFTER the whole-atom uid pass (so one oversized value cannot cost the page's other
  elements their uids) with a `[cut by the maxChars budget: … read_text (uid eN) …]` marker. String
  input still splits per line (legacy callers);
  `browserTools.report()` keeps a coarser defensive cap for old installed builds. Related renderer
  choices: links print their AX `url` property (`→ https://…`, so results can be compared without a
  click-and-load per candidate), NAMED table/tree rows and focusable non-opaque nodes mint uids
  (`NAMED_CLICKABLE_ROLES` — draw.io-style `<tr>` menus were visible but unclickable), and input ops
  focus via `focusForInput`, which falls back to a real centre click when `DOM.focus` refuses
  (ProseMirror bodies, canvases).
- **`snapshot` takes `uid` and `maxChars`; since 0.16.0 EVERY snapshot-returning action takes
  `maxChars` too, and `wait_for` returns no snapshot at all.** All optional, all full five-layer fields
  (`browserTools` zod → `BrowserRequest` → `routes/chat.ts` relay → `BridgeOperation` →
  `background.js`) — though widening `maxChars` to the 12 action tools needed NO wire work, because the
  chat relay always forwarded the field for every op; only the tool schemas (one shared
  `MAX_CHARS_SCHEMA`) and the extension's `op === "snapshot"` gate had to move. `uid` renders only that
  element's subtree (a frame header's uid scopes into that frame) and a dead uid raises read_text's
  re-snapshot error, not a silent whole-page fallback. `maxChars` tightens `capSnapshot`'s budget and is
  RE-CLAMPED extension-side to [2000, 30000], so the wire value can only ever shrink the cap.
  `wait_for` skips the action tail's snapshot read entirely (its own match loop still walks uncapped):
  one yes/no answer used to cost ~25 KB of page walk. Old builds ignore all of this and keep returning
  full snapshots — a degrade, not a break, which is why `BROWSER_EXTENSION_MIN_COMPATIBLE` stays 0.6.0.
- **Snapshots print STATE, so a toggle click can be VERIFIED instead of assumed** (`stateFlags`):
  `[checked]`/`[unchecked]`/`[checked=mixed]` and `[pressed]`/`[unpressed]`/`[pressed=mixed]` print
  BOTH ways — "not checked" is exactly the fact a verifying read is after — while `[selected]` and
  `[disabled]` print only when true (every option in a listbox is unselected and every control is
  enabled; the false form is pure noise). `[expanded]`/`[collapsed]` covers disclosures. Read through
  `axStateFlag`, which normalizes Chrome's boolean-or-string delivery to true/false/"mixed"/undefined —
  a raw truthiness read printed half a page's checked boxes as unchecked. Range controls
  (slider/spinbutton) additionally print `[min 0 max 5]` via `rangeFlags` from the AX
  `valuemin`/`valuemax` properties — `slider = "5"` alone gave an agent no scale to aim at. `step` is
  deliberately NOT printed or read from AX: measured (`tests/visual/ax-facts.spec.ts`), Chrome does not
  expose it there at all, so the slider driver reads the DOM `step` attribute only.
- **BOTH views group a table ROW onto one line, and membership is found by CLIMBING, not by one hop.**
  One line per cell made a 650-cell finance table force the agent to COUNT columns to find where a row
  began — but the original `container.role ∈ ROW_ROLES` test broke on every REAL table: a cell whose
  text lives on a nested LINK is itself nameless (never printed), and the link's container is the CELL,
  not the row, so Wikipedia's GDP table printed the rank on its own line and split its header row into
  six. Each renderer now keeps a per-render `parentOf` map and climbs it (`rowChain`, 25-hop bound):
  a piece whose nearest row matches the open row APPENDS — ` | ` when its nearest CELL changed; more of
  the SAME cell is GLUED in the reading view (`glueSegments`, space only at a word|word seam, so a
  footnote marker reads back as `China[n 1]` like the page; the snapshot view keeps the space, its
  pieces are decorated renderings) — and a row slot nulled by run suppression starts a fresh line
  rather than resurrecting a deleted duplicate. Cells keep their full rendering, uid included, and the
  joined line still starts with the first cell's, which is what `capSnapshot`'s uid-first keep
  classifies it by.
- **The snapshot view is INDENTED by emitted depth, and single values are PRINT-CAPPED with markers.**
  `walkAxNodes` passes `emit` a depth (emitting ancestors only); `renderAxTree` prefixes one space per
  level (cap 12 — indentation is budget), which is what lets an agent tell a submenu from its parent
  and a review from the card above it. Every in-place rewrite keeps the indent of the position it
  rewrites (runs, byHref upgrades, row appends), and `capSnapshot`'s uid regex tolerates the leading
  spaces. A value longer than `VALUE_PRINT_MAX` (3000) prints with an explicit
  `[value truncated: showing N of M chars — read the full text with mcp__browser__read_text (uid eK)]`
  marker (names: 1000, `[label truncated: …]`); the caps apply to the PRINTED line only — echo
  suppression, run joining and href identity compare RAW strings, and `renderAxText` never clips, since
  it is the recovery channel the marker names. Field case: a GitHub blob view's hidden textarea
  (44.7 KB file) ate 504 of 1204 snapshot lines and served silently corrupted text. Probe-measured
  (`tests/visual/ax-facts.spec.ts`): Chrome does NOT truncate AX values (42 000 chars round-trip
  byte-identical), so that corruption was the PAGE's own virtualized DOM re-windowing the textarea —
  unfixable from here; the marker is what stops partial text posing as complete.
- **A name is RE-SPACED only when it is EXACTLY the concatenation of its descendants' text.**
  Chrome computes some names by welding descendant text together with no separators — a Naver Maps
  place button arrives as `button "영업 종료별점 4.76리뷰7,262TV 식스센스"` — and the separated child
  texts that could have been read instead are then deleted as a run-level ECHO of that very name, so
  the structure was unrecoverable. `respacedName` (inside `walkAxNodes`, feeding both renderers AND
  ancestor coverage) accepts only when `segments.join("") === rawName` (≥ 2 segments, 300-node bound):
  the looser strip-spaces equality would re-space text the page never split ("검색어 광교역" →
  "검색어 광교 역", inventing a boundary inside a place name), and the walk aborts on TEXT_LEVEL
  wrappers, which split runs MID-word by construction. Segments are not StaticTexts only: a NAMED
  descendant contributes its NAME and is not walked into (accname semantics — star-rating rows carry
  their rating on an image's alt, and StaticText-only collection could never reconstruct those names,
  so they stayed welded). Accepted seams are GLUED, not blanket-spaced (`glueSegments`: a space only
  between letter/digit and letter/digit) — `Search for "` + `Accessibility tree` + `"` and footnote
  links `[` + `n 2` + `]` must come back exactly as the page wrote them, and the same rule runs every
  rejoin site (both renderers' inline runs, read_text same-cell appends), which is also what fixed
  read_text's `request a new article .` space-before-period.
- **A NAMED image outside every interactive ancestor mints a uid — and a SURFACE is not an
  "interactive ancestor".** Naver map markers surface as `image "음식점"` with nothing clickable above
  them, so reaching one was a click_at pixel gamble; but blanket image-uids would double a SERP with
  refs whose real click target is the wrapping link. `renderAxTree` tracks `interactiveOf` per emitted
  node and climbs `parentOf`: a link/button/named-row ancestor suppresses the image's uid, while
  `SURFACE_ROLES` (`region`/`application`/`canvas` — the map body itself, which mints a uid as a
  coordinate PLANE, not as the click target) are climbed PAST, because counting them re-lost exactly
  the markers the rule exists for. The ancestor test lives in the renderer, NOT in `isActionableNode` —
  that predicate is per-node and shared with `unlabeledInteractiveIds`, which has no chain to walk.
  Chrome's role string is `image` (probe-verified; `img` also tolerated). A marker's NEIGHBOURING label
  is FOLDED onto its line: 47 markers all named `image "음식점"` were clickable but indistinguishable, so
  a plain StaticText that lands immediately after a marker-minted image line (same container, ≤ 120
  chars, no value) rewrites that line to `image "음식점 <shop name>"` and is consumed — it never opens a
  run, joins a row, or mints anything (`pendingMarker`; `format()` returns `{line, uid, suffix}` so the
  rewrite cannot mint a second uid).
- **A link is never folded out of RUNNING PROSE, and the reading view keeps links in their sentence.**
  byHref folding deleted Wikipedia's mid-sentence "log in or create an account" (same href as the
  Personal-tools menu link printed far above), leaving "You need to and be autoconfirmed". An open
  StaticText run sharing the link's container marks the sentence as still being written: such a link
  prints instead of folding (SERP duplicates have no run beside them and fold as before). In
  `renderAxText`, a named link JOINS the text run outright — in the reading view a mid-sentence link is
  a word of the sentence, and breaking the line at it left prose in stubs.
- **Nine `axtree.js` rules exist because each one silently DELETED, DROWNED, or made UNREACHABLE real
  page content.**
  (1) `AXValue.value` is not always a string — a slider/spinbutton reports a number and `.trim()` threw,
  failing all three read tools on the whole page; both name and value are `String(… ?? "")`, with `??`
  not `||` so a numeric 0 prints as "0". (2) Echo suppression matches on TOKEN boundaries
  (`containsAsToken`), not `String.includes`: a substring hit let an ancestor label like
  "달력 2026.08.08" swallow every calendar cell named "2"/"8"/"20"/"26" — but a needle whose own edge
  IS a boundary character carries that boundary with it (a `[n 1]` link under a `China[n 1]` cell sits
  at a non-boundary `a` and printed the reference twice; digits-at-both-ends needles like "26" still
  demand real boundaries). Lines that are nothing but an EMPTY bracket pair (`( )`, `[ ]` — an opener
  AND a closer required, so a source listing's lone `}` survives) are dropped at both renderers' final
  filter, never a `[uid]` line. (3) `walkAxNodes` passes each
  emission its nearest emitting ancestor as `container`, which is what lets both renderers rejoin a
  paragraph that per-word `<span>`s split into a word per line, and lets `renderAxText` keep a table's
  row on one ` | `-separated line (`CELL_ROLES` inside `ROW_ROLES`) instead of a vertical list of cells.
  (4) `renderAxTree` folds links sharing a FULL href onto one line at the first occurrence's position,
  upgrading it in place when a later duplicate carries a longer name — one SERP result arrives as four
  to six links to the same destination. `linkHref` returns the URL untruncated because it is the dedupe
  identity; `printableUrl` applies `LINK_URL_MAX`, now 500 — a query with its tracking parameters or a
  doc anchor has to survive WHOLE, since a truncated URL names a target no tool can follow, which is
  worse than printing none; the cap still bounds what it exists for (data: URIs, tracker payloads).
  SAME-DOCUMENT fragment links are excluded from folding entirely: Chrome hands `href="#edit"` back
  ALREADY RESOLVED as `https://site/page#edit`, so it walked straight past the literal `#` test, every
  row of a ten-row table shared ONE href, and rows 2-10 lost their edit/delete links SILENTLY — no line
  in the snapshot at all. `documentUrl` (the RootWebArea's own url, its own fragment stripped because a
  page LOADED at an anchor reports one) is resolved ONCE per render and compared via `stripFragment`, so
  a `#sec` pointing at ANOTHER page stays a real destination and folds as before.
  Three later rules answer the same class of failure:
  (5) NAMED `region`/`application` containers mint uids (`NAMED_CONTAINER_UID_ROLES`) — a map's drawn
  body has no accessible children at all, so the container's own uid is the only thing click_at's uid
  mode can aim at; nameless ones stay structure, and `region` remains in `OPAQUE_NAME_ROLES` (a uid says
  "actionable", not "my name covers my subtree"). (6) `renderAxTree` falls back to the AX `description`
  (where a `title` attribute lands) when an interactive node has neither name nor value, so a page of
  icon-only `button ""` lines becomes distinguishable; it never replaces a real name and never feeds
  ancestor coverage. (7) Echo suppression is TWO-layered: per-node token matching, plus a RUN-level
  whitespace-insensitive check at close — a `<mark>` highlight splits a sentence mid-word, so no fragment
  sits on a token boundary and the rejoined run repeated the container's whole label as a second line.
  Only runs of ≥ 2 segments may be dropped (a lone StaticText inside a longer label is the calendar
  case, rule 2), and suppression NULLS the slot, filtered out once at the end, because `byHref` holds
  line indices that must stay valid for the rest of the walk. (8) Inline TEXT-LEVEL SEMANTIC roles are
  STRUCTURAL (`TEXT_LEVEL_ROLES` — `mark`/`strong`/`emphasis`/`superscript`/`subscript`/`deletion`/
  `insertion`, the exact strings Chrome emits for `<mark>`/`<strong>`/`<em>`/`<sup>`/`<sub>`/`<del>`,`<s>`/
  `<ins>`, verified against `getFullAXTree`; `<b>`/`<i>`/`<span>` already arrive as `generic`). Rule 7
  alone was not enough: the highlight wrapper printed NOTHING yet still became the `container` of the
  fragment inside it while the rest of the sentence sat on the real container, so the halves never joined
  into one run and the ≥2-segment suppression never saw them — an autocomplete option re-spelled its own
  label as two extra lines. `code` and `time` are deliberately excluded: `<pre><code>` is a block, and
  dissolving it would glue a listing into the surrounding prose. (9) An interactive node with NO name, no
  value and no description gets a DOM hint printed beside its empty label
  (`[e48] button "" (dom: #map-zoom-in)`). `axtree.js` stays pure — `unlabeledInteractiveIds` only NAMES
  the nodes worth asking about (through `isActionableNode`, the one interactive predicate it now shares
  with `renderAxTree` so the two cannot drift), and `background.js` does the asking: `buildDomHint`
  (`DOM.describeNode` depth 2 → `#id`, else two class tokens, else an input's `type`, else a nested
  img/svg's alt/aria-label/title or the first text, clipped to `HINT_MAX_CHARS` 60), at most
  `HINT_FETCH_PER_SNAPSHOT` (8) UNCACHED lookups per snapshot, cached in `hintByNode` keyed exactly like
  `uidByNode` — misses cached as `""` so they are not re-paid, swept by `forgetTabRefs` (by key prefix, so
  a hint cannot outlive its tab even if the uid was already evicted) and cleared with the `REF_MAP_MAX`
  eviction. `renderAxText` gets NO hints: the reading view has no uids to disambiguate.
