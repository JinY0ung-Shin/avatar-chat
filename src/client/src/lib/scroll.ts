// Auto-scroll ("stick to bottom") decision logic for the chat transcript,
// extracted so it can be unit-tested without a browser. The event wiring that
// feeds it (wheel/touch/pointer capture, ResizeObserver re-pins) lives in
// `autoscroll.ts`.
//
// The transcript pins to the bottom as tokens stream in, UNLESS the user has
// scrolled up to read — then it must stay put. Telling a genuine user scroll-up
// apart from scrollTop changes the browser makes on its own is the whole
// problem. Two facts anchor the design:
//
// 1. The browser also DECREASES scrollTop whenever it clamps the offset to a
//    shrunk range (content collapsed, composer autosized back to one line, …).
//    But a clamp always LANDS AT the new bottom (distance ≈ 0); only a real
//    gesture ends up meaningfully above it.
// 2. Heuristics on scroll events alone are not enough: per-event deltas from a
//    slow trackpad drag are 1–4px (under any jitter deadzone), and while tokens
//    stream the re-pin resets the viewport to the bottom between wheel notches,
//    so a distance threshold alone can keep a single notch from ever counting.
//    So the wiring layer marks scroll events that happen during a live
//    wheel/touch/pointer gesture (`userGesture`), and those get a hair-trigger
//    detach; only unattributed scrolls (keyboard, programmatic) fall back to
//    the conservative distance rule.

// Within this many px of the bottom counts as "caught up": re-engage auto-scroll
// here, and never treat an unattributed decrease that lands here as a scroll-up.
export const NEAR_BOTTOM_PX = 120;
// Minimum upward move (px) that counts as intentional WITHOUT gesture
// attribution; absorbs sub-pixel jitter on coalesced/programmatic scrolls.
export const SCROLL_UP_DEADZONE_PX = 5;
// During a live gesture even a 2px move is intent (slow scrollbar drags crawl
// 1–3px per event); 1px still absorbs fractional-pixel jitter.
export const GESTURE_DEADZONE_PX = 1;
// A browser range-clamp lands AT the new bottom — within rounding. Any landing
// above this is not a clamp.
export const CLAMP_LANDING_PX = 2;

export interface ScrollStickInput {
  /** Previous scrollTop for this pane (undefined before the first scroll event). */
  prev: number | undefined;
  /** Current scrollTop. */
  top: number;
  scrollHeight: number;
  clientHeight: number;
  /** Current stickBottom (undefined behaves as "sticky", matching the store default). */
  stickBottom: boolean | undefined;
  /** True while a wheel/touch/pointer gesture is (recently) driving this pane. */
  userGesture?: boolean;
}

// Decide the next `stickBottom` value from one scroll event. Returns the new
// boolean, or `null` when nothing should change (so the caller can skip a no-op
// store write — scroll fires rapidly while streaming).
export function nextStickBottom(input: ScrollStickInput): boolean | null {
  const { prev, top, scrollHeight, clientHeight, stickBottom, userGesture } = input;
  if (prev === undefined) return null;
  const distanceFromBottom = scrollHeight - top - clientHeight;

  // Detach on a genuine user scroll-UP. With gesture attribution any real
  // upward move counts as long as it doesn't land at the bottom (a clamp's
  // signature). Without it (keyboard / unknown source), require both a larger
  // move and landing clearly above the bottom zone.
  const deadzone = userGesture ? GESTURE_DEADZONE_PX : SCROLL_UP_DEADZONE_PX;
  const minLanding = userGesture ? CLAMP_LANDING_PX : NEAR_BOTTOM_PX;
  if (top < prev - deadzone && distanceFromBottom > minLanding) {
    // `undefined` (the store default) reads as sticky everywhere else, so it
    // must be detachable here too — otherwise a fresh pane can never let go.
    return stickBottom === false ? null : false;
  }

  // Re-engage once the user comes back DOWN within reach of the bottom (also
  // the path the scroll-to-bottom FAB settles into). Requiring an INCREASED
  // scrollTop keeps browser clamps from re-engaging: a clamp always decreases
  // scrollTop, and you cannot reach the bottom by scrolling up.
  if (stickBottom === false && top > prev && distanceFromBottom < NEAR_BOTTOM_PX) {
    return true;
  }
  return null;
}
