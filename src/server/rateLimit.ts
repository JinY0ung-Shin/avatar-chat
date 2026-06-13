import type { NextFunction, Request, Response } from "express";

interface Attempt {
  count: number;
  resetAt: number;
}

/**
 * Minimal in-memory fixed-window rate limiter. Single-process, like the rest of
 * the app (in-process SQLite, in-memory run registry) — if the server is ever
 * scaled horizontally this must move to a shared store. It is not a substitute
 * for an edge/CDN limiter, but it turns unlimited password / credential guessing
 * into a bounded, observable cost.
 *
 * Bypassed entirely under NODE_ENV=test so suites can hammer auth endpoints
 * without tripping it (mirrors loadEnv's test-mode handling).
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  message?: string;
}) {
  const {
    windowMs,
    max,
    keyFn,
    message = "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  } = options;
  const hits = new Map<string, Attempt>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === "test") {
      next();
      return;
    }
    const now = Date.now();
    const key = keyFn(req);
    const existing = hits.get(key);
    if (!existing || existing.resetAt <= now) {
      // Opportunistically drop expired buckets so the map can't grow unbounded
      // under key rotation (e.g. an attacker varying usernames/IPs).
      if (hits.size > 5_000) {
        for (const [k, v] of hits) {
          if (v.resetAt <= now) {
            hits.delete(k);
          }
        }
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((existing.resetAt - now) / 1000)));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
