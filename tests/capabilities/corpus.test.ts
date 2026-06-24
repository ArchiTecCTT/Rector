import { readFile } from "node:fs/promises";
import { ok } from "node:assert/strict";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { redactString } from "../../src/security/redaction";
import {
  EvalCorpusCaseSchema,
  EvalCorpusManifestSchema,
  EvalCorpusOracleSchema,
  expectedToolForArtifact,
  type EvalCorpusArtifactKind,
  type EvalCorpusManifest,
} from "../fixtures/eval-corpus/manifest.schema";

const corpusRoot = new URL("../fixtures/eval-corpus/", import.meta.url);

const REQUIRED_ARTIFACT_KINDS = [
  "rg_output",
  "tsc_no_emit_error",
  "git_diff",
  "test_log",
  "fake_audit_report",
  "package_diagnostic",
  "cartographer_inventory",
] as const satisfies readonly EvalCorpusArtifactKind[];

async function readCorpusText(relativePath: string): Promise<string> {
  return readFile(join(corpusRoot.pathname, relativePath), "utf8");
}

async function readCorpusJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readCorpusText(relativePath));
}

async function loadManifest(): Promise<EvalCorpusManifest> {
  return EvalCorpusManifestSchema.parse(await readCorpusJson("manifest.json"));
}

function countArtifactLines(text: string): number {
  return text.trimEnd().split("\n").length;
}

describe("phase-0 eval corpus fixtures", () => {
  it("validates the manifest and covers required real artifact classes", async () => {
    // Given: the offline eval-corpus manifest committed with the phase-0 fixtures.
    const manifest = await loadManifest();

    // When: callers inspect the manifest artifact classes and command-tool mapping.
    const artifactKinds = manifest.cases.map((fixtureCase) => fixtureCase.artifactKind);
    const uniqueArtifactKinds = new Set(artifactKinds);

    // Then: all required benchmark artifact kinds are present once and mapped to real tools.
    expect(manifest.schemaVersion).toBe("phase0.eval-corpus.v1");
    expect(manifest.cases.length).toBeGreaterThanOrEqual(10);
    expect(uniqueArtifactKinds.size).toBe(REQUIRED_ARTIFACT_KINDS.length);
    for (const requiredKind of REQUIRED_ARTIFACT_KINDS) {
      expect(artifactKinds).toContain(requiredKind);
    }
    for (const fixtureCase of manifest.cases) {
      expect(fixtureCase.generatedFrom.tool).toBe(expectedToolForArtifact(fixtureCase.artifactKind));
    }
  });

  it("keeps every case backed by a recorded command, real artifact, oracle, and inputs", async () => {
    // Given: a schema-valid manifest describing the phase-0 corpus cases.
    const manifest = await loadManifest();

    for (const fixtureCase of manifest.cases) {
      // When: the case files are loaded from disk and the oracle is parsed at the boundary.
      const command = await readCorpusText(fixtureCase.commandPath);
      const artifact = await readCorpusText(fixtureCase.artifactPath);
      const oracle = EvalCorpusOracleSchema.parse(await readCorpusJson(fixtureCase.oraclePath));
      const inputTexts = await Promise.all(fixtureCase.inputPaths.map((inputPath) => readCorpusText(inputPath)));

      // Then: the deterministic oracle matches the recorded real command artifact.
      expect(command.trimEnd()).toBe(fixtureCase.generatedFrom.recordedCommand);
      expect(oracle.caseId).toBe(fixtureCase.id);
      expect(oracle.artifactKind).toBe(fixtureCase.artifactKind);
      expect(oracle.expectedExitCode).toBe(fixtureCase.generatedFrom.exitCode);
      expect(countArtifactLines(artifact)).toBe(oracle.expectedLineCount);
      expect(inputTexts.every((inputText) => inputText.trim().length > 0)).toBe(true);
      for (const expectedText of oracle.mustContain) {
        expect(artifact).toContain(expectedText);
      }
      for (const forbiddenText of oracle.mustNotContain) {
        expect(artifact).not.toContain(forbiddenText);
      }
      expect(redactString(artifact)).toBe(artifact);
    }
  });

  it("rejects case entries that escape the eval-corpus root", async () => {
    // Given: a valid manifest case with one path replaced by an attempted parent-directory escape.
    const manifest = await loadManifest();
    const firstCase = manifest.cases[0];
    ok(firstCase);
    const escapingCase = {
      ...firstCase,
      artifactPath: "../outside.txt",
    };

    // When: the case is parsed by the same boundary schema used by the manifest.
    const result = EvalCorpusCaseSchema.safeParse(escapingCase);

    // Then: path traversal is rejected before any fixture loader can read it.
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with duplicate case ids", async () => {
    // Given: a valid manifest whose second case id is changed to duplicate the first.
    const manifest = await loadManifest();
    const [firstCase, secondCase] = manifest.cases;
    ok(firstCase);
    ok(secondCase);
    const duplicateIdManifest = {
      ...manifest,
      cases: [firstCase, { ...secondCase, id: firstCase.id }],
    };

    // When: the manifest is parsed by the boundary schema enforcing unique ids.
    const result = EvalCorpusManifestSchema.safeParse(duplicateIdManifest);

    // Then: duplicate ids are rejected before the corpus can be loaded.
    expect(result.success).toBe(false);
  });
});
