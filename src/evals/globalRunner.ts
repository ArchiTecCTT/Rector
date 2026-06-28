import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactString } from "../security/redaction";
import {
  ScorecardSchema,
  renderScorecardMarkdown,
  type FakePathStatus,
  type Scorecard,
} from "./scorecards";
import {
  loadGlobalScenario,
  type GlobalScenario,
  type GlobalValidator,
  type GlobalScenarioSetup,
  type GlobalScenarioOperation,
  type GlobalScenarioExpected,
} from "./globalScenarioSchema";
import {
  RegressionArtifactSchema,
  type RegressionArtifact,
} from "./regressionArtifactSchema";
import { buildTaskPacket, buildRunTrace } from "./runTrace";
import { globalHarnessResultToFacts } from "../facts";
import { RunEventSchema } from "../protocol/events";
import { RunPhaseSchema } from "../protocol/phases";
import { SpecialistTaskPacketSchema } from "../systems/contracts";
import {
  computeReliability as computeReliabilityReal,
  computeAccuracy as computeAccuracyReal,
  computeSafety as computeSafetyReal,
  computeCostEfficiency as computeCostEfficiencyReal,
  computeMemoryCorrectness as computeMemoryCorrectnessReal,
  computeDelegationQuality as computeDelegationQualityReal,
  computeEvidenceQuality as computeEvidenceQualityReal,
  computeSimplicity as computeSimplicityReal,
  MemoryAssertionSchema,
  type GlobalEvidenceContext,
  type MemoryAssertion,
} from "./scoreDimensions";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_SCENARIOS_DIR = path.join(REPO_ROOT, "tests", "global", "scenarios");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const VALIDATOR_TIMEOUT_CEILING_MS = 120000;

// Directories excluded from the full workspace hash manifest (per plan requirement).
const MANIFEST_EXCLUDE_DIRS = new Set([".git", "node_modules", ".omo", "tmp", "temp", ".cache", "dist", "build"]);

/** Compute SHA-256 hex of a file's contents. */
async function sha256File(absolutePath: string): Promise<string> {
  const data = await fs.readFile(absolutePath);
  return createHash("sha256").update(data).digest("hex");
}

/** Recursively compute a sorted manifest of {path, sha256} for all relevant files under root. */
interface ComputeWorkspaceManifestInput {
  readonly root: string;
}
async function computeWorkspaceManifest(input: ComputeWorkspaceManifestInput): Promise<readonly { path: string; sha256: string }[]> {
  const { root } = input;
  const entries: { path: string; sha256: string }[] = [];
  interface WalkInput { readonly dir: string; readonly relBase: string; }
  async function walk(winput: WalkInput): Promise<void> {
    const { dir, relBase } = winput;
    const names = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of names) {
      if (MANIFEST_EXCLUDE_DIRS.has(dirent.name)) continue;
      const abs = path.join(dir, dirent.name);
      const rel = path.posix.join(relBase, dirent.name.replace(/\\/g, "/"));
      if (dirent.isDirectory()) {
        await walk({ dir: abs, relBase: rel });
      } else if (dirent.isFile()) {
        const h = await sha256File(abs);
        entries.push({ path: rel, sha256: h });
      }
    }
  }
  await walk({ dir: root, relBase: "" });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** Resolve a local project binary deterministically. For `tsx`, prefer workspace node_modules/.bin/tsx, else validated npx --no-install. */
interface ResolveLocalBinaryInput {
  readonly cmd: string;
  readonly workspaceRoot: string;
}
function resolveLocalBinary(input: ResolveLocalBinaryInput): { cmd: string; argsPrefix: readonly string[] } {
  const { cmd, workspaceRoot } = input;
  if (cmd === "tsx") {
    const localBin = path.join(workspaceRoot, "node_modules", ".bin", "tsx");
    // We do not stat here (runner may run before install in some envs); the spawn will surface ENOENT if missing.
    // The caller will fall back to npx --no-install when the validator cmd is literally "npx".
    return { cmd: localBin, argsPrefix: [] };
  }
  if (cmd === "npx") {
    // npx is already validated by GlobalValidatorSchema to contain --no-install; pass through.
    return { cmd: "npx", argsPrefix: [] };
  }
  return { cmd, argsPrefix: [] };
}

export const GLOBAL_REPORT_SCHEMA_VERSION = "rector.global-report.v1";

/**
 * A scenario requires a live provider when its `type` is the literal `"live"` or any validator
 * command carries the `LIVE_EVALS` token. The four committed offline scenarios match neither, so
 * they always execute. When a live scenario is encountered without `LIVE_EVALS=1` in the
 * environment, it is SKIPPED with a recorded reason — never failed, never faked.
 */
export function requiresLiveProvider(scenario: GlobalScenario): boolean {
  if (scenario.type === "live") return true;
  return scenario.validators.some((validator) =>
    validator.args.some((arg) => arg.includes("LIVE_EVALS")),
  );
}

export type ValidatorRun = {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string; // RAW (for scoring / secret-leak detection in computeSafety)
  readonly outputRedacted: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
};

export type SkippedScenario = {
  readonly scenarioId: string;
  readonly reason: string;
  readonly actualStatus: "skipped";
  readonly expectedStatus: "passed" | "failed" | "skipped";
};

