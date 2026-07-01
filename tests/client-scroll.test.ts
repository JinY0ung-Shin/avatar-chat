import { describe, expect, it } from "vitest";
import {
  NEAR_BOTTOM_PX,
  SCROLL_UP_DEADZONE_PX,
  nextStickBottom,
} from "../src/client/src/lib/scroll.js";

// The chat transcript auto-scrolls ("sticks") to the bottom while tokens stream,
// and must disengage only when the USER scrolls up. The trap that broke this
// repeatedly: the browser itself DECREASES scrollTop when it clamps to a shrunk
// scroll range (the composer collapsing to one line after a multi-line send, a
// thinking/activity card shrinking, etc.), firing a `scroll` event that looks
// like an upward gesture. `nextStickBottom` distinguishes the two by where the
// viewport LANDS: a clamp lands at the bottom (distance ≈ 0); a real scroll-up
// lands away from it. These tests lock that invariant.

describe("nextStickBottom — browser scroll clamps must NOT disengage", () => {
  it("ignores the composer-shrink-after-send clamp (the reported bug)", () => {
    // Observed in a real-browser repro: afterUpdate pinned lastScrollTop to 887
    // (composer still multi-line), then autosize collapsed the composer in a
    // microtask, growing the viewport and clamping scrollTop to 775 — which lands
    // exactly at the new bottom. The OLD "any decrease is a scroll-up" rule
    // flipped stickBottom off here; the fix must not.
    expect(
      nextStickBottom({ prev: 887, top: 775, scrollHeight: 1428, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("ignores a content-shrink clamp (activity/thinking card collapses)", () => {
    // Pinned at 1400, content shrinks so the max offset drops to 200 → clamp to
    // 200, which is the bottom (800 - 600). distanceFromBottom === 0.
    expect(
      nextStickBottom({ prev: 1400, top: 200, scrollHeight: 800, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });

  it("ignores a large clamp as long as it lands at the bottom", () => {
    // A 500px downward clamp is still not a scroll-up if it ends at the bottom.
    expect(
      nextStickBottom({ prev: 900, top: 400, scrollHeight: 1000, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });
});

describe("nextStickBottom — genuine user scroll-up disengages", () => {
  it("disengages when the user scrolls up and lands away from the bottom", () => {
    // Moved up 459px and now 459px from the bottom (> NEAR_BOTTOM_PX).
    expect(
      nextStickBottom({ prev: 1259, top: 800, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBe(false);
  });

  it("does NOT disengage for a tiny scroll-up that stays within the bottom zone", () => {
    // Up 59px but still only 59px from the bottom — treated as staying caught up.
    expect(
      nextStickBottom({ prev: 1259, top: 1200, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("respects the deadzone for sub-pixel jitter", () => {
    // Up 3px (< SCROLL_UP_DEADZONE_PX) even though far from the bottom.
    expect(
      nextStickBottom({ prev: 1259, top: 1256, scrollHeight: 3000, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("just past the deadzone AND far from the bottom disengages", () => {
    const top = 1000;
    const prev = top + SCROLL_UP_DEADZONE_PX + 1;
    expect(
      nextStickBottom({ prev, top, scrollHeight: 3000, clientHeight: 653, stickBottom: true }),
    ).toBe(false);
  });
});

describe("nextStickBottom — re-engaging by scrolling back down", () => {
  it("re-engages once the user returns within the bottom zone", () => {
    expect(
      nextStickBottom({ prev: 500, top: 1800, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBe(true);
  });

  it("stays disengaged while still far from the bottom", () => {
    expect(
      nextStickBottom({ prev: 300, top: 600, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBeNull();
  });

  it("re-engages exactly at the bottom", () => {
    expect(
      nextStickBottom({ prev: 1000, top: 1847, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBe(true);
  });
});

describe("nextStickBottom — no-op and edge cases", () => {
  it("returns null on the first event (no previous scrollTop)", () => {
    expect(
      nextStickBottom({ prev: undefined, top: 100, scrollHeight: 2000, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });

  it("returns null while sticking and content grows downward (pin, no gesture)", () => {
    // scrollTop increased (we followed growth) — never a scroll-up.
    expect(
      nextStickBottom({ prev: 800, top: 1259, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("does not re-write when already disengaged and scrolling further up", () => {
    expect(
      nextStickBottom({ prev: 900, top: 500, scrollHeight: 3000, clientHeight: 653, stickBottom: false }),
    ).toBeNull();
  });

  it("treats undefined stickBottom (store default) as sticky and leaves it as-is on a scroll-up", () => {
    // Mirrors ChatView's `if (item.stickBottom)` guard: undefined is not written.
    expect(
      nextStickBottom({ prev: 1259, top: 800, scrollHeight: 1912, clientHeight: 653, stickBottom: undefined }),
    ).toBeNull();
  });

  it("exposes the tuning constants", () => {
    expect(NEAR_BOTTOM_PX).toBe(120);
    expect(SCROLL_UP_DEADZONE_PX).toBe(5);
  });
});
