import { describe, expect, it } from "vitest";
import { createInMemoryAuditLogService, hashAuditValue } from "../src/security/auditLog";

describe("Audit log service", () => {
  it("records security-relevant events without exposing raw network identifiers", async () => {
    const audit = createInMemoryAuditLogService({ now: () => "2026-06-12T00:00:00.000Z" });
    const ipHash = hashAuditValue("203.0.113.10");
    const uaHash = hashAuditValue("unit-test-agent");

    const event = await audit.record({
      workspaceId: "team",
      actorUserId: "alice",
      action: "provider.secret.write",
      targetType: "provider",
      targetId: "provider-1",
      outcome: "success",
      ipHash,
      userAgentHash: uaHash,
    });

    expect(event).toMatchObject({
      workspaceId: "team",
      actorUserId: "alice",
      action: "provider.secret.write",
      outcome: "success",
      ipHash,
      userAgentHash: uaHash,
    });
    expect(event.ipHash).not.toBe("203.0.113.10");
    expect(event.userAgentHash).not.toBe("unit-test-agent");
  });

  it("filters by workspace and outcome", async () => {
    const audit = createInMemoryAuditLogService();
    await audit.record({ workspaceId: "a", action: "quota.denied", targetType: "quota", outcome: "denied" });
    await audit.record({ workspaceId: "b", action: "auth.login", targetType: "user", outcome: "success" });

    const deniedA = await audit.list({ workspaceId: "a", outcome: "denied" });
    expect(deniedA).toHaveLength(1);
    expect(deniedA[0].action).toBe("quota.denied");
  });
});
