/**
 * Compiled cold-start probe for the performance baseline.
 *
 * Spawned as a fresh Node subprocess (no tsx). Requires `npm run build` first.
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
];

for (const key of PROVIDER_ENV_KEYS) {
  delete process.env[key];
}

const start = performance.now();
const serverMod = await import("../dist/api/server.js");
const { TaskManager } = await import("../dist/thalamus/router.js");
serverMod.createApp(new TaskManager());
const ms = performance.now() - start;
console.log(`RECTOR_PERF_MS=${ms}`);