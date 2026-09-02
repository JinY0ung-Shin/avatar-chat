import { describe, expect, it } from "vitest";
import {
  VISION_STANDARD_MAX_EDGE,
  VISION_STANDARD_MAX_TOKENS,
  jpegDimensions,
  visionFitSize,
  visionFits,
  visionTokens,
} from "../src/server/agent/visionImage.js";

// Coverage target: src/server/agent/visionImage.ts — the port of Claude's own
// image-resize rule (platform.claude.com/docs/en/build-with-claude/vision,
// /vision-coordinates, read 2026-09-02) and the header-only JPEG size reader
// behind it. Both exist for #66: the model answers pixel questions in the space
// of the image it SEES, so a screenshot has to be measured (never predicted)
// and compared against the size the API would resize it to. The numbers pinned
// here are the DOCS' own worked examples — if one of them moves, the docs
// changed and the extension's copy of the same rule must move with it.

/**
 * A JPEG header carrying the given SOF dimensions. jpegDimensions never decodes
 * pixels, so a real image is unnecessary: the frame header IS the fact under
 * test. `marker` picks the SOF flavour (0xC0 baseline, 0xC2 progressive).
 */
function jpegHeader(
  width: number,
  height: number,
  opts: { marker?: number; preamble?: number[]; trailer?: boolean } = {},
): Uint8Array {
  const { marker = 0xc0, preamble = [], trailer = true } = opts;
  const sof = [
    0xff,
    marker,
    // length 17 = 2 (itself) + 1 precision + 2 height + 2 width + 1 count + 3×3
    0x00,
    0x11,
    0x08, // 8-bit precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // three components, three bytes each
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  return Uint8Array.from([0xff, 0xd8, ...preamble, ...sof, ...(trailer ? [0xff, 0xd9] : [])]);
}

/** A JFIF APP0 plus a quantization table — the segments a real capture puts before its SOF. */
const REAL_PREAMBLE = [
  0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0x00), // APP0, length 16
  0xff, 0xdb, 0x00, 0x43, ...new Array<number>(65).fill(0x01), // DQT, length 67
];

describe("vision token accounting (visionTokens / visionFits)", () => {
  it("counts one visual token per 28×28 patch, rounding UP on both axes", () => {
    expect(visionTokens(28, 28)).toBe(1);
    // A single pixel over a patch boundary costs a whole extra row/column.
    expect(visionTokens(29, 28)).toBe(2);
    expect(visionTokens(28, 29)).toBe(2);
    // The field capture from #66: far past the standard tier's 1568 tokens,
    // which is exactly why it came back downscaled.
    expect(visionTokens(1400, 2197)).toBe(3950);
  });

  it("measures the PADDED edges against the standard tier's two ceilings", () => {
    expect(VISION_STANDARD_MAX_EDGE).toBe(1568);
    expect(VISION_STANDARD_MAX_TOKENS).toBe(1568);
    // Exactly 39×39 patches = 1521 tokens, both edges exactly 1568 padded.
    expect(visionFits(1092, 1092)).toBe(true);
    // A typical 1400×788 viewport capture: 1450 tokens, already native.
    expect(visionFits(1400, 788)).toBe(true);
    // Token ceiling binds first here — neither edge is over 1568.
    expect(visionFits(1400, 1400)).toBe(false);
    // Edge ceiling binds: 2197 padded is 2212 px.
    expect(visionFits(1400, 2197)).toBe(false);
  });
});

