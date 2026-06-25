#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SystemRegistry } from "../../src/systems/registry";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_PROFILES_DIR = path.join(REPO_ROOT, "src", "systems", "specialistProfiles");

/**
 * Offline specialist-contract validation runner (Phase 0.5, Todo 7).
 *
 * Loads every committed specialist profile JSON from `src/systems/specialistProfiles/`, registers
 * each through {@link SystemRegistry} (which validates against the contract schema and rejects
 * duplicate systemIds), prints one pass/fail line per profile, and exits 0 only when ALL profiles
 * are valid. Validation failures or load errors exit nonzero.
 *
 * SCOPE: contract validation ONLY — no specialist execution or routing (Phase 11/12), no model
 * calls. This proves committed profiles are well-formed and uniquely identified.
 */

export type ProfileValidationResult = {
  readonly file: string;
  readonly ok: boolean;
  readonly systemId?: string;
  readonly error?: string;
};

export type RunSpecialistContractsOutput = {
  readonly results: readonly ProfileValidationResult[];
  readonly allValid: boolean;
};

export type RunSpecialistContractsOptions = {
  readonly profilesDir?: string;
};

async function listProfileFiles(profilesDir: string): Promise<readonly string[]> {
  const entries = await fs.readdir(profilesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".profile.json"))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Validate all committed specialist profiles. Each profile is parsed as JSON and registered; a
 * single shared registry instance also catches duplicate systemIds across profiles.
 */
export async function runSpecialistSystemContracts(
  options: RunSpecialistContractsOptions = {},
): Promise<RunSpecialistContractsOutput> {
  const profilesDir = options.profilesDir ?? DEFAULT_PROFILES_DIR;
  const registry = new SystemRegistry();
  const files = await listProfileFiles(profilesDir);
  const results: ProfileValidationResult[] = [];

  for (const file of files) {
    const absolutePath = path.join(profilesDir, file);
    try {
      const raw: unknown = JSON.parse(await fs.readFile(absolutePath, "utf8"));
      const contract = registry.register(raw);
      results.push({ file, ok: true, systemId: contract.systemId });
    } catch (error) {
      results.push({ file, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { results, allValid: results.length > 0 && results.every((result) => result.ok) };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

async function main(): Promise<void> {
  const output = await runSpecialistSystemContracts();
  process.stdout.write("[specialist-contracts] validating committed specialist profiles (no execution).\n");
  if (output.results.length === 0) {
    process.stdout.write("  no specialist profiles found.\n");
    process.exitCode = 1;
    return;
  }
  for (const result of output.results) {
    if (result.ok) {
      process.stdout.write(`  PASS ${result.file} (systemId=${result.systemId})\n`);
    } else {
      process.stdout.write(`  FAIL ${result.file} — ${result.error}\n`);
    }
  }
  const passed = output.results.filter((result) => result.ok).length;
  process.stdout.write(`  ${passed}/${output.results.length} profiles valid\n`);
  process.exitCode = output.allValid ? 0 : 1;
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(`[specialist-contracts] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