export type GlobalScenarioOutcome = {
  readonly scenarioId: string;
  readonly scorecard: Scorecard;
  readonly validatorRuns: readonly ValidatorRun[];
  readonly taskPacket?: ReturnType<typeof SpecialistTaskPacketSchema.parse>;
  readonly runEvents?: readonly ReturnType<typeof RunEventSchema.parse>[];
  readonly artifactRefs?: readonly string[];
  readonly validationRefs?: readonly string[];
  readonly actualStatus: "passed" | "failed" | "skipped";
  readonly expectedStatus: "passed" | "failed" | "skipped";
  readonly scenarioFile: string;
};

type ProducedArtifactRecord = {
  readonly id: string;
  readonly path?: string;
  readonly line?: number;
};

type ProducedArtifactInput = {
  readonly runEvents: readonly ReturnType<typeof RunEventSchema.parse>[];
  readonly validators: readonly GlobalValidator[];
  readonly beforeHashes: ReadonlyMap<string, string>;
  readonly afterHashes: ReadonlyMap<string, string>;
  readonly packet: ReturnType<typeof SpecialistTaskPacketSchema.parse>;
  readonly allowed: readonly string[];
  readonly forbidden: readonly string[];
  readonly fakePathStatus: FakePathStatus;
  readonly harnessFactCount: number;
};

function buildProducedArtifactRecords(input: ProducedArtifactInput): readonly ProducedArtifactRecord[] {
  const records: ProducedArtifactRecord[] = [
    ...input.runEvents.map((event, index) => ({ id: `event-${index}`, path: undefined })),
    ...input.validators.map((validator) => ({ id: validator.id, path: undefined })),
  ];
  for (const p of new Set([...input.beforeHashes.keys(), ...input.afterHashes.keys()])) {
    records.push({ id: `file:${p}`, path: p });
  }
  if (input.beforeHashes.size > 0 || input.afterHashes.size > 0) {
    records.push({ id: "cartographer.grounding", path: undefined });
  }
  if (input.harnessFactCount > 0) {
    records.push({ id: "fact:global_harness:oracle", path: undefined });
  }
  if (input.packet.systemId === "coding" && input.allowed.includes("coding") && !input.forbidden.includes("coding")) {
    records.push({ id: "delegation.coding-only", path: undefined });
  }
  if (input.fakePathStatus === "clean") {
    records.push({ id: "fake-path.clean", path: undefined });
  }
  if (input.packet.systemId === "memory" && input.allowed.includes("memory") && !input.forbidden.includes("memory")) {
    records.push({ id: "memory.verified-only", path: undefined });
  }
  return records;
}

export type GlobalHarnessReport = {
  readonly schemaVersion: typeof GLOBAL_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly scenarioCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly passedCount: number;
  readonly fakePathStatus: FakePathStatus;
  readonly fakeFindingCount: number;
  readonly outcomes: readonly GlobalScenarioOutcome[];
  readonly skipped: readonly SkippedScenario[];
  readonly regressions: readonly { scenarioId: string; note?: string; failedValidators?: readonly ValidatorRun[] }[];
};

export type FakePathAudit = {
  readonly findingCount: number;
};

export type FakePathAuditor = () => Promise<FakePathAudit>;

export type RunGlobalHarnessOptions = {
  readonly scenariosDir?: string;
  readonly repoRoot?: string;
  readonly outputDir?: string;
  readonly write?: boolean;
  readonly scenarios?: readonly GlobalScenario[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /**
   * Injected fake-path auditor. `src` cannot import the `scripts/` audit module (rootDir boundary),
   * so the CLI passes auditNoProductionFakes in. When omitted, the harness reports
   * `audit_not_present` honestly rather than fabricating a `clean` status.
   */
  readonly fakePathAuditor?: FakePathAuditor;
};

export type RunGlobalHarnessResult = {
  readonly report: GlobalHarnessReport;
  readonly scorecards: readonly Scorecard[];
  readonly skipped: readonly SkippedScenario[];
  readonly reportJson: string;
  readonly reportMd: string;
  readonly jsonPath?: string;
  readonly markdownPath?: string;
};

async function readScenarioDirEntries(scenariosDir: string): Promise<readonly string[]> {
  const entries = await fs.readdir(scenariosDir);
  return entries.filter((entry) => entry.endsWith(".scenario.yaml")).sort();
}

async function loadScenarioDir(scenariosDir: string): Promise<readonly GlobalScenario[]> {
  const files = await readScenarioDirEntries(scenariosDir);
  const scenarios: GlobalScenario[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(scenariosDir, file), "utf8");
    scenarios.push(loadGlobalScenario(text, "yaml"));
  }
  return scenarios;
}

async function loadScenarioFileMap(scenariosDir: string): Promise<ReadonlyMap<string, string>> {
  const files = await readScenarioDirEntries(scenariosDir);
  const scenarioFiles = new Map<string, string>();
  for (const file of files) {
    const text = await fs.readFile(path.join(scenariosDir, file), "utf8");
    scenarioFiles.set(loadGlobalScenario(text, "yaml").id, file);
  }
  return scenarioFiles;
}

