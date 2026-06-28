import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDailyTouch } from "../../src/azure/dailyTouch.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<void> {
  const result = await runDailyTouch({ repoRoot: REPO_ROOT });
  const lines = [
    "[azure:daily-touch] Azure daily ritual complete.",
    "  Services touched: Key Vault, Blob (harness + cartographer), App Insights",
    "  VM + Foundry: use Grok Build sessions separately",
    ...result.steps.map((step) => `  ${step.id}: ${step.status} — ${step.detail}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  if (!result.ok) process.exitCode = 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(`[azure:daily-touch] FAILED: ${String(error)}\n`);
    process.exitCode = 1;
  });
}