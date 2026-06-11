// Smoke / doc-structure test for the Regional_Discovery architecture document
// (docs/architecture/regional-discovery.md, authored by task 14.1).
//
// This is a pure document-structure test: it reads the version-controlled
// design-only Markdown file from disk and asserts that every item the
// requirements mandate is present. It makes ZERO network and ZERO provider
// calls — it only reads a tracked file.
//
// Validates: Requirements 25.1, 25.2, 25.3, 25.4, 25.5
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DOC_PATH = fileURLToPath(
  new URL("../docs/architecture/regional-discovery.md", import.meta.url),
);
const doc = readFileSync(DOC_PATH, "utf8");
const lowerDoc = doc.toLowerCase();

describe("Regional_Discovery doc structure", () => {
  it("declares itself documentation/scaffolding that does not block the foundation", () => {
    expect(lowerDoc).toContain("documentation and scaffolding");
    expect(lowerDoc).toMatch(/does\s*\*{0,2}not\*{0,2}\s*block/i);
  });

  // Requirement 25.1: explain the distinction between Azure data-plane model
  // listing and Azure management-plane deployment discovery.
  describe("Azure data-plane vs management-plane distinction (Req 25.1)", () => {
    it("names both planes", () => {
      expect(lowerDoc).toContain("data plane");
      expect(lowerDoc).toContain("management plane");
    });

    it("ties the management plane to deployment discovery/enumeration", () => {
      expect(lowerDoc).toMatch(/management plane[\s\S]{0,400}deployment/i);
    });

    it("ties the data plane to catalog/model listing", () => {
      expect(lowerDoc).toMatch(/data plane[\s\S]{0,400}(catalog|model list|models)/i);
    });
  });

  // Requirement 25.2: record the Azure management-plane configuration fields
  // required for future Regional_Discovery.
  describe("Azure management-plane configuration fields (Req 25.2)", () => {
    const requiredFields: Array<[string, RegExp]> = [
      ["subscriptionId", /subscriptionId/],
      ["resourceGroup", /resourceGroup/],
      ["accountName", /accountName/],
      ["location", /location/],
      ["deployment name", /deployment name/i],
      ["model name and version", /model name and version/i],
      ["SKU or provisioning state", /SKU or provisioning state/i],
    ];

    it.each(requiredFields)("documents the '%s' field", (_label, pattern) => {
      expect(doc).toMatch(pattern);
    });
  });

  // Requirement 25.3: record the AWS Bedrock discovery design notes.
  describe("AWS Bedrock discovery notes (Req 25.3)", () => {
    it("references the region-first ListFoundationModels call", () => {
      expect(doc).toMatch(/ListFoundationModels/);
      expect(lowerDoc).toMatch(/region[-\s]?(first|scoped)/i);
    });

    it("references the GetFoundationModelAvailability readiness check", () => {
      expect(doc).toMatch(/GetFoundationModelAvailability/);
      expect(lowerDoc).toContain("readiness");
    });

    it("references inference-profile cross-region routing", () => {
      expect(lowerDoc).toMatch(/inference[-\s]profile/i);
      expect(lowerDoc).toMatch(/cross[-\s]region/i);
    });
  });

  // Requirement 25.4: record a data-residency and IAM warning for Bedrock
  // cross-region inference profiles.
  describe("data-residency and IAM warning (Req 25.4)", () => {
    it("warns about data residency", () => {
      expect(lowerDoc).toContain("data residency");
      expect(lowerDoc).toContain("warning");
    });

    it("warns about IAM permissions across profile regions", () => {
      expect(doc).toMatch(/IAM/);
      expect(lowerDoc).toMatch(/iam[\s\S]{0,400}region/i);
    });
  });

  // Requirement 25.5: note that Bedrock may require a separate future
  // Discovery_Adapter.
  it("notes Bedrock may require a separate future Discovery_Adapter (Req 25.5)", () => {
    expect(doc).toMatch(/separate[\s\S]{0,80}Discovery_Adapter/i);
    expect(lowerDoc).toMatch(/bedrock[\s\S]{0,400}separate[\s\S]{0,120}adapter/i);
  });
});
