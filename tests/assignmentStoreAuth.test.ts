import { describe, it, expect } from "vitest";
import {
  createInMemoryMemoryAssignmentStore,
  AuthorizingMemoryAssignmentStore,
  type MemoryAssignmentStore,
  type MemoryRoleAssignment,
} from "../src/providers/memoryAssignmentStore";
import {
  createInMemoryOrchestrationAssignmentStore,
  AuthorizingOrchestrationAssignmentStore,
  type OrchestrationAssignmentStore,
  type OrchestrationRole,
} from "../src/providers/orchestrationAssignments";
import type { AuthorizationSubject } from "../src/security/rbac";

function makeSubject(overrides: Partial<AuthorizationSubject> = {}): AuthorizationSubject {
  return {
    authEnabled: false,
    ...overrides,
  };
}

function makeMemoryAssignment(id: string): MemoryRoleAssignment {
  return {
    id,
    role: "conversationStore",
    providerRecordId: "local",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("AuthorizingMemoryAssignmentStore", () => {
  describe("read operations", () => {
    it("allows getState without subject", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const store = new AuthorizingMemoryAssignmentStore(inner, undefined);
      const state = await store.getState();
      expect(state).toBeDefined();
    });

    it("allows listAssignments with viewer role", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      await inner.upsertAssignment(makeMemoryAssignment("1"));
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      const assignments = await store.listAssignments();
      expect(assignments).toHaveLength(1);
    });
  });

  describe("mutation without subject", () => {
    it("allows upsert when no subject is provided", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const store = new AuthorizingMemoryAssignmentStore(inner, undefined);
      const result = await store.upsertAssignment(makeMemoryAssignment("1"));
      expect(result.ok).toBe(true);
    });

    it("allows remove when no subject is provided", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      await inner.upsertAssignment(makeMemoryAssignment("1"));
      const store = new AuthorizingMemoryAssignmentStore(inner, undefined);
      const result = await store.removeAssignment("1");
      expect(result.ok).toBe(true);
    });

    it("allows reset when no subject is provided", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      await inner.upsertAssignment(makeMemoryAssignment("1"));
      const store = new AuthorizingMemoryAssignmentStore(inner, undefined);
      const result = await store.resetAssignments();
      expect(result.ok).toBe(true);
    });
  });

  describe("mutation with auth disabled (local mode)", () => {
    it("allows upsert when authEnabled is false", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const subject = makeSubject({ authEnabled: false, role: "viewer" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      const result = await store.upsertAssignment(makeMemoryAssignment("1"));
      expect(result.ok).toBe(true);
    });
  });

  describe("mutation with auth enabled", () => {
    it("allows upsert for owner (has providers.configure)", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "owner" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      const result = await store.upsertAssignment(makeMemoryAssignment("1"));
      expect(result.ok).toBe(true);
    });

    it("allows upsert for admin (has providers.configure)", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "admin" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      const result = await store.upsertAssignment(makeMemoryAssignment("1"));
      expect(result.ok).toBe(true);
    });

    it("denies upsert for operator (no providers.configure)", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "operator" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      await expect(store.upsertAssignment(makeMemoryAssignment("1"))).rejects.toThrow(
        /providers\.configure/,
      );
    });

    it("denies remove for developer (no providers.configure)", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      await inner.upsertAssignment(makeMemoryAssignment("1"));
      const subject = makeSubject({ authEnabled: true, role: "developer" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      await expect(store.removeAssignment("1")).rejects.toThrow(
        /providers\.configure/,
      );
    });

    it("denies reset for viewer (no providers.configure)", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      await inner.upsertAssignment(makeMemoryAssignment("1"));
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      await expect(store.resetAssignments()).rejects.toThrow(
        /providers\.configure/,
      );
    });

    it("denies upsert when auth enabled but no role assigned", async () => {
      const inner = createInMemoryMemoryAssignmentStore();
      const subject = makeSubject({ authEnabled: true });
      const store = new AuthorizingMemoryAssignmentStore(inner, subject);
      await expect(store.upsertAssignment(makeMemoryAssignment("1"))).rejects.toThrow(
        /providers\.configure/,
      );
    });
  });
});

describe("AuthorizingOrchestrationAssignmentStore", () => {
  describe("read operations", () => {
    it("allows getState without subject", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const store = new AuthorizingOrchestrationAssignmentStore(inner, undefined);
      const state = await store.getState();
      expect(state).toBeDefined();
    });

    it("allows getAssignment with viewer role", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      const assignment = await store.getAssignment("planner" as OrchestrationRole);
      expect(assignment).toBeUndefined();
    });
  });

  describe("mutation without subject", () => {
    it("allows upsert when no subject is provided", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const store = new AuthorizingOrchestrationAssignmentStore(inner, undefined);
      const result = await store.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      expect(result.ok).toBe(true);
    });

    it("allows remove when no subject is provided", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      await inner.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, undefined);
      const result = await store.removeAssignment("planner" as OrchestrationRole);
      expect(result.ok).toBe(true);
    });

    it("allows reset when no subject is provided", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      await inner.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, undefined);
      const result = await store.resetAssignments();
      expect(result.ok).toBe(true);
    });
  });

  describe("mutation with auth disabled (local mode)", () => {
    it("allows upsert when authEnabled is false", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: false, role: "viewer" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      const result = await store.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("mutation with auth enabled", () => {
    it("allows upsert for owner (has providers.configure)", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "owner" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      const result = await store.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      expect(result.ok).toBe(true);
    });

    it("allows upsert for admin (has providers.configure)", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "admin" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      const result = await store.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      expect(result.ok).toBe(true);
    });

    it("denies upsert for operator (no providers.configure)", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: true, role: "operator" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      await expect(
        store.upsertAssignment("planner" as OrchestrationRole, {
          providerId: "deterministic",
        }),
      ).rejects.toThrow(/providers\.configure/);
    });

    it("denies remove for developer (no providers.configure)", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      await inner.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      const subject = makeSubject({ authEnabled: true, role: "developer" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      await expect(
        store.removeAssignment("planner" as OrchestrationRole),
      ).rejects.toThrow(/providers\.configure/);
    });

    it("denies reset for viewer (no providers.configure)", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      await inner.upsertAssignment("planner" as OrchestrationRole, {
        providerId: "deterministic",
      });
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      await expect(store.resetAssignments()).rejects.toThrow(/providers\.configure/);
    });

    it("denies upsert when auth enabled but no role assigned", async () => {
      const inner = createInMemoryOrchestrationAssignmentStore();
      const subject = makeSubject({ authEnabled: true });
      const store = new AuthorizingOrchestrationAssignmentStore(inner, subject);
      await expect(
        store.upsertAssignment("planner" as OrchestrationRole, {
          providerId: "deterministic",
        }),
      ).rejects.toThrow(/providers\.configure/);
    });
  });
});
