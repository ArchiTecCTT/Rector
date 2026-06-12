import { z } from "zod";
import { auditHashSaltReadiness } from "../security/auditLog";

export const DeploymentReadinessCheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pass", "warning", "blocker"]),
  message: z.string().min(1),
});
export type DeploymentReadinessCheck = z.infer<typeof DeploymentReadinessCheckSchema>;

export const CommercialDeploymentReadinessSchema = z.object({
  production: z.boolean(),
  authMode: z.enum(["local-dev", "self-hosted", "external-oidc"]),
  ready: z.boolean(),
  blockers: z.array(DeploymentReadinessCheckSchema),
  warnings: z.array(DeploymentReadinessCheckSchema),
  checks: z.array(DeploymentReadinessCheckSchema),
});
export type CommercialDeploymentReadiness = z.infer<typeof CommercialDeploymentReadinessSchema>;

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function authModeFromEnv(env: Record<string, string | undefined>): CommercialDeploymentReadiness["authMode"] {
  const raw = env.RECTOR_AUTH_MODE?.trim();
  if (raw === "self-hosted" || raw === "external-oidc" || raw === "local-dev") return raw;
  if (truthy(env.RECTOR_AUTH_ENABLED)) return "self-hosted";
  return "local-dev";
}

function check(id: string, status: DeploymentReadinessCheck["status"], message: string): DeploymentReadinessCheck {
  return DeploymentReadinessCheckSchema.parse({ id, status, message });
}

/**
 * Commercial deployment readiness checks. This is read-only and names configuration keys only; it
 * never returns secret values and performs no network calls.
 */
export function computeCommercialDeploymentReadiness(
  env: Record<string, string | undefined> = process.env,
): CommercialDeploymentReadiness {
  const production = env.NODE_ENV === "production";
  const authMode = authModeFromEnv(env);
  const checks: DeploymentReadinessCheck[] = [];

  if (!production) {
    checks.push(check("node-env", "pass", "Non-production mode keeps local-dev defaults available."));
  } else {
    checks.push(check("node-env", "pass", "NODE_ENV=production is set."));
  }

  if (production && authMode === "local-dev") {
    checks.push(check("auth-mode", "blocker", "Production deployment must use self-hosted auth or an external OIDC adapter; local-dev auth is not sufficient."));
  } else if (authMode === "external-oidc") {
    const oidcReady = present(env.RECTOR_OIDC_ISSUER_URL) && present(env.RECTOR_OIDC_CLIENT_ID);
    checks.push(
      check(
        "auth-mode",
        oidcReady ? "pass" : production ? "blocker" : "warning",
        oidcReady
          ? "External OIDC mode is selected and issuer/client id are configured."
          : "External OIDC mode is selected but RECTOR_OIDC_ISSUER_URL or RECTOR_OIDC_CLIENT_ID is missing.",
      ),
    );
  } else {
    checks.push(check("auth-mode", "pass", `${authMode} auth mode is configured.`));
  }

  if (authMode !== "local-dev" || truthy(env.RECTOR_AUTH_ENABLED)) {
    checks.push(
      check(
        "session-secret",
        present(env.RECTOR_AUTH_SESSION_SECRET) ? "pass" : production ? "blocker" : "warning",
        present(env.RECTOR_AUTH_SESSION_SECRET)
          ? "RECTOR_AUTH_SESSION_SECRET is configured."
          : "RECTOR_AUTH_SESSION_SECRET is required for secure cookie sessions.",
      ),
    );
  } else {
    checks.push(check("session-secret", "pass", "Session secret is not required for zero-config local-dev mode."));
  }

  const configuredPersistence = env.RECTOR_PERSISTENCE?.trim() || "memory";
  const persistenceDriver = ["memory", "sqlite", "tidb"].includes(configuredPersistence)
    ? configuredPersistence
    : configuredPersistence;
  if (production && persistenceDriver === "memory") {
    checks.push(check("persistence", "blocker", "Production deployment must use durable persistence (sqlite or tidb), not in-memory persistence."));
  } else {
    checks.push(check("persistence", "pass", `Persistence driver "${persistenceDriver}" is configured.`));
  }

  checks.push(
    check(
      "secret-store-key",
      present(env.RECTOR_SECRET_KEY) ? "pass" : production ? "warning" : "pass",
      present(env.RECTOR_SECRET_KEY)
        ? "RECTOR_SECRET_KEY is configured for stable encrypted local secret storage."
        : production
          ? "RECTOR_SECRET_KEY is not set; a generated local key may not survive container rebuilds."
          : "Local development can use a generated secret-store key with zero configuration.",
    ),
  );

  checks.push(
    check(
      "rate-limiter",
      present(env.RECTOR_RATE_LIMIT_ADAPTER) ? "pass" : production ? "warning" : "pass",
      present(env.RECTOR_RATE_LIMIT_ADAPTER)
        ? "A rate limiter adapter is explicitly configured."
        : production
          ? "No production rate limiter adapter is configured; in-memory limits do not coordinate across instances."
          : "Local development uses in-memory rate limiting.",
    ),
  );

  const auditSalt = auditHashSaltReadiness(env);
  checks.push(
    check(
      "audit-hash-salt",
      auditSalt.configured ? "pass" : production ? "warning" : "pass",
      auditSalt.message,
    ),
  );

  checks.push(
    check(
      "sandbox-mode",
      present(env.SANDBOX_RUNTIME) ? "pass" : production ? "warning" : "pass",
      present(env.SANDBOX_RUNTIME)
        ? "SANDBOX_RUNTIME is explicit."
        : production
          ? "SANDBOX_RUNTIME is not explicit; set it to local or a configured external sandbox before hosting."
          : "Local development defaults to the local workspace sandbox.",
    ),
  );

  const telemetryExplicitlyDisabled = truthy(env.RECTOR_TELEMETRY_DISABLED);
  const telemetryConfigured = present(env.SENTRY_DSN) || present(env.POSTHOG_API_KEY) || present(env.POSTHOG_HOST);
  checks.push(
    check(
      "telemetry",
      telemetryConfigured || telemetryExplicitlyDisabled ? "pass" : production ? "warning" : "pass",
      telemetryConfigured
        ? "Telemetry is configured."
        : telemetryExplicitlyDisabled
          ? "Telemetry is explicitly disabled."
          : production
            ? "Telemetry is neither configured nor explicitly disabled."
            : "Telemetry is optional in local development.",
    ),
  );

  checks.push(
    check(
      "backups",
      present(env.RECTOR_BACKUP_STRATEGY) || truthy(env.RECTOR_BACKUPS_ENABLED) ? "pass" : production ? "warning" : "pass",
      present(env.RECTOR_BACKUP_STRATEGY) || truthy(env.RECTOR_BACKUPS_ENABLED)
        ? "Backup strategy is configured."
        : production
          ? "Backups are not configured; set RECTOR_BACKUP_STRATEGY or RECTOR_BACKUPS_ENABLED before production use."
          : "Backups are optional for local development.",
    ),
  );

  const parsedChecks = checks.map((entry) => DeploymentReadinessCheckSchema.parse(entry));
  const blockers = parsedChecks.filter((entry) => entry.status === "blocker");
  const warnings = parsedChecks.filter((entry) => entry.status === "warning");
  return CommercialDeploymentReadinessSchema.parse({
    production,
    authMode,
    ready: blockers.length === 0,
    blockers,
    warnings,
    checks: parsedChecks,
  });
}
