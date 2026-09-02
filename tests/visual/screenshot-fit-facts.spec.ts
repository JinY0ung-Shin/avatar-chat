import { chromium, expect, test, type CDPSession, type Page } from "@playwright/test";
// Kept on ONE line: @ts-expect-error only covers the line after it, and the
// error is raised on the module specifier — the LAST line of a wrapped import.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { viewportShotScale, visionFits, visionFitSize, visionTokens, jpegDimensions, base64ToBytes, screenshotImageNote } from "../../extension/axtree.js";

// EMPIRICAL evidence for issue #66's two halves, driven over raw CDP exactly the
// way extension/background.js `captureShot` drives it:
//
//   1. THE FIT. Claude answers a pixel question in the space of the image it
//      SEES, which is the API's aspect-preserving downscale to the model's
//      native limits (standard tier: 1568 px long edge AND 1568 visual tokens of
//      28×28 patches). A 1400×2197 viewport capture is 3950 tokens, so it was
//      served at 874×1372 and every `click_at` coordinate came back a constant
//      ×1.60 off. `viewportShotScale` pre-fits the capture so the bytes we send
//      ARE the image the model sees. Measured here: the bitmap the browser
//      actually returns for that scale FITS, on three viewport shapes — and the
//      pre-fix scale (`min(1, 1400/pw, 7900/ph)`, the two physical caps alone)
//      does NOT, which is the negative control and the field bug itself.
//   2. THE MEASUREMENT. `pxPerCss = scale × zoom × dsf` is what the capture
//      ASKED for, assembled from `Page.getLayoutMetrics`; the field factor 8/7
//      is consistent with a display returning a bitmap 7/8 of that prediction,
//      and nothing ever compared the two. So `click_at` now inverts the size the
//      BYTES declare. Measured here: `jpegDimensions` (the extension's own
//      marker walk) equals the size the browser's decoder reports for the same
//      bytes — on real Chromium JPEG output, not a hand-built fixture.
//
// Both facts are pinned against the SHIPPED pure helpers, so a future edit to
// the vision math or the JPEG parser fails here and not in the field.
//
// Two environment facts this spec measures rather than assumes, both recorded:
// Playwright's EMULATED `deviceScaleFactor` (Emulation.setDeviceMetricsOverride)
// moves `window.devicePixelRatio` but NOT `Page.getLayoutMetrics.visualViewport`
// and NOT the returned bitmap — so Test A runs at an effective dsf of 1 whatever
// it asks for, and the bridge's own derivation agrees with the bitmap either way.
// The lever that DOES move both is the browser-level
// `--force-device-scale-factor` flag, which is Test B (skipped, not silently
// passed, if this Chromium ignores it).
//
// Run with
// `node node_modules/@playwright/test/cli.js test tests/visual/screenshot-fit-facts.spec.ts`
// (npx playwright is broken here). No dev server and no fixture file: the page is
// set inline, since only its GEOMETRY is under test.

/** captureShot's caps, in PHYSICAL image px — background.js owns these numbers. */
const SHOT_CAPS = { maxWidth: 1400, maxHeight: 7900 };

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

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`screenshot-fit ${label}:`, body);
  test.info().attach(`screenshot-fit-${label}`, { body });
}

/**
 * A page with content in every corner and a document taller than the viewport.
 * Flat colour would still carry a frame header, but a real JPEG with detail is
 * what the parser has to survive — and corner marks make an accidentally
 * cropped clip visible in the attached size numbers.
 */
const PAGE_HTML = `
<body style="margin:0;font:14px system-ui;background:#fff">
  <div style="position:fixed;inset:0;pointer-events:none">
    <div style="position:absolute;top:0;left:0;width:60px;height:60px;background:#e00"></div>
    <div style="position:absolute;top:0;right:0;width:60px;height:60px;background:#0a0"></div>
    <div style="position:absolute;bottom:0;left:0;width:60px;height:60px;background:#00d"></div>
    <div style="position:absolute;bottom:0;right:0;width:60px;height:60px;background:#d0d"></div>
  </div>
  <div style="padding:80px 24px;height:220vh;background:repeating-linear-gradient(45deg,#fff 0 12px,#eee 12px 24px)">
    <h1>screenshot fit probe</h1>
    <p>Detail so the encoder produces a real JPEG rather than one flat block.</p>
  </div>
</body>`;

