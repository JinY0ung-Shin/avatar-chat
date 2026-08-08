import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the browser bridge's snapshot lifecycle flush
// (extension/background.js: flushLifecycle, called from buildSnapshot /
// buildScopedSnapshot / buildPageText).
//
// The field bug this pins: clicking "Add Element" on
// the-internet.herokuapp.com/add_remove_elements returned success, and the
// `<button>Delete</button>` it added was absent from snapshot, read_text AND
// wait_for for many seconds — then appeared instantly on a later attempt. The
// snapshot path called ONLY `Accessibility.getFullAXTree`, and nothing in it
// forced a document lifecycle tick. Chrome updates its AXObject tree lazily, so
// on an IDLE tab (no animation, no further input) the walk answered from a tree
// that predated the DOM change; a page with a running animation pumped its own
// lifecycle, which is exactly why the failure looked intermittent.
//
// `Page.getLayoutMetrics` is the cheapest ALLOWLISTED call that forces the tick
// — the bridge is default-deny on CDP and will not add a method just for this —
// and it is why screenshots and quad reads never showed the bug: both already
// pay for a lifecycle update on the way in.
//
// Timing bugs do not prove themselves in one green run, so the assertion loops.
//
// OBSERVED (headless Chromium 143, Linux, Playwright 1.61): the FLUSHED read is
// fresh 10/10, and the unflushed read also missed 0/10 — this harness pumps its
// own lifecycle, so it cannot reproduce the field staleness and no assertion is
// made in that direction. That asymmetry is the point of the second test: it
// records the number instead of pretending headless is the field.
//
// Run with `node tests/run-visual.mjs ax-flush` (npx playwright is broken here).

/** An idle page: no animation, no timer, nothing that would pump the lifecycle. */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>idle page</title>
<div id="host"><p>static content</p></div>`;

const ROUNDS = 10;

/** Every AX node's accessible name, the way renderAxTree reads them. */
async function axNames(cdp: CDPSession): Promise<string[]> {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
  return ((nodes ?? []) as { name?: { value?: unknown } }[]).map((node) =>
    String(node?.name?.value ?? ""),
  );
}

test.describe("AX tree freshness after a page-JS DOM mutation (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
    await cdp.send("Accessibility.enable");
  });

  test("getLayoutMetrics before getFullAXTree reports a just-added button", async ({ page }) => {
    // `page.evaluate` stands in for the page's OWN click handler — the bridge
    // never runs page JS; what matters is that the mutation came from the
    // renderer and the tab then went idle, which is the field shape.
    for (let round = 0; round < ROUNDS; round += 1) {
      const label = `Delete ${round}`;
      await page.evaluate((text) => {
        const button = document.createElement("button");
        button.textContent = text;
        document.querySelector("#host")!.appendChild(button);
      }, label);

      await cdp.send("Page.getLayoutMetrics", {});
      expect(await axNames(cdp), `round ${round}: new button missing after flush`).toContain(label);
    }
  });

  test("the unflushed path is measured, not assumed", async ({ page }) => {
    // The counterpart measurement, kept OUT of the asserted loop so no flush of
    // its own can contaminate it: how often does the bare getFullAXTree — the
    // exact call the bridge used to make on its own — miss a button the page
    // just added? The number is recorded, never asserted: headless Chromium has
    // no browser UI and different idle behavior, so a red cell here would pin
    // the harness rather than the platform. What IS asserted is the direction
    // the fix depends on — after a flush, everything added is there.
    const added: string[] = [];
    let missed = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const label = `Unflushed ${round}`;
      added.push(label);
      await page.evaluate((text) => {
        const button = document.createElement("button");
        button.textContent = text;
        document.querySelector("#host")!.appendChild(button);
      }, label);
      if (!(await axNames(cdp)).includes(label)) missed += 1;
    }

    const summary = `unflushed getFullAXTree missed ${missed} of ${ROUNDS} just-added buttons`;
    // eslint-disable-next-line no-console
    console.log("ax-flush:", summary);
    test.info().attach("ax-flush-unflushed-miss-rate", { body: summary });

    await cdp.send("Page.getLayoutMetrics", {});
    const names = await axNames(cdp);
    for (const label of added) expect(names, `${label} missing after flush`).toContain(label);
  });
});
