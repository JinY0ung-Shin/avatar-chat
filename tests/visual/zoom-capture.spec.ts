import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";

// EMPIRICAL evidence for the PIXEL UNITS `Page.captureScreenshot` works in —
// the contract every screenshot the browser bridge takes now depends on
// (extension/background.js: captureShot's clip conversion, the
// SCREENSHOT_MAX_WIDTH bound, click_at's `pxPerCss` inversion, and buildUidMap's
// capture). Three units are in play and the protocol documents none of them in a
// way this repo is willing to trust, so they are pinned by experiment (the
// precedent: ax-facts.spec.ts's DOMSnapshot probe, overlay-highlight.spec.ts's
// Overlay probe):
//
//   1. `clip` is in DIP — device-independent px, PRE-zoom — for EVERY capture
//      mode (plain viewport, element with `captureBeyondViewport`, fullPage with
//      it). DIP = CSS px × `cssVisualViewport.zoom`, and the conversion held
//      across all 24 measured mode × dsf × zoom combinations (dsf ∈ {1, 1.5},
//      zoom ∈ {0.8, 1, 1.25, 1.5}), a scrolled viewport included. Everything
//      `Page.getLayoutMetrics` hands back — and every `DOM.getContentQuads`
//      box — is CSS px, so the two spaces coincide at 100% zoom ALONE. That is
//      the field bug this spec exists for: an unconverted CSS clip reads as
//      correct on an unzoomed window while cropping the bottom-right 1−1/zoom
//      of the visible page (a fifth at 125%, a third at 150%) — the model was
//      being shown less than the user saw and told it was the viewport. A
//      physical-px clip (× zoom × dsf) is the other wrong answer: it fails
//      whenever dsf ≠ 1.
//   2. The returned BITMAP is PHYSICAL px: imagePx = clipDIP × `scale` × dsf.
//      So SCREENSHOT_MAX_WIDTH (1400) and the ~8000px-per-edge ceiling vision
//      APIs enforce bound nothing unless they are measured AFTER the × dsf — on
//      a 150%-scaled Windows display an uncapped capture came back half again
//      as wide as the cap allows — and click_at's inversion needs the whole
//      scale × zoom × dsf factor, not `scale` alone.
//   3. Both factors come off ONE `getLayoutMetrics` call: zoom is
//      `cssVisualViewport.zoom` (absent → 1), and zoom × dsf is
//      `visualViewport.clientWidth / cssVisualViewport.clientWidth` (the
//      physical-px twin of the CSS block; absent → zoom, i.e. dsf 1). Both
//      fallbacks reproduce the pre-fix arithmetic exactly, so a browser that
//      reports neither field behaves as it always did.
//
// Test A measures fact 2 (and fact 3's derivation) with a forced device scale
// factor, and runs anywhere — including the headless shell, which pins its own
// measured truth when it ignores the flag. Test B measures fact 1 with a REAL
// browser zoom, and needs a display: browser zoom is a browser-level setting
// rather than an emulation override, and `chrome.tabs.setZoom` is the lever that
// moves `cssVisualViewport.zoom` — it needs the `tabs` permission, so the
// SHIPPED extension is loaded to provide it, which smoke-loads manifest.json on
// the way. Its negative control is the point of the test: the pre-fix clip must
// still be seen LOSING the bottom-right marker.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/zoom-capture.spec.ts`
// (npx playwright is broken here; no dev server needed — file:// fixture + raw
// CDP). Under WSLg export DISPLAY=:0 first, or Test B skips itself.

/**
 * The three `chrome.*` calls the service-worker callback below makes, declared
 * for the module scope tsc checks that callback in. `declare` emits nothing —
 * the callback is serialized and runs inside the extension's worker.
 */
declare const chrome: {
  tabs: {
    query(info: object): Promise<{ id?: number; url?: string }[]>;
    setZoom(tabId: number, zoom: number): Promise<void>;
    getZoom(tabId: number): Promise<number>;
  };
};

/** Loose shapes: the same fields captureShot reads, all optional like it treats them. */
type ViewportBox = {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
  zoom?: number;
};
type LayoutMetrics = {
  cssVisualViewport?: ViewportBox;
  cssLayoutViewport?: ViewportBox;
  visualViewport?: ViewportBox;
};
type Clip = { x: number; y: number; width: number; height: number };
type Shot = { width: number; height: number; corners: Record<string, string> };

/** Browser zoom Test B drives the fixture at — 125% loses a fifth of the page. */
const TEST_ZOOM = 1.25;
/** Test A's forced device scale factor; 1.5 is the common Windows setting. */
const FORCED_DSF = 1.5;

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`zoom-capture ${label}:`, body);
  test.info().attach(`zoom-capture-${label}`, { body });
}

const fixtureUrl = () =>
  pathToFileURL(path.join(path.dirname(test.info().file), "fixtures/zoom-capture.html")).href;

