import { z } from "zod";
import { auditHashSaltReadiness } from "../security/auditLog";
import { checkSessionSecretEntropy } from "../security/auth";

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

type ReadinessEnv = Record<string, string | undefined>;
type ReadinessStatus = DeploymentReadinessCheck["status"];

type ReadinessContext = {
  env: ReadinessEnv;
  production: boolean;
  authMode: CommercialDeploymentReadiness["authMode"];
};

type ReadinessCheckFactory = (context: ReadinessContext) => DeploymentReadinessCheck | DeploymentReadinessCheck[];

const SUPPORTED_PERSISTENCE_DRIVERS = new Set(["memory", "sqlite", "tidb"]);

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function authModeFromEnv(env: ReadinessEnv): CommercialDeploymentReadiness["authMode"] {
  const raw = env.RECTOR_AUTH_MODE?.trim();
  if (raw === "self-hosted" || raw === "external-oidc" || raw === "local-dev") return raw;
  if (truthy(env.RECTOR_AUTH_ENABLED)) return "self-hosted";
  return "local-dev";
}

function check(id: string, status: ReadinessStatus, message: string): DeploymentReadinessCheck {
  return DeploymentReadinessCheckSchema.parse({ id, status, message });
}

function productionStatus(context: ReadinessContext, configured: boolean, productionStatus: ReadinessStatus): ReadinessStatus {
  if (configured) return "pass";
  return context.production ? productionStatus : "pass";
}

function productionWarning(context: ReadinessContext, configured: boolean): ReadinessStatus {
  return productionStatus(context, configured, "warning");
}

function productionBlockerOrWarning(context: ReadinessContext, configured: boolean): ReadinessStatus {
  if (configured) return "pass";
  return context.production ? "blocker" : "warning";
}

function nodeEnvCheck(context: ReadinessContext): DeploymentReadinessCheck {
  return check(
    "node-env",
    "pass",
    context.production
      ? "NODE_ENV=production is set."
      : "Non-production mode keeps local-dev defaults available.",
  );
}

function authModeCheck(context: ReadinessContext): DeploymentReadinessCheck {
  if (context.production && context.authMode === "local-dev") {
    return check(
      "auth-mode",
      "blocker",
      "Production deployment must use self-hosted auth or an external OIDC adapter; local-dev auth is not sufficient.",
    );
  }

  if (context.authMode !== "external-oidc") {
    return check("auth-mode", "pass", `${context.authMode} auth mode is configured.`);
  }

  const oidcReady = present(context.env.RECTOR_OIDC_ISSUER_URL) && present(context.env.RECTOR_OIDC_CLIENT_ID);
  return check(
    "auth-mode",
    productionBlockerOrWarning(context, oidcReady),
    oidcReady
      ? "External OIDC mode is selected and issuer/client id are configured."
      : "External OIDC mode is selected but RECTOR_OIDC_ISSUER_URL or RECTOR_OIDC_CLIENT_ID is missing.",
  );
}

function sessionSecretCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const required = context.authMode !== "local-dev" || truthy(context.env.RECTOR_AUTH_ENABLED);
  if (!required) {
    return check("session-secret", "pass", "Session secret is not required for zero-config local-dev mode.");
  }

  const configured = present(context.env.RECTOR_AUTH_SESSION_SECRET);
  if (!configured) {
    return check(
      "session-secret",
      productionBlockerOrWarning(context, configured),
      "RECTOR_AUTH_SESSION_SECRET is required for secure cookie sessions.",
    );
  }

  // Check entropy and emit a warning (not a hard block) for low-entropy secrets
  const entropyWarning = checkSessionSecretEntropy(context.env.RECTOR_AUTH_SESSION_SECRET!);
  if (entropyWarning) {
    return check("session-secret", "warning", entropyWarning);
  }

  return check("session-secret", "pass", "RECTOR_AUTH_SESSION_SECRET is configured.");
}

function configuredPersistenceDriver(env: ReadinessEnv): string {
  return env.RECTOR_PERSISTENCE?.trim() || "memory";
}

function persistenceCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const driver = configuredPersistenceDriver(context.env);
  if (!SUPPORTED_PERSISTENCE_DRIVERS.has(driver)) {
    return check(
      "persistence",
      "blocker",
      `Unsupported persistence driver "${driver}" is configured; supported drivers are memory, sqlite, and tidb.`,
    );
  }

  if (context.production && driver === "memory") {
    return check(
      "persistence",
      "blocker",
      "Production deployment must use durable persistence (sqlite or tidb), not in-memory persistence.",
    );
  }

  return check("persistence", "pass", `Persistence driver "${driver}" is configured.`);
}

function secretStoreKeyCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const configured = present(context.env.RECTOR_SECRET_KEY);
  return check(
    "secret-store-key",
    productionWarning(context, configured),
    configured
      ? "RECTOR_SECRET_KEY is configured for stable encrypted local secret storage."
      : context.production
        ? "RECTOR_SECRET_KEY is not set; a generated local key may not survive container rebuilds."
        : "Local development can use a generated secret-store key with zero configuration.",
  );
}

function auditHashSaltCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const auditSalt = auditHashSaltReadiness(context.env);
  return check("audit-hash-salt", productionWarning(context, auditSalt.configured), auditSalt.message);
}

function rateLimiterCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const configured = present(context.env.RECTOR_RATE_LIMIT_ADAPTER);
  return check(
    "rate-limiter",
    productionWarning(context, configured),
    configured
      ? "A rate limiter adapter is explicitly configured."
      : context.production
        ? "No production rate limiter adapter is configured; in-memory limits do not coordinate across instances."
        : "Local development uses in-memory rate limiting.",
  );
}

function sandboxModeCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const configured = present(context.env.SANDBOX_RUNTIME);
  return check(
    "sandbox-mode",
    productionWarning(context, configured),
    configured
      ? "SANDBOX_RUNTIME is explicit."
      : context.production
        ? "SANDBOX_RUNTIME is not explicit; set it to local or a configured external sandbox before hosting."
        : "Local development defaults to the local workspace sandbox.",
  );
}

function telemetryCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const telemetryExplicitlyDisabled = truthy(context.env.RECTOR_TELEMETRY_DISABLED);
  const telemetryConfigured =
    present(context.env.SENTRY_DSN) || present(context.env.POSTHOG_API_KEY) || present(context.env.POSTHOG_HOST);
  const resolved = telemetryConfigured || telemetryExplicitlyDisabled;
  return check(
    "telemetry",
    productionWarning(context, resolved),
    telemetryConfigured
      ? "Telemetry is configured."
      : telemetryExplicitlyDisabled
        ? "Telemetry is explicitly disabled."
        : context.production
          ? "Telemetry is neither configured nor explicitly disabled."
          : "Telemetry is optional in local development.",
  );
}

function backupsCheck(context: ReadinessContext): DeploymentReadinessCheck {
  const configured = present(context.env.RECTOR_BACKUP_STRATEGY) || truthy(context.env.RECTOR_BACKUPS_ENABLED);
  return check(
    "backups",
    productionWarning(context, configured),
    configured
      ? "Backup strategy is configured."
      : context.production
        ? "Backups are not configured; set RECTOR_BACKUP_STRATEGY or RECTOR_BACKUPS_ENABLED before production use."
        : "Backups are optional for local development.",
  );
}

const READINESS_CHECKS: readonly ReadinessCheckFactory[] = [
  nodeEnvCheck,
  authModeCheck,
  sessionSecretCheck,
  persistenceCheck,
  secretStoreKeyCheck,
  auditHashSaltCheck,
  rateLimiterCheck,
  sandboxModeCheck,
  telemetryCheck,
  backupsCheck,
];

function evaluateReadinessChecks(context: ReadinessContext): DeploymentReadinessCheck[] {
  return READINESS_CHECKS.flatMap((factory) => factory(context));
}

/**
 * Commercial deployment readiness checks. This is read-only and names configuration keys only; it
 * never returns secret values and performs no network calls.
 */
export function computeCommercialDeploymentReadiness(
  env: ReadinessEnv = process.env,
): CommercialDeploymentReadiness {
  const production = env.NODE_ENV === "production";
  const authMode = authModeFromEnv(env);
  const parsedChecks = evaluateReadinessChecks({ env, production, authMode }).map((entry) =>
    DeploymentReadinessCheckSchema.parse(entry),
  );
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
