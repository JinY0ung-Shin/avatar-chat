import { describe, expect, it } from "vitest";
// Kept on ONE line: @ts-expect-error only covers the line after it, and the
// error is raised on the module specifier — the LAST line of a wrapped import.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { renderAxTree, renderAxText, capSnapshot, mergeTextLines, unlabeledInteractiveIds, axValueAnswer, clearFailed, sliderPlan } from "../extension/axtree.js";

/** Terse builder for the shape Accessibility.getFullAXTree returns. */
function node(
  nodeId: string,
  role: string,
  name?: string,
  childIds: string[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    nodeId,
    role: { value: role },
    ...(name === undefined ? {} : { name: { value: name } }),
    childIds,
    ...extra,
  };
}

const uids = () => {
  let seq = 0;
  return () => `e${++seq}`;
};

const render = (nodes: unknown[]) => renderAxTree(nodes, uids()) as string[];

/**
 * The two halves of an editable region, as a real Chromium probe reported them
 * over CDP: the ROOT carries editable AND focusable, while every descendant
 * (paragraphs, StaticTexts, InlineTextBoxes, a textarea's inner generic) carries
 * editable ALONE. Telling them apart is the whole rule.
 */
const editableRoot = () => ({
  properties: [
    { name: "editable", value: { value: "richtext" } },
    { name: "focusable", value: { value: true } },
  ],
});
const editableDescendant = () => ({
  properties: [{ name: "editable", value: { value: "richtext" } }],
});

/**
 * The naver shape: the page holds one sentence TWICE — once whole, and once
 * split around the highlighted keywords ("시럽", "단맛"), whose own text nodes
 * never reach the renderer. The split copy is therefore a substring of nothing,
 * so container-label suppression cannot see it and both lines used to print,
 * the second one garbled. Built in both orders, since the whole copy can arrive
 * on either side of the fragments.
 */
const HIGHLIGHT_SENTENCE = "저당 시럽이라 달달한 단맛을 돋보이게 하는 브랜드.";
const highlightDuplicate = (order: "plain-first" | "run-first") => [
  node("root", "RootWebArea", "검색", order === "plain-first" ? ["plain", "split"] : ["split", "plain"]),
  node("plain", "paragraph", "", ["full"]),
  node("full", "StaticText", HIGHLIGHT_SENTENCE),
  node("split", "paragraph", "", ["f1", "f2", "f3"]),
  node("f1", "StaticText", "저당 "),
  node("f2", "StaticText", "이라 달달한 "),
  node("f3", "StaticText", "을 돋보이게 하는 브랜드."),
];

/**
 * The Wikipedia edit-notice shape: a link sits MID-SENTENCE and reaches the
 * same destination as a menu link printed far above it. Folding deleted it out
 * of the middle of the sentence, which shipped as "You need to and be
 * autoconfirmed" — a sentence with a hole where an agent cannot see one.
 */
const inlineLinkProse = () => {
  const login = { name: "url", value: { value: "https://x/login" } };
  return [
    node("1", "RootWebArea", "문서", ["nav", "para"]),
    node("nav", "navigation", "", ["menu"]),
    node("menu", "link", "로그인", [], { backendDOMNodeId: 11, properties: [login] }),
    node("para", "paragraph", "", ["t1", "inline", "t2"]),
    node("t1", "StaticText", "이 문서를 편집하려면"),
    node("inline", "link", "로그인하거나 계정을 만들어야", ["it"], {
      backendDOMNodeId: 12,
      properties: [login],
    }),
    node("it", "StaticText", "로그인하거나 계정을 만들어야"),
    node("t2", "StaticText", "합니다"),
  ];
};

