import { describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  FactProvenanceSchema,
  InsufficientEvidenceSchema,
  ValidationRefSchema,
  artifactProvenance,
  artifactRef,
  capabilityEvalProvenance,
  graphProvenance,
  graphRef,
  insufficientEvidence,
  toolCallProvenance,
  validationProvenance,
  validationRef,
} from "../../src/facts";

describe("fact provenance contracts", () => {
  it("creates artifact, graph, and validation refs with strict shapes", () => {
    const artifact = artifactRef({ uri: "artifact://call-1/rg.txt", sha256: "a".repeat(64), contentType: "text/plain", sizeBytes: 12 });
    const graph = graphRef({ snapshotId: "snap-1", nodeId: "file:src/facts/schemas.ts", queryStatus: "ok" });
    const validation = validationRef({ validationId: "schema-1", validator: "zod", status: "passed" });

    expect(ArtifactRefSchema.safeParse(artifact).success).toBe(true);
    expect(ValidationRefSchema.safeParse(validation).success).toBe(true);
    expect(graph.refType).toBe("graph");
    expect(graph.snapshotId).toBe("snap-1");
  });

  it("rejects malformed artifact hashes and unknown provenance fields", () => {
    expect(ArtifactRefSchema.safeParse({ refType: "artifact", uri: "artifact://x/y", sha256: "not-sha" }).success).toBe(false);
    expect(FactProvenanceSchema.safeParse({ sourceType: "system", systemId: "s", extra: true }).success).toBe(false);
  });

  it("builds typed provenance variants for current Phase 2A sources", () => {
    const artifact = artifactRef({ uri: "artifact://call-1/result.txt" });
    const graph = graphRef({ snapshotId: "snap-1", edgeId: "edge:CALLS:a:b" });
    const validation = validationRef({ validationId: "scope-check", validator: "scope", status: "failed" });

    const variants = [
      artifactProvenance({ artifact }),
      graphProvenance(graph),
      validationProvenance(validation),
      toolCallProvenance({ toolName: "rg", callId: "call-1", artifact }),
      capabilityEvalProvenance({ capabilityId: "capability.grounding", caseId: "case-1", artifact }),
    ];

    expect(variants.every((variant) => FactProvenanceSchema.safeParse(variant).success)).toBe(true);
  });

  it("represents insufficient evidence explicitly", () => {
    const insufficient = insufficientEvidence({ reason: "No source span in artifact", missing: ["lineStart", "lineEnd"], searched: ["artifact://call-1/rg.txt"] });

    expect(InsufficientEvidenceSchema.safeParse(insufficient).success).toBe(true);
    expect(insufficient.refType).toBe("insufficient_evidence");
    expect(insufficient.missing).toEqual(["lineStart", "lineEnd"]);
  });
});