interface RunValidatorInput {
  readonly validator: GlobalValidator;
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}
function runValidator(input: RunValidatorInput): ValidatorRun {
  const { validator, workspaceRoot, env } = input;
  const startedAt = Date.now();
  // Trusted committed scenario source; spawnSync with shell:false so validator args never reach a
  // shell. cmd/args come from the typed schema (no whitespace split), so spaced args round-trip.
  const cwd = path.resolve(workspaceRoot, validator.cwd);
  const timeoutMs = Math.min(validator.timeoutMs, VALIDATOR_TIMEOUT_CEILING_MS);
  const { cmd: resolvedCmd, argsPrefix } = resolveLocalBinary({ cmd: validator.cmd, workspaceRoot });
  const finalArgs = [...argsPrefix, ...validator.args];
  const result = spawnSync(resolvedCmd, finalArgs, {
    cwd,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  // status is null when the process was killed by a signal (e.g. timeout) — treat as failure (-1).
  const exitCode = typeof result.status === "number" ? result.status : -1;
  const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Joined cmd+args string drives the replayable regression artifact's replay command.
  const command = [resolvedCmd, ...finalArgs].join(" ");
  return {
    command,
    exitCode,
    output: rawOutput, // RAW for scoring (computeSafety leak detection)
    outputRedacted: redactString(rawOutput),
    durationMs,
    timedOut,
  };
}

/** Copy a directory tree (src) into a fresh temp dir (dest). */
interface CopyWorkspaceInput {
  readonly src: string;
  readonly dest: string;
}
async function copyWorkspaceToTemp(input: CopyWorkspaceInput): Promise<void> {
  const { src, dest } = input;
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (MANIFEST_EXCLUDE_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyWorkspaceToTemp({ src: s, dest: d });
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

interface TargetCheckInput {
  readonly target: string;
  readonly allowedSet: ReadonlySet<string>;
}
function assertTargetInAllowed(input: TargetCheckInput): { ok: true } | { ok: false; reason: string } {
  const { target, allowedSet } = input;
  if (target.startsWith("/") || target.includes("..")) {
    return { ok: false, reason: `patch target escapes workspace: ${target}` };
  }
  if (!allowedSet.has(target)) {
    return { ok: false, reason: `patch target not in allowed set: ${target}` };
  }
  return { ok: true };
}

interface AssertNoUndeclaredInput {
  readonly targets: readonly string[];
  readonly allowedSet: ReadonlySet<string>;
}
function assertNoUndeclaredNewFile(input: AssertNoUndeclaredInput): { ok: true } | { ok: false; reason: string } {
  const { targets, allowedSet } = input;
  for (const t of targets) {
    const check = assertTargetInAllowed({ target: t, allowedSet });
    if (!check.ok) return check;
  }
  return { ok: true };
}

interface PatchScanInput {
  readonly patchText: string;
  readonly regex: RegExp;
  readonly allowedSet: ReadonlySet<string>;
  readonly pickTarget: (m: RegExpExecArray) => string;
}
function collectTargetsWithRegex(input: PatchScanInput): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const { patchText, regex, allowedSet, pickTarget } = input;
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(patchText)) !== null) {
    const target = pickTarget(m);
    const check = assertTargetInAllowed({ target, allowedSet });
    if (!check.ok) return check;
    targets.push(target);
  }
  return { ok: true, targets };
}

/** Validate that every target path in a patch file is inside the allowed set (changedPaths + declared setup-only allowed paths). New files must be declared. */
async function validateScriptedPatchTargets(
  patchFileAbs: string,
  allowedSet: ReadonlySet<string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const patchText = await fs.readFile(patchFileAbs, "utf8");
  const gitRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const gitRes = collectTargetsWithRegex({ patchText, regex: gitRegex, allowedSet, pickTarget: (m) => m[2] ?? m[1] });
  if (!gitRes.ok) return gitRes;
  let targets = gitRes.targets;

  if (targets.length === 0) {
    const tradRegex = /^(\+\+\+|---)\s+[ab]\/(.+?)$/gm;
    const tradRes = collectTargetsWithRegex({ patchText, regex: tradRegex, allowedSet, pickTarget: (m) => m[2] });
    if (!tradRes.ok) return tradRes;
    targets = tradRes.targets;
  }
  if (patchText.trim().length > 0 && targets.length === 0) {
    return { ok: false, reason: "patch contained no parsable targets (fail-closed)" };
  }
  return assertNoUndeclaredNewFile({ targets, allowedSet });
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}



// Dimensions that gate `passed`. reliability + safety plus the four deterministic oracle dims must
// all be 1 for a scenario to pass. cost_efficiency + simplicity stay informational (not gating).
const GATED_DIMENSION_IDS = [
  "reliability",
  "accuracy",
  "safety",
  "memory_correctness",
  "delegation_quality",
  "evidence_quality",
] as const;

/**
 * Names the gating dimensions whose score is not 1, in fixed order. Used to give each regression
 * artifact an honest note naming exactly which dimension(s) failed (not just reliability).
 */
function failedGatedDimensions(scorecard: Scorecard): readonly string[] {
  return GATED_DIMENSION_IDS.filter((id) => scorecard.dimensions[id].score !== 1);
}



/**
 * Builds the per-scenario {@link Scorecard} from REAL deterministic signals. Per-dimension derivation
 * (honest — offline, no specialist mutates files, so we never claim a change happened):
 *  - reliability:        1 iff every validator exited 0 (coding-basic-fix exits 1 on the unfixed bug -> 0).
 *  - accuracy:           fraction of mustChange+mustNotChange oracle paths that actually resolve on disk
 *                        (proves the oracle references are well-formed and evaluable).
 *  - safety:             1 iff no validator output leaks a secret (redactString is a no-op on the output).
 *  - cost_efficiency:    1 iff total validator runtime stayed within budgets.maxRuntimeMs (informational).
 *  - memory_correctness: fraction of mustNotChange surfaces still present (unmodified-surface presence).
  * Real behavioral wiring (todo 12): each dimension calls the pure function from scoreDimensions.ts.
  * reliability: validator exitCode === expectedExitCode (not just 0).
  * accuracy: before/after hash match on declared paths (hash mismatch forces 0).
  * safety: no secret leak + redaction-stable + no forbidden path changed (manifest).
  * cost_efficiency: runtime/tool-call counters within budgets (injected test clock for determinism).
  * memory_correctness: MemoryAssertionSchema fixture passes (never file existence).
  * delegation_quality: packet/trace match (already wired).
  * evidence_quality: every ref resolves via resolveEvidenceRef against GlobalEvidenceContext.
  * simplicity: deterministic rules from scoreDimensions (validator budget, no forbidden specialist, validator_only, no avoidable patch).
  */
async function buildScorecard(input: {
  readonly scenario: GlobalScenario;
  readonly repoRoot: string;
  readonly validatorRuns: readonly ValidatorRun[];
  readonly fakePathStatus: FakePathStatus;
  readonly fakeFindingCount: number;
  readonly beforeHashes?: Readonly<Record<string, string>>;
  readonly afterHashes?: Readonly<Record<string, string>>;
  readonly workspaceBeforeHashes?: Readonly<Record<string, string>>;
  readonly workspaceAfterHashes?: Readonly<Record<string, string>>;
  readonly runEvents?: readonly ReturnType<typeof RunEventSchema.parse>[];
  readonly artifactRecords?: readonly { readonly id: string; readonly path?: string; readonly line?: number }[];
  readonly memoryAssertion?: MemoryAssertion;
  readonly testNow?: () => Date;
  readonly packet: ReturnType<typeof SpecialistTaskPacketSchema.parse>;
  readonly allowed?: readonly string[];
  readonly forbidden?: readonly string[];
}): Promise<Scorecard> {
  const {
    scenario,
    repoRoot,
    validatorRuns,
    fakePathStatus,
    fakeFindingCount,
    beforeHashes = {},
    afterHashes = {},
    workspaceBeforeHashes,
    workspaceAfterHashes,
    runEvents = [],
    artifactRecords = [],
    memoryAssertion,
    packet,
    allowed = scenario.allowedSystems,
    forbidden = scenario.forbiddenSystems,
  } = input;

  // reliability: compare actual exitCode to expectedExitCode per validator
  const reliabilityInput = validatorRuns.map((r, idx) => ({
    exitCode: r.exitCode,
    expectedExitCode: scenario.validators[idx]?.expectedExitCode ?? 0,
  }));
  const reliability = computeReliabilityReal(reliabilityInput);

  // accuracy: hash match on declared paths (mismatch -> 0)
  const accuracyCtx: GlobalEvidenceContext = {
    artifactRecords,
    validatorRuns: validatorRuns.map((v, i) => ({ id: scenario.validators[i]?.id ?? `v${i}`, exitCode: v.exitCode, output: v.output, durationMs: v.durationMs })),
    runEvents,
    workspaceRoot: repoRoot,
    beforeHashes,
    afterHashes,
    workspaceBeforeHashes,
    workspaceAfterHashes,
  };
  // #5: accuracy also hash-verifies declared expected.changedPaths/unchangedPaths (via before/after hashes in ctx).
  const declaredPaths = [...(scenario.expected.changedPaths ?? []), ...(scenario.expected.unchangedPaths ?? [])];
  const accuracyOraclePaths = Array.from(new Set([...scenario.oracles.mustChange, ...scenario.oracles.mustNotChange, ...declaredPaths]));
  const accuracy = computeAccuracyReal(accuracyOraclePaths, accuracyCtx, {
    changedPaths: scenario.expected.changedPaths ?? [],
    unchangedPaths: scenario.expected.unchangedPaths ?? [],
  });

  // safety: redaction-stable + no secret + manifest check (no undeclared change)
  const allowedChangedPaths = scenario.expected.changedPaths ?? [];
  const safety = computeSafetyReal(validatorRuns, { workspaceBeforeHashes, workspaceAfterHashes, allowedChangedPaths });

  // cost_efficiency: deterministic via injected test clock (total runtime <= budget)
  const cost = computeCostEfficiencyReal(validatorRuns, scenario.budgets.maxRuntimeMs);

  // memory_correctness: memory scenarios must provide real MemoryAssertion fixtures; non-memory
  // scenarios remain neutral when no assertion is declared.
  let memoryCorrectness = { score: 1, note: "no memory assertion declared" };
  if (memoryAssertion) {
    memoryCorrectness = computeMemoryCorrectnessReal(memoryAssertion, accuracyCtx);
  } else if (scenario.type === "memory") {
    memoryCorrectness = { score: 0, note: "memory scenario missing memoryAssertionPath" };
  }

  // delegation_quality: packet + trace must agree on the expected specialist boundary.
  const delegationQualityResult = computeDelegationQualityReal({
    packet,
    runEvents,
    expectedSpecialist: scenario.expectedSpecialist,
    allowed,
    forbidden,
  });
  const delegationQuality = delegationQualityResult.score;

  // evidence_quality: score the UNION of oracles.mustIncludeEvidence + expected.evidenceRefs (deduped).
  // This ensures declared expected.evidenceRefs are actually scored (previously ignored).
  const evidenceRefsUnion = Array.from(new Set([
    ...scenario.oracles.mustIncludeEvidence,
    ...(scenario.expected.evidenceRefs ?? []),
  ]));
  const evidenceQuality = computeEvidenceQualityReal(evidenceRefsUnion, accuracyCtx);

  // simplicity: deterministic rules (validator budget, no forbidden specialist, validator_only, no avoidable patch)
  const forbiddenSpecialistUsed = forbidden.some((systemId) =>
    runEvents.some((event) => {
      const payload = event.payload ?? {};
      return payload["selectedSystemId"] === systemId || payload["usedSystemId"] === systemId || payload["systemId"] === systemId;
    })
  );
  const operationKind = scenario.operation?.kind ?? "validator_only";
  const validatorBudget = 3;
  const simplicity = computeSimplicityReal({
    validatorCount: scenario.validators.length,
    validatorBudget,
    forbiddenSpecialistUsed,
    operationKind,
    patchUsedWhenValidatorOnlySuffices: operationKind === "scripted_patch" && scenario.oracles.mustChange.length === 0 && scenario.expected.changedPaths.length === 0,
    extraValidatorsBeyondBudget: scenario.validators.length > validatorBudget,
  });

  const dimensions = {
    reliability: { score: reliability.score, notes: reliability.note },
    accuracy: { score: accuracy.score, notes: accuracy.note },
    safety: { score: safety.score, notes: safety.note },
    cost_efficiency: { score: cost.score, notes: cost.note },
    memory_correctness: { score: memoryCorrectness.score, notes: memoryCorrectness.note },
    delegation_quality: { score: delegationQuality, notes: delegationQualityResult.note },
    evidence_quality: { score: evidenceQuality.score, notes: evidenceQuality.note },
    simplicity: { score: simplicity.score, notes: simplicity.note },
  } satisfies Scorecard["dimensions"];

  const gatedScores = [
    reliability.score,
    accuracy.score,
    safety.score,
    memoryCorrectness.score,
    delegationQuality,
    evidenceQuality.score,
  ];
  const passed = gatedScores.every((score) => score === 1);

  const scorecard = {
    schemaVersion: "rector.global-scorecard.v1" as const,
    scenarioId: scenario.id,
    dimensions,
    fakePathStatus,
    fakeFindingCount,
    passed,
  };
  return ScorecardSchema.parse(scorecard);
}

function renderHarnessMarkdown(report: GlobalHarnessReport, scorecards: readonly Scorecard[]): string {
  const lines: string[] = [];
  lines.push("# Global Reliability Harness Report (offline Phase-0.5)");
  lines.push("");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Scenarios: ${report.scenarioCount} (executed ${report.executedCount}, skipped ${report.skippedCount})`);
  lines.push(`- Passed scenarios: ${report.passedCount}/${report.executedCount}`);
  lines.push(`- Fake-path status: ${report.fakePathStatus} (${report.fakeFindingCount} findings, report-only)`);
  lines.push("");
  lines.push("> Offline harness: it runs each scenario's REAL validator command against its fixture and");
  lines.push("> evaluates oracles deterministically. No specialist mutates files offline, so a `mustChange`");
  lines.push("> path is reported as evaluable, NOT as a change that happened. Specialist-driven mutation is");
  lines.push("> Phase 11/12. A scenario whose validator currently fails is recorded truthfully.");
  lines.push("");
  if (report.skipped.length > 0) {
    lines.push("## Skipped (live, no creds)");
    lines.push("");
    for (const skip of report.skipped) {
      lines.push(`- \`${skip.scenarioId}\`: ${skip.reason}`);
    }
    lines.push("");
  }
  lines.push("## Scorecards");
  lines.push("");
  for (const scorecard of scorecards) {
    lines.push(renderScorecardMarkdown(scorecard));
  }
  if (report.regressions.length > 0) {
    lines.push("## Regressions (replayable)");
    lines.push("");
    for (const regression of report.regressions) {
      lines.push(`### \`${regression.scenarioId}\``);
      if (regression.note) lines.push(regression.note);
      if (regression.failedValidators) {
        for (const failed of regression.failedValidators) {
          lines.push(`- exit ${failed.exitCode}: \`${failed.command}\``);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Offline global reliability harness. Loads the committed scenarios, runs each scenario's REAL
 * validator command against its fixture workspace, evaluates oracles deterministically, and emits one
 * {@link Scorecard} per executed scenario plus a fake-path status from the report-only audit. Live
 * scenarios without `LIVE_EVALS=1` are SKIPPED (reported, never failed, never faked). The run SUCCEEDS
 * when it produces a valid report; it is NOT gated on every scenario passing.
 */
export async function runGlobalHarness(options: RunGlobalHarnessOptions = {}): Promise<RunGlobalHarnessResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scenariosDir = options.scenariosDir ?? DEFAULT_SCENARIOS_DIR;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const shouldWrite = options.write ?? true;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  const now = options.now ?? (() => new Date());

  const scenarios = options.scenarios ?? (await loadScenarioDir(scenariosDir));
  const scenarioFiles = options.scenarios
    ? new Map(scenarios.map((scenario) => [scenario.id, `${scenario.id}.scenario.yaml`]))
    : await loadScenarioFileMap(scenariosDir);

  const audit = options.fakePathAuditor ? await options.fakePathAuditor() : undefined;
  const fakePathStatus: FakePathStatus =
    audit === undefined ? "audit_not_present" : audit.findingCount > 0 ? "fakes_present" : "clean";
  const fakeFindingCount = audit?.findingCount ?? 0;

  const outcomes: GlobalScenarioOutcome[] = [];
  const skipped: SkippedScenario[] = [];
  const regressions: { scenarioId: string; note?: string; failedValidators?: readonly ValidatorRun[] }[] = [];

  for (const scenario of scenarios) {
    const skipWithRegression = (reason: string): void => {
      skipped.push({ scenarioId: scenario.id, reason, actualStatus: "skipped", expectedStatus: scenario.expected.status });
      regressions.push({ scenarioId: scenario.id, note: reason });
    };

    if (requiresLiveProvider(scenario) && env.LIVE_EVALS !== "1") {
      skipped.push({
        scenarioId: scenario.id,
        reason: "requires a live provider but LIVE_EVALS=1 is not set; skipped (not failed, not faked)",
        actualStatus: "skipped",
        expectedStatus: scenario.expected.status,
      });
      continue;
    }

    const scenarioWorkspace = path.resolve(repoRoot, scenario.workspace);
    if (!(await pathExists(scenarioWorkspace))) {
      skipWithRegression(`workspace not found: ${scenario.workspace}`);
      continue;
    }

    // Determine effective workspace (temp copy when requested).
    let effectiveWorkspace = scenarioWorkspace;
    let tempWorkspace: string | undefined;
    const setup: GlobalScenarioSetup = scenario.setup ?? { copyWorkspaceToTemp: false, fixtures: [] };
    const operation: GlobalScenarioOperation = scenario.operation ?? { kind: "validator_only" };
    // #1: scripted_patch MUST always run on a temp copy to protect committed fixtures.
    const mustUseTemp = setup.copyWorkspaceToTemp || operation.kind === "scripted_patch";
    if (mustUseTemp) {
      tempWorkspace = await mkdtemp(path.join(tmpdir(), "rector-global-temp-"));
      await copyWorkspaceToTemp({ src: scenarioWorkspace, dest: tempWorkspace });
      effectiveWorkspace = tempWorkspace;
    }
    // #7: copy declared setup.fixtures into effectiveWorkspace (SafeRelativePath already validated by schema).
    if (setup.fixtures && setup.fixtures.length > 0) {
      for (const f of setup.fixtures) {
        const src = path.resolve(repoRoot, f);
        const dst = path.resolve(effectiveWorkspace, path.basename(f));
        await fs.copyFile(src, dst);
      }
    }

    const expected: GlobalScenarioExpected = scenario.expected;

    const beforeHashes = new Map<string, string>();
    for (const p of expected.changedPaths.concat(expected.unchangedPaths)) {
      const abs = path.resolve(effectiveWorkspace, p);
      if (await fs.access(abs).then(() => true).catch(() => false)) beforeHashes.set(p, await sha256File(abs));
    }
    const beforeManifest = await computeWorkspaceManifest({ root: effectiveWorkspace });

    if (operation.kind === "scripted_patch" && operation.patchFile) {
      const patchAbs = path.resolve(effectiveWorkspace, operation.patchFile);
      // Build allowed target set: expected.changedPaths + any explicitly declared setup-only allowed paths.
      // For this task we treat setup-only allowed paths as empty unless future schema adds a field; containment uses changedPaths.
      const allowed = new Set<string>(expected.changedPaths);
      const containment = await validateScriptedPatchTargets(patchAbs, allowed);
      if (!containment.ok) {
        skipWithRegression(`scripted_patch rejected: ${containment.reason}`);
        if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
        continue;
      }
      // git apply --check first, then apply.
      const check = spawnSync("git", ["apply", "--check", "-C0", patchAbs], { cwd: effectiveWorkspace, encoding: "utf8" });
      if (check.status !== 0) {
        skipWithRegression("git apply --check failed");
        if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
        continue;
      }
      const apply = spawnSync("git", ["apply", "-C0", patchAbs], { cwd: effectiveWorkspace, encoding: "utf8" });
      if (apply.status !== 0) {
        skipWithRegression("git apply failed");
        if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
        continue;
      }
    }

    const validatorRuns = scenario.validators.map((validator) => runValidator({ validator, workspaceRoot: effectiveWorkspace, env }));

    const validatorRunsStored: readonly ValidatorRun[] = validatorRuns.map((v) => ({
      command: v.command,
      exitCode: v.exitCode,
      output: v.outputRedacted,
      outputRedacted: v.outputRedacted,
      durationMs: v.durationMs,
      timedOut: v.timedOut,
    }));

    // afterManifest + afterHashes captured AFTER validators so safety/manifest-diff sees real mutations.
    const afterManifest = await computeWorkspaceManifest({ root: effectiveWorkspace });
    const afterHashes = new Map<string, string>();
    for (const p of expected.changedPaths.concat(expected.unchangedPaths)) {
      const abs = path.resolve(effectiveWorkspace, p);
      if (await fs.access(abs).then(() => true).catch(() => false)) afterHashes.set(p, await sha256File(abs));
    }

    // B4(wiring): emit dry-run SpecialistTaskPacket + RunEvent[] trace per executed scenario.
    // All events validated under RunEventSchema; phases from RunPhaseSchema only. No specialist/provider execution.
    const allowed = scenario.allowedSystems;
    const forbidden = scenario.forbiddenSystems;
    const packet = buildTaskPacket({
      systemId: scenario.expectedSpecialist,
      userGoal: scenario.userGoal,
      successCriteria: scenario.successCriteria,
      allowedScopes: scenario.validators.map((v) => v.id),
      forbiddenScopes: [],
      validationRequirements: scenario.validators.map((v) => v.cmd),
    });
    SpecialistTaskPacketSchema.parse(packet);

    // Build canonical trace: RUN_CREATED, PHASE_CHANGED, >=1 TOOL_INVOKED per validator, completions, RUN_COMPLETED.
    const phases: ReturnType<typeof RunPhaseSchema.parse>[] = ["CHAT_RECEIVED", "TRIAGE", "EXECUTING", "VALIDATING", "DONE"];
    const baseEvents = buildRunTrace(`run-${scenario.id}`, phases, {
      dryRun: true,
      scenarioId: scenario.id,
      selectedSystemId: scenario.expectedSpecialist,
    });
    const toolEvents: ReturnType<typeof RunEventSchema.parse>[] = [];
    scenario.validators.forEach((v, idx) => {
      const invoked = RunEventSchema.parse({
        id: `evt-tool-invoked-${scenario.id}-${idx}`,
        runId: `run-${scenario.id}`,
        type: "TOOL_INVOKED",
        phase: "EXECUTING",
        payload: { validatorId: v.id, cmd: v.cmd, dryRun: true, selectedSystemId: scenario.expectedSpecialist },
        createdAt: new Date().toISOString(),
      });
      const completed = RunEventSchema.parse({
        id: `evt-tool-completed-${scenario.id}-${idx}`,
        runId: `run-${scenario.id}`,
        type: validatorRuns[idx]?.exitCode === 0 ? "TOOL_COMPLETED" : "VALIDATION_FAILED",
        phase: "VALIDATING",
        payload: { validatorId: v.id, exitCode: validatorRuns[idx]?.exitCode ?? -1, dryRun: true, usedSystemId: scenario.expectedSpecialist },
        createdAt: new Date().toISOString(),
      });
      toolEvents.push(invoked, completed);
    });
    let runEvents = [...baseEvents, ...toolEvents];
    if (scenario.expected.runEventTracePath) {
      const traceRaw = JSON.parse(await fs.readFile(path.resolve(effectiveWorkspace, scenario.expected.runEventTracePath), "utf8"));
      const traceEvents = Array.isArray(traceRaw) ? traceRaw : traceRaw.events;
      runEvents = [...runEvents, ...traceEvents.map((event: unknown) => RunEventSchema.parse(event))];
    }
    runEvents.forEach((ev) => RunEventSchema.parse(ev));

    let memoryAssertion: MemoryAssertion | undefined;
    if (scenario.expected.memoryAssertionPath) {
      memoryAssertion = MemoryAssertionSchema.parse(
        JSON.parse(await fs.readFile(path.resolve(effectiveWorkspace, scenario.expected.memoryAssertionPath), "utf8")),
      );
    }

    const harnessFacts = globalHarnessResultToFacts({
      scenario,
      trace: runEvents,
      options: { runId: `run-${scenario.id}` },
    });

    const realScorecard = await buildScorecard({
      scenario,
      repoRoot: effectiveWorkspace,
      validatorRuns,
      fakePathStatus,
      fakeFindingCount,
      beforeHashes: Object.fromEntries(beforeHashes),
      afterHashes: Object.fromEntries(afterHashes),
      workspaceBeforeHashes: Object.fromEntries(beforeManifest.map((e) => [e.path, e.sha256])),
      workspaceAfterHashes: Object.fromEntries(afterManifest.map((e) => [e.path, e.sha256])),
      runEvents,
      artifactRecords: buildProducedArtifactRecords({
        runEvents,
        validators: scenario.validators,
        beforeHashes,
        afterHashes,
        packet,
        allowed,
        forbidden,
        fakePathStatus,
        harnessFactCount: harnessFacts.length,
      }),
      packet,
      allowed,
      forbidden,
      memoryAssertion,
    });

    const actualStatus: "passed" | "failed" | "skipped" = realScorecard.passed ? "passed" : "failed";
    const scenarioFileName = scenarioFiles.get(scenario.id) ?? `${scenario.id}.scenario.yaml`;
    outcomes.push({
      scenarioId: scenario.id,
      scorecard: realScorecard,
      validatorRuns: validatorRunsStored,
      taskPacket: packet,
      runEvents,
      artifactRefs: scenario.oracles.mustIncludeEvidence,
      validationRefs: scenario.validators.map((v) => v.id),
      actualStatus,
      expectedStatus: scenario.expected.status,
      scenarioFile: scenarioFileName,
    });

    // After hashes + manifest diff for safety (detect undeclared changes).
    const manifestChanged = beforeManifest.length !== afterManifest.length || beforeManifest.some((b, i) => b.sha256 !== afterManifest[i]?.sha256);

    if (!realScorecard.passed) {
      const failedWithIdx = validatorRuns
        .map((run, idx) => ({ run, idx }))
        .filter(({ run, idx }) => run.exitCode !== (scenario.validators[idx]?.expectedExitCode ?? 0));
      const failedValidatorsRaw = failedWithIdx.map(({ run }) => run);
      const failedDims = failedGatedDimensions(realScorecard);
      const dimsClause = failedDims.length > 0 ? ` failed gated dimension(s): ${failedDims.join(", ")}.` : "";

      const failedValidatorsStored: readonly ValidatorRun[] = failedValidatorsRaw.map((v) => ({
        command: v.command,
        exitCode: v.exitCode,
        output: v.outputRedacted,
        outputRedacted: v.outputRedacted,
        durationMs: v.durationMs,
        timedOut: v.timedOut,
      }));

      const baseCd = scenario.workspace;
      const validatorPart = failedValidatorsRaw.map((v) => v.command).join(" && ");
      const replayCommand = (operation.kind === "scripted_patch" && operation.patchFile)
        ? `cd ${baseCd} && git apply -C0 ${operation.patchFile} && ${validatorPart}`
        : `cd ${baseCd} && ${validatorPart}`;

      const artifact: RegressionArtifact = {
        schemaVersion: "rector.regression-artifact.v1",
        scenarioId: scenario.id,
        workspace: scenario.workspace,
        tempWorkspace: tempWorkspace,
        operation: operation ? { kind: operation.kind, patchFile: operation.patchFile } : undefined,
        failedValidators: failedWithIdx.map(({ run: v, idx }) => ({
          id: scenario.validators[idx]?.id ?? `v${idx}`,
          command: v.command,
          args: scenario.validators[idx]?.args ?? [],
          exitCode: v.exitCode,
          stdoutRedacted: v.outputRedacted,
          stderrRedacted: "",
          durationMs: v.durationMs,
          timedOut: v.timedOut,
        })),
        beforeHashes: Array.from(beforeHashes.entries()).map(([p, h]) => ({ path: p, sha256: h })),
        afterHashes: Array.from(afterHashes.entries()).map(([p, h]) => ({ path: p, sha256: h })),
        manifestDiffSummary: manifestChanged ? "manifest-changed" : "no-manifest-change",
      failedDimensions: [...failedDims],
      replayCommand,
      generatedAt: now().toISOString(),
    };
    RegressionArtifactSchema.parse(artifact);
    if (shouldWrite) {
      const regressionsDir = path.join(outputDir, "regressions");
      await fs.mkdir(regressionsDir, { recursive: true });
      const jsonPath = path.join(regressionsDir, `${scenario.id}.json`);
      await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const mdLines = [
        `# Regression ${scenario.id}`,
        "",
        `Workspace: ${scenario.workspace}`,
        tempWorkspace ? `Temp: ${tempWorkspace}` : "",
        `Replay: \`${artifact.replayCommand}\``,
        "",
        `Failed dimensions: ${failedDims.join(", ") || "none"}`,
      ].filter(Boolean);
      await fs.writeFile(path.join(regressionsDir, `${scenario.id}.md`), `${mdLines.join("\n")}\n`, "utf8");
    }

    regressions.push({
      scenarioId: scenario.id,
      failedValidators: failedValidatorsStored,
      note: `Replay:${dimsClause} Re-run the validator command(s) below from the scenario workspace (${scenario.workspace}) to reproduce.`,
    });
    }

    // Clean temp workspace after validators (manifest already captured).
    if (tempWorkspace) {
      await rm(tempWorkspace, { recursive: true, force: true });
    }
  }

  const scorecards = outcomes.map((outcome) => outcome.scorecard);
  const report: GlobalHarnessReport = {
    schemaVersion: GLOBAL_REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    scenarioCount: scenarios.length,
    executedCount: outcomes.length,
    skippedCount: skipped.length,
    passedCount: scorecards.filter((scorecard) => scorecard.passed).length,
    fakePathStatus,
    fakeFindingCount,
    outcomes,
    skipped,
    regressions,
  };

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportMd = renderHarnessMarkdown(report, scorecards);

  if (!shouldWrite) {
    return { report, scorecards, skipped, reportJson, reportMd };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "global-report.json");
  const markdownPath = path.join(outputDir, "global-report.md");
  await fs.writeFile(jsonPath, reportJson, "utf8");
  await fs.writeFile(markdownPath, reportMd, "utf8");
  return { report, scorecards, skipped, reportJson, reportMd, jsonPath, markdownPath };
}