const extensionDir = () => path.resolve(path.dirname(test.info().file), "../..", "extension");

/** captureShot's factor derivation, field for field — that the two agree IS fact 3. */
function factorsOf(metrics: LayoutMetrics): { css: ViewportBox; zoom: number; dsf: number } {
  const css = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? {};
  const physical = metrics.visualViewport ?? {};
  const zoom = Number(css.zoom) > 0 ? Number(css.zoom) : 1;
  const pxPerCssRaw =
    Number(physical.clientWidth) > 0 && Number(css.clientWidth) > 0
      ? Number(physical.clientWidth) / Number(css.clientWidth)
      : zoom;
  return { css, zoom, dsf: pxPerCssRaw / zoom || 1 };
}

/** captureShot's viewport branch: CSS px, straight off the metrics. */
function cssViewportClip(css: ViewportBox): Clip {
  return {
    x: css.pageX ?? 0,
    y: css.pageY ?? 0,
    width: Math.max(1, Math.round(css.clientWidth ?? 1024)),
    height: Math.max(1, Math.round(css.clientHeight ?? 768)),
  };
}

/** The fix: the same rectangle in the DIP space the protocol actually reads. */
function toDip(clip: Clip, zoom: number): Clip {
  return {
    x: clip.x * zoom,
    y: clip.y * zoom,
    width: Math.max(1, Math.round(clip.width * zoom)),
    height: Math.max(1, Math.round(clip.height * zoom)),
  };
}

/** The exact command captureShot sends for a viewport capture. */
async function capture(cdp: CDPSession, clip: Clip, scale: number): Promise<string> {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 75,
    clip: { ...clip, scale },
  });
  return String(data ?? "");
}

/**
 * Decode the capture IN the page and classify its four corners by color. A
 * marker missing from the bitmap is a region of the visible page the clip failed
 * to cover — which is the whole measurement.
 */
async function cornersOf(page: Page, base64: string): Promise<Shot> {
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    // Generous bands: these are JPEG pixels, so nothing lands on the exact hex.
    // Magenta is tested BEFORE red — both are red-dominant.
    const classify = (x: number, y: number): string => {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r > 170 && g < 100 && b > 170) return "magenta";
      if (r > 170 && g < 100 && b < 100) return "red";
      if (r < 100 && g > 110 && b < 100) return "green";
      if (r < 100 && g < 100 && b > 150) return "blue";
      if (r > 220 && g > 220) return "page";
      return `other(${r},${g},${b})`;
    };
    // 15px in from each image corner: inside the smallest marker the scales
    // below can produce, outside every JPEG edge artifact.
    const inset = 15;
    return {
      width: canvas.width,
      height: canvas.height,
      corners: {
        TL: classify(inset, inset),
        TR: classify(canvas.width - inset, inset),
        BL: classify(inset, canvas.height - inset),
        BR: classify(canvas.width - inset, canvas.height - inset),
      },
    };
  }, base64);
}

const ALL_MARKERS = { TL: "red", TR: "green", BL: "blue", BR: "magenta" };