/** captureShot's factor derivation, field for field. */
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

/** captureShot's viewport branch: the CSS clip, then the same × zoom conversion. */
function viewportClips(css: ViewportBox, zoom: number): { cssClip: Clip; dipClip: Clip } {
  const cssClip = {
    x: css.pageX ?? 0,
    y: css.pageY ?? 0,
    width: Math.max(1, Math.round(css.clientWidth ?? 1024)),
    height: Math.max(1, Math.round(css.clientHeight ?? 768)),
  };
  return {
    cssClip,
    dipClip: {
      x: cssClip.x * zoom,
      y: cssClip.y * zoom,
      width: Math.max(1, Math.round(cssClip.width * zoom)),
      height: Math.max(1, Math.round(cssClip.height * zoom)),
    },
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
 * The bitmap's size according to the BROWSER's own decoder — the independent
 * witness `jpegDimensions` is checked against. Decoded in the page because that
 * is where an `Image` exists (the same lever zoom-capture.spec.ts uses).
 */
async function decodedSize(page: Page, base64: string): Promise<[number, number]> {
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight] as [number, number];
  }, base64);
}

/** The PRE-#66 scale: the two physical caps and nothing else. */
const preFixScale = (pw: number, ph: number) =>
  Math.min(1, SHOT_CAPS.maxWidth / pw, SHOT_CAPS.maxHeight / ph);

/** The three viewport shapes under test; the middle one is the field report's. */
const CASES = [
  { label: "landscape-1280x720", width: 1280, height: 720, deviceScaleFactor: 1, mustNotFitPreFix: false },
  { label: "portrait-1152x1808", width: 1152, height: 1808, deviceScaleFactor: 1.25, mustNotFitPreFix: true },
  { label: "landscape-1600x900", width: 1600, height: 900, deviceScaleFactor: 2, mustNotFitPreFix: false },
];

