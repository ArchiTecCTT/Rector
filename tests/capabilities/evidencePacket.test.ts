import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION,
  CapabilityEvidenceItemSchema,
  CapabilityEvidencePacketSchema,
  validateEvidenceCoverage,
  type CapabilityCoverage,
  type CapabilityEvidenceItem,
  type CapabilityEvidencePacket,
} from "../../src/capabilities/eval/evidencePacket";

function validCoverage(passed = true): CapabilityCoverage {
  return {
    coveredMustContain: passed ? ["expected-evidence-anchor"] : [],
    missingMustContain: passed ? [] : ["expected-evidence-anchor"],
    forbiddenHits: [],
    unresolvedArtifactRefs: [],
    unresolvedFileRefs: [],
    outOfBoundsLineRefs: [],
    passed,
  };
}

function validItem(overrides: Partial<CapabilityEvidenceItem> = {}): CapabilityEvidenceItem {
  return {
    kind: "code_reference",
    relevance: "high",
    confidence: 0.9,
    rawArtifactRef: "artifact://offline/case-rg-orchestration-search/artifact.txt",
    excerpt: "expected-evidence-anchor present in the artifact",
    ...overrides,
  };
}

function validPacket(overrides: Partial<CapabilityEvidencePacket> = {}): CapabilityEvidencePacket {
  return {
    schemaVersion: CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION,
    capabilityId: "cartographer.grounding",
    summary: "Packet cites the orchestration grounding anchor.",
    evidence: [validItem()],
    coverage: validCoverage(true),
    warnings: [],
    rawArtifactRefs: ["artifact://offline/case-rg-orchestration-search/artifact.txt"],
    ...overrides,
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rector-evidence-packet-"));
  tempRoots.push(root);
  return root;
}

describe("capability evidence item schema", () => {
  it("parses a well-formed evidence item", () => {
    const item = validItem({ path: "src/notes.md", lineStart: 1, lineEnd: 2, symbol: "CartographerScanEventSchema" });

    const result = CapabilityEvidenceItemSchema.safeParse(item);

    expect(result.success).toBe(true);
  });

  it("rejects an evidence item with an empty rawArtifactRef", () => {
    const item = validItem({ rawArtifactRef: "" });

    const result = CapabilityEvidenceItemSchema.safeParse(item);

    expect(result.success).toBe(false);
  });

  it("rejects an evidence item with lineEnd less than lineStart", () => {
    const item = validItem({ path: "src/notes.md", lineStart: 5, lineEnd: 3 });

    const result = CapabilityEvidenceItemSchema.safeParse(item);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "lineEnd")).toBe(true);
    }
  });

  it("rejects an evidence item with lineStart but no lineEnd (half range)", () => {
    const item = validItem({ path: "src/notes.md", lineStart: 5 });

    const result = CapabilityEvidenceItemSchema.safeParse(item);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "lineStart")).toBe(true);
    }
  });

  it("rejects an evidence item with confidence greater than 1", () => {
    const item = validItem({ confidence: 1.5 });

    const result = CapabilityEvidenceItemSchema.safeParse(item);

    expect(result.success).toBe(false);
  });

  it("rejects an evidence item with an unknown kind or extra key", () => {
    const itemWithExtraKind = validItem({ kind: "bogus_kind" as never });
    const itemWithExtraKey = { ...validItem(), unexpected: "field" };

    expect(CapabilityEvidenceItemSchema.safeParse(itemWithExtraKind).success).toBe(false);
    expect(CapabilityEvidenceItemSchema.safeParse(itemWithExtraKey).success).toBe(false);
  });
});

describe("capability evidence packet schema", () => {
  it("parses a well-formed packet and defaults warnings to an empty array", () => {
    const { warnings: _warnings, ...packetWithoutWarnings } = validPacket();

    const result = CapabilityEvidencePacketSchema.safeParse(packetWithoutWarnings);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toEqual([]);
      expect(result.data.schemaVersion).toBe(CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION);
    }
  });

  it("rejects a packet missing the coverage block", () => {
    const { coverage: _coverage, ...packetWithoutCoverage } = validPacket();

    const result = CapabilityEvidencePacketSchema.safeParse(packetWithoutCoverage);

    expect(result.success).toBe(false);
  });
});

