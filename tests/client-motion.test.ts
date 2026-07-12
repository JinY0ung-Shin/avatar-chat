import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, project, rubberband, springValue } from "../src/client/src/lib/motion";

describe("motion helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects a resting position in the direction of velocity", () => {
    expect(project(40, 500)).toBeGreaterThan(40);
    expect(project(40, -500)).toBeLessThan(40);
  });

  it("rubber-bands beyond a boundary with progressive resistance", () => {
    expect(rubberband(100, 400)).toBeGreaterThan(0);
    expect(rubberband(100, 400)).toBeLessThan(100);
    expect(rubberband(-100, 400)).toBeLessThan(0);
  });

  it("settles immediately when reduced motion is requested", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const values: number[] = [];
    springValue({ from: 20, to: 0, onUpdate: (value) => values.push(value) });
    expect(prefersReducedMotion()).toBe(true);
    expect(values).toEqual([0]);
  });
});
