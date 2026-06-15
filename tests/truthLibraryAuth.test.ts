import { describe, it, expect } from "vitest";
import {
  InMemoryTruthLibrary,
  authorizingTruthLibrary,
  AuthorizationError,
  type TruthLibrary,
  type TruthItemUpsert,
} from "../src/memory/truthLibrary";
import type { AuthorizationSubject } from "../src/security/rbac";

function makeSubject(overrides: Partial<AuthorizationSubject> = {}): AuthorizationSubject {
  return {
    authEnabled: false,
    ...overrides,
  };
}

function makeItem(id: string, title = `Test ${id}`): TruthItemUpsert {
  return {
    id,
    kind: "memory",
    title,
    content: `Content for ${title}`,
    status: "TRUSTED",
    provenance: { source: "test", sourceType: "manual" },
  };
}

describe("authorizingTruthLibrary", () => {
  describe("read operations", () => {
    it("allows search without subject", () => {
      const inner = new InMemoryTruthLibrary();
      inner.upsert(makeItem("1"));
      const library = authorizingTruthLibrary(inner as TruthLibrary, undefined);
      const results = library.search({ query: "Test" });
      expect(results).toHaveLength(1);
    });

    it("allows search with any subject regardless of role", () => {
      const inner = new InMemoryTruthLibrary();
      inner.upsert(makeItem("1"));
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const results = library.search({ query: "Test" });
      expect(results).toHaveLength(1);
    });
  });

  describe("mutation without subject", () => {
    it("allows upsert when no subject is provided (backward compat)", () => {
      const inner = new InMemoryTruthLibrary();
      const library = authorizingTruthLibrary(inner as TruthLibrary, undefined);
      const item = library.upsert(makeItem("1"));
      expect(item.id).toBe("1");
    });
  });

  describe("mutation with auth disabled (local mode)", () => {
    it("allows upsert when authEnabled is false", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: false, role: "viewer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const item = library.upsert(makeItem("1"));
      expect(item.id).toBe("1");
    });

    it("allows upsert when authEnabled is false even without role", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: false });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const item = library.upsert(makeItem("1"));
      expect(item.id).toBe("1");
    });
  });

  describe("mutation with auth enabled", () => {
    it("allows upsert for owner role (has truth.mutate)", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "owner" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const item = library.upsert(makeItem("1"));
      expect(item.id).toBe("1");
    });

    it("allows upsert for admin role (has truth.mutate)", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "admin" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const item = library.upsert(makeItem("1"));
      expect(item.id).toBe("1");
    });

    it("denies upsert for operator role (no truth.mutate)", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "operator" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      expect(() => library.upsert(makeItem("1"))).toThrow(AuthorizationError);
    });

    it("denies upsert for developer role (no truth.mutate)", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "developer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      expect(() => library.upsert(makeItem("1"))).toThrow(AuthorizationError);
    });

    it("denies upsert for viewer role (no truth.mutate)", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      expect(() => library.upsert(makeItem("1"))).toThrow(AuthorizationError);
    });

    it("error includes permission name and role", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      try {
        library.upsert(makeItem("1"));
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
        const authErr = error as AuthorizationError;
        expect(authErr.permission).toBe("truth.mutate");
        expect(authErr.message).toContain("viewer");
        expect(authErr.message).toContain("truth.mutate");
      }
    });

    it("denies upsert when auth enabled but no role assigned", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      expect(() => library.upsert(makeItem("1"))).toThrow(AuthorizationError);
    });
  });

  describe("decoration passthrough", () => {
    it("search returns same results as inner library", () => {
      const inner = new InMemoryTruthLibrary();
      inner.upsert(makeItem("1", "Alpha"));
      inner.upsert(makeItem("2", "Beta"));
      const subject = makeSubject({ authEnabled: true, role: "viewer" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      const results = library.search({ query: "Alpha" });
      expect(results).toHaveLength(1);
      expect(results[0].item.id).toBe("1");
    });

    it("upsert delegates to inner library after auth check", () => {
      const inner = new InMemoryTruthLibrary();
      const subject = makeSubject({ authEnabled: true, role: "owner" });
      const library = authorizingTruthLibrary(inner as TruthLibrary, subject);
      library.upsert(makeItem("1", "Alpha"));
      // Verify it was actually stored in the inner library
      const results = inner.search({ query: "Alpha" });
      expect(results).toHaveLength(1);
    });
  });
});
