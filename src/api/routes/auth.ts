import type { Application, Request, Response } from "express";
import { z } from "zod";
import { redactOutbound, REDACTION_FAILED_ERROR } from "../../security/redaction";
import {
  SESSION_COOKIE_NAME,
  authErrorMessage,
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  verifyPassword,
  verifySessionToken,
  type ParsedAuthConfig,
} from "../../security/auth";

interface AuthAuditInput {
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: "success" | "denied" | "failed";
  reason?: string;
}

export interface AuthRoutesDeps {
  authConfig: ParsedAuthConfig;
  deploymentEnv: Record<string, string | undefined>;
  auditRequest(req: Request, input: AuthAuditInput): Promise<void>;
}

const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

type LoginRequest = z.infer<typeof LoginRequestSchema>;
type LoginAttempt = { count: number; resetAt: number };

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export function registerAuthRoutes(app: Application, deps: AuthRoutesDeps): void {
  const { authConfig, deploymentEnv, auditRequest } = deps;
  const loginAttempts = new Map<string, LoginAttempt>();

  app.post("/api/auth/login", async (req, res) => {
    if (!authConfig.enabled) return sendAuthResponse(res, 200, { authenticated: true, username: "default" });

    const parsed = parseLoginRequest(req.body);
    if (!parsed.ok) return sendAuthResponse(res, 400, { error: authErrorMessage("Invalid username or password") });

    const username = parsed.body.username.trim().toLowerCase();
    const attemptKey = loginAttemptKey(username, req.ip);
    const nowMs = Date.now();
    const currentAttempt = activeLoginAttempt(loginAttempts.get(attemptKey), nowMs);

    if (isLoginAttemptLimited(currentAttempt)) {
      await auditLogin(auditRequest, req, username, "denied", "Login attempt rate limit exceeded.");
      return sendAuthResponse(res, 429, { error: authErrorMessage("Too many login attempts") });
    }

    const storedHash = authConfig.users.get(username);
    if (!storedHash || !verifyPassword(parsed.body.password, storedHash)) {
      loginAttempts.set(attemptKey, nextLoginAttempt(currentAttempt, nowMs));
      await auditLogin(auditRequest, req, username, "failed", "Invalid username or password.");
      return sendAuthResponse(res, 401, { error: authErrorMessage("Invalid username or password") });
    }

    loginAttempts.delete(attemptKey);
    const token = createSessionToken(username, username, authConfig.sessionSecret);
    res.setHeader("Set-Cookie", buildSessionCookie(token, deploymentEnv));
    await auditLogin(auditRequest, req, username, "success");
    return sendAuthResponse(res, 200, { authenticated: true, username });
  });

  app.post("/api/auth/logout", async (req, res) => {
    res.setHeader("Set-Cookie", buildClearSessionCookie(deploymentEnv));
    await auditRequest(req, {
      action: "auth.logout",
      targetType: "session",
      outcome: "success",
    });
    return sendAuthResponse(res, 200, { authenticated: false });
  });

  app.get("/api/auth/session", (req, res) => {
    if (!authConfig.enabled) return sendAuthResponse(res, 200, { authenticated: true, username: "default" });

    const cookies = parseAuthCookieHeader(req.header("cookie"));
    const session = verifySessionToken(cookies[SESSION_COOKIE_NAME], authConfig.sessionSecret);
    return sendAuthResponse(
      res,
      200,
      session ? { authenticated: true, username: session.username } : { authenticated: false },
    );
  });
}

function parseLoginRequest(body: unknown): { ok: true; body: LoginRequest } | { ok: false } {
  const parsed = LoginRequestSchema.safeParse(body ?? {});
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false };
}

function loginAttemptKey(username: string, ip: string | undefined): string {
  return `${username}:${ip ?? "unknown"}`;
}

function activeLoginAttempt(attempt: LoginAttempt | undefined, nowMs: number): LoginAttempt | undefined {
  return attempt && attempt.resetAt > nowMs ? attempt : undefined;
}

function isLoginAttemptLimited(attempt: LoginAttempt | undefined): boolean {
  return Boolean(attempt && attempt.count >= LOGIN_ATTEMPT_LIMIT);
}

function nextLoginAttempt(currentAttempt: LoginAttempt | undefined, nowMs: number): LoginAttempt {
  return currentAttempt
    ? { count: currentAttempt.count + 1, resetAt: currentAttempt.resetAt }
    : { count: 1, resetAt: nowMs + LOGIN_ATTEMPT_WINDOW_MS };
}

async function auditLogin(
  auditRequest: AuthRoutesDeps["auditRequest"],
  req: Request,
  username: string,
  outcome: "success" | "denied" | "failed",
  reason?: string,
): Promise<void> {
  await auditRequest(req, {
    actorUserId: username,
    action: "auth.login",
    targetType: "user",
    targetId: username,
    outcome,
    reason,
  });
}

function sendAuthResponse(res: Response, status: number, payload: unknown) {
  const outcome = redactOutbound(payload);
  return res.status(outcome.ok ? status : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
}

function parseAuthCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
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
