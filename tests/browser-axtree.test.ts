import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { renderAxTree, renderAxText, capSnapshot, mergeTextLines } from "../extension/axtree.js";

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
    const lines = render([
      node("3", "StaticText", "셋째"),
      node("1", "RootWebArea", "Doc", ["2", "3"]),
      node("2", "StaticText", "둘째"),
    ]);
    expect(lines).toEqual(['RootWebArea "Doc"', 'StaticText "둘째"', 'StaticText "셋째"']);
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
});
