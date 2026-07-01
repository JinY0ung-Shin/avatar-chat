// Auto-scroll ("stick to bottom") decision logic for the chat transcript,
// extracted from ChatView so it can be unit-tested without a browser.
//
// The transcript pins to the bottom as tokens stream in, UNLESS the user has
// scrolled up to read — then it must stay put. Telling a genuine user scroll-up
// apart from our own programmatic pinning is the whole problem, and it has a
// sharp edge: the browser ALSO decreases scrollTop on its own whenever it clamps
// the scroll offset to a shrunk range. That happens constantly mid-turn — most
// reliably right after a multi-line send, when the composer autosizes back to one
// line (via a queued microtask, AFTER we already pinned to the bottom) and the
// transcript viewport grows, forcing scrollTop down. That clamp fires a `scroll`
// event with a DECREASED scrollTop, and the old "any decrease is a scroll-up"
// rule misread it and killed auto-scroll for the rest of the turn — the
// intermittent "sometimes it doesn't follow the tokens".
//
// The tell: a clamp always lands the viewport AT the (new) bottom
// (distanceFromBottom ≈ 0); only a real gesture leaves it meaningfully ABOVE the
// bottom. So an upward move counts as user intent only when it ALSO ends up away
// from the bottom.

// Within this many px of the bottom counts as "caught up": re-engage auto-scroll
// here, and never treat a decrease that lands here as a user scroll-up.
export const NEAR_BOTTOM_PX = 120;
// Minimum upward move (px) that counts as intentional; absorbs sub-pixel jitter.
export const SCROLL_UP_DEADZONE_PX = 5;

export interface ScrollStickInput {
  /** Previous scrollTop for this pane (undefined before the first scroll event). */
  prev: number | undefined;
  /** Current scrollTop. */
  top: number;
  scrollHeight: number;
  clientHeight: number;
  /** Current stickBottom (undefined behaves as "sticky", matching the store default). */
  stickBottom: boolean | undefined;
}

// Decide the next `stickBottom` value from one scroll event. Returns the new
// boolean, or `null` when nothing should change (so the caller can skip a no-op
// store write — scroll fires rapidly while streaming).
export function nextStickBottom(input: ScrollStickInput): boolean | null {
  const { prev, top, scrollHeight, clientHeight, stickBottom } = input;
  const distanceFromBottom = scrollHeight - top - clientHeight;
  // A genuine user scroll-UP: moved up past the deadzone AND now away from the
  // bottom. The distance guard is what rejects browser clamps (they land at ≈0).
  const scrolledUp =
    prev !== undefined && top < prev - SCROLL_UP_DEADZONE_PX && distanceFromBottom > NEAR_BOTTOM_PX;
  if (scrolledUp) {
    // Hand control to the user only if we were still sticking. `undefined` (the
    // store default) reads as sticky but is left as-is, mirroring ChatView's
    // `if (item.stickBottom)` guard.
    return stickBottom ? false : null;
  }
  // Re-engage once the user is back within reach of the bottom (also the path the
  // scroll-to-bottom FAB settles into).
  if (stickBottom === false && distanceFromBottom < NEAR_BOTTOM_PX) {
    return true;
  }
  return null;
}
