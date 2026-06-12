import { describe, expect, it } from "vitest";
import { computeCommercialDeploymentReadiness } from "../src/deployment/readiness";

describe("commercial deployment readiness", () => {
  it("preserves zero-config local-dev readiness", () => {
    const readiness = computeCommercialDeploymentReadiness({ NODE_ENV: "development" });

    expect(readiness.authMode).toBe("local-dev");
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toHaveLength(0);
    expect(readiness.checks.find((check) => check.id === "session-secret")?.status).toBe("pass");
  });

  it("reports production blockers for local-dev auth and in-memory persistence", () => {
    const readiness = computeCommercialDeploymentReadiness({ NODE_ENV: "production", RECTOR_PERSISTENCE: "memory" });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((check) => check.id)).toContain("auth-mode");
    expect(readiness.blockers.map((check) => check.id)).toContain("persistence");
  });

  it("keeps OIDC/Auth0 optional but validates external-oidc shape when selected", () => {
    const missing = computeCommercialDeploymentReadiness({ NODE_ENV: "production", RECTOR_AUTH_MODE: "external-oidc", RECTOR_PERSISTENCE: "sqlite" });
    expect(missing.blockers.map((check) => check.id)).toContain("auth-mode");

    const configured = computeCommercialDeploymentReadiness({
      NODE_ENV: "production",
      RECTOR_AUTH_MODE: "external-oidc",
      RECTOR_OIDC_ISSUER_URL: "https://issuer.example.test",
      RECTOR_OIDC_CLIENT_ID: "rector",
      RECTOR_AUTH_SESSION_SECRET: "session-secret",
      RECTOR_PERSISTENCE: "sqlite",
      RECTOR_TELEMETRY_DISABLED: "true",
      RECTOR_BACKUP_STRATEGY: "sqlite-snapshot",
      SANDBOX_RUNTIME: "local",
    });

    expect(configured.blockers).toHaveLength(0);
    expect(configured.checks.find((check) => check.id === "auth-mode")?.status).toBe("pass");
  });
});