describe("validateEvidenceCoverage", () => {
  it("passes when every mustContain is represented by an evidence item, refs resolve, and no forbidden content appears", async () => {
    const packet = validPacket({
      evidence: [
        validItem({ excerpt: "expected-evidence-anchor present in the artifact" }),
        validItem({ rawArtifactRef: "artifact://offline/case-extra/extra.txt", excerpt: "another anchor" }),
      ],
      rawArtifactRefs: [
        "artifact://offline/case-rg-orchestration-search/artifact.txt",
        "artifact://offline/case-extra/extra.txt",
      ],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: ["api_key=", "Bearer "] };
    const context = {
      rawArtifactRefs: new Set<string>([
        "artifact://offline/case-rg-orchestration-search/artifact.txt",
        "artifact://offline/case-extra/extra.txt",
      ]),
    };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(true);
    expect(result.coverage.coveredMustContain).toContain("expected-evidence-anchor");
    expect(result.coverage.missingMustContain).toEqual([]);
    expect(result.coverage.forbiddenHits).toEqual([]);
  });

  it("fails a too-small incomplete packet that omits a required mustContain even though compression would be high", async () => {
    // A tiny packet with high compression (huge raw artifact vs tiny evidence) but whose single
    // evidence item does NOT carry the oracle's required mustContain anchor.
    const packet = validPacket({
      evidence: [validItem({ excerpt: "unrelated noise that compresses well" })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = { rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]) };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.missingMustContain).toContain("expected-evidence-anchor");
    expect(result.coverage.coveredMustContain).toEqual([]);
  });

  it("fails when forbidden mustNotContain content appears in an evidence excerpt", async () => {
    const packet = validPacket({
      evidence: [validItem({ excerpt: "expected-evidence-anchor plus api_key=sk-leaked" })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: ["api_key="] };
    const context = { rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]) };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.forbiddenHits).toContain("api_key=");
  });

  it("fails when an evidence rawArtifactRef is not in the supplied ref set", async () => {
    const packet = validPacket({
      evidence: [validItem({ rawArtifactRef: "artifact://offline/fabricated/ref.txt" })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = { rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]) };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.unresolvedArtifactRefs).toContain("artifact://offline/fabricated/ref.txt");
  });

  it("fails when a packet-level rawArtifactRef is not in the supplied ref set", async () => {
    const packet = validPacket({
      rawArtifactRefs: [
        "artifact://offline/case-rg-orchestration-search/artifact.txt",
        "artifact://offline/another-fabricated/ref.txt",
      ],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = { rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]) };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.unresolvedArtifactRefs).toContain("artifact://offline/another-fabricated/ref.txt");
  });

  it("resolves a real file/line ref under fixtureRoot and passes when in bounds", async () => {
    const fixtureRoot = await tempFixtureRoot();
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "src", "notes.md"), "line one\nline two\nline three\n", "utf8");
    const packet = validPacket({
      evidence: [
        validItem({
          excerpt: "expected-evidence-anchor",
          path: "src/notes.md",
          lineStart: 1,
          lineEnd: 3,
        }),
      ],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = {
      rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]),
      fixtureRoot,
    };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(true);
    expect(result.coverage.unresolvedFileRefs).toEqual([]);
    expect(result.coverage.outOfBoundsLineRefs).toEqual([]);
  });

  it("records an unresolved file ref when the evidence path does not exist under fixtureRoot", async () => {
    const fixtureRoot = await tempFixtureRoot();
    const packet = validPacket({
      evidence: [validItem({ excerpt: "expected-evidence-anchor", path: "src/missing.md", lineStart: 1, lineEnd: 1 })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = {
      rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]),
      fixtureRoot,
    };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.unresolvedFileRefs).toContain("src/missing.md");
  });

  it("records an out-of-bounds line ref when the line range exceeds the file's line count", async () => {
    const fixtureRoot = await tempFixtureRoot();
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "src", "notes.md"), "only line one\n", "utf8");
    const packet = validPacket({
      evidence: [validItem({ excerpt: "expected-evidence-anchor", path: "src/notes.md", lineStart: 1, lineEnd: 9 })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = {
      rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]),
      fixtureRoot,
    };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.outOfBoundsLineRefs.some((entry) => entry.startsWith("src/notes.md:"))).toBe(true);
  });

  it("rejects a path-traversal evidence path as an unresolved file ref without following it", async () => {
    const fixtureRoot = await tempFixtureRoot();
    await writeFile(path.join(fixtureRoot, "secret.txt"), "top secret\n", "utf8");
    const packet = validPacket({
      evidence: [validItem({ excerpt: "expected-evidence-anchor", path: "../secret.txt", lineStart: 1, lineEnd: 1 })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = {
      rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]),
      fixtureRoot,
    };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(false);
    expect(result.coverage.unresolvedFileRefs).toContain("../secret.txt");
  });

  it("skips file resolution when no fixtureRoot is supplied even if paths are present", async () => {
    const packet = validPacket({
      evidence: [validItem({ excerpt: "expected-evidence-anchor", path: "src/notes.md", lineStart: 1, lineEnd: 2 })],
    });
    const oracle = { mustContain: ["expected-evidence-anchor"], mustNotContain: [] };
    const context = { rawArtifactRefs: new Set<string>(["artifact://offline/case-rg-orchestration-search/artifact.txt"]) };

    const result = await validateEvidenceCoverage(packet, oracle, context);

    expect(result.passed).toBe(true);
    expect(result.coverage.unresolvedFileRefs).toEqual([]);
  });
});