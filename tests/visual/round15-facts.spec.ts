import { chromium, expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";

// EMPIRICAL evidence for the grid-cell typing gap VOC round 15 decides on
// (extension/background.js typeRef/fillField/focusForInput): typing into a
// Handsontable grid cell via the bridge's exact wire sequences silently
// no-ops — both the insertText path and the keystrokes replay — while the
// tool reports success.
//
//   Field case (handsontable.com/demo, live session 2026-09-06): click on a
//   gridcell selects it; `type` (clear:true) then `type` (keystrokes:true)
//   both returned "Typed into e156" and the cell kept its value through an
//   Enter commit. Suspected mechanism: a grid keeps keyboard focus on its own
//   proxy element (hidden textarea / the TD itself), and focusForInput's
//   DOM.focus on the TD either steals or misses that focus, so the grid's
//   keydown handlers never see the replayed keys.
//
// This spec pins, against the REAL demo page (network required — it skips
// itself when unreachable):
//   A. what a dispatched click (clickNode's sequence) does to focus;
//   B. what DOM.focus on the TD does (throw? focus where?);
//   C. whether the bridge's per-char keyDown replay opens the grid editor
//      after A alone (no DOM.focus) — the sequence that a person's keyboard
//      produces;
//   D. whether the same replay opens the editor after A + B (the bridge's
//      actual focusForInput order) — the suspected killer;
//   E. where bare Input.insertText lands after A + B (fillField's default
//      path);
//   F. negative control: Playwright's own mouse+keyboard commits an edit,
//      proving the page itself accepts real input.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/round15-facts.spec.ts`
// (npx playwright is broken here). Headless is fine — no window state involved.

const DEMO_URL = "https://handsontable.com/demo";
const CELL_SELECTOR = ".handsontable td";

function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`round15-facts ${label}:`, body);
  test.info().attach(`round15-facts-${label}`, { body });
}

/** clickNode's exact wire sequence (extension/background.js) — keep line-for-line. */
async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  const base = { x, y, button: "left" as const, clickCount: 1, pointerType: "mouse" as const };
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...base });
}

/** dispatchKey's exact ASCII-printable sequence (extension/background.js). */
async function dispatchPrintable(cdp: CDPSession, ch: string): Promise<void> {
  const upper = ch.toUpperCase();
  const params = {
    key: ch,
    text: ch,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    ...(/^[A-Z]$/.test(upper) ? { code: `Key${upper}` } : /^[0-9]$/.test(ch) ? { code: `Digit${ch}` } : {}),
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 0, ...params });
  const { text: _text, ...upParams } = params;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...upParams });
}

/** dispatchKey's exact Enter sequence (KEY_DEFS.Enter carries text "\r"). */
async function dispatchEnter(cdp: CDPSession): Promise<void> {
  const params = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 0, ...params });
  const { text: _text, ...upParams } = params;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...upParams });
}

type FocusState = {
  activeTag: string;
  activeClass: string;
  editorOpen: boolean;
  editorValue: string | null;
  cellText: string;
};

async function focusState(page: Page): Promise<FocusState> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const editor = document.querySelector(
      "textarea.handsontableInput",
    ) as HTMLTextAreaElement | null;
    const editorHolder = editor?.closest(".handsontableInputHolder") as HTMLElement | null;
    const cell = (window as unknown as { __vocCell?: HTMLElement }).__vocCell;
    return {
      activeTag: active ? active.tagName : "(none)",
      activeClass: active ? String(active.className).slice(0, 120) : "",
      editorOpen: Boolean(
        editor && editorHolder && getComputedStyle(editorHolder).display !== "none" &&
          editorHolder.style.zIndex !== "-1",
      ),
      editorValue: editor ? editor.value : null,
      cellText: cell ? String(cell.textContent) : "(no cell)",
    };
  });
}

