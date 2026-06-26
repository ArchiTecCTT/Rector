#!/usr/bin/env tsx
/**
 * verify-phase0-5-complete.ts
 * Focused completion verifier for Phase 0.5 (global harness).
 * Imports schemas + helpers; performs positive + negative validations; invokes gate.
 * Exits 1 with clear message on any unmet requirement.
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GlobalScenarioSchema, SafeRelativePathSchema } from "../../src/evals/globalScenarioSchema";
import YAML from "yaml";

const REPO_ROOT = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const SCENARIOS_DIR = process.env.VERIFY_SCENARIOS_DIR || path.join(REPO_ROOT, "tests/global/scenarios");

function fail(msg: string): never {
  console.error(`[verify:phase0.5] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd: string): { code: number } {
  try {
    execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    return { code: 0 };
  } catch (e: any) {
    return { code: e.status ?? 1 };
  }
}

async function verifyScenarioCount(): Promise<void> {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".scenario.yaml"));
  if (files.length < 20) fail(`only ${files.length} scenarios (<20)`);
}

async function checkNoHardcodedProcessExit(f: string, raw: string): Promise<void> {
  if (raw.includes("process.exit(")) {
    fail(`scenario ${f} contains hardcoded process.exit stub`);
  }
}

async function checkNoBlockedEvalAliases(f: string, scenario: { validators: { cmd: string; id: string; args: string[] }[] }): Promise<void> {
  const blockedEvalArgs = ["-e", "--eval", "-p", "--print"];
  for (const validator of scenario.validators) {
    const hasEvalAlias = validator.cmd === "node" && validator.args.some((arg) => blockedEvalArgs.includes(arg));
    if (hasEvalAlias) {
      fail(`scenario ${f} validator ${validator.id} uses a blocked node eval alias`);
    }
    if (validator.args.some((arg) => arg.includes("process.exit(0)") || arg.includes("process.exit(1)"))) {
      fail(`scenario ${f} validator ${validator.id} contains hardcoded process.exit status`);
    }
  }
}

async function checkNoNpxWithoutNoInstall(f: string, raw: string): Promise<void> {
  if (raw.includes("npx ") && !raw.includes("--no-install")) {
    fail(`scenario ${f} uses npx without --no-install`);
  }
}

async function verifyScenarioContent(): Promise<void> {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".scenario.yaml"));
  for (const f of files) {
    const raw = readFileSync(path.join(SCENARIOS_DIR, f), "utf8");
    await checkNoHardcodedProcessExit(f, raw);
    const scenario = GlobalScenarioSchema.parse(YAML.parse(raw));
    await checkNoBlockedEvalAliases(f, scenario);
    await checkNoNpxWithoutNoInstall(f, raw);
  }
}

async function verifyPathSchema(): Promise<void> {
  const badPaths = ["/abs", "../up", "./lead", "C:\\win", "\\\\unc"];
  for (const p of badPaths) {
    if (SafeRelativePathSchema.safeParse(p).success) fail(`SafeRelativePathSchema accepted ${p}`);
  }
}

async function verifyGate(): Promise<void> {
  const gate = run("npm run test:global:gate");
  if (gate.code !== 0) fail(`test:global:gate exited ${gate.code} (expected 0)`);
}

async function main() {
  await verifyScenarioCount();
  await verifyScenarioContent();
  await verifyPathSchema();
  await verifyGate();

  console.log("[verify:phase0.5] PASS");
  process.exit(0);
}

main().catch((e) => fail(String(e)));
