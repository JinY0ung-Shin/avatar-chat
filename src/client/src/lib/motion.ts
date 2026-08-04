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
 *
 * The default `dampingRatio` is critically damped (1.0) per DESIGN §2.5: a
 * programmatic settle must not overshoot. Underdamping (~0.8) is reserved for
 * springs continuing a user's flick momentum, and those callers pass it
 * explicitly.
 */
export function springValue(options: SpringValueOptions): () => void {
  const {
    from,
    to,
    velocity: initialVelocity = 0,
    response = 0.3,
    dampingRatio = 1,
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
