import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_EVAL_SCHEMA_VERSION,
  CapabilityEvalCaseSchema,
  CapabilityEvalResultSchema,
  type CapabilityEvalCase,
  type CapabilityEvalResult,
} from "../../src/capabilities/eval/schemas";

const sampleCase = {
  id: "case-cartographer-grounding-001",
  capabilityId: "cartographer.grounding",
  workspaceRef: "fixture://phase0/workspaces/cartographer-basic",
  request: {
    intent: "Find the cartographer schema definitions and cite the file that owns them.",
    scope: ["src/cartographer"],
    queryHints: ["CartographerScanEventSchema", "FileNodeSchema"],
  },
  oracle: {
    mustIncludePaths: ["src/cartographer/schemas.ts"],
    mustIncludeLineContains: ["export const CartographerScanEventSchema"],
    mustNotClaimPaths: ["src/providers/fakeProvider.ts"],
  },
};

const sampleResult = {
  caseId: sampleCase.id,
  capabilityId: sampleCase.capabilityId,
  passed: false,
  metricScores: {
    schema_valid: 1,
    recall: 0.8,
    omission: 0.1,
    secret_leak: 0,
    compression: 12,
    raw_token_reduction: 0.85,
    line_ref_accuracy: 0.9,
    root_cause_accuracy: 0.75,
  },
  omissions: ["Expected cartographer schema path was not cited."],
  rawArtifactRefs: ["artifact://phase0/case-cartographer-grounding-001/raw.json"],
  failureReason: "Missing required grounding citation.",
};

describe("Capability eval schemas", () => {
  it("parses valid case and result fixtures when all oracle fields are present", () => {
    // Given: deterministic offline fixtures for one capability eval case and its result.
    const caseFixture = sampleCase satisfies z.input<typeof CapabilityEvalCaseSchema>;
    const resultFixture = sampleResult satisfies z.input<typeof CapabilityEvalResultSchema>;

    // When: the schemas parse the fixtures at the eval-data boundary.
    const parsedCase = CapabilityEvalCaseSchema.parse(caseFixture);
    const parsedResult = CapabilityEvalResultSchema.parse(resultFixture);

    // Then: the parsed values preserve the public schema contract.
    expect(parsedCase).toEqual({ ...caseFixture, schemaVersion: CAPABILITY_EVAL_SCHEMA_VERSION } satisfies CapabilityEvalCase);
    expect(parsedResult).toEqual({ ...resultFixture, schemaVersion: CAPABILITY_EVAL_SCHEMA_VERSION } satisfies CapabilityEvalResult);
    expect(parsedCase.request.scope).toEqual(["src/cartographer"]);
    expect(parsedCase.oracle.mustIncludeLineContains).toEqual(["export const CartographerScanEventSchema"]);
    expect(parsedResult.metricScores.recall).toBe(0.8);
    expect(parsedResult.omissions).toEqual(["Expected cartographer schema path was not cited."]);
  });

  it("rejects a case missing the oracle block", () => {
    // Given: a malformed case with no oracle expectations.
    const { oracle: _oracle, ...caseWithoutOracle } = sampleCase;

    // When: the case is parsed at the schema boundary.
    const result = CapabilityEvalCaseSchema.safeParse(caseWithoutOracle);

    // Then: parsing fails instead of accepting an unverifiable eval case.
    expect(result.success).toBe(false);
  });

  it("reports clear paths when scope or line expectations are not arrays", () => {
    // Given: runtime inputs that violate the request scope and oracle line-list contracts.
    const malformedScopeCase: unknown = {
      ...sampleCase,
      request: {
        ...sampleCase.request,
        scope: "src/cartographer",
      },
    };
    const malformedLineCase: unknown = {
      ...sampleCase,
      oracle: {
        ...sampleCase.oracle,
        mustIncludeLineContains: "export const CartographerScanEventSchema",
      },
    };

    // When: the schema parses the malformed runtime values.
    const scopeResult = CapabilityEvalCaseSchema.safeParse(malformedScopeCase);
    const lineResult = CapabilityEvalCaseSchema.safeParse(malformedLineCase);

    // Then: Zod pinpoints the malformed field paths for fixture authors.
    expect(scopeResult.success).toBe(false);
    expect(lineResult.success).toBe(false);
    if (!scopeResult.success) {
      expect(scopeResult.error.issues.some((issue) => issue.path.join(".") === "request.scope")).toBe(true);
    }
    if (!lineResult.success) {
      expect(lineResult.error.issues.some((issue) => issue.path.join(".") === "oracle.mustIncludeLineContains")).toBe(true);
    }
  });
});
