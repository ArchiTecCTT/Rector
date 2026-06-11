#!/usr/bin/env tsx
// ============================================================
// Mem0 / Chroma live memory smoke test (manual, opt-in only).
//
// Performs a write-then-search-then-read-then-delete cycle against the optional
// Mem0 cloud and/or Chroma vector memory providers. PASSES ONLY when each
// exercised provider round-trip succeeds and read-back matches expectations.
//
// This script is MANUAL and NEVER runs in CI: it is not referenced by any
// npm test/build/check script and is not invoked by the CI workflow. It opens
// real network connections and requires credentials the provider-free verification
// gates deliberately do not have.
//
// Usage:
//   tsx --env-file=.env scripts/memory-live-smoke-test.ts
//   npm run smoke:memory            # convenience wrapper
//
// Required environment variables (at least one provider):
//   MEM0_API_KEY    Mem0 cloud API key (requires optional `mem0ai` package)
//   CHROMA_URL      Chroma server URL (requires optional `chromadb` package)
//   CHROMA_API_KEY  Optional Chroma auth token when the server requires it
//
// Exit codes:
//   0  all configured provider round-trips passed
//   1  missing config, optional dep missing, or a round-trip failed
// ============================================================

import { createRequire } from "node:module";

import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { defaultMemoryBudgetRun } from "../src/memory/defaultRun";
import { Mem0MemoryProvider } from "../src/memory/mem0Adapter";
import { redactString } from "../src/security/redaction";
import type { MemoryEntry } from "../src/store/schemas";

const mem0ApiKey = process.env.MEM0_API_KEY?.trim() ?? "";
const chromaUrl = process.env.CHROMA_URL?.trim() ?? "";
const chromaApiKey = process.env.CHROMA_API_KEY?.trim() ?? "";

function isOptionalPackageInstalled(packageName: string): boolean {
  const requireFromHere = createRequire(import.meta.url);
  try {
    requireFromHere(packageName);
    return true;
  } catch {
    return false;
  }
}

function uniqueContent(label: string): string {
  return `${label} ${new Date().toISOString()} smoke=${Date.now()}`;
}

async function roundTrip(
  label: string,
  provider: {
    createMemoryEntry(input: {
      layer: "episodic";
      content: string;
      tags: string[];
      source: string;
      metadata: Record<string, unknown>;
    }): Promise<MemoryEntry>;
    searchMemory(
      query?: string,
      options?: { layer?: "episodic"; limit?: number },
    ): Promise<MemoryEntry[]>;
    getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
    deleteMemoryEntry(id: string): Promise<boolean>;
  },
): Promise<void> {
  const content = uniqueContent(label);
  const created = await provider.createMemoryEntry({
    layer: "episodic",
    content,
    tags: ["rector-smoke-test"],
    source: "system",
    metadata: { suite: "memory-live-smoke-test" },
  });

  const searchResults = await provider.searchMemory("rector-smoke-test", {
    layer: "episodic",
    limit: 10,
  });
  if (!searchResults.some((entry) => entry.id === created.id)) {
    throw new Error(`${label}: search did not return the created entry ${created.id}`);
  }

  const fetched = await provider.getMemoryEntry(created.id);
  if (!fetched) {
    throw new Error(`${label}: get returned no record for ${created.id}`);
  }
  if (!fetched.content.includes("rector-smoke-test")) {
    throw new Error(`${label}: read-back content did not match expected marker`);
  }

  await provider.deleteMemoryEntry(created.id);
  const afterDelete = await provider.getMemoryEntry(created.id);
  if (afterDelete) {
    throw new Error(`${label}: entry ${created.id} still present after delete`);
  }
}

async function smokeMem0(): Promise<void> {
  if (!isOptionalPackageInstalled("mem0ai")) {
    throw new Error(
      'Mem0 smoke requires the optional "mem0ai" package. Run `npm install mem0ai` and retry.',
    );
  }

  const provider = new Mem0MemoryProvider({
    id: `mem0:smoke-${Date.now()}`,
    apiKey: mem0ApiKey,
    run: defaultMemoryBudgetRun(),
  });
  provider.validateConfig();
  await roundTrip("Mem0", provider);
  console.log("PASS: Mem0 live memory round-trip (create → search → get → delete).");
}

async function smokeChroma(): Promise<void> {
  if (!isOptionalPackageInstalled("chromadb")) {
    throw new Error(
      'Chroma smoke requires the optional "chromadb" package. Run `npm install chromadb` and retry.',
    );
  }

  const provider = new ChromaMemoryProvider({
    id: `chroma:smoke-${Date.now()}`,
    config: { baseUrl: chromaUrl },
    apiKey: chromaApiKey || undefined,
    run: defaultMemoryBudgetRun(),
  });
  provider.validateConfig();
  await roundTrip("Chroma", provider);
  console.log("PASS: Chroma live memory round-trip (create → search → get → delete).");
}

async function main(): Promise<void> {
  const runMem0 = mem0ApiKey.length > 0;
  const runChroma = chromaUrl.length > 0;

  if (!runMem0 && !runChroma) {
    console.error(
      "FAIL: memory smoke test requires at least one provider credential. " +
        "Set MEM0_API_KEY and/or CHROMA_URL (see .env.example).",
    );
    process.exitCode = 1;
    return;
  }

  const failures: string[] = [];

  if (runMem0) {
    try {
      await smokeMem0();
    } catch (error) {
      failures.push(redactString(error instanceof Error ? error.message : String(error)));
    }
  }

  if (runChroma) {
    try {
      await smokeChroma();
    } catch (error) {
      failures.push(redactString(error instanceof Error ? error.message : String(error)));
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL: memory live smoke test failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("PASS: all configured memory provider smoke checks succeeded.");
}

main().catch((error: unknown) => {
  const message = redactString(error instanceof Error ? error.message : String(error));
  console.error(`FAIL: memory live smoke test errored: ${message}`);
  process.exitCode = 1;
});