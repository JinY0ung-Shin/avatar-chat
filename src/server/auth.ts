import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { User } from "./types.js";
import type { Store } from "./store.js";

const SESSION_COOKIE = "ac_session";

export interface AuthenticatedRequest extends Request {
  user?: User;
}

// ---- Password hashing (scrypt) -----------------------------------------

/** Hash a password as `${saltHex}:${hashHex}` using scrypt with a random salt. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify a password against a `${saltHex}:${hashHex}` digest in constant time. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/** Hash a session token (sha256) for storage as token_hash. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---- Cookies ------------------------------------------------------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const cookie of header.split(";").map((part) => part.trim())) {
    const [cookieName, ...rest] = cookie.split("=");
    if (cookieName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function sessionTokenFromRequest(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}

// ---- Middleware ---------------------------------------------------------

export function requireAuth(store: Store) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.user = user;
    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user?.roles.includes("admin")) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
