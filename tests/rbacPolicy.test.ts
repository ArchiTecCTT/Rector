import { describe, expect, it } from "vitest";
import { canRole, permissionsForRole, requirePermission } from "../src/security/rbac";

describe("RBAC permission policy", () => {
  it("matches the commercial readiness role expectations", () => {
    expect(canRole("viewer", "providers.configure")).toBe(false);
    expect(canRole("developer", "runs.create")).toBe(true);
    expect(canRole("developer", "providers.secrets.write")).toBe(false);
    expect(canRole("operator", "runs.approve")).toBe(true);
    expect(canRole("operator", "runs.abort")).toBe(true);
    expect(canRole("admin", "templates.apply")).toBe(true);
    expect(canRole("owner", "billing.manage")).toBe(true);
    expect(canRole("owner", "secrets.rotate")).toBe(true);
  });

  it("treats auth-disabled local mode as an implicit owner to preserve zero-config dev", () => {
    expect(requirePermission({ authEnabled: false }, "providers.secrets.write")).toMatchObject({
      ok: true,
      role: "owner",
    });
  });

  it("returns structured denials for central route guards", () => {
    const decision = requirePermission(
      { authEnabled: true, userId: "dev", workspaceId: "team", role: "developer" },
      "providers.secrets.write",
    );
    expect(decision).toMatchObject({
      ok: false,
      status: 403,
      permission: "providers.secrets.write",
      role: "developer",
      workspaceId: "team",
    });
  });

  it("fails closed when auth is enabled but no workspace role is assigned", () => {
    const decision = requirePermission(
      { authEnabled: true, userId: "viewer", workspaceId: "team" },
      "workspace.read",
    );

    expect(decision).toMatchObject({
      ok: false,
      status: 403,
      permission: "workspace.read",
      role: "viewer",
      workspaceId: "team",
    });
    expect(decision.reason).toContain("No workspace role");
  });

  it("exposes the role permission summary for the API", () => {
    expect(permissionsForRole("viewer")).toContain("workspace.read");
    expect(permissionsForRole("viewer")).not.toContain("billing.manage");
  });
});
