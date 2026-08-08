import { describe, expect, it } from "vitest";
// Kept on ONE line: @ts-expect-error only covers the line after it, and the
// error is raised on the module specifier — the LAST line of a wrapped import.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { renderAxTree, renderAxText, capSnapshot, mergeTextLines, unlabeledInteractiveIds } from "../extension/axtree.js";

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

describe("renderAxTree", () => {
  it("prints a link once, not again as the text inside it", () => {
    // The doubling that made every snapshot twice as expensive to read.
    const lines = render([
      node("1", "RootWebArea", "Docs", ["2"]),
      node("2", "link", "Parsoid", ["3"], { backendDOMNodeId: 42 }),
      node("3", "StaticText", "Parsoid"),
    ]);
    expect(lines).toEqual(['RootWebArea "Docs"', '[e1] link "Parsoid"']);
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
    expect(lines).toEqual(['RootWebArea "위키백과의 신뢰도"', 'StaticText "위키백과"']);
  });

  it("keeps prose that is not contained in any ancestor label", () => {
    const lines = render([
      node("1", "link", "짧은 라벨", ["2"], { backendDOMNodeId: 3 }),
      node("2", "StaticText", "이건 라벨에 없는 새로운 문장이다"),
    ]);
    expect(lines).toEqual([
      '[e1] link "짧은 라벨"',
      'StaticText "이건 라벨에 없는 새로운 문장이다"',
    ]);
  });

  it("emits in document order, not in the order Chrome listed the nodes", () => {
    // Both StaticTexts hang off the same container, so they now render as ONE
    // joined run (inline text used to print a word per line). Document order is
    // still what the assertion pins — it is visible inside the joined line.
    const lines = render([
      node("3", "StaticText", "셋째"),
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "StaticText", "둘째"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', 'StaticText "둘째 셋째"']);
  });

  it("still gives a uid to a nameless interactive element", () => {
    // An icon-only button or an unlabeled rich-text editor: unreachable if the
    // walk drops it for having no name.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "textbox", "", [], { backendDOMNodeId: 9 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] textbox ""']);
  });

  it("prints a field's value even when the label repeats an ancestor", () => {
    // Suppressing this would hide what the user actually typed.
    const lines = render([
      node("1", "form", "검색", ["2"]),
      node("2", "combobox", "검색", [], { backendDOMNodeId: 5, value: { value: "위키백과" } }),
    ]);
    expect(lines).toEqual(['form "검색"', '[e1] combobox "검색" = "위키백과"']);
  });

  it("mints uids in output order so they match what the agent reads", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "button", "첫째", [], { backendDOMNodeId: 1 }),
      node("3", "button", "둘째", [], { backendDOMNodeId: 2 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] button "첫째"', '[e2] button "둘째"']);
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
    expect(lines).toEqual(['RootWebArea "Doc"', 'StaticText "루프"']);
  });

  it("skips ignored nodes but keeps walking through them", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "StaticText", "숨겨짐", ["3"], { ignored: true }),
      node("3", "button", "보임", [], { backendDOMNodeId: 4 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] button "보임"']);
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
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] link "메뉴"', '[e2] link "위로"']);
  });

  it("truncates a very long link url", () => {
    const long = `https://example.com/${"x".repeat(300)}`;
    const lines = render([
      node("1", "link", "긴 링크", [], {
        backendDOMNodeId: 7,
        properties: [{ name: "url", value: { value: long } }],
      }),
    ]);
    expect(lines[0].length).toBeLessThan(200);
    expect(lines[0]).toContain("…");
  });

  it("gives a uid to a NAMED table-row menu item, but not to a nameless cell", () => {
    // draw.io's submenu rows render as LayoutTableCell — with no uid they were
    // visible but unclickable, making whole menus unreachable.
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "LayoutTableCell", "다이어그램 편집...", [], { backendDOMNodeId: 7 }),
      node("3", "LayoutTableCell", "", [], { backendDOMNodeId: 8 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] LayoutTableCell "다이어그램 편집..."']);
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
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] heading "섹션 열기"']);
  });

  it("gives a uid to a nameless canvas so canvas apps can be focused", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "canvas", "", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] canvas ""']);
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
    expect(lines).toEqual(['RootWebArea "지도"', '[e1] region "지도"']);
  });

  it("gives a uid to a named application container", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "application", "도면 편집기", [], { backendDOMNodeId: 7 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] application "도면 편집기"']);
  });

  it("keeps a named region's label from covering its children", () => {
    // A uid says "actionable", not "my name describes my subtree" — region
    // stays opaque, so text repeating its name is still real page content.
    const lines = render([
      node("1", "region", "공지", ["2"], { backendDOMNodeId: 7 }),
      node("2", "StaticText", "공지"),
    ]);
    expect(lines).toEqual(['[e1] region "공지"', 'StaticText "공지"']);
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
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] button "길찾기"']);
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
    expect(lines).toEqual(['RootWebArea "지도"', '[e1] slider "0" = "14"']);
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
      'StaticText "26"',
      'StaticText "2"',
      'StaticText "8"',
      'StaticText "20"',
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
    expect(lines).toEqual(['heading "8월 26일 토요일"', 'StaticText "일"', 'StaticText "월"']);
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
    expect(lines).toEqual(['RootWebArea "Doc"', 'StaticText "오늘 서울에 폭염경보"']);
  });

  it("does not join text across two different containers", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "paragraph", "", ["4"]),
      node("3", "paragraph", "", ["5"]),
      node("4", "StaticText", "첫 문단"),
      node("5", "StaticText", "둘째 문단"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', 'StaticText "첫 문단"', 'StaticText "둘째 문단"']);
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
      'StaticText "앞"',
      '[e1] link "링크"',
      'StaticText "뒤"',
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
    expect(lines).toEqual(['[e1] link "댓글 보기"', 'StaticText "어제 갔던 가게"']);
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
      expect(lines, role).toEqual(['StaticText "오늘 서울에 폭염경보"']);
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
      expect(lines, role).toEqual(['StaticText "앞"', 'StaticText "뒤"']);
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
    expect(lines).toEqual(['grid "달력 2026.08.08"', 'StaticText "26"']);
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
      '[e2] link "폭염 특보 확대 발령" → https://news.example/a',
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
      '[e1] button "" (dom: #map-zoom-in)',
      '[e2] button "저장"',
      '[e3] textbox "" = "광교"',
    ]);
  });

  it("renders unchanged when the caller passes no hints at all", () => {
    const lines = render([
      node("1", "RootWebArea", "Doc", ["2"]),
      node("2", "button", "", [], { backendDOMNodeId: 48 }),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', '[e1] button ""']);
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
      '[e1] link "첫째" → https://e.example/1',
      '[e2] link "둘째" → https://e.example/2',
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

  it("preserves document order among the kept lines", () => {
    const filler = `StaticText "${"x".repeat(500)}"`;
    const out = capSnapshot([filler, '[e1] button "둘"', '[e2] button "하나"'].join("\n"), 60);
    expect(out.indexOf("[e1]")).toBeLessThan(out.indexOf("[e2]"));
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
});