test.describe("what Page.captureScreenshot's units actually are (empirical)", () => {
  test("the bitmap is PHYSICAL px — clip × scale × device scale factor", async () => {
    // Own browser, not the `page` fixture: the project's devices preset pins a
    // viewport and a deviceScaleFactor through Emulation, which would override
    // the very flag being measured. The runner injects those options into
    // `newContext` too, and `deviceScaleFactor` is REJECTED alongside a null
    // viewport — so both are dropped here, deliberately and explicitly.
    const browser = await chromium.launch({
      args: [`--force-device-scale-factor=${FORCED_DSF}`, "--window-size=1200,900", "--disable-gpu"],
    });
    try {
      const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined });
      const page = await context.newPage();
      await page.goto(fixtureUrl());
      const cdp = await context.newCDPSession(page);
      const metrics: LayoutMetrics = await cdp.send("Page.getLayoutMetrics");
      const { css, zoom, dsf } = factorsOf(metrics);
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      // Deliberately the UNCONVERTED clip: with no browser zoom, CSS px IS DIP,
      // so the region is complete and only the output SIZE is under test.
      const clip = cssViewportClip(css);
      const shot = await cornersOf(page, await capture(cdp, clip, 1));
      const observed = {
        forcedDsf: FORCED_DSF,
        honoredForcedDsf: dpr > 1.01,
        devicePixelRatio: dpr,
        derivedZoom: zoom,
        derivedDsf: Number(dsf.toFixed(3)),
        clip,
        image: { width: shot.width, height: shot.height },
        imagePxPerClipPx: Number((shot.width / clip.width).toFixed(3)),
        corners: shot.corners,
      };
      record("physical-px", observed);

      // Fact 3: the two factors derived from one metrics read agree with the
      // page's own view of the display, whatever this environment's is.
      expect(zoom, "no browser zoom is set here — Test B is the zoom half").toBeCloseTo(1, 2);
      expect(dsf, "visualViewport ÷ cssVisualViewport recovers the device scale factor").toBeCloseTo(
        dpr,
        2,
      );
      // Fact 2, each environment pinning its own measured truth. The headless
      // shell may ignore --force-device-scale-factor; then dpr is 1 and the
      // relation still has to hold. If that pin ever flips, CI has become able
      // to measure the scaled half — tighten, don't loosen.
      expect(
        Math.abs(shot.width - clip.width * dpr),
        "the bitmap is the clip times the device scale factor",
      ).toBeLessThanOrEqual(1);
      if (observed.honoredForcedDsf) {
        expect(
          shot.width,
          "a scaled display returns MORE px than the clip asked for — which is why the width cap is measured after × dsf",
        ).toBeGreaterThan(clip.width + 1);
      } else {
        expect(shot.width, "an unscaled display returns exactly the clip").toBe(clip.width);
      }
      // And the region itself is whole, so a lost marker below means zoom.
      expect(shot.corners, "an unzoomed viewport clip covers the whole page").toEqual(ALL_MARKERS);
    } finally {
      await browser.close();
    }
  });

  test("browser zoom: the CSS clip crops the viewport, the × zoom clip captures it whole", async () => {
    // Headful launch, a real extension load and a zoom settle: the 30s default
    // is not enough headroom, and a missing display has to time out cleanly.
    test.setTimeout(120_000);
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-zoom-profile-"));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        // As in Test A: a real window, with the project's emulated viewport and
        // deviceScaleFactor dropped so the browser's own geometry is measured.
        viewport: null,
        deviceScaleFactor: undefined,
        args: [
          `--disable-extensions-except=${extensionDir()}`,
          `--load-extension=${extensionDir()}`,
          "--window-size=1200,900",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-search-engine-choice-screen",
        ],
      });
    } catch (error) {
      // Recorded before skipping: a skip reason alone is easy to read as "no
      // display here" when it is really a broken launch option.
      record("headful-launch-failed", { error: String(error).slice(0, 400) });
      test.skip(
        true,
        `headful Chromium could not start (${String(error).slice(0, 160)}). Browser zoom needs a real ` +
          `browser window: run with a display (under WSLg, DISPLAY=:0).`,
      );
    }
    if (!context) return;
    try {
      // The shipped service worker — loading it at all is the manifest smoke test.
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(fixtureUrl());
      const zoomReadBack = await worker.evaluate(async (wanted) => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((tab) => (tab.url ?? "").startsWith("file:"));
        if (!target?.id) return 0;
        await chrome.tabs.setZoom(target.id, wanted);
        return chrome.tabs.getZoom(target.id);
      }, TEST_ZOOM);
      // Zoom relayouts the page; measure only once it has.
      await page.waitForTimeout(500);

      const cdp = await context.newCDPSession(page);
      const metrics: LayoutMetrics = await cdp.send("Page.getLayoutMetrics");
      const { css, zoom, dsf } = factorsOf(metrics);
      const cssClip = cssViewportClip(css);
      const dipClip = toDip(cssClip, zoom);
      // (1) the pre-fix clip — the NEGATIVE CONTROL, and the field bug itself.
      const cropped = await cornersOf(page, await capture(cdp, cssClip, 1));
      // (2) the same rectangle converted to DIP — the fix.
      const whole = await cornersOf(page, await capture(cdp, dipClip, 1));
      const observed = {
        zoomReadBack,
        derivedZoom: zoom,
        derivedDsf: Number(dsf.toFixed(3)),
        cssClip,
        dipClip,
        cssClipImage: { width: cropped.width, height: cropped.height },
        cssClipCorners: cropped.corners,
        dipClipImage: { width: whole.width, height: whole.height },
        dipClipCorners: whole.corners,
      };
      record("zoom-clip", observed);

      // The lever worked: this really is a zoomed browser, not an emulation.
      expect(zoomReadBack, "chrome.tabs.setZoom is what moves browser zoom").toBeCloseTo(
        TEST_ZOOM,
        2,
      );
      expect(zoom, "cssVisualViewport.zoom reports the browser zoom").toBeCloseTo(TEST_ZOOM, 2);

      // Fact 1, negative half: the CSS-px clip covers only 1/zoom of the
      // visible page, measured from the top-left, so the top-left marker is
      // still there and the bottom-right one is simply gone.
      expect(cropped.corners.TL, "the crop starts at the origin, so TL survives").toBe("red");
      expect(
        cropped.corners.BR,
        "an unconverted CSS clip LOSES the bottom-right of a zoomed viewport — the field bug",
      ).not.toBe("magenta");
      expect(cropped.width, "the cropped capture is narrower than the fixed one").toBeLessThan(
        whole.width,
      );

      // Fact 1, positive half: × zoom captures exactly what the user sees.
      expect(whole.corners, "clip × zoom covers the whole visible viewport").toEqual(ALL_MARKERS);
    } finally {
      await context.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
