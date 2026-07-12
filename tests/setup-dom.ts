// jsdom does not implement Web Animations. Svelte 5 uses it internally for
// transition directives, so component tests get a zero-time, deterministic
// stand-in while real timing remains covered by Playwright.
if (typeof Element !== "undefined" && !(Element.prototype as Element & { animate?: unknown }).animate) {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(_keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const duration = typeof options === "number" ? options : Number(options?.duration ?? 0);
      let cancelled = false;
      let finish: (() => void) | null = null;
      const animation = {
        currentTime: duration,
        effect: null,
        playState: "finished",
        cancel() {
          cancelled = true;
        },
        get onfinish() {
          return finish;
        },
        set onfinish(callback: (() => void) | null) {
          finish = callback;
          if (callback) queueMicrotask(() => {
            if (!cancelled && finish === callback) callback();
          });
        },
      };
      return animation;
    },
  });
}