/** Pick a stable text cell, remember it on window, return its center + text. */
async function pickCell(page: Page): Promise<{ x: number; y: number; text: string }> {
  await page.waitForSelector(CELL_SELECTOR, { timeout: 20_000 });
  return page.evaluate((selector) => {
    const cells = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    const cell = cells.find((td) => (td.textContent || "").trim().length > 2);
    if (!cell) throw new Error("no text cell found");
    (window as unknown as { __vocCell?: HTMLElement }).__vocCell = cell;
    const box = cell.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: String(cell.textContent) };
  }, CELL_SELECTOR);
}

async function backendNodeIdOfCell(cdp: CDPSession, page: Page): Promise<number> {
  // Resolve the remembered cell to a backendNodeId the way any bridge ref is.
  const { result } = (await cdp.send("Runtime.evaluate", {
    expression: "window.__vocCell",
  })) as { result: { objectId?: string } };
  if (!result.objectId) throw new Error("cell objectId unavailable");
  const { node } = (await cdp.send("DOM.describeNode", { objectId: result.objectId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

test.describe("what the bridge's type sequences do to a Handsontable cell (empirical)", () => {
  test("grid editor focus vs the bridge's focus/type wire order", async ({ page: _unused }) => {
    test.setTimeout(180_000);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
    } catch (error) {
      record("launch-failed", { error: String(error).slice(0, 400) });
      test.skip(true, "Chromium could not start");
    }
    if (!browser) return;
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(DEMO_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector(CELL_SELECTOR, { timeout: 20_000 });
      } catch (error) {
        record("demo-unreachable", { error: String(error).slice(0, 400) });
        test.skip(true, "handsontable.com/demo unreachable from this host");
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.getDocument", { depth: 0 });

      // Phase F first (fresh page state): negative control — real input works.
      const control = await pickCell(page);
      await page.mouse.click(control.x, control.y);
      await page.keyboard.type("CTRL");
      const controlMid = await focusState(page);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const controlAfter = await focusState(page);
      record("F-playwright-native-control", { before: control.text, controlMid, controlAfter });
      expect(controlMid.editorOpen, "native typing opens the grid editor").toBe(true);
      expect(controlAfter.cellText, "native edit commits").toContain("CTRL");

      // Reload for a clean grid, then measure the bridge's sequences.
      await page.reload({ waitUntil: "domcontentloaded" });
      const cell = await pickCell(page);
      record("cell-under-test", cell);

      // Phase A — clickNode's dispatched click: where does focus land?
      await dispatchClick(cdp, cell.x, cell.y);
      await page.waitForTimeout(300);
      const afterClick = await focusState(page);
      record("A-after-dispatched-click", afterClick);

      // Phase C — keystrokes replay STRAIGHT after the click (no DOM.focus):
      // does the editor open, and does Enter commit?
      for (const ch of [...`SEQC`]) await dispatchPrintable(cdp, ch);
      await page.waitForTimeout(200);
      const afterReplayNoFocus = await focusState(page);
      await dispatchEnter(cdp);
      await page.waitForTimeout(300);
      const committedNoFocus = await focusState(page);
      record("C-replay-after-click-only", { afterReplayNoFocus, committedNoFocus });

      // Reload — fresh state for the bridge's ACTUAL order (click, then DOM.focus).
      await page.reload({ waitUntil: "domcontentloaded" });
      const cell2 = await pickCell(page);
      const backendNodeId = await backendNodeIdOfCell(cdp, page);

      // Phase B — DOM.focus on the TD, exactly what focusForInput tries first.
      await dispatchClick(cdp, cell2.x, cell2.y);
      await page.waitForTimeout(200);
      let domFocusError: string | null = null;
      try {
        await cdp.send("DOM.focus", { backendNodeId });
      } catch (error) {
        domFocusError = String(error).slice(0, 300);
      }
      const afterDomFocus = await focusState(page);
      record("B-after-dom-focus", { domFocusError, afterDomFocus });

      // Phase D — keystrokes replay AFTER the DOM.focus (the bridge's real order).
      for (const ch of [...`SEQD`]) await dispatchPrintable(cdp, ch);
      await page.waitForTimeout(200);
      const afterReplayPostFocus = await focusState(page);
      await dispatchEnter(cdp);
      await page.waitForTimeout(300);
      const committedPostFocus = await focusState(page);
      record("D-replay-after-dom-focus", { afterReplayPostFocus, committedPostFocus });

      // Phase E — bare Input.insertText after click+DOM.focus (fillField default).
      await page.reload({ waitUntil: "domcontentloaded" });
      const cell3 = await pickCell(page);
      const backendNodeId3 = await backendNodeIdOfCell(cdp, page);
      await dispatchClick(cdp, cell3.x, cell3.y);
      await page.waitForTimeout(200);
      try {
        await cdp.send("DOM.focus", { backendNodeId: backendNodeId3 });
      } catch {
        // recorded shape in phase B; here the write path just continues
      }
      await cdp.send("Input.insertText", { text: "SEQE" });
      await page.waitForTimeout(200);
      const afterInsert = await focusState(page);
      await dispatchEnter(cdp);
      await page.waitForTimeout(300);
      const committedInsert = await focusState(page);
      record("E-insertText-after-dom-focus", { afterInsert, committedInsert });

      // Phase G — the FIELD sequence: the widget's selection sits on a
      // DIFFERENT cell than the uid being typed at. Click cellA, ArrowDown
      // (selection moves one row down), then the bridge's order for typing at
      // cellA: DOM.focus(cellA) + replay + Enter. Which cell got the text?
      await page.reload({ waitUntil: "domcontentloaded" });
      const cellG = await pickCell(page);
      const backendNodeIdG = await backendNodeIdOfCell(cdp, page);
      const belowBefore = await page.evaluate(() => {
        const cell = (window as unknown as { __vocCell?: HTMLElement }).__vocCell;
        const row = cell?.closest("tr");
        const next = row?.nextElementSibling as HTMLElement | null;
        const idx = cell ? Array.from(row!.children).indexOf(cell) : -1;
        const target = next?.children[idx] as HTMLElement | null;
        (window as unknown as { __vocBelow?: HTMLElement }).__vocBelow = target || undefined;
        return target ? String(target.textContent) : "(none)";
      });
      await dispatchClick(cdp, cellG.x, cellG.y);
      await page.waitForTimeout(200);
      // ArrowDown exactly as dispatchKey sends it (no text → rawKeyDown).
      const down = { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, ...down });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...down });
      await page.waitForTimeout(200);
      let domFocusErrorG: string | null = null;
      try {
        await cdp.send("DOM.focus", { backendNodeId: backendNodeIdG });
      } catch (error) {
        domFocusErrorG = String(error).slice(0, 300);
      }
      for (const ch of [...`SEQG`]) await dispatchPrintable(cdp, ch);
      await page.waitForTimeout(200);
      const afterReplayG = await focusState(page);
      await dispatchEnter(cdp);
      await page.waitForTimeout(300);
      // Text-based ground truth — HOT recycles row/cell nodes on re-render, so
      // the remembered element references can report another row's content.
      const cellsAfterG = await page.evaluate(() => {
        const rowTextOf = (needle: string) => {
          const cell = Array.from(document.querySelectorAll(".handsontable td")).find((td) =>
            String(td.textContent).includes(needle),
          );
          return cell ? String(cell.closest("tr")?.textContent).slice(0, 120) : "(nowhere)";
        };
        return {
          seqRow: rowTextOf("SEQG"),
          jamesRow: rowTextOf("James Brown"),
          maryRow: rowTextOf("Mary Hernandez"),
        };
      });
      record("G-selection-elsewhere", { belowBefore, domFocusErrorG, afterReplayG, cellsAfterG });

      // Phase H — the FIX's contract (writeGridCell's exact order): with the
      // grid's selection parked on ANOTHER cell, a real click on the target +
      // key replay + Enter must commit into the TARGET cell.
      await page.reload({ waitUntil: "domcontentloaded" });
      const cellH = await pickCell(page);
      await page.evaluate(() => {
        const cell = (window as unknown as { __vocCell?: HTMLElement }).__vocCell;
        const row = cell?.closest("tr");
        const next = row?.nextElementSibling as HTMLElement | null;
        const idx = cell ? Array.from(row!.children).indexOf(cell) : -1;
        (window as unknown as { __vocBelow?: HTMLElement }).__vocBelow =
          (next?.children[idx] as HTMLElement | null) || undefined;
      });
      // Park the selection elsewhere first (click target, ArrowDown), as in G.
      await dispatchClick(cdp, cellH.x, cellH.y);
      await page.waitForTimeout(200);
      const downH = { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, ...downH });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...downH });
      await page.waitForTimeout(200);
      // writeGridCell: click the target (no DOM.focus), Escape (a second click
      // on a recently-clicked cell registers as the grid's OWN double-click and
      // opens its editor pre-loaded with the old value — the replay then
      // APPENDS; Escape closes it without committing), replay, Enter.
      await dispatchClick(cdp, cellH.x, cellH.y);
      await page.waitForTimeout(200);
      const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, ...esc });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...esc });
      await page.waitForTimeout(100);
      const afterSecondClick = await page.evaluate(
        ({ x, y }) => {
          const w = window as unknown as { __vocCell?: HTMLElement };
          const at = document.elementFromPoint(x, y) as HTMLElement | null;
          const current = document.querySelector("td.current") as HTMLElement | null;
          const box = w.__vocCell?.getBoundingClientRect();
          return {
            activeTag: document.activeElement?.tagName,
            activeText: String(document.activeElement?.textContent || "").slice(0, 30),
            elementAtPoint: at ? `${at.tagName} ${String(at.textContent).slice(0, 30)}` : "(none)",
            currentCell: current ? String(current.textContent).slice(0, 30) : "(none)",
            targetBox: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
            clickedAt: { x, y },
          };
        },
        { x: cellH.x, y: cellH.y },
      );
      record("H-after-second-click", afterSecondClick);
      for (const ch of [...`SEQH`]) await dispatchPrintable(cdp, ch);
      await dispatchEnter(cdp);
      await page.waitForTimeout(300);
      // HOT recycles row/cell DOM nodes on re-render, so the remembered element
      // references can go STALE and report another row's content. Ground truth
      // by TEXT: which logical row (its full text) holds the committed marker,
      // and where did the two names land.
      const cellsAfterH = await page.evaluate(() => {
        const w = window as unknown as { __vocCell?: HTMLElement; __vocBelow?: HTMLElement };
        const rowTextOf = (needle: string) => {
          const cell = Array.from(document.querySelectorAll(".handsontable td")).find((td) =>
            String(td.textContent).includes(needle),
          );
          return cell ? String(cell.closest("tr")?.textContent).slice(0, 120) : "(nowhere)";
        };
        return {
          staleTargetRef: w.__vocCell ? String(w.__vocCell.textContent) : "(none)",
          staleBelowRef: w.__vocBelow ? String(w.__vocBelow.textContent) : "(none)",
          seqRow: rowTextOf("SEQH"),
          jamesRow: rowTextOf("James Brown"),
          maryRow: rowTextOf("Mary Hernandez"),
        };
      });
      record("H-fix-contract", { cellsAfterH });
      expect(cellsAfterH.jamesRow, "the TARGET cell's old value is replaced").toBe("(nowhere)");
      expect(cellsAfterH.seqRow, "the marker sits in the TARGET's row").toContain("Engineering");
      expect(cellsAfterH.maryRow, "the parked-selection row is untouched").toContain("Mary Hernandez");

      // The everywhere-contract this round fixes toward: at least ONE bridge
      // sequence must actually commit, or the op must report failure. Recorded
      // here; asserted only as "the facts were measured" — the fix's own spec
      // asserts the contract.
      expect(afterClick.activeTag).toBeTruthy();
    } finally {
      await browser.close();
    }
  });
});
