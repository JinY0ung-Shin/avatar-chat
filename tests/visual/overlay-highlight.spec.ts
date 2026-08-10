import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the CDP Overlay facts the action highlight
// (extension/background.js: the DevTools-style box drawn over the element an
// op is about to act on) is built on. The browser compositor renders the box —
// the page executes no JS and its DOM never changes — but whether the wiring
// is RIGHT rests on protocol behavior this repo pins by experiment, not by
// reading the specification (ax-facts.spec.ts's DOMSnapshot.enable probe is
// the precedent):
//
//   1. `Overlay.highlightNode` REFUSES without `Overlay.enable` ("Overlay must
//      be enabled before a tool can be shown" — measured below). That refusal
//      is exactly why `Overlay.enable` earns its CDP_ALLOWLIST entry and its
//      call in ensureAttached, where the DOMSnapshot.enable probe kept THAT
//      method off the list: default-deny means an entry exists only when a
//      real call needs it, and this one is needed.
//   2. In a HEADFUL browser — what the fleet runs; the bridge drives the
//      user's real window — a drawn box IS included in what
//      `Page.captureScreenshot` returns (measured with `--headed` under
//      WSLg). The screenshot is MODEL INPUT and click_at inverts its pixel
//      mapping, so captureShot's hide-before-capture is LOAD-BEARING: without
//      it the model reads a green box that is not page content. The headless
//      shell this suite runs under in CI never paints the overlay at all
//      (byte-identical captures), so the test pins each environment's own
//      truth and the headful half is exercised by running `--headed` locally
//      when touching the highlight path.
//   3. A drawn highlight does NOT intercept `DOM.getNodeForLocation`. The
//      obscured-click guard hit-tests the exact point about to be clicked
//      after the box is up; if the overlay were hit-testable, every
//      highlighted click would refuse itself.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/overlay-highlight.spec.ts`
// (npx playwright is broken here; no dev server needed — setContent + raw CDP).

/**
 * Static and animation-free on purpose: the probe decides "did the overlay
 * draw?" by comparing whole-viewport PNG captures byte-for-byte, so the page
 * itself must never be a source of pixel change between two captures.
 */
const FIXTURE = `
  <style>
    body { margin: 0; background: #ffffff; }
    #target { width: 240px; height: 120px; margin: 40px; background: #dddddd; }
  </style>
  <div id="target">조작 대상</div>
`;

/** Center of #target under the fixture's margins: (40 + 240/2, 40 + 120/2). */
const TARGET_CENTER = { x: 160, y: 100 };

/**
 * A loud, mostly-opaque fill: if the overlay composites at all, two captures
 * around highlightNode cannot come back byte-identical.
 */
const HIGHLIGHT_CONFIG = {
  showInfo: false,
  contentColor: { r: 46, g: 160, b: 67, a: 0.55 },
  borderColor: { r: 46, g: 160, b: 67, a: 1 },
};

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`overlay-highlight ${label}:`, body);
  test.info().attach(`overlay-highlight-${label}`, { body });
}

async function backendIdFor(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId as number;
}

/** Viewport PNG via the same command the bridge's captureShot sends. */
async function shot(cdp: CDPSession): Promise<string> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return data;
}

/** Give the compositor a couple of frames to present (or clear) the overlay. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test.describe("what the CDP Overlay domain actually does (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(FIXTURE);
    cdp = await page.context().newCDPSession(page);
    // Exactly the domains ensureAttached turns on. Overlay.enable is
    // deliberately NOT sent here: the first test pins that highlighting
    // refuses without it, the later ones send it themselves.
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
  });

  test("highlightNode refuses without Overlay.enable — the allowlist justification", async () => {
    const backendNodeId = await backendIdFor(cdp, "#target");
    let failure = "";
    try {
      await cdp.send("Overlay.highlightNode", {
        backendNodeId,
        highlightConfig: HIGHLIGHT_CONFIG,
      });
    } catch (error) {
      failure = String(error);
    }
    record("no-enable", { failure: failure || null });

    // The measured refusal. If a future Chrome starts answering without
    // enable, this pin flips and Overlay.enable should come OFF the allowlist
    // and out of ensureAttached — the DOMSnapshot.enable rule applied in the
    // other direction.
    expect(failure, "highlightNode needs Overlay.enable first").toContain(
      "Overlay must be enabled",
    );
  });

  test("headful capture includes the box; hideHighlight restores it exactly", async () => {
    await cdp.send("Overlay.enable");
    const backendNodeId = await backendIdFor(cdp, "#target");
    // Which of the two measured worlds is this run in? NOT the page's
    // navigator.userAgent — the config's devices["Desktop Chrome"] preset
    // pins that to a regular Chrome string in every mode. Browser.getVersion
    // reports the browser's own product ("HeadlessChrome/…" vs "Chrome/…"),
    // beneath emulation's reach.
    const { product } = await cdp.send("Browser.getVersion");
    const headless = product.includes("Headless");

    const before = await shot(cdp);
    await cdp.send("Overlay.highlightNode", {
      backendNodeId,
      highlightConfig: HIGHLIGHT_CONFIG,
    });
    await settle();
    const during = await shot(cdp);
    await cdp.send("Overlay.hideHighlight");
    await settle();
    const after = await shot(cdp);
    const observed = {
      headless,
      captureSeesBox: during !== before,
      captureRestored: after === before,
    };
    record("draw-hide", observed);

    // Fact 2, each environment pinning its own measured truth. If the
    // headless pin ever flips (a future shell that paints the overlay), CI
    // has become able to measure the headful half — tighten, don't loosen.
    if (observed.headless) {
      expect(observed.captureSeesBox, "the headless shell never paints the overlay").toBe(false);
    } else {
      expect(
        observed.captureSeesBox,
        "headful Page.captureScreenshot INCLUDES the box — hide-before-capture is load-bearing",
      ).toBe(true);
    }
    expect(observed.captureRestored, "hideHighlight returns the exact pre-highlight pixels").toBe(
      true,
    );
  });

  test("a drawn highlight does not intercept DOM.getNodeForLocation", async () => {
    await cdp.send("Overlay.enable");
    const backendNodeId = await backendIdFor(cdp, "#target");
    await cdp.send("Overlay.highlightNode", {
      backendNodeId,
      highlightConfig: HIGHLIGHT_CONFIG,
    });
    await settle();
    const hit = await cdp.send("DOM.getNodeForLocation", {
      x: TARGET_CENTER.x,
      y: TARGET_CENTER.y,
    });
    const observed = { hitBackendNodeId: hit.backendNodeId, target: backendNodeId };
    record("hit-test", observed);

    // Fact 3: the overlay is not a DOM node and takes no part in hit-testing,
    // so the obscured-click guard keeps working with the box up.
    expect(observed.hitBackendNodeId, "the hit under a drawn box is still the page element").toBe(
      backendNodeId,
    );
  });
});