test.describe("what a viewport capture's bitmap actually measures (empirical)", () => {
  test("the pre-fitted scale returns a bitmap that FITS, and the bytes report its size", async () => {
    // Three own browsers' worth of work, each with a capture and two decodes.
    test.setTimeout(180_000);
    // Own browser, not the `page` fixture: the project's Desktop Chrome preset
    // pins a viewport and a deviceScaleFactor, and each case needs its own.
    const browser = await chromium.launch({ args: ["--disable-gpu"] });
    try {
      for (const shape of CASES) {
        const context = await browser.newContext({
          viewport: { width: shape.width, height: shape.height },
          deviceScaleFactor: shape.deviceScaleFactor,
        });
        try {
          const page = await context.newPage();
          await page.setContent(PAGE_HTML);
          const cdp = await context.newCDPSession(page);
          const metrics: LayoutMetrics = await cdp.send("Page.getLayoutMetrics");
          const { css, zoom, dsf } = factorsOf(metrics);
          const dpr = await page.evaluate(() => window.devicePixelRatio);
          const { cssClip, dipClip } = viewportClips(css, zoom);
          // The physical size an unscaled capture would come back at — the only
          // edge the caps and the vision limits mean anything against.
          const physicalWidth = dipClip.width * dsf;
          const physicalHeight = dipClip.height * dsf;

          const fitScale: number = viewportShotScale(physicalWidth, physicalHeight, SHOT_CAPS);
          const fitted = await capture(cdp, dipClip, fitScale);
          const [fitW, fitH] = await decodedSize(page, fitted);
          const parsed = jpegDimensions(base64ToBytes(fitted, 64 * 1024)) as {
            width: number;
            height: number;
          } | null;

          // The negative control, captured for real rather than computed: the
          // scale the bridge used BEFORE this fix.
          const oldScale = preFixScale(physicalWidth, physicalHeight);
          const unfitted = await capture(cdp, dipClip, oldScale);
          const [oldW, oldH] = await decodedSize(page, unfitted);

          const observed = {
            asked: shape,
            devicePixelRatio: dpr,
            derived: { zoom, dsf: Number(dsf.toFixed(3)) },
            cssClip,
            dipClip,
            physical: { width: physicalWidth, height: physicalHeight },
            fitted: {
              scale: Number(fitScale.toFixed(6)),
              decoded: [fitW, fitH],
              parsedFromBytes: parsed,
              tokens: visionTokens(fitW, fitH),
              fits: visionFits(fitW, fitH),
            },
            preFix: {
              scale: Number(oldScale.toFixed(6)),
              decoded: [oldW, oldH],
              tokens: visionTokens(oldW, oldH),
              fits: visionFits(oldW, oldH),
              apiWouldResizeTo: visionFitSize(oldW, oldH),
              coordinateErrorFactor: Number((oldW / visionFitSize(oldW, oldH)[0]).toFixed(3)),
            },
            note: screenshotImageNote({
              mode: "viewport",
              imageWidth: fitW,
              imageHeight: fitH,
              cssWidth: cssClip.width,
              cssHeight: cssClip.height,
              zoom,
              dsf,
            }),
          };
          record(shape.label, observed);

          // Fact 2: the extension's own marker walk agrees with the browser's
          // decoder on the same bytes. This is what click_at now inverts, so a
          // disagreement here is a wrong coordinate space in the field.
          expect(parsed, `${shape.label}: the frame header must be readable`).not.toBeNull();
          expect(
            [parsed?.width, parsed?.height],
            `${shape.label}: jpegDimensions must equal the decoded natural size`,
          ).toEqual([fitW, fitH]);

          // Fact 1: what the browser actually returned for the fitted scale
          // reaches a standard-tier model UNRESIZED, so its pixels are the
          // model's pixels.
          expect(
            visionFits(fitW, fitH),
            `${shape.label}: the fitted bitmap ${fitW}×${fitH} must reach the model unresized`,
          ).toBe(true);
          expect(fitW, `${shape.label}: the width cap still holds`).toBeLessThanOrEqual(
            SHOT_CAPS.maxWidth,
          );
          // Aspect preserved, which is what makes ONE pair of per-axis factors
          // a faithful inversion of the whole image.
          expect(
            fitW / fitH,
            `${shape.label}: the capture is aspect-preserving`,
          ).toBeCloseTo(cssClip.width / cssClip.height, 1);

          // The bridge's derivation and the bitmap agree in this environment,
          // whatever the environment turns out to be — that agreement is what
          // makes the fit computed on `physicalWidth` correct.
          expect(
            Math.abs(oldW - Math.round(physicalWidth * oldScale)),
            `${shape.label}: the returned bitmap is the clip × scale × the DERIVED dsf`,
          ).toBeLessThanOrEqual(1);

          if (shape.mustNotFitPreFix) {
            // NEGATIVE CONTROL: the field bug, reproduced. The caps alone let
            // this capture through, and a standard-tier model would have been
            // shown it resized — with no layer saying so.
            expect(
              visionFits(oldW, oldH),
              `${shape.label}: the pre-fix scale must still be seen producing an OVERSIZED bitmap`,
            ).toBe(false);
            expect(
              observed.preFix.coordinateErrorFactor,
              `${shape.label}: and that oversize is a real coordinate error, not a rounding one`,
            ).toBeGreaterThan(1.1);
            expect(
              fitH,
              `${shape.label}: the fit is what shrank it`,
            ).toBeLessThan(oldH);
          } else {
            // The common shapes are UNTOUCHED — the fit must not cost fidelity
            // where the caps already produced a fitting image.
            expect(
              fitScale,
              `${shape.label}: a viewport that already fits keeps the pre-fix scale`,
            ).toBeCloseTo(oldScale, 6);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  });

  test("a scaled DISPLAY is measured in physical px, and the fit is computed there", async () => {
    test.setTimeout(120_000);
    // The browser-level flag, not Emulation: this is the lever that moves BOTH
    // `visualViewport` and the returned bitmap (Test A records that emulated
    // deviceScaleFactor moves neither). 1.5 is the common Windows setting.
    const FORCED_DSF = 1.5;
    const browser = await chromium.launch({
      args: [
        `--force-device-scale-factor=${FORCED_DSF}`,
        // Portrait-ish and wide enough that the standard-tier fit has to bind.
        "--window-size=1000,1500",
        "--disable-gpu",
      ],
    });
    try {
      // As in zoom-capture.spec.ts: the project's emulated viewport and
      // deviceScaleFactor are dropped so the browser's own geometry is measured.
      const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined });
      const page = await context.newPage();
      await page.setContent(PAGE_HTML);
      const cdp = await context.newCDPSession(page);
      const metrics: LayoutMetrics = await cdp.send("Page.getLayoutMetrics");
      const { css, zoom, dsf } = factorsOf(metrics);
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const { cssClip, dipClip } = viewportClips(css, zoom);
      const physicalWidth = dipClip.width * dsf;
      const physicalHeight = dipClip.height * dsf;
      const fitScale: number = viewportShotScale(physicalWidth, physicalHeight, SHOT_CAPS);
      const fitted = await capture(cdp, dipClip, fitScale);
      const [fitW, fitH] = await decodedSize(page, fitted);
      const parsed = jpegDimensions(base64ToBytes(fitted, 64 * 1024)) as {
        width: number;
        height: number;
      } | null;
      // What a CSS-measured fit would have produced — the wrong answer this
      // whole unit note exists to prevent.
      const cssMeasuredScale: number = viewportShotScale(cssClip.width, cssClip.height, SHOT_CAPS);
      const observed = {
        forcedDsf: FORCED_DSF,
        honoredForcedDsf: dpr > 1.01,
        devicePixelRatio: dpr,
        derived: { zoom, dsf: Number(dsf.toFixed(3)) },
        cssClip,
        physical: { width: physicalWidth, height: physicalHeight },
        fitted: {
          scale: Number(fitScale.toFixed(6)),
          decoded: [fitW, fitH],
          parsedFromBytes: parsed,
          tokens: visionTokens(fitW, fitH),
          fits: visionFits(fitW, fitH),
        },
        pxPerCss: {
          predicted: Number((fitScale * zoom * dsf).toFixed(6)),
          measuredX: Number((fitW / cssClip.width).toFixed(6)),
          measuredY: Number((fitH / cssClip.height).toFixed(6)),
        },
        cssMeasuredScale: Number(cssMeasuredScale.toFixed(6)),
      };
      record("forced-dsf", observed);

      test.skip(
        !observed.honoredForcedDsf,
        "this Chromium ignored --force-device-scale-factor, so there is no scaled display to measure",
      );

      // The flag really moved the display, and the bridge's derivation found it.
      expect(dsf, "visualViewport ÷ cssVisualViewport recovers the device scale factor").toBeCloseTo(
        dpr,
        2,
      );
      expect(physicalWidth, "the physical edge is larger than the CSS one here").toBeGreaterThan(
        cssClip.width,
      );

      // The fit computed on PHYSICAL px lands on a bitmap that fits…
      expect(parsed, "the frame header must be readable").not.toBeNull();
      expect([parsed?.width, parsed?.height], "jpegDimensions equals the decoded size").toEqual([
        fitW,
        fitH,
      ]);
      expect(
        visionFits(fitW, fitH),
        `the fitted bitmap ${fitW}×${fitH} must reach the model unresized`,
      ).toBe(true);
      // …and a CSS-measured fit would have asked for a LARGER scale, i.e. the
      // bound would have bounded nothing: dsf multiplies whatever it allows.
      expect(
        cssMeasuredScale,
        "a CSS-measured fit is the wrong answer on a scaled display — it allows more than it should",
      ).toBeGreaterThan(fitScale);
    } finally {
      await browser.close();
    }
  });
});
