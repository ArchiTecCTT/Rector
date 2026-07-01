#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatGateRegoloLiveEvidenceResult,
  gateRegoloLiveEvidence,
  resolveGateRegoloLiveEvidenceInvocation,
} from "../../src/live/gateRegoloLiveEvidence";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function parseArgs(argv: readonly string[]): { repoRoot?: string; noManifestUpdate: boolean; harnessOnly: boolean } {
  let repoRoot: string | undefined;
  let noManifestUpdate = false;
  let harnessOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      repoRoot = argv[++index];
      if (!repoRoot) throw new Error("--repo-root requires a value");
    } else if (arg === "--no-manifest-update") {
      noManifestUpdate = true;
    } else if (arg === "--harness-only") {
      harnessOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: tsx scripts/live/gate-regolo-live-evidence.ts [--repo-root <path>] [--no-manifest-update] [--harness-only]",
          "",
          "Validates .rector/evidence/live/regolo latest harness evidence for live Z.ai verification.",
          "--harness-only skips provider-smoke and phase2 tracks and disables manifest update (diagnostic only).",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { repoRoot, noManifestUpdate, harnessOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const invocation = resolveGateRegoloLiveEvidenceInvocation({
    harnessOnly: args.harnessOnly,
    noManifestUpdate: args.noManifestUpdate,
  });
  if (invocation.harnessOnlyDiagnostic) {
    process.stderr.write(
      "[evidence:regolo-live:gate] harness-only: campaign tracks skipped; manifest update disabled (diagnostic only)\n",
    );
  }
  const result = await gateRegoloLiveEvidence({
    repoRoot: args.repoRoot ?? REPO_ROOT,
    requireCampaignTracks: invocation.requireCampaignTracks,
    updateManifestOnPass: invocation.updateManifestOnPass,
  });
  const channel = result.ok ? process.stdout : process.stderr;
  channel.write(formatGateRegoloLiveEvidenceResult(result));
  if (!result.ok) process.exit(1);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[evidence:regolo-live:gate] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}