import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { renderAxTree, renderAxText } from "../extension/axtree.js";

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
