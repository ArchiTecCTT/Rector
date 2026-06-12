import type { Request } from "express";
import { SESSION_COOKIE_NAME, type ParsedAuthConfig, verifySessionToken } from "./auth";

export interface AuthIdentity {
  userId: string;
  email?: string;
  displayName?: string;
  providerSubject?: string;
}

export interface AuthSession {
  userId: string;
  username?: string;
  expiresAt?: string;
  claims?: Record<string, unknown>;
}

export interface AuthProviderAdapter {
  kind: "local" | "oidc" | "auth0" | "clerk" | "workos";
  getLoginUrl?(state: string): Promise<string>;
  handleCallback?(input: unknown): Promise<AuthIdentity>;
  verifySession(req: Request): Promise<AuthSession | undefined>;
  logout?(session: AuthSession): Promise<void>;
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/** Adapter wrapper around Rector's built-in signed-cookie local/session auth. */
export function createLocalSessionAuthAdapter(config: ParsedAuthConfig): AuthProviderAdapter {
  return {
    kind: "local",
    async verifySession(req: Request): Promise<AuthSession | undefined> {
      if (!config.enabled) {
        return { userId: "default", username: "default" };
      }
      const verified = verifySessionToken(cookieValue(req, SESSION_COOKIE_NAME), config.sessionSecret);
      if (!verified) return undefined;
      return { userId: verified.userId, username: verified.username };
    },
    async logout(): Promise<void> {
      // Cookie invalidation is handled by the HTTP route so this adapter stays storage-agnostic.
    },
  };
}

export interface OidcAdapterOptions {
  kind?: "oidc" | "auth0" | "clerk" | "workos";
  issuerUrl?: string;
  clientId?: string;
  enabled?: boolean;
}

/**
 * Optional OIDC/Auth0/Clerk/WorkOS adapter shape. It is deliberately inert unless explicitly
 * enabled and fully configured; no external auth provider is required for local or self-hosted use.
 */
export function createOidcAuthAdapterStub(options: OidcAdapterOptions = {}): AuthProviderAdapter {
  const kind = options.kind ?? "oidc";
  return {
    kind,
    async getLoginUrl(state: string): Promise<string> {
      if (!options.enabled || !options.issuerUrl || !options.clientId) {
        throw new Error(`${kind} auth adapter is not enabled or fully configured.`);
      }
      const url = new URL(options.issuerUrl);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      return url.toString();
    },
    async handleCallback(): Promise<AuthIdentity> {
      throw new Error(`${kind} callback handling is not implemented; plug in an OIDC verifier adapter.`);
    },
    async verifySession(): Promise<AuthSession | undefined> {
      return undefined;
    },
  };
}
