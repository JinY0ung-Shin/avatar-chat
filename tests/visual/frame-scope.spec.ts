import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the browser bridge's frame-scoped snapshot
// (extension/background.js: frameSourceFor / buildScopedSnapshot).
//
// The published tool description promises that "an Iframe's uid scopes into that
// frame". A plain `startBackendNodeId` walk CANNOT keep that promise, and this
// spec pins the reason: the <iframe> ELEMENT and the frame's CONTENT live in two
// different accessibility trees. `getFullAXTree` stops at the frame boundary, so
// scoping to the Iframe node returns the lone `Iframe` line and nothing under it
// — for the one uid an agent is most likely to scope by.
//
// It also pins the LOOKUP the special case is built on: `DOM.describeNode`
// populates `frameId` on frame owner elements and leaves it absent everywhere
// else, so one round trip turns "is this uid a frame owner?" into "which frame".
// That is why the bridge matches on frameId rather than on the backendNodeId
// `DOM.getFrameOwner` returns: a frameId is a browser-global string, while a
// backendNodeId only means anything inside the target that resolved it — so the
// frameId route stays correct even when the uid was minted in an OOPIF session.
//
// Run with `node tests/run-visual.mjs frame-scope` (npx playwright is broken).

/** A same-process child frame (srcdoc), plus a control element in the parent. */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>frame host</title>
<button id="outside">Parent Button</button>
<iframe id="widget" title="Widget frame"
        srcdoc="&lt;button&gt;Inside The Frame&lt;/button&gt;"></iframe>`;

type Described = { backendNodeId: number; frameId?: string };

async function describe(cdp: CDPSession, selector: string): Promise<Described> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return { backendNodeId: node.backendNodeId as number, frameId: node.frameId as string | undefined };
}

type AxNode = { role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };

async function axNodes(cdp: CDPSession, frameId?: string): Promise<AxNode[]> {
  const { nodes } = await cdp.send(
    "Accessibility.getFullAXTree",
    (frameId ? { frameId } : {}) as never,
  );
  return (nodes ?? []) as AxNode[];
}

const names = (nodes: AxNode[]) => nodes.map((node) => String(node?.name?.value ?? ""));

test.describe("frame-scoped snapshot mechanism (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
    await cdp.send("Accessibility.enable");
    await page.waitForTimeout(100); // let the srcdoc frame commit
  });

  test("describeNode carries frameId on the owner element only", async () => {
    const frame = await describe(cdp, "#widget");
    const plain = await describe(cdp, "#outside");
    expect(frame.frameId, "an <iframe> element must name its frame").toBeTruthy();
    expect(plain.frameId, "a non-owner element must not").toBeUndefined();

    // …and that id is the one Page.getFrameTree lists, which is what the bridge
    // matches against its per-source `docFrameId`.
    const { frameTree } = await cdp.send("Page.getFrameTree", {});
    const childIds = (frameTree.childFrames ?? []).map((child) => child.frame.id);
    expect(childIds).toContain(frame.frameId);
  });

  test("the root AX tree stops at the frame boundary", async () => {
    // The failure the special case exists for: the parent tree HAS the Iframe
    // node but NOT a single thing inside it, so a subtree walk from the Iframe
    // yields one line.
    const root = await axNodes(cdp);
    expect(names(root)).toContain("Parent Button");
    expect(names(root)).not.toContain("Inside The Frame");

    const iframeNode = root.find((node) => node.role?.value === "Iframe");
    expect(iframeNode, "the Iframe element itself is present in the parent tree").toBeTruthy();
    // The uid the agent holds is minted from THIS node, and it is the same
    // element describeNode answered about — that is the whole link from
    // uid → frameId → the source that renders the frame.
    const frame = await describe(cdp, "#widget");
    expect(iframeNode!.backendDOMNodeId).toBe(frame.backendNodeId);
  });

  test("asking per frameId returns the frame's own tree", async () => {
    const frame = await describe(cdp, "#widget");
    const inner = await axNodes(cdp, frame.frameId);
    // What buildScopedSnapshot returns for an Iframe uid: the frame's content,
    // which is exactly what the root tree could not give.
    expect(names(inner)).toContain("Inside The Frame");
    expect(names(inner)).not.toContain("Parent Button");
  });
});