describe("renderAxTree", () => {
  it("prints a link once, not again as the text inside it", () => {
    // The doubling that made every snapshot twice as expensive to read.
    const lines = render([
      node("1", "RootWebArea", "Docs", ["2"]),
      node("2", "link", "Parsoid", ["3"], { backendDOMNodeId: 42 }),
      node("3", "StaticText", "Parsoid"),
    ]);
    expect(lines).toEqual(['RootWebArea "Docs"', ' [e1] link "Parsoid"']);
  });

  it("drops an intermediate heading that only echoes its link", () => {
    // A Google result is link > heading > StaticText, all the same words.
    const lines = render([
      node("1", "link", "제목 example.com", ["2"], { backendDOMNodeId: 7 }),
      node("2", "heading", "제목", ["3"]),
      node("3", "StaticText", "제목"),
    ]);
    expect(lines).toEqual(['[e1] link "제목 example.com"']);
  });

  it("keeps body text that merely repeats a word from the page title", () => {
    // RootWebArea's name is the tab title, NOT a label built from the text
    // under it. If it were allowed to cover its subtree, every mention of the
    // subject would vanish from the article.
    const lines = render([
      node("1", "RootWebArea", "위키백과의 신뢰도", ["2"]),
      node("2", "StaticText", "위키백과"),
    ]);
    expect(lines).toEqual(['RootWebArea "위키백과의 신뢰도"', ' StaticText "위키백과"']);
  });

  it("keeps prose that is not contained in any ancestor label", () => {
    const lines = render([
      node("1", "link", "짧은 라벨", ["2"], { backendDOMNodeId: 3 }),
      node("2", "StaticText", "이건 라벨에 없는 새로운 문장이다"),
    ]);
    expect(lines).toEqual([
      '[e1] link "짧은 라벨"',
      ' StaticText "이건 라벨에 없는 새로운 문장이다"',
    ]);
  });

  it("emits in document order, not in the order Chrome listed the nodes", () => {
    // Both StaticTexts hang off the RootWebArea, which is a LANDMARK: sharing
    // one says only "same page", so they stay two lines (they briefly rendered
    // as one joined run — see the "0 Powered by" case below). Document order is
    // what this pins either way.
    const lines = render([
      node("3", "StaticText", "셋째"),
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "StaticText", "둘째"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' StaticText "둘째"', ' StaticText "셋째"']);
  });

  it("still gives a uid to a nameless interactive element", () => {
    // An icon-only button or an unlabeled rich-text editor: unreachable if the
    // walk drops it for having no name.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "textbox", "", [], { backendDOMNodeId: 9 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] textbox ""']);
  });

  it("prints a field's value even when the label repeats an ancestor", () => {
    // Suppressing this would hide what the user actually typed.
    const lines = render([
      node("1", "form", "검색", ["2"]),
      node("2", "combobox", "검색", [], { backendDOMNodeId: 5, value: { value: "위키백과" } }),
    ]);
    expect(lines).toEqual(['form "검색"', ' [e1] combobox "검색" = "위키백과"']);
  });

  it("mints uids in output order so they match what the agent reads", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "button", "첫째", [], { backendDOMNodeId: 1 }),
      node("3", "button", "둘째", [], { backendDOMNodeId: 2 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] button "첫째"', ' [e2] button "둘째"']);
  });

  it("prints nodes detached from every root instead of losing them", () => {
    // A frame can mutate mid-walk and leave a subtree with no reachable parent.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "StaticText", "붙어 있음"),
      node("9", "StaticText", "떨어져 있음", [], { parentId: "404" }),
    ]);
    expect(lines).toContain('StaticText "떨어져 있음"');
  });

  it("survives a cycle in childIds without hanging", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "StaticText", "루프", ["1"]),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' StaticText "루프"']);
  });

  it("skips ignored nodes but keeps walking through them", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "StaticText", "숨겨짐", ["3"], { ignored: true }),
      node("3", "button", "보임", [], { backendDOMNodeId: 4 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] button "보임"']);
  });

  it("prints a link's destination from the AX url property", () => {
    // Without the href, choosing between several results means clicking each
    // one and paying a full page load per candidate.
    const lines = render([
      node("1", "link", "결과 하나", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: "https://example.com/a" } }],
      }),
    ]);
    expect(lines).toEqual(['[e1] link "결과 하나" → https://example.com/a']);
  });

  it("omits javascript: and same-document fragment link urls", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "link", "메뉴", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: "javascript:void(0)" } }],
      }),
      node("3", "link", "위로", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "url", value: { value: "#top" } }],
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] link "메뉴"', ' [e2] link "위로"']);
  });

  it("prints an ordinary long query url WHOLE, and truncates only a dump", () => {
    // The cap was 150, which cut the tail off perfectly ordinary links (a search
    // query with its tracking parameters) and left a string that identifies the
    // target but that no tool can open — worse than printing nothing. 500 keeps
    // those whole and still bounds the data:/tracker dumps the cap exists for.
    const ordinary = `https://example.com/search?q=${"a".repeat(300)}`;
    const kept = render([
      node("1", "link", "검색 결과", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: ordinary } }],
      }),
    ]);
    expect(kept[0]).toContain(ordinary);
    expect(kept[0]).not.toContain("…");

    const dump = `https://example.com/${"x".repeat(900)}`;
    const cut = render([
      node("1", "link", "긴 링크", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: dump } }],
      }),
    ]);
    expect(cut[0]).toContain("…");
    expect(cut[0].length).toBeLessThan(560);
  });

  it("gives a uid to a NAMED table-row menu item, but not to a nameless cell", () => {
    // draw.io's submenu rows render as LayoutTableCell — with no uid they were
    // visible but unclickable, making whole menus unreachable.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "LayoutTableCell", "다이어그램 편집...", [], { backendDOMNodeId: 7 }),
      node("3", "LayoutTableCell", "", [], { backendDOMNodeId: 8 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] LayoutTableCell "다이어그램 편집..."']);
  });

  it("gives a uid to a named focusable node, but not to a focusable opaque container", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"], {
        backendDOMNodeId: 1,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
      node("2", "heading", "섹션 열기", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] heading "섹션 열기"']);
  });

  it("gives a uid to a nameless canvas so canvas apps can be focused", () => {
    // This fixture used to say lowercase "canvas" and passed while every REAL
    // canvas failed: Chrome COMPUTES a plain <canvas> as CamelCase "Canvas"
    // (like RootWebArea/StaticText), so it matched nothing, counted as neither
    // named nor interactive, and vanished from the snapshot altogether —
    // leaving click_at's uid mode with no target on the whole page.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "Canvas", "", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] Canvas ""']);
    // An explicit role="canvas" still arrives lowercase, so both are matched.
    const authored = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "canvas", "", [], { backendDOMNodeId: 7 }),
    ]);
    expect(authored).toEqual(['RootWebArea "Doc"', ' [e1] canvas ""']);
  });

  it("gives a uid to a NAMED region, but not to a nameless one", () => {
    // A map's drawn body surfaces as `region "지도"` and nothing inside it has
    // an accessibility entry — without a uid on the region itself, click_at's
    // uid mode had no target at all and the map was unreachable. A nameless
    // region is page structure; minting it would flood the snapshot.
    const lines = render([
      node("1", "RootWebArea", "지도", ["2", "3"]),
      node("2", "region", "지도", [], { backendDOMNodeId: 7 }),
      node("3", "region", "", [], { backendDOMNodeId: 8 }),
    ]);
    expect(lines).toEqual(['RootWebArea "지도"', ' [e1] region "지도"']);
  });

  it("gives a uid to a named application container", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "application", "도면 편집기", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] application "도면 편집기"']);
  });

  it("keeps a named region's label from covering its children", () => {
    // A uid says "actionable", not "my name describes my subtree" — region
    // stays opaque, so text repeating its name is still real page content.
    const lines = render([
      node("1", "region", "공지", ["2"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "공지"),
    ]);
    expect(lines).toEqual(['[e1] region "공지"', ' StaticText "공지"']);
  });

  it("falls back to the AX description for a nameless interactive node", () => {
    // An icon-only button's `title` lands in the AX description. Ignoring it
    // printed a page of indistinguishable `button ""` lines.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "button", "", [], {
        backendDOMNodeId: 7,
        description: { value: " 길찾기 " },
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] button "길찾기"']);
  });

  it("never lets a description displace a real name", () => {
    const lines = render([
      node("1", "button", "저장", [], {
        backendDOMNodeId: 7,
        description: { value: "문서를 저장합니다" },
      }),
    ]);
    expect(lines).toEqual(['[e1] button "저장"']);
  });

  it("renders a node whose AX name and value are NUMBERS", () => {
    // AXValue is not always a string: a slider or spinbutton reports a number,
    // and .trim() on it threw — one zoom slider failed every read tool on the
    // whole page. A numeric 0 must print as "0", not vanish into "".
    const lines = render([
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "slider", undefined, [], {
        backendDOMNodeId: 7,
        name: { value: 0 },
        value: { value: 14 },
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "지도"', ' [e1] slider "0" = "14"']);
  });

  it("does not let a date-bearing ancestor label swallow short cell text", () => {
    // Substring coverage deleted a calendar's day numbers: every one of "2",
    // "8", "20", "26" occurs INSIDE "2026.08.08". Only whole-token echoes are
    // an echo.
    const lines = render([
      node("1", "grid", "달력 2026.08.08", ["2", "3", "4", "5"]),
      node("2", "cell", "", ["6"]),
      node("3", "cell", "", ["7"]),
      node("4", "cell", "", ["8"]),
      node("5", "cell", "", ["9"]),
      node("6", "StaticText", "26"),
      node("7", "StaticText", "2"),
      node("8", "StaticText", "8"),
      node("9", "StaticText", "20"),
    ]);
    expect(lines).toEqual([
      'grid "달력 2026.08.08"',
      '  StaticText "26"',
      '  StaticText "2"',
      '  StaticText "8"',
      '  StaticText "20"',
    ]);
  });

  it("keeps day headers whose text only occurs inside a longer word above", () => {
    // "일" and "월" appear in "8월 26일 토요일" but never as a token of their
    // own, so the weekday row must survive.
    const lines = render([
      node("1", "heading", "8월 26일 토요일", ["2", "4"]),
      node("2", "cell", "", ["3"]),
      node("3", "StaticText", "일"),
      node("4", "cell", "", ["5"]),
      node("5", "StaticText", "월"),
    ]);
    expect(lines).toEqual(['heading "8월 26일 토요일"', '  StaticText "일"', '  StaticText "월"']);
  });

  it("still suppresses a WHOLE-TOKEN echo of an ancestor label", () => {
    const lines = render([
      node("1", "link", "오늘 날씨", ["2"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "오늘"),
    ]);
    expect(lines).toEqual(['[e1] link "오늘 날씨"']);
  });

  it("joins a paragraph split into per-word spans into one line", () => {
    // A briefing panel wraps every word in its own <span>; unjoined, the
    // snapshot printed one word per line and buried the page's structure.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "paragraph", "", ["3", "4", "5"]),
      node("3", "generic", "", ["6"]),
      node("4", "generic", "", ["7"]),
      node("5", "generic", "", ["8"]),
      node("6", "StaticText", "오늘"),
      node("7", "StaticText", "서울에"),
      node("8", "StaticText", "폭염경보"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '  StaticText "오늘 서울에 폭염경보"']);
  });

  it("does not join text across two different containers", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "paragraph", "", ["4"]),
      node("3", "paragraph", "", ["5"]),
      node("4", "StaticText", "첫 문단"),
      node("5", "StaticText", "둘째 문단"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '  StaticText "첫 문단"', '  StaticText "둘째 문단"']);
  });

  it("breaks a text run at an interleaved non-StaticText element", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "paragraph", "", ["3", "4", "5"]),
      node("3", "StaticText", "앞"),
      node("4", "link", "링크", [], { backendDOMNodeId: 7 }),
      node("5", "StaticText", "뒤"),
    ]);
    expect(lines).toEqual([
      'RootWebArea "Doc"',
      '  StaticText "앞"',
      '  [e1] link "링크"',
      '  StaticText "뒤"',
    ]);
  });

  it("drops a joined run that only re-spells its container's label", () => {
    // A <mark> keyword highlight splits the sentence MID-word, so no fragment
    // sits on a token boundary of the link's label and each one survives echo
    // suppression alone — the rejoined run then printed the whole sentence a
    // SECOND time, right under the link that already said it.
    const lines = render([
      node("1", "link", "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데", ["2", "3", "4"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "옥수수 "),
      node("3", "StaticText", "크림 뇨끼"),
      node("4", "StaticText", "랑 홈메이드 라자냐 시켰는데"),
    ]);
    expect(lines).toEqual(['[e1] link "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데"']);
  });

  it("keeps a joined run that says something the ancestor label does not", () => {
    const lines = render([
      node("1", "link", "댓글 보기", ["2", "3"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "어제 갔던"),
      node("3", "StaticText", "가게"),
    ]);
    expect(lines).toEqual(['[e1] link "댓글 보기"', ' StaticText "어제 갔던 가게"']);
  });

  it("prints ONE line for an autocomplete option whose highlight split its text", () => {
    // The residual after run-level suppression shipped: the `<mark>` around the
    // matched keyword emitted namelessly (printing nothing) yet still became the
    // CONTAINER of the fragment inside it, while the rest of the text sat on the
    // option. The two halves never joined, so the ≥2-segment suppression never
    // saw them and the option's own label was re-spelled as two extra lines.
    const lines = render([
      node("1", "option", "검색어 광교역", ["2", "3", "4"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "검색어 "),
      node("3", "mark", "", ["5"]),
      node("4", "StaticText", "역"),
      node("5", "StaticText", "광교"),
    ]);
    expect(lines).toEqual(['[e1] option "검색어 광교역"']);
  });

  it("treats every inline text-level role as a phrasing wrapper, not a container", () => {
    // The exact role strings Chrome emits, verified against getFullAXTree:
    // <mark>/<strong>/<em>/<sup>/<sub>/<del>/<ins>. (<b>, <i>, <span> already
    // arrive as `generic`, which was structural all along.)
    for (const role of [
      "mark",
      "strong",
      "emphasis",
      "superscript",
      "subscript",
      "deletion",
      "insertion",
    ]) {
      const lines = render([
        node("1", "paragraph", "", ["2", "3", "5"]),
        node("2", "StaticText", "오늘"),
        node("3", role, "", ["4"]),
        node("4", "StaticText", "서울에"),
        node("5", "StaticText", "폭염경보"),
      ]);
      expect(lines, role).toEqual([' StaticText "오늘 서울에 폭염경보"']);
    }
  });

  it("still breaks the run at a code or time wrapper, which can be a block", () => {
    // Deliberately NOT text-level: `<pre><code>` is a block of its own, and
    // dissolving it would glue a code listing into the surrounding prose.
    for (const role of ["code", "time"]) {
      const lines = render([
        node("1", "paragraph", "", ["2", "3"]),
        node("2", "StaticText", "앞"),
        node("3", role, "", ["4"]),
        node("4", "StaticText", "뒤"),
      ]);
      // The wrapper EMITS (it is not text-level), so the text inside it sits
      // one level deeper — the indent says so, which is the point of it.
      expect(lines, role).toEqual([' StaticText "앞"', '  StaticText "뒤"']);
    }
  });

  it("keeps a SINGLE StaticText contained in its ancestor label", () => {
    // The ≥2-segment guard is what protects the calendar: "26" IS a substring
    // of "달력 2026.08.08" once whitespace is stripped, and whitespace-blind
    // suppression without that guard would delete the day numbers all over
    // again. One segment is never a mid-word highlight fragment.
    const lines = render([
      node("1", "grid", "달력 2026.08.08", ["2"]),
      node("2", "cell", "", ["3"]),
      node("3", "StaticText", "26"),
    ]);
    expect(lines).toEqual(['grid "달력 2026.08.08"', '  StaticText "26"']);
  });

  it("prints ONE line for several links to the same destination", () => {
    // A search result surfaces as thumbnail + title + source links, all to the
    // same href. The richest label wins, at the FIRST one's position, and the
    // line carries that element's uid.
    const url = { name: "url", value: { value: "https://news.example/a" } };
    const lines = render([
      node("1", "RootWebArea", "뉴스", ["2", "3", "4"]),
      node("2", "link", "", [], { backendDOMNodeId: 11, properties: [url] }),
      node("3", "link", "폭염 특보 확대 발령", [], { backendDOMNodeId: 12, properties: [url] }),
      node("4", "link", "연합뉴스", [], { backendDOMNodeId: 13, properties: [url] }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "뉴스"',
      ' [e2] link "폭염 특보 확대 발령" → https://news.example/a',
    ]);
  });

  it("prints a DOM hint beside a control the accessibility tree cannot name", () => {
    // `[e48] button ""` / `[e49] button ""` are indistinguishable, and with no
    // name, value OR title there is nothing in the AX tree left to print. The
    // hint the caller looked up in the DOM is the last thing that tells them
    // apart — and it never decorates a control that HAS a label.
    const lines = renderAxTree(
      [
        node("1", "RootWebArea", "Doc", ["2", "3", "4"]),
        node("2", "button", "", [], { backendDOMNodeId: 48 }),
        node("3", "button", "저장", [], { backendDOMNodeId: 49 }),
        node("4", "textbox", "", [], { backendDOMNodeId: 50, value: { value: "광교" } }),
      ],
      uids(),
      new Map([
        [48, "#map-zoom-in"],
        [49, "#save"],
        [50, ".search-input"],
      ]),
    ) as string[];
    expect(lines).toEqual([
      'RootWebArea "Doc"',
      ' [e1] button "" (dom: #map-zoom-in)',
      ' [e2] button "저장"',
      ' [e3] textbox "" = "광교"',
    ]);
  });

  it("renders unchanged when the caller passes no hints at all", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "button", "", [], { backendDOMNodeId: 48 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] button ""']);
  });

  it("leaves links with different destinations alone", () => {
    const lines = render([
      node("1", "RootWebArea", "목록", ["2", "3"]),
      node("2", "link", "첫째", [], {
        backendDOMNodeId: 11,
        properties: [{ name: "url", value: { value: "https://e.example/1" } }],
      }),
      node("3", "link", "둘째", [], {
        backendDOMNodeId: 12,
        properties: [{ name: "url", value: { value: "https://e.example/2" } }],
      }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "목록"',
      ' [e1] link "첫째" → https://e.example/1',
      ' [e2] link "둘째" → https://e.example/2',
    ]);
  });

  it("prints checkbox state, so a form can be read and a toggle verified", () => {
    // Deployed pages printed `checkbox ""` identically whether ticked or not:
    // the agent could not read a form back, and a click it made "verified"
    // against a line that never changes. Chrome sends the state as a real
    // boolean on some builds and as the STRING "true"/"false" on others, so a
    // `=== true` read prints half a page's checked boxes as unchecked — both
    // spellings are pinned here.
    const lines = render([
      node("1", "RootWebArea", "가입", ["2", "3"]),
      node("2", "checkbox", "약관 동의", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "checked", value: { value: true } }],
      }),
      node("3", "checkbox", "광고 수신", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "checked", value: { value: "false" } }],
      }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "가입"',
      ' [e1] checkbox "약관 동의" [checked]',
      ' [e2] checkbox "광고 수신" [unchecked]',
    ]);
  });

  it("prints a tri-state box as mixed instead of guessing which way it leans", () => {
    const lines = render([
      node("1", "checkbox", "전체 선택", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "checked", value: { value: "mixed" } }],
      }),
    ]);
    expect(lines).toEqual(['[e1] checkbox "전체 선택" [checked=mixed]']);
  });

  it("prints pressed, expanded/collapsed and disabled where they are carried", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3", "4", "5"]),
      node("2", "button", "굵게", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "pressed", value: { value: true } }],
      }),
      node("3", "combobox", "지역", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "expanded", value: { value: false } }],
      }),
      node("4", "combobox", "정렬", [], {
        backendDOMNodeId: 9,
        properties: [{ name: "expanded", value: { value: "true" } }],
      }),
      node("5", "button", "저장", [], {
        backendDOMNodeId: 10,
        properties: [{ name: "disabled", value: { value: true } }],
      }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "Doc"',
      ' [e1] button "굵게" [pressed]',
      ' [e2] combobox "지역" [collapsed]',
      ' [e3] combobox "정렬" [expanded]',
      ' [e4] button "저장" [disabled]',
    ]);
  });

  it("puts state after the value, and prints nothing for a state's default", () => {
    // The flags describe the control, so they sit after what it HOLDS and before
    // where it points. `selected: false` is the state of every option in a list
    // and `disabled: false` of every live control — printing those is pure noise.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3", "4"]),
      node("2", "textbox", "검색", [], {
        backendDOMNodeId: 7,
        value: { value: "광교" },
        properties: [{ name: "disabled", value: { value: true } }],
      }),
      node("3", "option", "서울", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "selected", value: { value: true } }],
      }),
      node("4", "option", "부산", [], {
        backendDOMNodeId: 9,
        properties: [
          { name: "selected", value: { value: false } },
          { name: "disabled", value: { value: false } },
        ],
      }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "Doc"',
      ' [e1] textbox "검색" = "광교" [disabled]',
      ' [e2] option "서울" [selected]',
      ' [e3] option "부산"',
    ]);
  });

  it("never folds same-document fragment links, however Chrome resolved them", () => {
    // Chrome delivers `href="#edit"` ALREADY RESOLVED as https://x/page#edit, so
    // the literal `#` exclusion missed it: all ten rows' edit links shared ONE
    // href, folded onto a single uid, and rows 2-10 lost their edit and delete
    // buttons from the snapshot entirely — silently, since folding prints no
    // trace of what it dropped.
    const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const url = (fragment: string) => ({
      name: "url",
      value: { value: `https://x/page${fragment}` },
    });
    const lines = render([
      node(
        "root",
        "RootWebArea",
        "표",
        rows.flatMap((i) => [`edit-${i}`, `del-${i}`]),
        { properties: [url("")] },
      ),
      ...rows.flatMap((i) => [
        node(`edit-${i}`, "link", "edit", [], {
          backendDOMNodeId: 100 + i,
          properties: [url("#edit")],
        }),
        node(`del-${i}`, "link", "delete", [], {
          backendDOMNodeId: 200 + i,
          properties: [url("#delete")],
        }),
      ]),
    ]);
    expect(lines.filter((line) => /^ *\[e\d+\] link /.test(line))).toHaveLength(20);
    // Exempt from folding AND from decoration, exactly like a literal `#foo`:
    // a same-document destination tells the agent nothing it did not know.
    expect(lines).toContain(' [e1] link "edit"');
    expect(lines.some((line) => line.includes("→"))).toBe(false);
  });

  it("recognizes a fragment link even when the page was loaded at an anchor", () => {
    // The document then reports its OWN url with `#intro` attached, which would
    // make every in-page link look cross-document all over again.
    const lines = render([
      node("1", "RootWebArea", "문서", ["2"], {
        properties: [{ name: "url", value: { value: "https://x/page#intro" } }],
      }),
      node("2", "link", "편집", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: "https://x/page#edit" } }],
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "문서"', ' [e1] link "편집"']);
  });

  it("still folds duplicate links to ANOTHER page's fragment", () => {
    // The behaviour the fragment exemption must not cost: a search result
    // reaches one destination four to six times, and a `#sec` on a different
    // document is a real destination.
    const url = { name: "url", value: { value: "https://x/other#sec" } };
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"], {
        properties: [{ name: "url", value: { value: "https://x/page" } }],
      }),
      node("2", "link", "", [], { backendDOMNodeId: 11, properties: [url] }),
      node("3", "link", "다른 문서의 절", [], { backendDOMNodeId: 12, properties: [url] }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e2] link "다른 문서의 절" → https://x/other#sec']);
  });

  it("does not glue two unrelated blocks that share only a landmark", () => {
    // `StaticText "0 Powered by"` shipped from a real page: a counter and a
    // footer credit, each inside its own <div> (generic → transparent), so the
    // nearest EMITTING container of both was the RootWebArea and the run-joiner
    // fused them into a sentence the page never contained.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "generic", "", ["4"]),
      node("3", "generic", "", ["5"]),
      node("4", "StaticText", "0"),
      node("5", "StaticText", "Powered by"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' StaticText "0"', ' StaticText "Powered by"']);
  });

  it("blocks joining under main too, while real prose in a paragraph still joins", () => {
    const across = render([
      node("1", "main", "", ["2", "3"]),
      node("2", "StaticText", "로딩 중"),
      node("3", "StaticText", "Powered by"),
    ]);
    expect(across).toEqual([' StaticText "로딩 중"', ' StaticText "Powered by"']);
    const inside = render([
      node("1", "main", "", ["2"]),
      node("2", "paragraph", "", ["3", "4"]),
      node("3", "StaticText", "오늘"),
      node("4", "StaticText", "폭염경보"),
    ]);
    expect(inside).toEqual(['  StaticText "오늘 폭염경보"']);
  });

  it("drops a highlight-split run the line ABOVE it already spells out", () => {
    expect(render(highlightDuplicate("plain-first"))).toEqual([
      'RootWebArea "검색"',
      `  StaticText "${HIGHLIGHT_SENTENCE}"`,
    ]);
  });

  it("drops it the other way round too, when the whole copy arrives after", () => {
    expect(render(highlightDuplicate("run-first"))).toEqual([
      'RootWebArea "검색"',
      `  StaticText "${HIGHLIGHT_SENTENCE}"`,
    ]);
  });

  it("keeps a run that says something the line beside it does not", () => {
    const lines = render([
      node("1", "RootWebArea", "검색", ["2", "3"]),
      node("2", "paragraph", "", ["4"]),
      node("4", "StaticText", HIGHLIGHT_SENTENCE),
      node("3", "paragraph", "", ["5", "6"]),
      node("5", "StaticText", "리뷰 3,214건"),
      node("6", "StaticText", "영업 중"),
    ]);
    expect(lines).toEqual([
      'RootWebArea "검색"',
      `  StaticText "${HIGHLIGHT_SENTENCE}"`,
      '  StaticText "리뷰 3,214건 영업 중"',
    ]);
  });

  it("does not let a SHORT run be swallowed by a coincidental ordered match", () => {
    // "2" and "8" both occur, in that order, inside "2026.08.08" — the calendar
    // case again, one line up instead of one level up. Eight characters of
    // ordered agreement is where coincidence stops and a duplicate begins.
    const lines = render([
      node("1", "RootWebArea", "달력", ["2", "3"]),
      node("2", "StaticText", "2026.08.08"),
      node("3", "paragraph", "", ["4", "5"]),
      node("4", "StaticText", "2"),
      node("5", "StaticText", "8"),
    ]);
    expect(lines).toEqual(['RootWebArea "달력"', ' StaticText "2026.08.08"', '  StaticText "2 8"']);
  });

  it("keeps a table row on ONE line here too, as the reading view already did", () => {
    // A 650-cell finance table printed one line per cell, so the agent had to
    // count columns to work out where each row began.
    const lines = render([
      node("1", "table", "실적", ["2", "3"]),
      node("2", "row", "", ["4", "5", "6"]),
      node("3", "row", "", ["7", "8", "9"]),
      node("4", "columnheader", "분기"),
      node("5", "columnheader", "매출"),
      node("6", "columnheader", "비고"),
      node("7", "cell", "1Q"),
      node("8", "cell", "100"),
      node("9", "cell", "호조"),
    ]);
    expect(lines).toEqual([
      'table "실적"',
      '  columnheader "분기" | columnheader "매출" | columnheader "비고"',
      '  cell "1Q" | cell "100" | cell "호조"',
    ]);
  });

  it("keeps every joined cell's own uid, so a row loses no addressability", () => {
    // The challenging_dom shape: no table or columnheader roles anywhere, just
    // LayoutTableRow/LayoutTableCell, each cell a click target of its own. The
    // line still STARTS with a uid, which is what capSnapshot keeps it by.
    const lines = render([
      node("1", "LayoutTable", "", ["2", "3"]),
      node("2", "LayoutTableRow", "", ["4", "5"]),
      node("3", "LayoutTableRow", "", ["6", "7"]),
      node("4", "LayoutTableCell", "편집", [], { backendDOMNodeId: 11 }),
      node("5", "LayoutTableCell", "삭제", [], { backendDOMNodeId: 12 }),
      node("6", "LayoutTableCell", "복사", [], { backendDOMNodeId: 13 }),
      node("7", "LayoutTableCell", "이동", [], { backendDOMNodeId: 14 }),
    ]);
    expect(lines).toEqual([
      '  [e1] LayoutTableCell "편집" | [e2] LayoutTableCell "삭제"',
      '  [e3] LayoutTableCell "복사" | [e4] LayoutTableCell "이동"',
    ]);
  });

  it("leaves a cell alone when its container is not a row", () => {
    const lines = render([
      node("1", "grid", "달력", ["2", "3"]),
      node("2", "cell", "26", [], { backendDOMNodeId: 11 }),
      node("3", "cell", "27", [], { backendDOMNodeId: 12 }),
    ]);
    expect(lines).toEqual(['grid "달력"', ' [e1] cell "26"', ' [e2] cell "27"']);
  });

  it("joins a row through a cell whose text is a StaticText of its own", () => {
    // The cell holding the sentence is NAMELESS, so it never prints and the
    // text arrives with the CELL as its container — the row is one hop further
    // up, which a container-role test cannot see. The row line is indented at
    // the first piece's own depth, and the run that built it is closed before
    // the second cell lands, so it can no longer rewrite the joined slot.
    const lines = render([
      node("1", "row", "", ["2", "3"]),
      node("2", "cell", "", ["4"]),
      node("4", "StaticText", "설명 문장"),
      node("3", "cell", "값", [], { backendDOMNodeId: 12 }),
    ]);
    expect(lines).toEqual(['  StaticText "설명 문장" | [e1] cell "값"']);
  });

  it("starts a new row line when suppression deleted the one being built", () => {
    // The run that opened the row line is dropped as a duplicate of the cell
    // arriving beside it, which NULLS that slot: appending onto it would
    // resurrect the very line the suppression had just decided to delete.
    const lines = render([
      node("1", "row", "", ["2", "3"]),
      node("2", "cell", "", ["4", "5"]),
      node("4", "StaticText", "폭염 특보가"),
      node("5", "StaticText", "확대 발령됐다"),
      node("3", "cell", "폭염 특보가 확대 발령됐다", [], { backendDOMNodeId: 12 }),
    ]);
    expect(lines).toEqual([' [e1] cell "폭염 특보가 확대 발령됐다"']);
  });

  it("gives a uid to an Iframe, which is nameless and so used to get none", () => {
    // The Iframe's uid is the handle for a frame-scoped snapshot or screenshot,
    // the only thing tying a trailing frame block to a place in the main tree,
    // and a click target of last resort.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "Iframe", "", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] Iframe ""']);
  });

  it("gives a uid to a designMode frame's document AND its body", () => {
    // Old TinyMCE. Fixture transcribed from a real Chromium probe over CDP: the
    // frame's RootWebArea carries editable+focusable, the <body> arrives as a
    // `generic` with editable+focusable, and the paragraph inside carries
    // `editable` ONLY. Both roots are typeable handles; the paragraph is not.
    const lines = render([
      node("1", "RootWebArea", "", ["2"], { backendDOMNodeId: 10, ...editableRoot() }),
      node("2", "generic", "", ["3"], { backendDOMNodeId: 11, ...editableRoot() }),
      node("3", "paragraph", "", ["4"], editableDescendant()),
      node("4", "StaticText", "본문", [], editableDescendant()),
    ]);
    expect(lines).toEqual(['[e1] RootWebArea ""', ' [e2] generic ""', '   StaticText "본문"']);
  });

  it("reaches a body-contenteditable frame through its body, not its document", () => {
    // Measured: with a contenteditable BODY the frame's RootWebArea reports
    // focusable but NO `editable` at all, so the RootWebArea route this fix was
    // originally aimed at does not exist. The real editable surface is the body,
    // which arrives as role `generic` — structural, and so never emitted until
    // the walk learned to keep an editable ROOT.
    const lines = render([
      node("1", "RootWebArea", "편집기", ["2"], {
        backendDOMNodeId: 10,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
      node("2", "generic", "", ["3"], { backendDOMNodeId: 11, ...editableRoot() }),
      node("3", "StaticText", "초안", [], editableDescendant()),
    ]);
    expect(lines).toEqual(['RootWebArea "편집기"', ' [e1] generic ""', '  StaticText "초안"']);
  });

  it("mints ONE uid for a contenteditable editor, not one per node inside it", () => {
    // The probe that corrected this rule: Chrome stamps `editable` on every
    // DESCENDANT of an editable region — the div, both paragraphs and all three
    // StaticTexts here — and `focusable` on the root alone. Keying on `editable`
    // by itself flooded the snapshot with uids AND made StaticText interactive,
    // which silently switched off run joining inside every editor (`inRun`
    // requires `!interactive`) — so the prose below is the regression guard.
    const nodes = [
      node("1", "RootWebArea", "글쓰기", ["2"]),
      node("2", "generic", "", ["3", "6"], { backendDOMNodeId: 20, ...editableRoot() }),
      node("3", "paragraph", "", ["4", "5"], editableDescendant()),
      node("4", "StaticText", "hello", [], editableDescendant()),
      node("5", "StaticText", "world", [], editableDescendant()),
      node("6", "paragraph", "", ["7"], editableDescendant()),
      node("7", "StaticText", "second para", [], editableDescendant()),
    ];
    expect(render(nodes)).toEqual([
      'RootWebArea "글쓰기"',
      ' [e1] generic ""',
      '   StaticText "hello world"',
      '   StaticText "second para"',
    ]);
    // Nameless and description-less, so it is exactly the kind of control the
    // caller looks a DOM identifier up for.
    expect(unlabeledInteractiveIds(nodes)).toEqual([20]);
  });

  it("leaves a textarea's inner editable generic invisible", () => {
    // Measured: that inner generic carries editable="plaintext" and no focusable
    // — a descendant, not a root. The textarea itself is a textbox and mints as
    // it always has; minting the inner one too would double every text field.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "textbox", "메모", ["3"], { backendDOMNodeId: 30 }),
      node("3", "generic", "", [], {
        backendDOMNodeId: 31,
        properties: [{ name: "editable", value: { value: "plaintext" } }],
      }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] textbox "메모"']);
  });

  it("leaves an ordinary document without a uid", () => {
    const lines = render([node("1", "RootWebArea", "Doc", [], { backendDOMNodeId: 3 })]);
    expect(lines).toEqual(['RootWebArea "Doc"']);
  });

  it("marks the Iframe line with the frame label its subtree is rendered under", () => {
    const lines = renderAxTree(
      [node("1", "RootWebArea", "Doc", ["2"]), node("2", "Iframe", "", [], { backendDOMNodeId: 7 })],
      uids(),
      undefined,
      { frameLabels: new Map([[7, "f2"]]) },
    ) as string[];
    expect(lines).toEqual(['RootWebArea "Doc"', ' [e1] Iframe "" (frame f2)']);
  });

  it("renders only the requested subtree, and null when the start id is stale", () => {
    const nodes = [
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "article", "본문", ["4"], { backendDOMNodeId: 10 }),
      node("3", "StaticText", "사이드바"),
      node("4", "StaticText", "기사 내용"),
    ];
    const scoped = renderAxTree(nodes, uids(), undefined, { startBackendNodeId: 10 }) as string[];
    // The scope root starts at depth 0, so the subtree is indented from IT.
    expect(scoped).toEqual(['article "본문"', ' StaticText "기사 내용"']);
    expect(renderAxTree(nodes, uids(), undefined, { startBackendNodeId: 999 })).toBeNull();
  });

  it("adopts in-scope nodes the childIds chain cannot reach, when told which", () => {
    // `snapshot(uid=…)` on a map's `region "Map"` answered with the region line
    // alone, while the full page showed 47 markers under it: the markers are a
    // detached island, which the full walk's leftover sweep prints and a scoped
    // walk structurally cannot reach. The caller's DOM subtree says they belong.
    const nodes = [
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "region", "Map", [], { backendDOMNodeId: 10 }),
      node("3", "image", "음식점", [], { backendDOMNodeId: 11 }),
    ];
    // Today's answer, pinned: with no set the scope is the chain and nothing more.
    expect(renderAxTree(nodes, uids(), undefined, { startBackendNodeId: 10 })).toEqual([
      '[e1] region "Map"',
    ]);
    expect(
      renderAxTree(nodes, uids(), undefined, {
        startBackendNodeId: 10,
        scopeDomIds: new Set([11]),
      }),
    ).toEqual(['[e1] region "Map"', '[e2] image "음식점"']);
    // The stale-uid contract is unchanged: a start node matching nothing is
    // still null, however much the set claims is in scope.
    expect(
      renderAxTree(nodes, uids(), undefined, {
        startBackendNodeId: 999,
        scopeDomIds: new Set([11]),
      }),
    ).toBeNull();
  });

  it("renders ONLY the in-scope nodes when there is no start node to walk from", () => {
    // The scoped element is alive in the DOM and absent from the AX tree that
    // was just fetched — a covering overlay div that never got an accessibility
    // node, a map pane caught mid-rebuild. There is no start node to descend
    // from, so what the DOM says lives inside it is the entire answer; falling
    // back to the full walk would hand the whole page back as that element's
    // contents, which is what an agent would read it as.
    const nodes = [
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "region", "Map", [], { backendDOMNodeId: 10 }),
      node("3", "image", "음식점", [], { backendDOMNodeId: 11 }),
    ];
    expect(renderAxTree(nodes, uids(), undefined, { scopeDomIds: new Set([11]) })).toEqual([
      '[e1] image "음식점"',
    ]);
    // An EMPTY set is not a scope, so it still means the whole page.
    expect(renderAxTree(nodes, uids(), undefined, { scopeDomIds: new Set() })).toEqual(
      render(nodes),
    );
    // And the mode's boundary: a start id that was GIVEN and matches nothing is
    // a stale uid whatever the set holds, never a reason to sweep instead.
    expect(
      renderAxTree(nodes, uids(), undefined, {
        startBackendNodeId: 999,
        scopeDomIds: new Set([11]),
      }),
    ).toBeNull();
  });

  it("drops a line that is nothing but brackets, keeping bracketed TEXT", () => {
    // What is left of a construct suppressed elsewhere: the page's own
    // parentheses around a hole, shipped as if they were content. A uid line is
    // never dropped — its element would become unreachable over punctuation.
    const lines = render([
      node("1", "RootWebArea", "지도", ["2", "3", "4", "5"]),
      node("2", "StaticText", "( )"),
      node("3", "StaticText", "(광교점)"),
      node("4", "StaticText", "-"),
      node("5", "StaticText", "( )", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "지도"',
      ' StaticText "(광교점)"',
      ' StaticText "-"',
      ' [e1] StaticText "( )"',
    ]);
  });

  it("renders identically whether the options argument is passed, null or omitted", () => {
    // `null` is the natural shape of `frameLabels ? { frameLabels } : null` at a
    // call site, and a parameter default only covers `undefined` — destructuring
    // it would throw and take out the whole snapshot, not just the frame part.
    const nodes = [
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "button", "저장", [], { backendDOMNodeId: 7 }),
      node("3", "StaticText", "본문"),
    ];
    const bare = renderAxTree(nodes, uids(), undefined) as string[];
    expect(bare).toEqual(['RootWebArea "Doc"', ' [e1] button "저장"', ' StaticText "본문"']);
    expect(renderAxTree(nodes, uids(), undefined, {})).toEqual(bare);
    expect(renderAxTree(nodes, uids(), undefined, null)).toEqual(bare);
  });

  it("caps the indent, so deep nesting cannot eat the snapshot budget", () => {
    // Real pages nest far deeper than they read, and every space is budget
    // spent on layout instead of the page's own text.
    const levels = 16;
    const lines = render([
      ...Array.from({ length: levels }, (_, i) =>
        node(`n${i}`, "paragraph", "", [i + 1 < levels ? `n${i + 1}` : "leaf"]),
      ),
      node("leaf", "StaticText", "바닥"),
    ]);
    expect(lines).toEqual([`${" ".repeat(12)}StaticText "바닥"`]);
  });

  it("cuts a runaway field value, marking the cut and where to read the rest", () => {
    // A GitHub blob view keeps the whole file in a hidden <textarea>: a 44.7 KB
    // source file ate 504 of the page's 1204 snapshot lines, and what survived
    // was source cut mid-line by capSnapshot with nothing saying so.
    const lines = render([
      node("1", "textbox", "소스", [], { backendDOMNodeId: 7, value: { value: "x".repeat(4000) } }),
    ]);
    expect(lines).toEqual([
      `[e1] textbox "소스" = "${"x".repeat(3000)}" [value truncated: showing 3000 of 4000 ` +
        "chars — read the full text with mcp__browser__read_text (uid e1)]",
    ]);
  });

  it("points at the page's text when the cut line has no uid to name", () => {
    // No backend id, so nothing was minted — read_text can still return the
    // page, it just cannot be scoped to this element.
    const lines = render([node("1", "textbox", "", [], { value: { value: "x".repeat(3200) } })]);
    expect(lines).toEqual([
      `textbox "${"x".repeat(3000)}" [value truncated: showing 3000 of 3200 ` +
        "chars — read the full page text with mcp__browser__read_text]",
    ]);
  });

  it("cuts a runaway accessible name too, saying how much of it is shown", () => {
    const lines = render([node("1", "button", "가".repeat(1500), [], { backendDOMNodeId: 7 })]);
    expect(lines).toEqual([
      `[e1] button "${"가".repeat(1000)}" [label truncated: showing 1000 of 1500 chars]`,
    ]);
  });

  it("caps only what is PRINTED, never what the suppression compares", () => {
    // The cut is a display decision. Comparing cut strings instead would let a
    // child whose text sits past the cap survive as a duplicate line.
    const label = `${"가".repeat(1200)} 끝`;
    const lines = render([
      node("1", "link", label, ["2"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "끝"),
    ]);
    expect(lines).toEqual([
      `[e1] link "${"가".repeat(1000)}" [label truncated: showing 1000 of 1202 chars]`,
    ]);
  });

  it("re-spaces a name Chrome welded out of its descendants' text", () => {
    // Naver Maps: business status, rating, review count and title arrive
    // concatenated with NO separators, and the separated child StaticTexts are
    // then deleted as a run-level echo of that very name — so nothing on the
    // page recovers the structure unless the name itself is put back together.
    const lines = render([
      node("1", "button", "영업 종료별점 4.76리뷰7,262TV 식스센스", ["2", "3", "4", "5"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "영업 종료"),
      node("3", "StaticText", "별점 4.76"),
      node("4", "StaticText", "리뷰7,262"),
      node("5", "StaticText", "TV 식스센스"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료 별점 4.76 리뷰7,262 TV 식스센스"']);
  });

  it("fires when a segment carries a space of its OWN, splitting only the welds", () => {
    // The same field string cut a different way: "별점 4.76" arrives as ONE
    // text node whose space is real page content, while the four boundaries
    // BETWEEN the children carry none. Those welds are what gets a space, and
    // the segment's own spacing is left exactly as the page wrote it.
    const lines = render([
      node("1", "button", "영업 종료별점 4.76리뷰7,262TV 식스센스", ["2", "3", "4", "5", "6"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "영업 종료"),
      node("3", "StaticText", "별점 4.76"),
      node("4", "StaticText", "리뷰"),
      node("5", "StaticText", "7,262"),
      node("6", "StaticText", "TV 식스센스"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료 별점 4.76 리뷰 7,262 TV 식스센스"']);
  });

  it("declines a MIXED name, separated at some boundaries and welded at others", () => {
    // The honest limit of the rule, pinned rather than papered over. Here the
    // space before "4.76" sits BETWEEN two children — so either Chrome inserted
    // a separator there and not elsewhere, or the page did. Nothing in the
    // strings says which boundaries deserve a space: 종료|별점, which wants one,
    // and 광교|역, which must never get one, are both Hangul beside Hangul. The
    // welded name is what prints, which is today's behaviour and recoverable —
    // the alternative is shipping invented words as the page's own text.
    const lines = render([
      node("1", "button", "영업 종료별점 4.76리뷰7,262TV 식스센스", ["2", "3", "4", "5", "6", "7"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "영업 종료"),
      node("3", "StaticText", "별점"),
      node("4", "StaticText", " 4.76"),
      node("5", "StaticText", "리뷰"),
      node("6", "StaticText", "7,262"),
      node("7", "StaticText", "TV 식스센스"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료별점 4.76리뷰7,262TV 식스센스"']);
  });

  it("leaves a name alone when the page's own text already separated it", () => {
    // The segments do not concatenate into the raw name — a separator is
    // already there — so there is nothing to put back and nothing to invent.
    const lines = render([
      node("1", "button", "영업 종료 별점 4.76", ["2", "3"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "영업 종료"),
      node("3", "StaticText", "별점 4.76"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료 별점 4.76"']);
  });

  it("never re-spaces a name a phrasing wrapper split MID-WORD", () => {
    // `<mark>` around a matched keyword splits "수원광교역" into "수원광교" +
    // "역", which DOES concatenate back into the raw name — re-spacing it would
    // invent a word boundary inside a place name and ship it as the page's own.
    const lines = render([
      node("1", "option", "수원광교역", ["2", "3"], { backendDOMNodeId: 7 }),
      node("2", "mark", "", ["4"]),
      node("4", "StaticText", "수원광교"),
      node("3", "StaticText", "역"),
    ]);
    expect(lines).toEqual(['[e1] option "수원광교역"']);
  });

  it("puts a name back together WITHOUT inventing spaces around its punctuation", () => {
    // Wikipedia's search link: the quotes around the phrase are text nodes of
    // their own, and a blanket space at every seam shipped
    // `Search for " Accessibility tree "` — a label the page does not contain
    // and that no search for it would match. A boundary character on either
    // side of a seam already separates the pieces.
    const lines = render([
      node("1", "link", 'Search for "Accessibility tree"', ["2", "3", "4"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", 'Search for "'),
      node("3", "StaticText", "Accessibility tree"),
      node("4", "StaticText", '"'),
    ]);
    expect(lines).toEqual(['[e1] link "Search for "Accessibility tree""']);
  });

  it("keeps a bracketed footnote label tight, as the page drew it", () => {
    // `[` + `n 2` + `]` are three text nodes, and the same blanket space made
    // every Wikipedia footnote link read `[ n 2 ]`.
    const lines = render([
      node("1", "link", "[n 2]", ["2", "3", "4"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "["),
      node("3", "StaticText", "n 2"),
      node("4", "StaticText", "]"),
    ]);
    expect(lines).toEqual(['[e1] link "[n 2]"']);
  });

  it("re-spaces a name whose rating arrives as a named image, not as text", () => {
    // The star-rating rows on the same Naver Maps result list never re-spaced:
    // the rating's text lives on an image's alt, so the collected StaticTexts
    // could not reconstruct the raw name and the strict test declined every
    // time — leaving `button "영업 종료별점 4.87리뷰1,269"` welded on the page
    // this whole rule exists for.
    const lines = render([
      node("1", "button", "영업 종료별점 4.87리뷰1,269", ["2", "3", "4", "5"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "영업 종료"),
      node("3", "image", "별점 4.87"),
      node("4", "StaticText", "리뷰"),
      node("5", "StaticText", "1,269"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료 별점 4.87 리뷰 1,269"']);
  });

  it("counts a named descendant ONCE, not again as the text inside it", () => {
    // Per accname a named descendant stands in for its contents, so the walk
    // stops there. Recursing as well would collect "도움말" twice, the
    // reconstruction would miss, and the name would print welded — the failure
    // this rule was added to end.
    const lines = render([
      node("1", "button", "저장하기도움말", ["2", "3"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "저장하기"),
      node("3", "image", "도움말", ["4"]),
      node("4", "StaticText", "도움말"),
    ]);
    expect(lines).toEqual(['[e1] button "저장하기 도움말"']);
  });

  it("re-spaces a name whose only separator CHROME inserted at a block edge", () => {
    // The live CDP dump from map.naver.com, used verbatim: the rating row's
    // visually-hidden `place_blind` span is absolutely positioned, so Chrome
    // itself put a space at that block boundary (accname leaves separation to
    // the implementation). The raw name therefore carries exactly ONE space that
    // NO segment contains, which `segments.join("") === rawName` could never
    // satisfy — so every place row on the service printed welded, and its child
    // StaticTexts then escaped container-echo suppression and re-spelled the
    // label a line at a time. Both are gone once the name reads as words: the
    // children are covered by it and drop out, leaving the one line.
    const lines = render([
      node("1", "button", "영업 종료별점 4.87리뷰1,269", ["st", "g1", "g2"], {
        backendDOMNodeId: 7,
      }),
      node("st", "StaticText", "영업 종료"),
      node("g1", "none", "", ["svg1", "blind", "rate"], { ignored: true }),
      node("svg1", "generic", ""),
      node("blind", "none", "", ["blindText"], { ignored: true }),
      node("blindText", "StaticText", "별점"),
      node("rate", "StaticText", "4.87"),
      node("g2", "none", "", ["svg2", "reviews", "count"], { ignored: true }),
      node("svg2", "generic", ""),
      node("reviews", "StaticText", "리뷰"),
      node("count", "StaticText", "1,269"),
    ]);
    expect(lines).toEqual(['[e1] button "영업 종료 별점 4.87 리뷰 1,269"']);
  });

  it("declines a name whose own text nodes are doing the spacing", () => {
    // The PROSE GUARD, and the reason it is a guard and not a heuristic: the
    // page wrote a space after 옥수수 and none in front of the postposition 랑,
    // so the segments "옥수수 " + "크림 뇨끼" + "랑 홈메이드 …" would rebuild as
    // "옥수수 크림 뇨끼 랑 홈메이드 …" — a sentence the page does not contain.
    // An edge space on ANY segment says the page is spacing itself here, and
    // then there is nothing to put back.
    const lines = render([
      node("1", "button", "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데", ["2", "3", "4"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "옥수수 "),
      node("3", "StaticText", "크림 뇨끼"),
      node("4", "StaticText", "랑 홈메이드 라자냐 시켰는데"),
    ]);
    expect(lines).toEqual(['[e1] button "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데"']);
  });

  it("guesses a DRY seam even in a name that also crossed a block boundary", () => {
    // The honest limit of the Chrome-separator branch, pinned rather than papered
    // over. "가격 안내" arrives with the separator between 가격 and 안내 and the
    // word 안내 itself split across two spans, all three segments dry — so the
    // 안|내 seam falls to glueSegments' character rule and gets a space it should
    // not have. That is knowingly the SAME guess this module already makes for a
    // fully-welded name (종료|별점 and 광교|역 are both Hangul beside Hangul, and
    // no character rule tells them apart); what it now costs is this corner,
    // and what it buys is every rating row on Korea's dominant map service.
    const lines = render([
      node("1", "button", "가격 안내", ["2", "3", "4"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "가격"),
      node("3", "StaticText", "안"),
      node("4", "StaticText", "내"),
    ]);
    expect(lines).toEqual(['[e1] button "가격 안 내"']);
  });

  it("joins a row whose cell text lives on a nested link", () => {
    // Wikipedia's GDP table: the country cell is NAMELESS because its text sits
    // on a link inside it, and that link's container is the CELL, not the row —
    // so the row chain broke and the rank printed on a line of its own.
    const lines = render([
      node("t", "table", "GDP", ["r"]),
      node("r", "row", "", ["c1", "c2", "c3"]),
      node("c1", "rowheader", "1", [], { backendDOMNodeId: 20 }),
      node("c2", "cell", "", ["l"]),
      node("l", "link", "United States", [], {
        backendDOMNodeId: 21,
        properties: [{ name: "url", value: { value: "https://x/us" } }],
      }),
      node("c3", "cell", "32,383,920", [], { backendDOMNodeId: 22 }),
    ]);
    // Every piece keeps its OWN uid, so joining the row costs no addressability.
    expect(lines).toEqual([
      'table "GDP"',
      '  [e1] rowheader "1" | [e2] link "United States" → https://x/us | [e3] cell "32,383,920"',
    ]);
  });

  it("joins a header row where EVERY cell's text sits on a nested link", () => {
    // The same table's header split into one line per column for the same
    // reason: not one of its columnheaders carries a name of its own.
    const lines = render([
      node("t", "table", "", ["r"]),
      node("r", "row", "", ["c1", "c2"]),
      node("c1", "columnheader", "", ["l1"]),
      node("l1", "link", "Country", [], { backendDOMNodeId: 31 }),
      node("c2", "columnheader", "", ["l2"]),
      node("l2", "link", "GDP", [], { backendDOMNodeId: 32 }),
    ]);
    expect(lines).toEqual(['   [e1] link "Country" | [e2] link "GDP"']);
  });

  it("separates columns with a bar, but more of ONE cell with a space", () => {
    // A reference marker belongs to the value beside it, not to a column of its
    // own — the bar has to mean "next cell" or a row stops being readable.
    const lines = render([
      node("r", "row", "", ["c"]),
      node("c", "cell", "", ["l", "sup"]),
      node("l", "link", "United States", [], { backendDOMNodeId: 41 }),
      node("sup", "superscript", "", ["st"]),
      node("st", "StaticText", "[1]"),
    ]);
    expect(lines).toEqual(['  [e1] link "United States" StaticText "[1]"']);
  });

  it("gives a uid to a named image with no actionable ancestor above it", () => {
    // Naver map markers surface as `image "음식점"` with nothing above them that
    // takes a click, so picking one out was a click_at pixel gamble. A nameless
    // image is still structure and mints nothing.
    const lines = render([
      node("1", "RootWebArea", "지도", ["2", "3", "4"]),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
      node("3", "img", "카페", [], { backendDOMNodeId: 8 }),
      node("4", "image", "", [], { backendDOMNodeId: 9 }),
    ]);
    expect(lines).toEqual(['RootWebArea "지도"', ' [e1] image "음식점"', ' [e2] img "카페"']);
  });

  it("mints an image uid INSIDE a named map surface, which is the whole case", () => {
    // The field shape: markers are drawn on a map body that surfaces as
    // `region "지도"` and takes a uid of its own. That uid exists so click_at
    // has a coordinate plane to aim at — clicking the region's centre is not
    // clicking a marker — so counting it as the marker's click target would put
    // every one of them straight back out of reach.
    const lines = render([
      node("1", "region", "지도", ["2"], { backendDOMNodeId: 5 }),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['[e1] region "지도"', ' [e2] image "음식점"']);
  });

  it("mints an image uid inside a canvas, which is a plane and not a target", () => {
    const lines = render([
      node("1", "Canvas", "", ["2"], { backendDOMNodeId: 5 }),
      node("2", "image", "표식", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['[e1] Canvas ""', ' [e2] image "표식"']);
  });

  it("folds the label beside a map marker onto the marker's own line", () => {
    // A Naver map draws 47 markers and every one of them printed as
    // `[eN] image "음식점"` — addressable, and indistinguishable from the other
    // 46, so picking the right one was a guess. The name that tells them apart
    // is the StaticText next to it, which read as an unrelated line.
    const lines = render([
      node("1", "region", "지도", ["2", "3"], { backendDOMNodeId: 5 }),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
      node("3", "StaticText", "스타벅스 광교점"),
    ]);
    expect(lines).toEqual(['[e1] region "지도"', ' [e2] image "음식점 스타벅스 광교점"']);
  });

  it("does not fold text from a block of its own into a marker", () => {
    // A shared container is what makes the text the marker's label rather than
    // the next thing on the page.
    const lines = render([
      node("1", "region", "지도", ["2", "3"], { backendDOMNodeId: 5 }),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
      node("3", "group", "", ["4"]),
      node("4", "StaticText", "카페 이름"),
    ]);
    expect(lines).toEqual([
      '[e1] region "지도"',
      ' [e2] image "음식점"',
      '  StaticText "카페 이름"',
    ]);
  });

  it("does not fold across a line that landed in between", () => {
    const lines = render([
      node("1", "region", "지도", ["2", "3", "4"], { backendDOMNodeId: 5 }),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
      node("3", "button", "확대", [], { backendDOMNodeId: 8 }),
      node("4", "StaticText", "카페 이름"),
    ]);
    expect(lines).toEqual([
      '[e1] region "지도"',
      ' [e2] image "음식점"',
      ' [e3] button "확대"',
      ' StaticText "카페 이름"',
    ]);
  });

  it("does not fold a paragraph that merely happens to follow a marker", () => {
    const long = "가".repeat(121);
    const lines = render([
      node("1", "region", "지도", ["2", "3"], { backendDOMNodeId: 5 }),
      node("2", "image", "음식점", [], { backendDOMNodeId: 7 }),
      node("3", "StaticText", long),
    ]);
    expect(lines).toEqual(['[e1] region "지도"', ' [e2] image "음식점"', ` StaticText "${long}"`]);
  });

  it("keeps the marker's own decoration when a label is folded in", () => {
    // The fold rewrites a line that was already printed, so it has to rebuild
    // everything format() put AFTER the label — calling format() again is not
    // an option, since that would mint a second uid for the same element.
    const lines = renderAxTree(
      [
        node("1", "region", "지도", ["2", "3"], { backendDOMNodeId: 5 }),
        node("2", "image", "음식점", [], {
          backendDOMNodeId: 7,
          properties: [{ name: "disabled", value: { value: true } }],
        }),
        node("3", "StaticText", "스타벅스"),
      ],
      uids(),
      undefined,
      { frameLabels: new Map([[7, "f2"]]) },
    ) as string[];
    expect(lines).toEqual([
      '[e1] region "지도"',
      ' [e2] image "음식점 스타벅스" [disabled] (frame f2)',
    ]);
  });

  it("leaves an image inside a link alone — the ancestor IS the click target", () => {
    // A search page is thumbnails inside their own result links; minting one
    // per image would flood the snapshot with refs that all click the link.
    const lines = render([
      node("1", "link", "결과", ["2"], { backendDOMNodeId: 7 }),
      node("2", "image", "썸네일", [], { backendDOMNodeId: 8 }),
    ]);
    expect(lines).toEqual(['[e1] link "결과"', ' image "썸네일"']);
  });

  it("keeps a link that interrupts running prose instead of folding it away", () => {
    // Both links reach https://x/login, and the folding above ("prints ONE line
    // for several links to the same destination") is what a search page needs —
    // but applied mid-sentence it deleted the words out of the sentence. An
    // open text run under the link's OWN container is what tells them apart.
    expect(render(inlineLinkProse())).toEqual([
      'RootWebArea "문서"',
      '  [e1] link "로그인" → https://x/login',
      '  StaticText "이 문서를 편집하려면"',
      '  [e2] link "로그인하거나 계정을 만들어야" → https://x/login',
      '  StaticText "합니다"',
    ]);
  });

  it("prints a range control's bounds, so its value has a scale", () => {
    // `slider "별점" = "5"` says nothing about where 5 sits — and the clearing
    // ladder's End key pinned such a control to its MAXIMUM while nothing on
    // the line said what the maximum was. Only bounds Chrome carries print: a
    // missing one is unknown, not zero.
    const lines = render([
      node("1", "RootWebArea", "설정", ["2", "3", "4"]),
      node("2", "slider", "별점", [], {
        backendDOMNodeId: 7,
        value: { value: 5 },
        properties: [
          { name: "valuemin", value: { value: 0 } },
          { name: "valuemax", value: { value: "5" } },
        ],
      }),
      node("3", "spinbutton", "수량", [], {
        backendDOMNodeId: 8,
        properties: [{ name: "valuemin", value: { value: "1" } }],
      }),
      node("4", "slider", "밝기", [], { backendDOMNodeId: 9 }),
    ]);
    expect(lines).toEqual([
      'RootWebArea "설정"',
      ' [e1] slider "별점" = "5" [min 0 max 5]',
      ' [e2] spinbutton "수량" [min 1]',
      ' [e3] slider "밝기"',
    ]);
  });
});

describe("unlabeledInteractiveIds", () => {
  it("finds only interactive nodes with no name, no value and no description", () => {
    // The set the caller spends CDP round trips on. A named control needs no
    // hint, a described one already prints its title, a nameless StaticText is
    // not actionable at all, and a field with a value is identified by it.
    const ids = unlabeledInteractiveIds([
      node("1", "RootWebArea", "Doc", ["2", "3", "4", "5", "6"]),
      node("2", "button", "", [], { backendDOMNodeId: 48 }),
      node("3", "button", "저장", [], { backendDOMNodeId: 49 }),
      node("4", "button", "", [], { backendDOMNodeId: 50, description: { value: " 길찾기 " } }),
      node("5", "StaticText", "", [], { backendDOMNodeId: 51 }),
      node("6", "textbox", "", [], { backendDOMNodeId: 52, value: { value: "광교" } }),
    ]) as number[];
    expect(ids).toEqual([48]);
  });

  it("skips a nameless node that carries no backend id to address it by", () => {
    const ids = unlabeledInteractiveIds([node("1", "button", "", [], {})]) as number[];
    expect(ids).toEqual([]);
  });

  it("includes a nameless Iframe, which is exactly what a DOM hint is for", () => {
    // An Iframe is actionable now and almost never named, so `[e7] Iframe ""` is
    // the line a hint has to tell apart from the next one.
    const ids = unlabeledInteractiveIds([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "Iframe", "", [], { backendDOMNodeId: 60 }),
    ]) as number[];
    expect(ids).toEqual([60]);
  });
});

describe("capSnapshot", () => {
  it("returns text under the budget unchanged", () => {
    expect(capSnapshot("짧은 스냅샷", 100)).toBe("짧은 스냅샷");
  });

  it("keeps [uid] lines over text lines and appends a truncation notice", () => {
    const lines = [
      `StaticText "${"가".repeat(60)}"`,
      '[e1] button "저장"',
      `StaticText "${"나".repeat(60)}"`,
      '[e2] link "다음"',
    ];
    const out = capSnapshot(lines.join("\n"), 60);
    expect(out).toContain('[e1] button "저장"');
    expect(out).toContain('[e2] link "다음"');
    expect(out).not.toContain("가가가");
    expect(out).toContain("snapshot truncated");
    expect(out).toContain("mcp__browser__read_text");
  });

  it("recognizes an INDENTED uid line, which is how the snapshot prints them", () => {
    // The snapshot view indents by nesting depth, so a uid line almost never
    // starts at column 0 — a regex anchored there would classify every one of
    // them as droppable text and cut the page's actionable elements first.
    const out = capSnapshot([`  StaticText "${"가".repeat(60)}"`, '   [e1] button "저장"'].join("\n"), 40);
    expect(out).toContain('   [e1] button "저장"');
    expect(out).not.toContain("가가가");
  });

  it("preserves document order among the kept lines", () => {
    const filler = `StaticText "${"x".repeat(500)}"`;
    const out = capSnapshot([filler, '[e1] button "둘"', '[e2] button "하나"'].join("\n"), 60);
    expect(out.indexOf("[e1]")).toBeLessThan(out.indexOf("[e2]"));
  });

  it("keeps a multi-line ELEMENT whole when it fits, newlines and all", () => {
    // The renderers push one entry per element, and an element's own value can
    // hold newlines (a source file inside one textbox). Under the budget it is
    // returned exactly as it came.
    const atom = ['[e1] textbox "소스" = "첫 줄', "둘째 줄", '셋째 줄"'].join("\n");
    expect(capSnapshot([atom, 'StaticText "꼬리"'], 10000)).toBe(`${atom}\nStaticText "꼬리"`);
  });

  it("head-keeps an oversized element CONTIGUOUSLY, and says where the rest is", () => {
    // The field report: `[e246] textbox "file content"` came back with different
    // middle lines missing on every call and nothing saying so, because only the
    // atom's FIRST line carried the uid and the rest competed as ordinary lines.
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}: ${"y".repeat(40)}`).join("\n");
    const atom = `[e7] textbox "file" = "${body}"`;
    const out = capSnapshot([atom, '[e8] button "저장"', 'StaticText "꼬리"'], 900);
    const head = out.slice(0, out.indexOf("… [cut by the maxChars budget"));
    // A PREFIX of the element, not a selection of its lines.
    expect(head.length).toBeGreaterThan(100);
    expect(atom.startsWith(head)).toBe(true);
    expect(out).toContain(`of ${atom.length} chars`);
    expect(out).toContain("mcp__browser__read_text (uid e7)");
    // Whole uid atoms are kept BEFORE the head-keep spends what is left, so one
    // runaway element cannot cost the rest of the page its addressability.
    expect(out).toContain('[e8] button "저장"');
    expect(out).toContain("snapshot truncated");
  });

  it("never fills a hole in one element with a later line that happened to fit", () => {
    const atom = ['[e1] textbox "소스" = "머리', "y".repeat(600), '짧은 꼬리"'].join("\n");
    const out = capSnapshot([atom], 600);
    const head = out.slice(0, out.indexOf("… [cut by the maxChars budget"));
    expect(atom.startsWith(head)).toBe(true);
    expect(out).not.toContain("짧은 꼬리");
  });

  it("still splits a plain STRING per physical line, as its callers rely on", () => {
    const text = [
      'StaticText "머리"',
      `StaticText "${"가".repeat(200)}"`,
      '[e1] button "저장"',
    ].join("\n");
    const out = capSnapshot(text, 40);
    expect(out).toContain('[e1] button "저장"');
    expect(out).toContain('StaticText "머리"');
    expect(out).not.toContain("가가가");
  });
});

describe("mergeTextLines", () => {
  it("appends only the non-overlapping tail of the next capture", () => {
    expect(mergeTextLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("adds nothing when the next capture is the same view", () => {
    expect(mergeTextLines(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("concatenates whole when there is no overlap — a duplicate beats a hole", () => {
    expect(mergeTextLines(["a", "b"], ["x", "y"])).toEqual(["a", "b", "x", "y"]);
  });

  it("starts from the first capture when nothing is accumulated yet", () => {
    expect(mergeTextLines([], ["a"])).toEqual(["a"]);
  });
});

describe("renderAxText", () => {
  it("renders plain text lines with no uids or role decoration", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "Docs", ["2", "4"]),
      node("2", "link", "Parsoid", ["3"], { backendDOMNodeId: 42 }),
      node("3", "StaticText", "Parsoid"),
      node("4", "StaticText", "본문 문장입니다"),
    ]) as string[];
    // The link name still prints ONCE (echo suppression), just undecorated.
    expect(lines).toEqual(["Docs", "Parsoid", "본문 문장입니다"]);
  });

  it("keeps a field's value alongside its label", () => {
    const lines = renderAxText([
      node("1", "form", "검색", ["2"]),
      node("2", "combobox", "검색", [], { backendDOMNodeId: 5, value: { value: "위키백과" } }),
    ]) as string[];
    expect(lines).toEqual(["검색", "검색: 위키백과"]);
  });

  it("drops nameless interactive elements that only exist to carry a uid", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "textbox", "", [], { backendDOMNodeId: 9 }),
    ]) as string[];
    expect(lines).toEqual(["Doc"]);
  });

  it("renders only the requested subtree when a start node is given", () => {
    const lines = renderAxText(
      [
        node("1", "RootWebArea", "Doc", ["2", "3"]),
        node("2", "article", "본문", ["4"], { backendDOMNodeId: 10 }),
        node("3", "StaticText", "사이드바 텍스트"),
        node("4", "StaticText", "기사 내용"),
      ],
      10,
    ) as string[];
    expect(lines).toEqual(["본문", "기사 내용"]);
    expect(lines).not.toContain("사이드바 텍스트");
  });

  it("returns null for a stale start node so the caller owns the message", () => {
    expect(renderAxText([node("1", "RootWebArea", "Doc")], 999)).toBeNull();
  });

  it("renders a node whose AX name and value are NUMBERS", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "slider", undefined, [], {
        backendDOMNodeId: 7,
        name: { value: 0 },
        value: { value: 14 },
      }),
    ]) as string[];
    expect(lines).toEqual(["지도", "0: 14"]);
  });

  it("reads a paragraph of per-word spans as one line of prose", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "paragraph", "", ["3", "4", "5"]),
      node("3", "generic", "", ["6"]),
      node("4", "generic", "", ["7"]),
      node("5", "generic", "", ["8"]),
      node("6", "StaticText", "오늘"),
      node("7", "StaticText", "서울에"),
      node("8", "StaticText", "폭염경보"),
    ]) as string[];
    expect(lines).toEqual(["Doc", "오늘 서울에 폭염경보"]);
  });

  it("keeps two paragraphs on separate lines", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "paragraph", "", ["4"]),
      node("3", "paragraph", "", ["5"]),
      node("4", "StaticText", "첫 문단"),
      node("5", "StaticText", "둘째 문단"),
    ]) as string[];
    expect(lines).toEqual(["Doc", "첫 문단", "둘째 문단"]);
  });

  it("drops a joined run that only re-spells its container's label", () => {
    // Same mid-word highlight as the interaction view: the reading view would
    // otherwise repeat the sentence immediately after printing it.
    const lines = renderAxText([
      node("1", "link", "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데", ["2", "3", "4"], {
        backendDOMNodeId: 7,
      }),
      node("2", "StaticText", "옥수수 "),
      node("3", "StaticText", "크림 뇨끼"),
      node("4", "StaticText", "랑 홈메이드 라자냐 시켰는데"),
    ]) as string[];
    expect(lines).toEqual(["옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데"]);
  });

  it("reads a highlight-split option as its label alone, nothing extra", () => {
    // Same walk, so the phrasing-wrapper fix lands here too: the reading view
    // must not repeat the option's text as a second line of fragments.
    const lines = renderAxText([
      node("1", "option", "검색어 광교역", ["2", "3", "4"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "검색어 "),
      node("3", "mark", "", ["5"]),
      node("4", "StaticText", "역"),
      node("5", "StaticText", "광교"),
    ]) as string[];
    expect(lines).toEqual(["검색어 광교역"]);
  });

  it("keeps a table's rows together instead of one cell per line", () => {
    // Flattened into a vertical list, a table stops being a table: which value
    // belongs to which column is no longer recoverable from the text.
    const lines = renderAxText([
      node("1", "table", "실적", ["2", "3"]),
      node("2", "row", "", ["4", "5", "6"]),
      node("3", "row", "", ["7", "8", "9"]),
      node("4", "columnheader", "분기"),
      node("5", "columnheader", "매출"),
      node("6", "columnheader", "비고"),
      node("7", "cell", "1Q"),
      node("8", "cell", "100"),
      node("9", "cell", "호조"),
    ]) as string[];
    expect(lines).toEqual(["실적", "분기 | 매출 | 비고", "1Q | 100 | 호조"]);
  });

  it("does not glue two unrelated blocks that share only a landmark", () => {
    // The reading view fused the same two blocks the snapshot view did: a
    // counter and a footer credit, read back as one sentence "0 Powered by".
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "generic", "", ["4"]),
      node("3", "generic", "", ["5"]),
      node("4", "StaticText", "0"),
      node("5", "StaticText", "Powered by"),
    ]) as string[];
    expect(lines).toEqual(["Doc", "0", "Powered by"]);
  });

  it("drops a highlight-split run the whole sentence beside it already spells", () => {
    // Both orders: the plain copy can arrive before or after its split twin.
    expect(renderAxText(highlightDuplicate("plain-first"))).toEqual(["검색", HIGHLIGHT_SENTENCE]);
    expect(renderAxText(highlightDuplicate("run-first"))).toEqual(["검색", HIGHLIGHT_SENTENCE]);
  });

  it("keeps a run that says something the line beside it does not", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "검색", ["2", "3"]),
      node("2", "paragraph", "", ["4"]),
      node("4", "StaticText", HIGHLIGHT_SENTENCE),
      node("3", "paragraph", "", ["5", "6"]),
      node("5", "StaticText", "리뷰 3,214건"),
      node("6", "StaticText", "영업 중"),
    ]) as string[];
    expect(lines).toEqual(["검색", HIGHLIGHT_SENTENCE, "리뷰 3,214건 영업 중"]);
  });

  it("keeps an inline link inside the sentence it interrupts", () => {
    // Breaking the line at a mid-sentence link left Wikipedia's prose in stubs;
    // in the reading view such a link is a WORD of the sentence. The menu link
    // above still prints on its own line — its container is a landmark.
    expect(renderAxText(inlineLinkProse())).toEqual([
      "문서",
      "로그인",
      "이 문서를 편집하려면 로그인하거나 계정을 만들어야 합니다",
    ]);
  });

  it("keeps a row together when its cell text lives on a nested link", () => {
    const lines = renderAxText([
      node("t", "table", "GDP", ["r"]),
      node("r", "row", "", ["c1", "c2", "c3"]),
      node("c1", "rowheader", "1"),
      node("c2", "cell", "", ["l"]),
      node("l", "link", "United States", [], { backendDOMNodeId: 21 }),
      node("c3", "cell", "32,383,920"),
    ]) as string[];
    expect(lines).toEqual(["GDP", "1 | United States | 32,383,920"]);
  });

  it("reads a link and the reference beside it as one cell, not two columns", () => {
    // Glued rather than spaced, which is the CHANGE: a reference marker sits
    // against the word it annotates on the page, and inventing a space in front
    // of it makes the reading view disagree with what the reader sees. Only the
    // bar between CELLS is a separator this view supplies itself.
    const lines = renderAxText([
      node("r", "row", "", ["c"]),
      node("c", "cell", "", ["l", "sup"]),
      node("l", "link", "United States", [], { backendDOMNodeId: 41 }),
      node("sup", "superscript", "", ["st"]),
      node("st", "StaticText", "[1]"),
    ]) as string[];
    expect(lines).toEqual(["United States[1]"]);
  });

  it("carries no indent and no bounds — it is the plain-reading view", () => {
    const lines = renderAxText([
      node("1", "RootWebArea", "설정", ["2"]),
      node("2", "slider", "별점", [], {
        backendDOMNodeId: 7,
        value: { value: 5 },
        properties: [
          { name: "valuemin", value: { value: 0 } },
          { name: "valuemax", value: { value: 5 } },
        ],
      }),
    ]) as string[];
    expect(lines).toEqual(["설정", "별점: 5"]);
  });

  it("ends a sentence at its period, without a space in front of it", () => {
    // The trailing period is a StaticText of its own, so joining the run with a
    // blanket space read back "request a new article ." — punctuation the page
    // never wrote, in text an agent quotes verbatim.
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["p"]),
      node("p", "paragraph", "", ["t1", "l", "t2"]),
      node("t1", "StaticText", "You can"),
      node("l", "link", "request a new article", [], { backendDOMNodeId: 7 }),
      node("t2", "StaticText", "."),
    ]) as string[];
    expect(lines).toEqual(["Doc", "You can request a new article."]);
  });

  it("glues more of the SAME cell as the page drew it", () => {
    // The two pieces sit in one cell but under different containers, so no run
    // carries them — the row join is what puts them back together, and it must
    // not invent a space either.
    const lines = renderAxText([
      node("r", "row", "", ["c"]),
      node("c", "cell", "", ["p", "st2"]),
      node("p", "paragraph", "", ["st1"]),
      node("st1", "StaticText", "China"),
      node("st2", "StaticText", "[n 1]"),
    ]) as string[];
    expect(lines).toEqual(["China[n 1]"]);
  });

  it("keeps the space a text node carried in front of the link beside it", () => {
    // Wikipedia's deletion notice, byte-exact: the trailing space belongs to the
    // text node, and the emit-time trim threw it away — so the character rule saw
    // a comma, decided no space was needed, and read_text answered
    // "If the page has been deleted,check the deletion log". The space is not
    // inferred here, it is EVIDENCE the node carries.
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["p"]),
      node("p", "paragraph", "", ["t1", "l"]),
      node("t1", "StaticText", "If the page has been deleted, "),
      node("l", "link", "check the deletion log", [], { backendDOMNodeId: 7 }),
    ]) as string[];
    expect(lines).toEqual(["Doc", "If the page has been deleted, check the deletion log"]);
  });

  it("welds a quote to the phrase but restores the space after it", () => {
    // Both directions of the rule in ONE sentence, which is why this shape is
    // the sharpest pin: the closing `"` is its own text node with dry edges and
    // must stay against "tree" (a blanket space shipped `Accessibility tree "`),
    // while the next node BEGINS with a real space that the same character rule
    // deleted — read_text answered `…"Accessibility tree"in existing articles.`
    const lines = renderAxText([
      node("1", "RootWebArea", "Doc", ["p"]),
      node("p", "paragraph", "", ["t1", "l", "t2", "t3"]),
      node("t1", "StaticText", 'Search for "'),
      node("l", "link", "Accessibility tree", [], { backendDOMNodeId: 7 }),
      node("t2", "StaticText", '"'),
      node("t3", "StaticText", " in existing articles."),
    ]) as string[];
    expect(lines).toEqual(["Doc", 'Search for "Accessibility tree" in existing articles.']);
  });

  it("keeps the space in front of a parenthesis the page put one before", () => {
    // "Wiktionary(dictionary)" in the field: an opening bracket is a boundary
    // character, so the character rule welded it onto the link's name — but the
    // page's own text node opens with a space, which decides it.
    const lines = renderAxText([
      node("p", "paragraph", "", ["l", "t"]),
      node("l", "link", "Wiktionary", [], { backendDOMNodeId: 7 }),
      node("t", "StaticText", " (dictionary)"),
    ]) as string[];
    expect(lines).toEqual(["Wiktionary (dictionary)"]);
  });

  it("keeps a footnote marker tight but starts the next sentence with a space", () => {
    // The two rules meeting at one link: "[3]" has dry edges and belongs against
    // the word it annotates, exactly as round 7 pinned it, and the sentence that
    // follows carries its own leading space — which used to vanish, shipping
    // "…currency.[3]Such fluctuations may change…" as the page's own prose.
    const lines = renderAxText([
      node("p", "paragraph", "", ["t1", "l", "t2"]),
      node("t1", "StaticText", "using current exchange rates for currency."),
      node("l", "link", "[3]", [], { backendDOMNodeId: 7 }),
      node("t2", "StaticText", " Such fluctuations may change a country ranking."),
    ]) as string[];
    expect(lines).toEqual([
      "using current exchange rates for currency.[3] Such fluctuations may change a country ranking.",
    ]);
  });

  it("reads a comma-separated list of links as the list the page wrote", () => {
    // Every separator here is a text node of its own — ", " between the links,
    // and ": " after the lead-in — and each one's trailing space was trimmed
    // away, so a whole list of countries came back as
    // "includes the following states:Andorra,Australia,Bahamas, The". The comma
    // still gets no space in FRONT of it, because that edge is genuinely dry.
    const lines = renderAxText([
      node("p", "paragraph", "", ["t1", "l1", "c1", "l2", "c2", "l3"]),
      node("t1", "StaticText", "includes the following states: "),
      node("l1", "link", "Andorra", [], { backendDOMNodeId: 7 }),
      node("c1", "StaticText", ", "),
      node("l2", "link", "Australia", [], { backendDOMNodeId: 8 }),
      node("c2", "StaticText", ", "),
      node("l3", "link", "Bahamas, The", [], { backendDOMNodeId: 9 }),
    ]) as string[];
    expect(lines).toEqual(["includes the following states: Andorra, Australia, Bahamas, The"]);
  });

  it("still welds a period whose own text node has no space either side", () => {
    // The round-7 case that motivated gluing in the first place, kept as a pin:
    // with BOTH edges dry there is no evidence, the character rule decides, and
    // read_text must not go back to answering "request a new article ."
    const lines = renderAxText([
      node("p", "paragraph", "", ["t1", "t2"]),
      node("t1", "StaticText", "request a new article"),
      node("t2", "StaticText", "."),
    ]) as string[];
    expect(lines).toEqual(["request a new article."]);
  });

  it("spaces two BLOCKS of one cell, which no text node spans", () => {
    // A cell holding two paragraphs: the boundary between them carries no text
    // node at all, so there is no edge whitespace to find — and welded, the cell
    // read back as "First sentence.Second sentence.", a sentence boundary an
    // agent cannot see. The structure is the evidence here. It is a SIBLING-block
    // test and not "the container changed", because moving from inside a block
    // out to cell level changes the container too and must stay welded — see the
    // "China[n 1]" pin above.
    const lines = renderAxText([
      node("r", "row", "", ["c"]),
      node("c", "cell", "", ["p1", "p2"]),
      node("p1", "paragraph", "", ["s1"]),
      node("s1", "StaticText", "First sentence."),
      node("p2", "paragraph", "", ["s2"]),
      node("s2", "StaticText", "Second sentence."),
    ]) as string[];
    expect(lines).toEqual(["First sentence. Second sentence."]);
  });

  it("suppresses a footnote link its cell's label already spells out", () => {
    // The needle carries its own boundaries: `[n 1]` sits at a NON-boundary
    // position inside "China[n 1]" (an `a` right before the bracket), so
    // whole-token suppression missed it and the reference printed twice.
    const lines = renderAxText([
      node("r", "row", "", ["c"]),
      node("c", "cell", "China[n 1]", ["l", "f"]),
      node("l", "link", "China", [], { backendDOMNodeId: 41 }),
      node("f", "link", "[n 1]", [], { backendDOMNodeId: 42 }),
    ]) as string[];
    expect(lines).toEqual(["China[n 1]"]);
  });

  it("suppresses a fragment that starts on punctuation inside a longer label", () => {
    const lines = renderAxText([
      node("1", "cell", "ASEAN-5[r 10]", ["2", "3"]),
      node("2", "StaticText", "ASEAN"),
      node("3", "StaticText", "-5"),
    ]) as string[];
    expect(lines).toEqual(["ASEAN-5[r 10]"]);
  });

  it("still prints a day number its calendar's date only CONTAINS", () => {
    // The other side of the same rule: "26" is digits at both ends, so it keeps
    // demanding real boundaries and still fails to find them inside
    // "2026.08.08" — the day numbers stay on the page.
    const lines = renderAxText([
      node("1", "grid", "달력 2026.08.08", ["2"]),
      node("2", "cell", "", ["3"]),
      node("3", "StaticText", "26"),
    ]) as string[];
    expect(lines).toEqual(["달력 2026.08.08", "26"]);
  });

  it("drops a bracket-only line, keeping bracketed text and bare punctuation", () => {
    // The lone `}` is the reason an UNPAIRED bracket survives: read_text is how
    // an agent reads a source listing, and that line is the listing's content.
    const lines = renderAxText([
      node("1", "RootWebArea", "지도", ["2", "3", "4", "5", "6"]),
      node("2", "StaticText", "( )"),
      node("3", "StaticText", "(광교점)"),
      node("4", "StaticText", "-"),
      node("5", "StaticText", "[ ]"),
      node("6", "StaticText", "}"),
    ]) as string[];
    expect(lines).toEqual(["지도", "(광교점)", "-", "}"]);
  });

  it("adopts in-scope nodes the childIds chain cannot reach, when told which", () => {
    // read_text scoped to a map region answered a few characters for an element
    // the unscoped read shows full — the same detached-island case the
    // interaction view has.
    const nodes = [
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "region", "Map", [], { backendDOMNodeId: 10 }),
      node("3", "image", "음식점", [], { backendDOMNodeId: 11 }),
    ];
    expect(renderAxText(nodes, 10)).toEqual(["Map"]);
    expect(renderAxText(nodes, 10, new Set([11]))).toEqual(["Map", "음식점"]);
    expect(renderAxText(nodes, 999, new Set([11]))).toBeNull();
  });

  it("reads ONLY the in-scope nodes when there is no start node to walk from", () => {
    // A read scoped to an element the DOM has and this AX tree does not — an
    // overlay that never got an accessibility node, a pane mid-rebuild. The set
    // is then the whole scope, each id entered as its own root; answering with
    // the full page instead would read as that element's text.
    const nodes = [
      node("1", "RootWebArea", "지도", ["2"]),
      node("2", "region", "Map", [], { backendDOMNodeId: 10 }),
      node("3", "image", "음식점", [], { backendDOMNodeId: 11 }),
    ];
    expect(renderAxText(nodes, undefined, new Set([11]))).toEqual(["음식점"]);
    // An empty set is not a scope, and neither is an absent one: both still mean
    // the whole page.
    expect(renderAxText(nodes, undefined, new Set())).toEqual(["지도", "Map", "음식점"]);
    expect(renderAxText(nodes)).toEqual(["지도", "Map", "음식점"]);
  });

  it("prints a huge value WHOLE — it is the channel the snapshot's cut points at", () => {
    const lines = renderAxText([
      node("1", "textbox", "소스", [], { backendDOMNodeId: 7, value: { value: "x".repeat(4000) } }),
    ]) as string[];
    expect(lines).toEqual([`소스: ${"x".repeat(4000)}`]);
  });
});

describe("sliderPlan", () => {
  // A slider takes no text at all: the clearing ladder pressed End (which on a
  // range control means MAXIMUM), typed, and verified only that the OLD value
  // was gone — so `type(value="4")` left a 0-to-5 rating at 5 and said it
  // worked. The arrow-press arithmetic that replaces it is unit-tested here so
  // that no page is needed to know whether it lands where it says.

  it("counts presses toward the target and names the direction", () => {
    expect(sliderPlan({ current: "1", target: "4", min: "0", max: "5", step: "1" })).toEqual({
      ok: true,
      presses: 3,
      key: "ArrowRight",
      fromMin: false,
      expected: 4,
      min: 0,
      max: 5,
      step: 1,
    });
    expect(sliderPlan({ current: "5", target: "2", min: "0", max: "5", step: "1" })).toMatchObject({
      ok: true,
      presses: 3,
      key: "ArrowLeft",
      expected: 2,
    });
  });

  it("lands exactly on a fractional step without float noise", () => {
    // 0.1 + 0.2 is 0.30000000000000004, and a verify comparing that against the
    // page's "0.3" would fail a move that landed exactly right.
    expect(sliderPlan({ current: "1", target: "3.5", min: "0", max: "5", step: "0.5" })).toMatchObject(
      { ok: true, presses: 5, key: "ArrowRight", expected: 3.5 },
    );
    expect(sliderPlan({ current: "0.1", target: "0.3", min: "0", max: "1", step: "0.1" })).toMatchObject(
      { ok: true, presses: 2, expected: 0.3 },
    );
  });

  it("plans from the minimum when the current value cannot be read", () => {
    // Not a failure: Home takes the control to its minimum, which is a known
    // place to count from — the caller presses it first.
    expect(sliderPlan({ current: "", target: "2", min: "0", max: "5", step: "1" })).toMatchObject({
      ok: true,
      presses: 2,
      fromMin: true,
      expected: 2,
    });
    expect(sliderPlan({ target: "0", min: "0", max: "5" })).toMatchObject({
      ok: true,
      presses: 0,
      key: "ArrowRight",
      fromMin: true,
    });
  });

  it("refuses a target that is not a number, or is off the scale", () => {
    // Both answers carry the resolved bounds, which is what lets the caller say
    // "max is 5" instead of leaving the agent to retry the same value.
    expect(sliderPlan({ current: "1", target: "높게", max: "5" })).toEqual({
      ok: false,
      reason: "not-a-number",
      min: 0,
      max: 5,
      step: 1,
    });
    expect(sliderPlan({ current: "1", target: "9", min: "0", max: "5", step: "1" })).toEqual({
      ok: false,
      reason: "out-of-range",
      min: 0,
      max: 5,
      step: 1,
    });
    expect(sliderPlan({ current: "1", target: "-1", min: "0", max: "5", step: "1" })).toMatchObject({
      ok: false,
      reason: "out-of-range",
    });
  });

  it("refuses a move too far to be worth pressing an arrow for", () => {
    expect(
      sliderPlan({ current: "0", target: "5000", min: "0", max: "100000", step: "1" }),
    ).toEqual({ ok: false, reason: "too-far", presses: 5000, min: 0, max: 100000, step: 1 });
  });

  it("falls back to 0/100/1 for bounds a page did not give, or gave badly", () => {
    // `step="any"` is unparseable and a bad attribute can arrive at 0 or below,
    // either of which divides the press count into Infinity.
    expect(sliderPlan({ current: "0", target: "50" })).toMatchObject({
      ok: true,
      presses: 50,
      min: 0,
      max: 100,
      step: 1,
    });
    expect(sliderPlan({ current: "0", target: "2", step: "any" })).toMatchObject({ step: 1 });
    expect(sliderPlan({ current: "0", target: "2", step: "0" })).toMatchObject({ step: 1 });
    expect(sliderPlan({ current: "0", target: "2", step: "-1" })).toMatchObject({ step: 1 });
  });

  it("refuses rather than throwing when called with nothing at all", () => {
    expect(sliderPlan()).toMatchObject({ ok: false, reason: "not-a-number" });
    expect(sliderPlan(null)).toMatchObject({ ok: false, reason: "not-a-number" });
  });
});

describe("axValueAnswer", () => {
  // The shapes are transcribed from real Chrome output, measured in
  // tests/visual/clear-ladder.spec.ts. This is the half of the clear bug that
  // needed no page at all to be wrong: reading three states as two.
  const field = (value?: string, editable = "plaintext") => ({
    role: { value: "textbox" },
    ...(value === undefined ? {} : { value: { type: "string", value } }),
    properties: [
      { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
      { name: "editable", value: { type: "token", value: editable } },
    ],
  });

  it("reads a field's text RAW, so a length can be counted off it", () => {
    // Trimming here would under-count an IME replacement range and leave residue.
    expect(axValueAnswer(field("광교카페거리성남"))).toBe("광교카페거리성남");
    expect(axValueAnswer(field("  spaced  "))).toBe("  spaced  ");
  });

  it("answers \"\" for an EMPTY field, which Chrome reports by omitting `value`", () => {
    expect(axValueAnswer(field(undefined))).toBe("");
    expect(axValueAnswer(field(undefined, "richtext"))).toBe("");
  });

  it("answers null for a node that carries no value AND is not editable", () => {
    // The combobox WRAPPER an agent's uid actually points at. Answering "" here
    // is what silently disarmed clear verification: an empty `before` makes
    // clearFailed give up, so a deterministic append reported success.
    const wrapper = {
      role: { value: "combobox" },
      properties: [{ name: "expanded", value: { type: "booleanOrUndefined", value: false } }],
    };
    expect(axValueAnswer(wrapper)).toBeNull();
    expect(axValueAnswer(undefined)).toBeNull();
    expect(axValueAnswer(null)).toBeNull();
  });

  it("keeps a numeric or zero value readable", () => {
    // A slider/spinbutton reports a number, and `??` (not `||`) is why 0 prints.
    expect(axValueAnswer({ value: { type: "number", value: 0 } })).toBe("0");
    expect(axValueAnswer({ value: { type: "string", value: "" } })).toBe("");
  });
});

describe("clearFailed", () => {
  it("catches the old value surviving at EITHER end", () => {
    // Caret at the end, then caret at 0 — both seen in the field.
    expect(clearFailed("광교", "광교카페거리", "카페거리")).toBe(true);
    expect(clearFailed("광교", "카페거리광교", "카페거리")).toBe(true);
    expect(clearFailed("광교카페거리성남", "광교카페거리성남성남", "성남")).toBe(true);
  });

  it("does not fire on a clean replacement, a middle hit, or an unreadable read", () => {
    expect(clearFailed("광교", "카페거리", "카페거리")).toBe(false);
    // An exact match on the requested value is success whatever came before.
    expect(clearFailed("광교", "광교역", "광교역")).toBe(false);
    // A short old value colliding mid-string is a coincidence, not a survival —
    // a false alarm here costs a real error on a page that worked.
    expect(clearFailed("교", "광교역", "광교역")).toBe(false);
    // Verification unavailable must never read as failure.
    expect(clearFailed(null, "광교카페거리", "카페거리")).toBe(false);
    expect(clearFailed("광교", null, "카페거리")).toBe(false);
    // Nothing was there to survive.
    expect(clearFailed("", "카페거리", "카페거리")).toBe(false);
    expect(clearFailed("   ", "카페거리", "카페거리")).toBe(false);
  });

  it("compares trimmed, so a page's own padding is not a survival", () => {
    expect(clearFailed(" 광교 ", " 카페거리 ", "카페거리")).toBe(false);
    expect(clearFailed(" 광교 ", " 광교카페거리 ", "카페거리")).toBe(true);
  });
});
