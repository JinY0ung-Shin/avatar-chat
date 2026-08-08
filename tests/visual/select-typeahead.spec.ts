import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the browser bridge's collapsed-<select> path
// (extension/background.js: typeaheadPrefix / selectOption).
//
// The field bug this pins: on the-internet.herokuapp.com/dropdown, asking for
// "Option 2" through the arrow-walk path came back
// `Selecting "Option 2" did not take: the dropdown now reads "Please select an
// option"`. A COLLAPSED select does not move its selection on ArrowDown on this
// platform — the key opens the browser-process native popup, which lives outside
// the renderer and which `Input.*` cannot reach at all. The bridge never runs
// page JS, so there is no setter to fall back on: the only remaining lever is
// the one a person uses, TYPING the option's name.
//
// What this spec asserts is the MECHANISM the fix depends on: type-ahead
// characters dispatched over raw CDP into a focused collapsed <select> change
// the element's value. It deliberately does NOT assert that ArrowDown fails —
// headless Chromium has no browser-process popup to open, so it may well move
// the selection here while the field build does not. A test that pinned the
// broken behavior would be pinning the harness, not the platform.
//
// Run with `node tests/run-visual.mjs select-typeahead` (npx playwright is
// broken in this repo — see tests/run-visual.mjs).

/** A plain collapsed <select>: no size, no multiple — the shape that failed. */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>collapsed select</title>
<form>
  <select id="dropdown">
    <option value="" selected>Please select an option</option>
    <option value="1">Option 1</option>
    <option value="2">Option 2</option>
    <option value="3" disabled>Option 3 (disabled)</option>
    <option value="4">Banana</option>
  </select>
</form>`;

type Ref = { backendNodeId: number };

async function refFor(cdp: CDPSession, selector: string): Promise<Ref> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return { backendNodeId: node.backendNodeId as number };
}

/**
 * background.js `dispatchKey`'s single printable-ASCII path. `text` is the whole
 * point: a keyDown WITHOUT it is a rawKeyDown, which produces no keypress and
 * feeds no type-ahead — which is also why the non-ASCII IME branch is excluded
 * in `typeaheadPrefix` rather than tried and measured after the fact.
 */
async function typeChar(cdp: CDPSession, ch: string): Promise<void> {
  const upper = ch.toUpperCase();
  const params = {
    key: ch,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    ...(/^[A-Z]$/.test(upper) ? { code: `Key${upper}` } : {}),
    ...(/^[0-9]$/.test(ch) ? { code: `Digit${ch}` } : {}),
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, ...params });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

/** What the bridge verifies against: the select's AX value, not the DOM value. */
async function axValue(cdp: CDPSession, ref: Ref): Promise<string> {
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId: ref.backendNodeId,
    fetchRelatives: false,
  });
  const list = (Array.isArray(nodes) ? nodes : []) as {
    backendDOMNodeId?: number;
    value?: { value?: unknown };
  }[];
  const node = list.find((one) => one.backendDOMNodeId === ref.backendNodeId) ?? list[0];
  return String(node?.value?.value ?? "").trim();
}

test.describe("collapsed <select> type-ahead (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
  });

  test("typing a unique prefix selects that option", async ({ page }) => {
    const ref = await refFor(cdp, "#dropdown");
    await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
    expect(await axValue(cdp, ref)).toBe("Please select an option");

    // "Option 2" shares "Option " with "Option 1", so the shortest prefix that
    // singles it out is the full 8 characters — exactly what typeaheadPrefix
    // computes, and well inside Blink's ~1s inter-key buffer when sent back to
    // back like this.
    for (const ch of "Option 2") await typeChar(cdp, ch);

    // The same settle the bridge waits before believing a read: the AX value is
    // one flush behind the keystroke that changed it, and reading immediately
    // is how a SUCCESSFUL selection got reported as a failure in the field.
    await page.waitForTimeout(150);
    expect(await page.locator("#dropdown").inputValue()).toBe("2");
    expect(await axValue(cdp, ref)).toBe("Option 2");
  });

  test("a one-character prefix is enough when it is unique", async ({ page }) => {
    const ref = await refFor(cdp, "#dropdown");
    await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
    // No other enabled label starts with "B", so typeaheadPrefix stops at one
    // character — the cheap case, and the reason the prefix is computed rather
    // than typing the whole label every time.
    await typeChar(cdp, "B");
    await page.waitForTimeout(150);
    expect(await page.locator("#dropdown").inputValue()).toBe("4");
    expect(await axValue(cdp, ref)).toBe("Banana");
  });

  test("type-ahead fires the page's own change event", async ({ page }) => {
    // The bridge drives a select this way INSTEAD of setting .value, so the
    // page's handlers must see it — a selection the page never learns about is
    // the same silent failure by another route.
    await page.evaluate(() => {
      const el = document.querySelector("#dropdown") as HTMLSelectElement;
      (window as unknown as { __changes: string[] }).__changes = [];
      el.addEventListener("change", () => {
        (window as unknown as { __changes: string[] }).__changes.push(el.value);
      });
    });
    const ref = await refFor(cdp, "#dropdown");
    await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
    for (const ch of "Option 2") await typeChar(cdp, ch);
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(() => (window as unknown as { __changes: string[] }).__changes),
    ).toContain("2");
  });
});
