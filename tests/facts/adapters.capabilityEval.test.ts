import { describe, expect, it } from "vitest";

import { capabilityEvalResultToFacts, capabilityEvidencePacketToFacts, RectorFactSchema } from "../../src/facts";
import type { CapabilityEvidencePacket } from "../../src/capabilities/eval/evidencePacket";
import type { CapabilityEvalCase, CapabilityEvalResult } from "../../src/capabilities/eval/schemas";

const OPTIONS = { runId: "run-capability", createdAt: "2026-06-28T00:00:00.000Z" };

const evalCase: CapabilityEvalCase = {
  schemaVersion: "rector.capability-eval.v1",
  id: "case-search-1",
  capabilityId: "capability.search",
  workspaceRef: "fixture://repo",
  request: { intent: "Find parser", scope: ["src/parser.ts"], queryHints: ["parse"] },
  oracle: { mustIncludePaths: ["src/parser.ts"], mustIncludeLineContains: ["parse"], mustNotClaimPaths: ["src/missing.ts"] },
};

const metricScores: CapabilityEvalResult["metricScores"] = {
  schema_valid: 1,
  recall: 0.5,
  omission: 1,
  secret_leak: 1,
  compression: 0.8,
  raw_token_reduction: 0.8,
  line_ref_accuracy: 0.5,
  root_cause_accuracy: 0.5,
};

function expectValidFacts(facts: readonly unknown[]) {
  for (const fact of facts) expect(RectorFactSchema.safeParse(fact).success).toBe(true);
}

describe("capability eval fact adapter", () => {
  it("references raw artifacts and preserves omissions as explicit facts", () => {
    const result: CapabilityEvalResult = {
      schemaVersion: "rector.capability-eval.v1",
      caseId: evalCase.id,
      capabilityId: evalCase.capabilityId,
      passed: false,
      metricScores,
      omissions: ["src/parser.ts:missing line span"],
      rawArtifactRefs: ["artifact://case-search-1/rg.json"],
      failureReason: "missing required path",
    };

    const facts = capabilityEvalResultToFacts({ caseInput: evalCase, result, options: OPTIONS });

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "capability_request" && fact.requestId === "case-search-1")).toBe(true);
    const evidence = facts.find((fact) => fact.kind === "capability_evidence");
    expect(evidence?.kind).toBe("capability_evidence");
    if (evidence?.kind === "capability_evidence") expect(evidence.evidence[0]).toMatchObject({ refType: "artifact", uri: "artifact://case-search-1/rg.json" });
    expect(facts.some((fact) => fact.kind === "capability_warning" && fact.warning.includes("missing line span"))).toBe(true);
    expect(facts.some((fact) => fact.kind === "capability_failure" && fact.trust.level === "rejected")).toBe(true);
  });

  it("emits insufficient_evidence when eval result has no raw artifact refs", () => {
    const result: CapabilityEvalResult = {
      schemaVersion: "rector.capability-eval.v1",
      caseId: evalCase.id,
      capabilityId: evalCase.capabilityId,
      passed: false,
      metricScores,
      omissions: [],
      rawArtifactRefs: [],
      failureReason: "runner skipped before artifacts",
    };

    const facts = capabilityEvalResultToFacts({ result, options: OPTIONS });

    expectValidFacts(facts);
    const evidence = facts.find((fact) => fact.kind === "capability_evidence");
    expect(evidence?.kind).toBe("capability_evidence");
    if (evidence?.kind === "capability_evidence") {
      expect(evidence.trust.level).toBe("insufficient_evidence");
      expect(evidence.evidence[0]).toMatchObject({ refType: "insufficient_evidence" });
    }
  });

  it("converts evidence packet path spans and artifacts into capability evidence refs", () => {
    const packet: CapabilityEvidencePacket = {
      schemaVersion: "rector.capability.evidence.v1",
      capabilityId: "capability.search",
      caseId: "case-search-1",
      summary: "Parser found",
      evidence: [{ kind: "code_reference", path: "src/parser.ts", lineStart: 3, lineEnd: 5, excerpt: "parse", relevance: "high", confidence: 0.9, rawArtifactRef: "artifact://case-search-1/rg.json" }],
      coverage: { coveredMustContain: ["parse"], missingMustContain: [], forbiddenHits: [], unresolvedArtifactRefs: [], unresolvedFileRefs: [], outOfBoundsLineRefs: [], passed: true },
      warnings: [],
      rawArtifactRefs: ["artifact://case-search-1/rg.json"],
    };

    const facts = capabilityEvidencePacketToFacts(packet, OPTIONS);

    expectValidFacts(facts);
    const evidence = facts.find((fact) => fact.kind === "capability_evidence");
    expect(evidence?.kind).toBe("capability_evidence");
    if (evidence?.kind === "capability_evidence") {
      expect(evidence.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ refType: "source_span", path: "src/parser.ts", startLine: 3, endLine: 5 }),
        expect.objectContaining({ refType: "artifact", uri: "artifact://case-search-1/rg.json" }),
      ]));
    }
  });
});
