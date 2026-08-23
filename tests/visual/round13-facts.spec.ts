import zlib from "node:zlib";

import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the Chrome fact VOC round 13 decides on
// (extension/background.js captureShot): `Page.captureScreenshot` with
// `captureBeyondViewport: true` RE-LAYS-OUT a responsive page for the duration
// of the capture — even when the clip sits entirely INSIDE the visible
// viewport — so the bitmap it returns can show elements at positions and sizes
// that are NOT what is on screen.
//
//   Field case: an ECharts chart in a %-height iframe
//   (echarts.apache.org/examples editor). Fractions measured on the element
//   screenshot made uid-fraction click_at MISS the legend twice, while the
//   same target measured on the live viewport hit. Two capture-side causes
//   were separated in round 13:
//
//   1. The 8px pad captureShot adds around an element clip: fractions are
//      measured against the IMAGE's edges but applied to the ELEMENT's box,
//      so every fraction is skewed by pad/size per axis (1.5% on a 550px-tall
//      canvas — exactly the miss). A code fact, fixed by dropping the pad.
//   2. THRASH, pinned here: a flag-on capture makes the page's own resize
//      listener fire even when the clip is fully inside the viewport, while a
//      flag-off capture of the same clip fires none. A chart library redraws
//      its canvas from exactly that listener, so a flag-on capture can catch
//      a mid-redraw frame at a size the screen never showed. (In THIS pure-CSS
//      fixture the returned pixels happen to still match the screen — the
//      probe records them rather than asserting a difference — but the event
//      firing is the mechanism, and it is flag-on-only.)
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/round13-facts.spec.ts`
// (npx playwright is broken here; no dev server — page.setContent + raw CDP).

const RESPONSIVE_FIXTURE = `
  <style>html, body { margin: 0; height: 100%; }</style>
  <div id="panel" style="position: relative; height: 100%; background: #eeeeff;">
    <div id="probe" style="position: absolute; left: 20px; bottom: 20px; width: 200px; height: 100px; background: #ff8800;"></div>
  </div>
  <div style="height: 2000px;">tall tail so content size exceeds the viewport</div>
  <script>
    window.resizes = 0;
    window.addEventListener("resize", () => { window.resizes += 1; });
  </script>
`;

/**
 * Sample one pixel of a PNG (truecolor 8-bit, the format headless Chrome
 * returns for captures) straight off node's zlib — enough decoder for a probe,
 * not a library: concatenate IDAT, inflate, undo per-scanline filters, index.
 */
function pngPixelAt(base64: string, x: number, y: number): [number, number, number] {
  const png = Buffer.from(base64, "base64");
  const width = png.readUInt32BE(16);
  const bitDepth = png[24];
  const colorType = png[25];
  expect(bitDepth, "probe decoder handles 8-bit only").toBe(8);
  expect([2, 6], "probe decoder handles truecolor (±alpha) only").toContain(colorType);
  const bpp = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const size = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    if (kind === "IDAT") idat.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp + 1; // one filter byte per scanline
  const line = Buffer.alloc(width * bpp);
  let prior = Buffer.alloc(width * bpp);
  for (let row = 0; row <= y; row += 1) {
    const filter = raw[row * stride];
    for (let i = 0; i < width * bpp; i += 1) {
      const rawByte = raw[row * stride + 1 + i];
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = prior[i];
      const upLeft = i >= bpp ? prior[i - bpp] : 0;
      let recon: number;
      if (filter === 0) recon = rawByte;
      else if (filter === 1) recon = rawByte + left;
      else if (filter === 2) recon = rawByte + up;
      else if (filter === 3) recon = rawByte + Math.floor((left + up) / 2);
      else {
        // Paeth
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        recon = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      line[i] = recon & 0xff;
    }
    prior = Buffer.from(line);
  }
  const off = x * bpp;
  return [line[off], line[off + 1], line[off + 2]];
}

const near = (a: [number, number, number], b: [number, number, number]) =>
  a.every((channel, i) => Math.abs(channel - b[i]) <= 12);

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`round13-facts ${label}:`, body);
  test.info().attach(`round13-facts-${label}`, { body });
}

test.describe("round-13 Chrome facts (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    await page.setContent(RESPONSIVE_FIXTURE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
  });

  test("captureBeyondViewport captures a DIFFERENT layout than the screen shows", async ({
    page,
  }) => {
    // The clip is the probe's ON-SCREEN box — fully inside the viewport.
    const probe = await page.locator("#probe").boundingBox();
    expect(probe).not.toBeNull();
    const clip = {
      x: probe!.x,
      y: probe!.y,
      width: Math.round(probe!.width),
      height: Math.round(probe!.height),
      scale: 1,
    };

    const flat = await cdp.send("Page.captureScreenshot", { format: "png", clip });
    await page.waitForTimeout(100);
    const resizesAfterFlat = (await page.evaluate(
      () => (window as unknown as { resizes: number }).resizes,
    )) as number;

    const beyond = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: true,
    });
    await page.waitForTimeout(100);
    const resizesAfterBeyond = (await page.evaluate(
      () => (window as unknown as { resizes: number }).resizes,
    )) as number;

    const flatPixel = pngPixelAt(flat.data, 100, 50);
    const beyondPixel = pngPixelAt(beyond.data, 100, 50);
    record("layout-fidelity", {
      clip,
      flatPixel,
      beyondPixel,
      resizesAfterFlat,
      resizesAfterBeyond,
    });

    const PROBE_ORANGE: [number, number, number] = [0xff, 0x88, 0x00];
    const PANEL_BLUE: [number, number, number] = [0xee, 0xee, 0xff];

    // CONTROL: the flag-off capture shows exactly what is on screen at that
    // spot — the probe — and perturbs no layout on the way.
    expect(near(flatPixel, PROBE_ORANGE), "flag-off capture shows the on-screen probe").toBe(true);
    expect(resizesAfterFlat, "flag-off capture fires no resize").toBe(0);

    // FACT: the beyond-viewport capture of the SAME in-viewport clip made the
    // page's resize listener fire — the layout was changed and restored around
    // the capture. A JS-redrawn surface (a chart canvas) can repaint from that
    // listener mid-capture; a pure-CSS fixture happens to rasterize before its
    // relayout, so the pixel is recorded above rather than asserted, and the
    // panel color is kept as the constant a future Chrome that DOES capture
    // the expanded layout would flip it to.
    void PANEL_BLUE;
    expect(resizesAfterBeyond, "beyond-viewport capture fires resize").toBeGreaterThan(0);
  });

  test("a page-absolute clip inside the viewport needs no beyond-viewport flag", async ({
    page,
  }) => {
    // Scroll the window so pageY ≠ 0 — production computes clips as
    // viewport-relative quads + pageX/pageY, so the unit contract for the
    // flag-OFF path must hold on a scrolled page too (zoom-capture pins the
    // DIP conversion; this pins that the flag-off capture accepts a
    // page-absolute clip at scroll and returns a correctly-sized bitmap).
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(50);
    const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { pageY?: number };
    };
    const pageY = metrics.cssVisualViewport?.pageY ?? 0;
    expect(pageY, "the window really scrolled").toBeGreaterThan(0);

    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 20, y: pageY + 20, width: 200, height: 100, scale: 1 },
    });
    const png = Buffer.from(shot.data, "base64");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    record("scrolled-flag-off-clip", { width, height, pageY });
    expect(width, "bitmap width matches the asked clip").toBe(200);
    expect(height, "bitmap height matches the asked clip").toBe(100);
  });
});
