import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ORCHESTRATION_ROLES,
  resolveEffectiveAssignment,
  type OrchestrationRole,
} from "../src/providers/orchestrationAssignments";

describe("orchestration assignment local-mode invariants", () => {
  it("property: zero providers always resolves to deterministic/disabled local routes without secrets or network state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORCHESTRATION_ROLES),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        (role: OrchestrationRole, userId, workspaceId) => {
          const effective = resolveEffectiveAssignment({
            role,
            providerState: { version: 1, providers: [], activeRoutes: {} },
            scope: {
              ...(userId ? { userId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
            },
          });

          expect(["deterministic", "disabled"]).toContain(effective.providerId);
          expect(effective.budgetProjection.estimatedUsdPerCall).toBe(0);
          expect(effective.capabilities.costTier).toBe("free");
          const serialized = JSON.stringify(effective);
          expect(serialized).not.toContain("apiKey");
          expect(serialized).not.toContain("secretRef");
          expect(serialized).not.toContain("Authorization");
        },
      ),
      { numRuns: 50 },
    );
  });
});
