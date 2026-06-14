#!/usr/bin/env tsx
/**
 * Cold-start probe for the performance baseline.
 *
 * Spawned as a fresh Node subprocess by scripts/performance-baseline.ts.
 * Measures module import + createApp from a clean process and prints a single
 * machine-readable timing line to stdout.
 */

import { performance } from "node:perf_hooks";

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "GOOGLE_API_KEY",
  "MEM0_API_KEY",
  "CHROMA_URL",
  "CHROMA_API_KEY",
  "E2B_API_KEY",
] as const;

for (const key of PROVIDER_ENV_KEYS) {
  delete process.env[key];
}

async function main(): Promise<void> {
  const start = performance.now();
  const serverMod = await import("../src/api/server");
  const { TaskManager } = await import("../src/thalamus/router");
  serverMod.createApp(new TaskManager());
  const ms = performance.now() - start;
  console.log(`RECTOR_PERF_MS=${ms}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cold-start probe failed: ${message}`);
  process.exitCode = 1;
});