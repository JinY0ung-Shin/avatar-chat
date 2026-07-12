export interface SpringValueOptions {
  from: number;
  to: number;
  velocity?: number;
  response?: number;
  dampingRatio?: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

/** Apple-style exponential momentum projection. */
export function project(value: number, velocity: number, decelerationRate = 0.998): number {
  return value + (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Progressive resistance once a direct-manipulation gesture crosses a bound. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/**
 * Display-synchronised scalar spring. Retargeting callers can cancel this and
 * feed the current presentation value and velocity into the next spring.
 */
export function springValue(options: SpringValueOptions): () => void {
  const {
    from,
    to,
    velocity: initialVelocity = 0,
    response = 0.3,
    dampingRatio = 0.86,
    onUpdate,
    onComplete,
  } = options;

  if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
    onUpdate(to);
    onComplete?.();
    return () => {};
  }

  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = 2 * dampingRatio * omega;
  let position = from;
  let velocity = initialVelocity;
  let previous = performance.now();
  let frame = 0;
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - previous) / 1000));
    previous = now;
    const acceleration = -stiffness * (position - to) - damping * velocity;
    velocity += acceleration * dt;
    position += velocity * dt;
    onUpdate(position);

    if (Math.abs(position - to) < 0.5 && Math.abs(velocity) < 5) {
      onUpdate(to);
      onComplete?.();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (frame) cancelAnimationFrame(frame);
  };
}
