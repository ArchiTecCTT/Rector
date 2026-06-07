// Unit tests for the workspace safety status builder (`buildWorkspaceSafetyResponse`).
//
// The builder is the pure, read-only core of `GET /api/setup/workspace` (Requirement 3). It reads
// configuration only and never executes a command, routes the workspace root through the
// Redaction_Layer (Req 3.7), and reports `available:false` when the root or policy cannot be
// retrieved (Req 3.8). These examples exercise the policy rendering and the unavailable state.
//
// Validates (by example): Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8

import { describe, expect, it } from "vitest";

import { buildWorkspaceSafetyResponse } from "../src/api/server";

describe("buildWorkspaceSafetyResponse", () => {
  it("renders the configured workspace root, allowlist, protection, and approval categories", () => {
    const response = buildWorkspaceSafetyResponse({
      workspaceRoot: "/srv/rector/workspace",
      allowlistedCommands: ["npm:build", "npm:test"],
      riskyCommands: [],
      destructiveProtectionEnabled: true,
    });

    expect(response.available).toBe(true);
    expect(response.workspaceRoot).toBe("/srv/rector/workspace");
    expect(response.allowlistedCommands).toEqual(["npm:build", "npm:test"]);
    expect(response.destructiveProtection).toBe("enabled");
    // FILE_WRITE always requires approval; COMMAND only when a risky command is configured.
    expect(response.approvalRequiredCategories).toEqual(["FILE_WRITE"]);
  });

  it("adds the COMMAND approval category when a risky command is configured", () => {
    const response = buildWorkspaceSafetyResponse({
      workspaceRoot: "/srv/rector/workspace",
      allowlistedCommands: ["git:push"],
      riskyCommands: ["git:push"],
    });

    expect(response.approvalRequiredCategories).toEqual(["FILE_WRITE", "COMMAND"]);
  });

  it("defaults destructive protection to enabled and the allowlist to empty", () => {
    const response = buildWorkspaceSafetyResponse({ workspaceRoot: "/workspace" });

    expect(response.available).toBe(true);
    expect(response.allowlistedCommands).toEqual([]);
    expect(response.destructiveProtection).toBe("enabled");
  });

  it("reports destructive protection disabled only when explicitly false", () => {
    const response = buildWorkspaceSafetyResponse({
      workspaceRoot: "/workspace",
      destructiveProtectionEnabled: false,
    });

    expect(response.destructiveProtection).toBe("disabled");
  });

  it("redacts secret material embedded in the workspace root (Req 3.7)", () => {
    const secret = "s3cr3t-token-value";
    const response = buildWorkspaceSafetyResponse({
      workspaceRoot: `https://user:${secret}@host/workspace`,
    });

    expect(response.available).toBe(true);
    expect(response.workspaceRoot).not.toContain(secret);
    expect(response.workspaceRoot).toContain("[REDACTED]");
  });

  it("returns an unavailable response when the workspace root is missing (Req 3.8)", () => {
    const response = buildWorkspaceSafetyResponse({});

    expect(response.available).toBe(false);
    expect(response.workspaceRoot).toBe("");
    expect(response.allowlistedCommands).toEqual([]);
    expect(response.approvalRequiredCategories).toEqual([]);
  });

  it("returns an unavailable response when the workspace root is blank (Req 3.8)", () => {
    const response = buildWorkspaceSafetyResponse({ workspaceRoot: "   " });

    expect(response.available).toBe(false);
  });
});