describe("visionFitSize (the size the API resizes an upload to)", () => {
  it("reproduces the vision docs' worked examples", () => {
    expect(visionFitSize(1075, 1520)).toEqual([924, 1307]);
    expect(visionFitSize(1920, 1080)).toEqual([1456, 819]);
  });

  it("leaves an image that already fits completely untouched", () => {
    expect(visionFitSize(1000, 1000)).toEqual([1000, 1000]);
    expect(visionFitSize(1092, 1092)).toEqual([1092, 1092]);
    expect(visionFitSize(200, 200)).toEqual([200, 200]);
    expect(visionFitSize(1400, 788)).toEqual([1400, 788]);
  });

  it("gives the #66 field capture the size the model actually saw", () => {
    // 1400×2197 is what the bridge sent; 874×1372 is what a standard-tier model
    // received, so every coordinate it reported was ×1.60 too small.
    const [width, height] = visionFitSize(1400, 2197);
    expect([width, height]).toEqual([874, 1372]);
    expect((1400 / width).toFixed(2)).toBe("1.60");
  });

  it("always returns something that fits, and fitting twice changes nothing", () => {
    for (const [width, height] of [
      [1400, 2197],
      [1075, 1520],
      [1920, 1080],
      [3840, 2160],
      [1152, 2260],
      [400, 5000],
      [5000, 400],
    ]) {
      const fitted = visionFitSize(width, height);
      expect(visionFits(fitted[0], fitted[1]), `${width}×${height}`).toBe(true);
      // Idempotent: the fitted size is a fixed point, so a double pass (a
      // pre-fitted capture re-checked by the server) can never shrink twice.
      expect(visionFitSize(fitted[0], fitted[1])).toEqual(fitted);
      // Aspect ratio survives — a stretched fit would move coordinates on one
      // axis only, which is worse than the scale error it replaces.
      const aspect = width / height;
      expect(Math.abs(fitted[0] / fitted[1] - aspect) / aspect, `${width}×${height}`).toBeLessThan(
        0.01,
      );
    }
  });

  it("honours a caller-supplied tier (the high-resolution ceilings)", () => {
    // Documented for the follow-up: a 4.7-class model sees 2576 px / 4784
    // tokens, so the same capture would not need fitting at all.
    expect(visionFits(1400, 2197, { maxEdge: 2576, maxTokens: 4784 })).toBe(true);
    expect(visionFitSize(1400, 2197, { maxEdge: 2576, maxTokens: 4784 })).toEqual([1400, 2197]);
  });
});

describe("jpegDimensions (measure the bitmap, never trust the formula)", () => {
  it("reads the frame size out of a baseline SOF0 header", () => {
    expect(jpegDimensions(jpegHeader(1400, 2197))).toEqual({ width: 1400, height: 2197 });
    expect(jpegDimensions(jpegHeader(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it("reads a progressive SOF2 frame too, and skips the segments before it", () => {
    expect(jpegDimensions(jpegHeader(874, 1372, { marker: 0xc2 }))).toEqual({
      width: 874,
      height: 1372,
    });
    expect(jpegDimensions(jpegHeader(1280, 720, { preamble: REAL_PREAMBLE }))).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("tolerates 0xFF fill bytes padded ahead of a marker", () => {
    const padded = jpegHeader(640, 480, { preamble: [0xff, 0xff, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00] });
    expect(jpegDimensions(padded)).toEqual({ width: 640, height: 480 });
  });

  it("accepts a Buffer as readily as a Uint8Array — the base64 decode hands us one", () => {
    expect(jpegDimensions(Buffer.from(jpegHeader(1024, 768)))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("returns null — never a guess — for anything it cannot parse", () => {
    // A PNG: the caller must simply say nothing about its size.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC",
      "base64",
    );
    expect(jpegDimensions(png)).toBeNull();
    expect(jpegDimensions(new Uint8Array(0))).toBeNull();
    expect(jpegDimensions(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    // Truncated mid-SOF: the length word promises bytes the buffer does not have.
    expect(jpegDimensions(jpegHeader(1400, 2197).slice(0, 8))).toBeNull();
    // Entropy-coded data begins before any frame header — nothing to read.
    expect(jpegDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0]))).toBeNull();
    // A zero dimension is corrupt, not a 0-pixel image.
    expect(jpegDimensions(jpegHeader(0, 500))).toBeNull();
  });
});
