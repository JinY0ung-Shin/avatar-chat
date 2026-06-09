import type { NextFunction, Request, Response } from "express";
import type { User } from "./types.js";
import type { JsonStore } from "./store.js";

const SESSION_COOKIE = "avatar_session";

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  const cookies = header.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
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

export function requireAuth(store: JsonStore) {
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

export function requireOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "owner") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
}
