import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the mouse-event shape `dragPointer`
// (extension/background.js) dispatches — the round-11 drag primitive:
//
//   1. press → interpolated moves WITH `buttons: 1` → release actually drags a
//      JS mousedown/mousemove/mouseup handler: the element lands at the target
//      point and every interpolated move was seen.
//   2. NEGATIVE CONTROL — press → release with NO intermediate move is a
//      click: the handler records the drop but nothing moved.
//   3. Chromium SYNTHESIZES `event.buttons` on moves from its own tracked
//      button state: after a dispatched mousePressed, a mouseMoved dispatched
//      with `buttons: 0` still reaches the page as `event.buttons === 1`
//      (measured 2026-08-22 — the box dragged anyway). So dragPointer's
//      `buttons: 1` on each move states intent and matches what the page sees,
//      but the PRESS is what arms the drag; there is no way to send a
//      "buttonless move" while Chromium believes the button is down.
//
// The dispatch helper below REPLICATES dragPointer line for line rather than
// importing it (the copy pattern scrolled-hit-facts.spec.ts documents) — the
// round-10 lesson is that a spec helper diverging from the shipped code lets
// the spec pass a bug, so keep them in step by eye when either changes.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/drag-facts.spec.ts`
// (npx playwright is broken here; this spec needs no dev server — it drives a
// local file:// fixture over raw CDP).

const DRAG_STEP_PX = 60;
const DRAG_MOVE_STEPS_MAX = 16;
const DRAG_STEP_PAUSE_MS = 12;

type Point = { x: number; y: number };

/** background.js `dragPointer`, replicated so the probe drags what the bridge drags. */
async function dragPointer(cdp: CDPSession, from: Point, to: Point, buttonsOnMoves = 1) {
  const base = { button: "left", pointerType: "mouse" } as const;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    buttons: 1,
    clickCount: 1,
    ...base,
  });
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(DRAG_MOVE_STEPS_MAX, Math.max(3, Math.ceil(distance / DRAG_STEP_PX)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      buttons: buttonsOnMoves,
      ...base,
    });
    await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_PAUSE_MS));
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    buttons: 0,
    clickCount: 1,
    ...base,
  });
  return steps;
}

/** The fixture's box position and its handler's counters. */
async function boxState(cdp: CDPSession) {
  // Read through DOM.getBoxModel + attributes rather than page JS — the bridge
  // itself never runs page JS, and neither does this probe.
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId: boxId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#box",
  });
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId: boxId });
  const { nodeId: logId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#log",
  });
  const { attributes } = await cdp.send("DOM.getAttributes", { nodeId: logId });
  const attr = (name: string) => {
    const at = attributes.indexOf(name);
    return at >= 0 ? Number(attributes[at + 1]) : NaN;
  };
  return {
    left: model.border[0],
    top: model.border[1],
    moves: attr("data-moves"),
    drops: attr("data-drops"),
  };
}

function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`drag-facts ${label}:`, body);
  test.info().attach(`drag-facts-${label}`, { body });
}

test.describe("what a dispatched mouse drag does (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    const fixture = path.join(path.dirname(test.info().file), "fixtures/drag-facts.html");
    await page.goto(pathToFileURL(fixture).href);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
  });

  test("press → held moves → release drags the box to the target", async () => {
    const before = await boxState(cdp);
    // Grab the box's centre (fixture: 100,100 + 80×80 → 140,140) and drop it
    // 200px right, 150px down.
    const from = { x: before.left + 40, y: before.top + 40 };
    const to = { x: from.x + 200, y: from.y + 150 };
    const steps = await dragPointer(cdp, from, to);
    const after = await boxState(cdp);
    record("drag", { before, after, steps });
    // The grab point tracked the pointer exactly, so the box's origin moved by
    // the drag delta; every interpolated move was seen and the drop landed.
    expect(after.left - before.left).toBe(200);
    expect(after.top - before.top).toBe(150);
    expect(after.moves).toBe(steps);
    expect(after.drops).toBe(1);
  });

  test("NEGATIVE: press → release with no move between them is a click, not a drag", async () => {
    const before = await boxState(cdp);
    const at = { x: before.left + 40, y: before.top + 40 };
    const base = { button: "left", pointerType: "mouse" } as const;
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, buttons: 1, clickCount: 1, ...base });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, buttons: 0, clickCount: 1, ...base });
    const after = await boxState(cdp);
    record("click-only", { before, after });
    expect(after.left).toBe(before.left);
    expect(after.moves).toBe(0);
    expect(after.drops).toBe(1);
  });

  test("Chromium synthesizes event.buttons on moves from the tracked press state", async () => {
    const before = await boxState(cdp);
    const from = { x: before.left + 40, y: before.top + 40 };
    const to = { x: from.x + 200, y: from.y + 150 };
    // Dispatch the moves with buttons: 0 — the page still sees buttons === 1,
    // because the dispatched mousePressed set Chromium's internal button state
    // and the renderer rebuilds the bitmask from that, not from this field.
    const steps = await dragPointer(cdp, from, to, 0);
    const after = await boxState(cdp);
    record("buttons-synthesized", { before, after, steps });
    expect(after.left - before.left).toBe(200);
    expect(after.top - before.top).toBe(150);
    expect(after.moves).toBe(steps);
    expect(after.drops).toBe(1);
  });
});
