import type { Request, RequestHandler, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  authErrorMessage,
  type ParsedAuthConfig,
  verifySessionToken,
} from "./auth";
import { redactOutbound, redactString } from "./redaction";
import type { UserStores } from "./userStores";

export interface RectorAuthContext {
  userId: string;
  username: string;
}

declare module "express-serve-static-core" {
  interface Request {
    rectorAuth?: RectorAuthContext;
    rectorStores?: UserStores;
  }
}

const DEFAULT_AUTH: RectorAuthContext = { userId: "default", username: "default" };

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function sendRedactedAuthError(res: Response, status: number, message: string): void {
  const outcome = redactOutbound({ error: authErrorMessage(message) });
  if (outcome.ok) {
    res.status(status).json(outcome.value);
    return;
  }
  res.status(500).json({ error: redactString("redaction-failed: outbound content suppressed") });
}

/** Routes that remain accessible without a session when auth is enabled. */
export function isPublicAuthRoute(method: string, path: string): boolean {
  if (method === "GET" && path === "/") return true;
  if (method === "POST" && path === "/api/auth/login") return true;
  if (method === "GET" && path === "/api/setup/status") return true;
  // Static assets are served before auth middleware; allow any non-API GET for safety.
  if (method === "GET" && !path.startsWith("/api/")) return true;
  return false;
}

/**
 * Attach `req.rectorAuth` and `req.rectorStores`. When auth is disabled, every
 * request receives the default identity with zero gate overhead (Req 9).
 */
export function createAuthMiddleware(
  authConfig: ParsedAuthConfig,
  resolveUserStores: (userId: string) => UserStores,
): RequestHandler {
  return (req, res, next) => {
    if (!authConfig.enabled) {
      req.rectorAuth = DEFAULT_AUTH;
      req.rectorStores = resolveUserStores(DEFAULT_AUTH.userId);
      next();
      return;
    }

    if (isPublicAuthRoute(req.method, req.path)) {
      req.rectorAuth = undefined;
      req.rectorStores = resolveUserStores("default");
      next();
      return;
    }

    const cookies = parseCookies(req.header("cookie"));
    const session = verifySessionToken(cookies[SESSION_COOKIE_NAME], authConfig.sessionSecret);
    if (!session) {
      sendRedactedAuthError(res, 401, "Authentication required");
      return;
    }

    req.rectorAuth = { userId: session.userId, username: session.username };
    req.rectorStores = resolveUserStores(session.userId);
    next();
  };
}

/** Convenience guard for route handlers that require an authenticated identity. */
export function requireAuthenticated(req: Request): RectorAuthContext | undefined {
  return req.rectorAuth;
}