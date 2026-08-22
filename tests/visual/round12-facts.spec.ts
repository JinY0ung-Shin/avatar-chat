import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the Chrome fact VOC round 12 decides on
// (extension/axtree.js: which listener kinds DOMSnapshot's `isClickable`
// marks, and therefore whether a drag-and-drop container that binds
// `pointerdown` — SortableJS on any browser with PointerEvent — is
// DETECTABLE from the one capture the snapshot already pays for):
//
//   Field case: sortablejs.github.io's simple list. The items are plain
//   <div>s with no role, name, cursor or listener of their own; the ONE
//   signal on the page is the container's `pointerdown` listener. If
//   Chrome's isClickable does not mark that, no DOMSnapshot-only heuristic
//   can see the list at all, and the honest answer is a documented
//   limitation (pixel-mode drag on a screenshot), not a guess.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/round12-facts.spec.ts`
// (npx playwright is broken here; this spec needs no dev server — it drives a
// local fixture over raw CDP).

type DomSnapshot = {
  documents: {
    nodes: {
      parentIndex: number[];
      nodeName: number[];
      backendNodeId: number[];
      isClickable?: { index: number[] };
    };
  }[];
  strings: string[];
};

async function backendIdFor(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId as number;
}

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`round12-facts ${label}:`, body);
  test.info().attach(`round12-facts-${label}`, { body });
}

/**
 * One div per listener kind, nothing else on any of them — so a mark can only
 * come from the listener itself. `#plain` is the negative control that the
 * capture isn't marking everything; `#click` is the positive control that it
 * marks anything at all.
 */
const LISTENER_FIXTURE = `
  <style> div { width: 200px; height: 40px; } </style>
  <div id="plain">no listener</div>
  <div id="click">click</div>
  <div id="mousedown">mousedown</div>
  <div id="mouseup">mouseup</div>
  <div id="pointerdown">pointerdown</div>
  <div id="touchstart">touchstart</div>
  <script>
    for (const kind of ["click", "mousedown", "mouseup", "pointerdown", "touchstart"]) {
      document.getElementById(kind).addEventListener(kind, () => {});
    }
  </script>
`;

test.describe("round-12 Chrome facts (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(LISTENER_FIXTURE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
  });

  test("which listener kinds isClickable marks", async () => {
    const snapshot = (await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: ["cursor"],
    } as never)) as DomSnapshot;
    const doc = snapshot.documents[0];
    const indexOfBackend = new Map<number, number>();
    doc.nodes.backendNodeId.forEach((backendId, index) => indexOfBackend.set(backendId, index));
    const clickable = new Set(doc.nodes.isClickable?.index ?? []);
    const marked = async (selector: string) =>
      clickable.has(indexOfBackend.get(await backendIdFor(cdp, selector)) as number);

    const observed = {
      plain: await marked("#plain"),
      click: await marked("#click"),
      mousedown: await marked("#mousedown"),
      mouseup: await marked("#mouseup"),
      pointerdown: await marked("#pointerdown"),
      touchstart: await marked("#touchstart"),
    };
    record("listener-kinds", observed);

    // Controls: the capture marks listeners and only listeners.
    expect(observed.plain, "a div with no listener is not marked").toBe(false);
    expect(observed.click, "a click listener is marked").toBe(true);

    // The decision facts. Blink computes isClickable from
    // WillRespondToMouseClickEvents, which is about MOUSE click events —
    // whether pointerdown/touchstart count is exactly what this probe pins.
    // No expectation here beyond recording: whichever way these land IS the
    // fact the round-12 detection (and its documented limitation) is built on.
    record("decision", {
      mousedownDetectable: observed.mousedown,
      pointerdownDetectable: observed.pointerdown,
      touchstartDetectable: observed.touchstart,
    });
  });
});
