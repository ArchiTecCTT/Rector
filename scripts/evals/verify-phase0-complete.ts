#!/usr/bin/env tsx
/**
 * verify-phase0-complete.ts
 * Focused completion verifier for Phase 0 (capability evals).
 * Imports schemas + helpers; performs positive + negative validations; invokes gate.
 * Exits 1 with clear message on any unmet requirement.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EvalCorpusManifestSchema } from "../../tests/fixtures/eval-corpus/manifest.schema";
import {
  CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION,
  CapabilityEvidencePacketSchema,
} from "../../src/capabilities/eval/evidencePacket";
import { CapabilityEvalResultSchema } from "../../src/capabilities/eval/schemas";
import { getEvidenceTrackDir, getLegacyEvidenceRoot } from "../../src/evidence";
const PHASE_0_BASELINE_SCHEMA_VERSION = "rector.phase0-baseline.v1";

const REPO_ROOT = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const CORPUS_ROOT = process.env.VERIFY_CORPUS_ROOT || path.join(REPO_ROOT, "tests/fixtures/eval-corpus");
const EVIDENCE_DIR = getEvidenceTrackDir("phase0", REPO_ROOT);
const LEGACY_EVIDENCE_DIR = getLegacyEvidenceRoot(REPO_ROOT);

function fail(msg: string): never {
  console.error(`[verify:phase0] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd: string): { code: number; stdout: string; stderr: string } {
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function verifyManifestAndCases(): Promise<void> {
  if (!existsSync(path.join(CORPUS_ROOT, "manifest.json"))) fail("manifest.json missing");
  const manifestRaw = JSON.parse(readFileSync(path.join(CORPUS_ROOT, "manifest.json"), "utf8"));
  const manifest = EvalCorpusManifestSchema.parse(manifestRaw);
  if (manifest.cases.length < 10) fail(`corpus has only ${manifest.cases.length} cases (<10)`);
}

async function verifyMetricSchema(): Promise<void> {
  const badMetricMissing = { schema_valid: 1, recall: 1, omission: 0, secret_leak: 0, compression: 10, raw_token_reduction: 0.8, line_ref_accuracy: 1 /* root_cause_accuracy missing */ };
  const badMetricExtra = { schema_valid: 1, recall: 1, omission: 0, secret_leak: 0, compression: 10, raw_token_reduction: 0.8, line_ref_accuracy: 1, root_cause_accuracy: 1, extra: 1 };
  if (CapabilityEvalResultSchema.safeParse({ schemaVersion: "rector.capability-eval.v1", caseId: "x", capabilityId: "x", passed: true, metricScores: badMetricMissing, omissions: [], rawArtifactRefs: [] }).success) fail("metric schema accepted missing key");
  if (CapabilityEvalResultSchema.safeParse({ schemaVersion: "rector.capability-eval.v1", caseId: "x", capabilityId: "x", passed: true, metricScores: badMetricExtra, omissions: [], rawArtifactRefs: [] }).success) fail("metric schema accepted extra key");
}

async function verifyEvidencePacketSchema(): Promise<void> {
  const validEvidencePacket = {
    schemaVersion: CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION,
    capabilityId: "cartographer.grounding",
    caseId: "x",
    summary: "valid evidence packet fixture",
    evidence: [
      {
        kind: "summary",
        path: "cases/x/artifact.txt",
        lineStart: 1,
        lineEnd: 1,
        excerpt: "required anchor",
        relevance: "high",
        confidence: 0.95,
        rawArtifactRef: "artifact://x/artifact.txt",
      },
    ],
    coverage: {
      coveredMustContain: ["required anchor"],
      missingMustContain: [],
      forbiddenHits: [],
      unresolvedArtifactRefs: [],
      unresolvedFileRefs: [],
      outOfBoundsLineRefs: [],
      passed: true,
    },
    warnings: [],
    rawArtifactRefs: ["artifact://x/artifact.txt"],
  };
  if (!CapabilityEvidencePacketSchema.safeParse(validEvidencePacket).success) fail("valid evidence packet fixture did not parse");
  const badPacket1 = structuredClone(validEvidencePacket);
  badPacket1.evidence[0].rawArtifactRef = "";
  const badPacket2 = structuredClone(validEvidencePacket);
  badPacket2.evidence[0].lineStart = 5;
  badPacket2.evidence[0].lineEnd = 3;
  if (CapabilityEvidencePacketSchema.safeParse(badPacket1).success) fail("packet schema accepted empty rawArtifactRef");
  if (CapabilityEvidencePacketSchema.safeParse(badPacket2).success) fail("packet schema accepted invalid line range");
}

async function verifyGate(): Promise<void> {
  const gate = run("npm run eval:capabilities:gate");
  if (gate.code !== 0) fail(`eval:capabilities:gate exited ${gate.code} (expected 0)`);
}

async function verifyBaseline(): Promise<void> {
  let baselinePath = resolveBaselinePath();
  if (!existsSync(baselinePath)) {
    if (process.env.RECTOR_BASELINE_ACTIVE === "1") {
      fail("REENTRANCY GUARD: baseline missing while RECTOR_BASELINE_ACTIVE=1; refusing recursive generation");
    }
    const gen = run("npm run baseline:phase0");
    if (gen.code !== 0) fail(`baseline:phase0 exited ${gen.code} (expected 0)`);
    baselinePath = resolveBaselinePath();
  }
  if (!existsSync(baselinePath)) fail("phase0-baseline.json missing after generation attempt");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.schemaVersion !== PHASE_0_BASELINE_SCHEMA_VERSION) fail("baseline schemaVersion mismatch");
}

function resolveBaselinePath(): string {
  const primaryPath = path.join(EVIDENCE_DIR, "phase0-baseline.json");
  if (existsSync(primaryPath)) return primaryPath;
  const legacyPath = path.join(LEGACY_EVIDENCE_DIR, "phase0-baseline.json");
  if (existsSync(legacyPath)) return legacyPath;
  return primaryPath;
}

async function main() {
  await verifyManifestAndCases();
  await verifyMetricSchema();
  await verifyEvidencePacketSchema();
  await verifyGate();
  await verifyBaseline();

  console.log("[verify:phase0] PASS");
  process.exit(0);
}

main().catch((e) => fail(String(e)));
