import { chromium, expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";

// EMPIRICAL evidence for the Chrome fact VOC round 14 decides on
// (extension/background.js ensureFrameForInput): a tab whose WINDOW is not
// producing frames silently DROPS dispatched mouse press/release while
// delivering everything else, and one `Page.captureScreenshot` revives it.
//
//   Field case (Windows Chrome, live-measured on the instrumented ruler page):
//   the user's browser window sat fully covered by another window, so Chrome's
//   native occlusion tracking marked the page hidden
//   (`document.visibilityState === "hidden"` while the tab stayed ACTIVE —
//   showTab had already run). In that state `Input.dispatchMouseEvent`
//   delivered mouseMoved (mv=1) but dropped mousePressed/mouseReleased
//   (md=0, mu=0) with NO error — click, click_at and drag all reported
//   success while the page counted nothing. `Input.dispatchKeyEvent` (kd=1),
//   `Input.insertText`, hit tests and AX snapshots all kept working, which is
//   exactly what made the drop masquerade as a page bug across three sites
//   (ProseMirror drag-select, react-window SPA links, the ruler control page).
//   Immediately after ANY `Page.captureScreenshot` the same dispatch landed
//   (md=1, mu=1) — 4 out of 4 times — even though visibilityState stayed
//   "hidden" throughout: the capture mints a composited frame, and it is the
//   frame (input-router hit-test state), not page-visible-ness, that decides
//   whether presses route.
//
//   Windows-style occlusion cannot be reproduced from Playwright on this Linux
//   host (occlusion tracking is Windows/Mac/CrOS-native), so this spec uses the
//   nearest lever it has — minimizing the window via `Browser.setWindowBounds` —
//   and pins whatever THIS platform measurably does in each phase, the
//   zoom-capture.spec.ts precedent: record first, assert what must hold
//   everywhere. The assertions that must hold on every platform:
//     1. control — a normal visible window delivers move+press+release;
//     2. contract — after a captureScreenshot warm, press/release deliver
//        AGAIN, whatever the minimized phase did (this is the exact sequence
//        ensureFrameForInput performs before every input op);
//     3. recovery — a restored window delivers.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/round14-facts.spec.ts`
// (npx playwright is broken here; no dev server — setContent + raw CDP).
// Under WSLg export DISPLAY=:0 first, or the test skips itself.

const COUNTER_FIXTURE = `
  <style>html, body { margin: 0; } #target { position: fixed; left: 100px; top: 100px; width: 200px; height: 80px; }</style>
  <button id="target">target</button>
  <script>
    window.counts = { md: 0, mu: 0, mv: 0, click: 0 };
    document.addEventListener("mousedown", () => { window.counts.md += 1; }, true);
    document.addEventListener("mouseup", () => { window.counts.mu += 1; }, true);
    document.addEventListener("mousemove", () => { window.counts.mv += 1; }, true);
    document.addEventListener("click", () => { window.counts.click += 1; }, true);
  </script>
`;

type Counts = { md: number; mu: number; mv: number; click: number };

function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`round14-facts ${label}:`, body);
  test.info().attach(`round14-facts-${label}`, { body });
}

/** clickPoint's exact wire sequence (extension/background.js) — keep line-for-line. */
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

async function countsOf(page: Page): Promise<Counts> {
  return (await page.evaluate(() => (window as unknown as { counts: Counts }).counts)) as Counts;
}

/** Dispatch one full click and report how much of it the page received. */
async function measuredClick(page: Page, cdp: CDPSession): Promise<Counts> {
  const before = await countsOf(page);
  await dispatchClick(cdp, 200, 140);
  // The dispatch ack does NOT mean delivery (that non-guarantee is the fact
  // under test); give the renderer a beat before reading the counters back.
  await page.waitForTimeout(300);
  const after = await countsOf(page);
  return {
    md: after.md - before.md,
    mu: after.mu - before.mu,
    mv: after.mv - before.mv,
    click: after.click - before.click,
  };
}

test.describe("what a frameless window does to dispatched mouse input (empirical)", () => {
  test("press/release need a composited frame; captureScreenshot mints one", async () => {
    test.setTimeout(120_000);
    let browser: Browser | undefined;
    try {
      // Headful and GPU-less like the project default; a real OS window is the
      // thing being minimized, so the headless shell cannot measure this.
      browser = await chromium.launch({
        headless: false,
        args: ["--window-size=1000,700", "--disable-gpu"],
      });
    } catch (error) {
      record("headful-launch-failed", { error: String(error).slice(0, 400) });
      test.skip(
        true,
        `headful Chromium could not start (${String(error).slice(0, 160)}). Minimizing needs a real ` +
          `window: run with a display (under WSLg, DISPLAY=:0).`,
      );
    }
    if (!browser) return;
    try {
      // As in zoom-capture.spec.ts: the runner injects the devices preset into
      // newContext, and deviceScaleFactor is rejected alongside a null viewport.
      const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined });
      const page = await context.newPage();
      await page.setContent(COUNTER_FIXTURE);
      const cdp = await context.newCDPSession(page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };

      // Phase A — control: a normal, visible window delivers the whole click.
      const control = await measuredClick(page, cdp);
      record("A-visible-window", { control, visibility: await page.evaluate(() => document.visibilityState) });
      expect(control.md, "control: mousedown reaches a visible window").toBe(1);
      expect(control.mu, "control: mouseup reaches a visible window").toBe(1);
      expect(control.click, "control: the click event fires").toBe(1);

      // Phase B — minimize, the nearest Linux lever to Windows occlusion, and
      // measure what THIS platform does. Recorded, not asserted: a platform
      // that keeps delivering into a minimized window is a real measured truth
      // (the Windows occlusion drop is pinned by the field session, not here).
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      const hidden = await page
        .waitForFunction(() => document.visibilityState === "hidden", undefined, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      const minimized = await measuredClick(page, cdp);
      record("B-minimized-window", {
        minimized,
        reachedHidden: hidden,
        visibility: await page.evaluate(() => document.visibilityState),
      });

      // Phase C — the ensureFrameForInput contract: captureScreenshot with the
      // exact settings the extension uses, then the SAME dispatch must land,
      // whatever phase B did. Tolerate a capture error only to record it — the
      // assertion then still runs and fails loudly, which is the right noise.
      let captureError: string | null = null;
      try {
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 1, optimizeForSpeed: true });
      } catch (error) {
        captureError = String(error).slice(0, 400);
      }
      const warmed = await measuredClick(page, cdp);
      record("C-after-capture-warm", { warmed, captureError });
      expect(warmed.md, "after a captureScreenshot warm, mousedown lands").toBe(1);
      expect(warmed.mu, "after a captureScreenshot warm, mouseup lands").toBe(1);

      // Phase D — recovery control: a restored window delivers again.
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await page.waitForTimeout(300);
      const restored = await measuredClick(page, cdp);
      record("D-restored-window", { restored });
      expect(restored.md, "restored window: mousedown reaches the page").toBe(1);
      expect(restored.mu, "restored window: mouseup reaches the page").toBe(1);
    } finally {
      await browser.close();
    }
  });
});
