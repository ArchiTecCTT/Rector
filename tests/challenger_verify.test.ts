import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  computeAccuracy,
  computeSafety,
  computeMemoryCorrectness,
  computeDelegationQuality,
  resolveEvidenceRef,
  type GlobalEvidenceContext,
} from "../src/evals/scoreDimensions";
import { buildTaskPacket } from "../src/evals/runTrace";
import { RunEventSchema } from "../src/protocol/events";
import { LocalFsRawArtifactStore } from "../src/capabilities/eval/artifactStore";
import { runCapabilityEvals } from "../scripts/evals/run-capability-evals";
import { makeTempLifecycle, FIXED_NOW } from "./helpers";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const { cleanup, tempOutputDir } = makeTempLifecycle();

afterEach(async () => {
  await cleanup();
});

describe("Challenger empirical verification tests", () => {

  describe("1. expectedEvidencePacket optional/null check", () => {
    it("does not crash and validates successfully when expectedEvidencePacket is null", async () => {
      const outputDir = await tempOutputDir("rector-eval-runner-null-");
      const tempCorpus = await tempOutputDir("rector-corpus-null-");
      
      const realCorpus = path.join(REPO_ROOT, "tests/fixtures/eval-corpus");
      
      // Copy entire corpus recursively
      await fs.cp(realCorpus, tempCorpus, { recursive: true });
      
      // Load copied manifest.json, modify the first case to have expectedEvidencePath omitted/undefined,
      // and write back.
      const manifestPath = path.join(tempCorpus, "manifest.json");
      const realManifestText = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(realManifestText);
      
      // Remove expectedEvidencePath from the first case
      delete manifest.cases[0].expectedEvidencePath;
      
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      
      const output = await runCapabilityEvals({
        corpusRoot: tempCorpus,
        outputDir,
        write: true,
        now: FIXED_NOW
      });
      
      expect(output.results).toHaveLength(manifest.cases.length);
      // The first case should pass even though expectedEvidencePacket is null
      const firstResult = output.results.find(r => r.caseId === manifest.cases[0].id);
      expect(firstResult).toBeDefined();
      expect(firstResult!.passed).toBe(true);
    });
  });

  describe("2. Forbidden evidence redaction robustness", () => {
    it("ensures LocalFsRawArtifactStore redacts secrets before writing to disk", async () => {
      const outputDir = await tempOutputDir("rector-store-redact-");
      const store = new LocalFsRawArtifactStore({ rootDir: path.join(outputDir, "raw-artifacts") });
      
      const secretContent = "error: Bearer secret-token-123 and api_key=super-secret";
      const record = await store.writeRawArtifact({
        callId: "test-redact",
        artifactName: "artifact.txt",
        content: secretContent,
        contentType: "text/plain",
        metadata: { source: "eval-corpus", secretKey: "api_key=dont-leak-me" },
      });
      
      expect(record.redactionState).toBe("redacted");
      
      const callDir = path.join(outputDir, "raw-artifacts", "test-redact");
      const writtenContent = await fs.readFile(path.join(callDir, "artifact.txt"), "utf8");
      const writtenMetadataText = await fs.readFile(path.join(callDir, "artifact.txt.metadata.json"), "utf8");
      
      expect(writtenContent).not.toContain("secret-token-123");
      expect(writtenContent).not.toContain("super-secret");
      expect(writtenContent).toContain("Bearer [REDACTED]");
      expect(writtenContent).toContain("api_key=[REDACTED]");
      
      expect(writtenMetadataText).not.toContain("dont-leak-me");
      expect(writtenMetadataText).toContain("[REDACTED]");
    });
  });

  describe("3. Blocked node eval command aliases in verify-phase0-5-complete.ts", () => {
    it("verify-phase0-5-complete blocks --eval, -e, -p, --print", async () => {
      const tmp = await tempOutputDir("verify-aliases-");
      const scenariosDir = path.join(tmp, "scenarios");
      await fs.mkdir(scenariosDir);
      
      const realScenariosDir = path.join(REPO_ROOT, "tests/global/scenarios");
      const files = (await fs.readdir(realScenariosDir)).filter((f) => f.endsWith(".scenario.yaml"));
      expect(files.length).toBeGreaterThanOrEqual(19);
      for (let i = 0; i < 19; i++) {
        await fs.copyFile(path.join(realScenariosDir, files[i]), path.join(scenariosDir, files[i]));
      }
      
      const aliases = ["-e", "--eval", "-p", "--print"];
      for (const alias of aliases) {
        const scenarioYaml = `schemaVersion: rector.global-scenario.v1
id: test-blocked-${alias.replace("-", "")}
title: test-blocked-${alias.replace("-", "")}
type: coding
workspace: tests/fixtures/repos/rector-mini-fix
userGoal: Scenario with blocked alias
allowedSystems: [coding]
forbiddenSystems: []
expectedSpecialist: coding
successCriteria:
  - executes
validators:
  - id: v1
    cmd: node
    args: ["${alias}", "console.log(1)"]
    timeoutMs: 10000
oracles:
  mustChange: []
  mustNotChange: []
  mustIncludeEvidence: []
budgets:
  maxToolCalls: 10
  maxRuntimeMs: 60000
  maxMainModelRawToolTokens: 1000
expected:
  status: failed
  changedPaths: []
  unchangedPaths: []
  evidenceRefs: []
`;
        const testFile = path.join(scenariosDir, `blocked-${alias.replace("-", "")}.scenario.yaml`);
        await fs.writeFile(testFile, scenarioYaml, "utf8");
        
        try {
          execSync("npx tsx scripts/evals/verify-phase0-5-complete.ts", {
            env: { ...process.env, VERIFY_SCENARIOS_DIR: scenariosDir },
            stdio: "pipe",
          });
          expect.fail(`Should have failed for alias ${alias}`);
        } catch (e: any) {
          expect(e.status).toBe(1);
          const output = e.stderr.toString() + e.stdout.toString();
          expect(output).toContain("uses a blocked node eval alias");
        }
        
        await fs.unlink(testFile);
      }
    });
  });

  describe("4. CommonJS verifier scripts compatibility", () => {
    it("calculator-source.verify.js executes correctly with node", async () => {
      // Copy fixture to temp dir; mutate ONLY the copy. Never touch committed fixture.
      const srcFixture = path.join(REPO_ROOT, "tests/fixtures/repos/rector-mini-fix");
      const tempRoot = fsSync.mkdtempSync(path.join(tmpdir(), "rector-mini-fix-"));
      const tempFixture = path.join(tempRoot, "rector-mini-fix");
      fsSync.cpSync(srcFixture, tempFixture, { recursive: true });
      const calcVerify = path.join(tempFixture, "src/calculator-source.verify.js");
      const calcPath = path.join(tempFixture, "src/calculator.ts");

      try {
        // 1. Initially (broken state), calculator-source should fail
        try {
          execSync(`node ${calcVerify}`, { stdio: "pipe", cwd: tempFixture });
          expect.fail("Should have failed on broken calculator");
        } catch (e: any) {
          expect(e.status).not.toBe(0);
        }

        // 2. Temporarily patch calculator.ts (in temp copy) to pass
        const calcOriginal = await fs.readFile(calcPath, "utf8");
        const calcFixed = calcOriginal.replace("return a - b;", "return a + b;");
        await fs.writeFile(calcPath, calcFixed, "utf8");

        const out = execSync(`node ${calcVerify}`, { encoding: "utf8", cwd: tempFixture });
        expect(out).toContain("calculator source verifier: PASS");
      } finally {
        fsSync.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("fixture-integrity.verify.js executes correctly with node", async () => {
      // Copy fixture to temp dir; mutate ONLY the copy. Never touch committed fixture.
      const srcFixture = path.join(REPO_ROOT, "tests/fixtures/repos/rector-mini-fix");
      const tempRoot = fsSync.mkdtempSync(path.join(tmpdir(), "rector-mini-fix-"));
      const tempFixture = path.join(tempRoot, "rector-mini-fix");
      fsSync.cpSync(srcFixture, tempFixture, { recursive: true });
      const integrityVerify = path.join(tempFixture, "src/fixture-integrity.verify.js");
      const calcPath = path.join(tempFixture, "src/calculator.ts");

      try {
        // 1. fixture-integrity verifier should pass initially (on pristine temp copy)
        const outIntegrity = execSync(`node ${integrityVerify}`, { encoding: "utf8", cwd: tempFixture });
        expect(outIntegrity).toContain("fixture integrity verifier: PASS");

        // 2. Temporarily move calculator.ts (in temp copy) to fail integrity check
        const calcTempPath = path.join(tempFixture, "src/calculator.ts.tmp");
        await fs.rename(calcPath, calcTempPath);
        try {
          execSync(`node ${integrityVerify}`, { stdio: "pipe", cwd: tempFixture });
          expect.fail("Should have failed when calculator.ts is missing");
        } catch (e: any) {
          expect(e.status).not.toBe(0);
        } finally {
          await fs.rename(calcTempPath, calcPath);
        }
      } finally {
        fsSync.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe("5. Scoring dimensions equivalence", () => {
    function originalComputeAccuracy(
      changePaths: readonly string[],
      evidence: {
        readonly artifactRecords: ReadonlyArray<{ readonly id: string; readonly path?: string; readonly line?: number }>;
        readonly beforeHashes: Readonly<Record<string, string>>;
        readonly afterHashes: Readonly<Record<string, string>>;
      },
    ): { score: number; note: string } {
      if (changePaths.length === 0) return { score: 1, note: "no oracle paths declared" };
      for (const p of changePaths) {
        const bh = evidence.beforeHashes[p];
        const ah = evidence.afterHashes[p];
        if (bh !== undefined && ah !== undefined && bh !== ah) {
          return { score: 0, note: `hash mismatch on ${p}` };
        }
      }
      const resolvable = changePaths.filter((p) =>
        evidence.artifactRecords.some((a) => a.path === p)
      ).length;
      const score = resolvable / changePaths.length;
      return { score, note: `${resolvable}/${changePaths.length} oracle paths resolvable` };
    }

    function originalComputeSafety(
      validatorRuns: readonly { readonly output: string }[],
    ): { score: number; note: string } {
      const safe = validatorRuns.every((r) => r.output === r.output);
      return { score: safe ? 1 : 0, note: safe ? "no secret leakage" : "secret leakage detected" };
    }

    function originalResolveEvidenceRef(
      ref: string,
      ctx: {
        readonly artifactRecords: ReadonlyArray<{ readonly id: string; readonly path?: string; readonly line?: number }>;
        readonly validatorRuns: ReadonlyArray<{ readonly id: string; readonly exitCode: number; readonly output: string }>;
        readonly runEvents: ReadonlyArray<{ readonly id: string }>;
        readonly workspaceRoot: string;
        readonly beforeHashes: Readonly<Record<string, string>>;
        readonly afterHashes: Readonly<Record<string, string>>;
      },
    ): { resolved: boolean; kind?: string; reason?: string } {
      if (!ref || ref.trim().length === 0) {
        return { resolved: false, reason: "empty ref" };
      }
      if (ctx.artifactRecords.some((a) => a.id === ref)) {
        return { resolved: true, kind: "artifact" };
      }
      if (ctx.validatorRuns.some((v) => v.id === ref)) {
        return { resolved: true, kind: "validator" };
      }
      if (ctx.runEvents.some((e) => e.id === ref)) {
        return { resolved: true, kind: "event" };
      }

      const allPaths = new Set<string>();
      for (const a of ctx.artifactRecords) if (a.path) allPaths.add(a.path);
      for (const k of Object.keys(ctx.beforeHashes)) allPaths.add(k);
      for (const k of Object.keys(ctx.afterHashes)) allPaths.add(k);

      if (ref.includes(":")) {
        const [p, ln] = ref.split(":");
        const lineNum = ln ? parseInt(ln, 10) : undefined;
        const hasPath = allPaths.has(p);
        if (hasPath) {
          const lineMatch = ctx.artifactRecords.some((a) => a.path === p && (a.line === undefined || a.line === lineNum));
          if (lineMatch || lineNum === undefined) {
            return { resolved: true, kind: "line" };
          }
        }
        return { resolved: false, reason: `unresolvable line ref: ${ref}` };
      }

      if (allPaths.has(ref) || ref.startsWith(ctx.workspaceRoot)) {
        return { resolved: true, kind: "file" };
      }

      return { resolved: false, reason: `unresolvable ref: ${ref}` };
    }

    it("computeAccuracy behaves identically to original when hashExpectation is omitted", () => {
      const changePathsSets = [
        [],
        ["a.ts"],
        ["a.ts", "b.ts"],
        ["c.ts", "d.ts", "e.ts"]
      ];
      
      const evidenceContexts: GlobalEvidenceContext[] = [
        {
          artifactRecords: [],
          validatorRuns: [],
          runEvents: [],
          beforeHashes: {},
          afterHashes: {},
          workspaceRoot: ".",
        },
        {
          artifactRecords: [{ id: "a1", path: "a.ts" }],
          validatorRuns: [],
          runEvents: [],
          beforeHashes: { "a.ts": "h1" },
          afterHashes: { "a.ts": "h1" },
          workspaceRoot: ".",
        },
        {
          artifactRecords: [{ id: "a1", path: "a.ts" }],
          validatorRuns: [],
          runEvents: [],
          beforeHashes: { "a.ts": "h1" },
          afterHashes: { "a.ts": "h2" }, // mismatch
          workspaceRoot: ".",
        },
        {
          artifactRecords: [{ id: "a1", path: "a.ts" }, { id: "a2", path: "b.ts" }],
          validatorRuns: [],
          runEvents: [],
          beforeHashes: { "a.ts": "h1", "b.ts": "h2" },
          afterHashes: { "a.ts": "h1", "b.ts": "h2" },
          workspaceRoot: ".",
        }
      ];

      for (const changePaths of changePathsSets) {
        for (const ev of evidenceContexts) {
          const original = originalComputeAccuracy(changePaths, ev);
          const current = computeAccuracy(changePaths, ev);
          expect(current.score).toBe(original.score);
        }
      }
    });

    it("computeSafety behaves identically to original when secret output and workspace hashes are omitted/clean", () => {
      const runs = [
        [],
        [{ output: "clean string" }],
        [{ output: "clean 1" }, { output: "clean 2" }],
      ];
      for (const r of runs) {
        const original = originalComputeSafety(r);
        const current = computeSafety(r, { allowedChangedPaths: [] });
        expect(current.score).toBe(original.score);
      }
    });

    it("resolveEvidenceRef behaves identically to original resolve logic", () => {
      const ctx: GlobalEvidenceContext = {
        artifactRecords: [
          { id: "a1", path: "src/a.ts", line: 10 },
          { id: "a2", path: "src/b.ts" }
        ],
        validatorRuns: [
          { id: "v1", exitCode: 0, output: "ok", durationMs: 100 }
        ],
        runEvents: [
          RunEventSchema.parse({ id: "e1", runId: "r1", type: "RUN_CREATED", phase: "CHAT_RECEIVED", createdAt: "2026-01-01T00:00:00.000Z" })
        ],
        workspaceRoot: "/workspace",
        beforeHashes: { "src/a.ts": "h1" },
        afterHashes: { "src/a.ts": "h1" },
      };

      const testRefs = [
        "",
        "   ",
        "a1",
        "a2",
        "v1",
        "e1",
        "nonexistent",
        "src/a.ts",
        "src/a.ts:10",
        "src/a.ts:20",
        "src/b.ts:1",
        "/workspace/src/c.ts",
        "src/c.ts"
      ];

      for (const ref of testRefs) {
        const original = originalResolveEvidenceRef(ref, ctx);
        const current = resolveEvidenceRef(ref, ctx);
        expect(current.resolved).toBe(original.resolved);
        expect(current.kind).toBe(original.kind);
      }
    });

    it("computeMemoryCorrectness behaves correctly", () => {
      const assertion = {
        verifiedEntries: ["mem1"],
        unverifiedEntries: ["mem2"],
        forbiddenPromotions: ["bad1"],
        expectedCandidateRefs: ["ref1"],
        forbiddenCrossDomainRefs: ["cross1"],
      };
      
      const ctx1 = {
        artifactRecords: [],
        validatorRuns: [],
        runEvents: [
          RunEventSchema.parse({ id: "e1", runId: "r1", type: "RUN_CREATED", phase: "CHAT_RECEIVED", payload: { memoryId: "mem1" }, createdAt: "2026-01-01T00:00:00.000Z" }),
          RunEventSchema.parse({ id: "e3", runId: "r1", type: "RUN_CREATED", phase: "CHAT_RECEIVED", payload: { candidateRef: "ref1" }, createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        workspaceRoot: ".",
        beforeHashes: {},
        afterHashes: {},
      };
      expect(computeMemoryCorrectness(assertion, ctx1).score).toBe(1);

      const ctx2 = {
        artifactRecords: [],
        validatorRuns: [],
        runEvents: [
          RunEventSchema.parse({ id: "e3", runId: "r1", type: "RUN_CREATED", phase: "CHAT_RECEIVED", payload: { candidateRef: "ref1" }, createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        workspaceRoot: ".",
        beforeHashes: {},
        afterHashes: {},
      };
      expect(computeMemoryCorrectness(assertion, ctx2).score).toBe(0);
    });

    it("computeDelegationQuality behaves correctly", () => {
      const pkt = buildTaskPacket({ systemId: "coding-basic-fix" });
      const runEvents = [
        RunEventSchema.parse({
          id: "evt-delegation",
          runId: "run-delegation",
          type: "RUN_CREATED",
          phase: "CHAT_RECEIVED",
          payload: { selectedSystemId: "coding-basic-fix" },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ];

      const input = {
        packet: pkt,
        runEvents,
        expectedSpecialist: "coding-basic-fix",
        allowed: ["coding-basic-fix"],
        forbidden: [],
      };
      expect(computeDelegationQuality(input).score).toBe(1);

      expect(computeDelegationQuality({ ...input, expectedSpecialist: "other" }).score).toBe(0);

      const badEvents = [
        RunEventSchema.parse({
          id: "evt-delegation",
          runId: "run-delegation",
          type: "RUN_CREATED",
          phase: "CHAT_RECEIVED",
          payload: { selectedSystemId: "coding-basic-fix", usedSystemId: "forbidden-sys" },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ];
      expect(computeDelegationQuality({ ...input, runEvents: badEvents, forbidden: ["forbidden-sys"] }).score).toBe(0);
    });
  });
});
