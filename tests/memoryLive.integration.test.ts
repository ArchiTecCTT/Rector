import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { evaluateMemoryBudget, MEMORY_OP_COST_USD } from "../src/memory/budget";
import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { defaultMemoryBudgetRun } from "../src/memory/defaultRun";
import { Mem0MemoryProvider } from "../src/memory/mem0Adapter";
import { redactSecrets, redactString } from "../src/security/redaction";
import type { CreateMemoryEntryInput, MemoryEntry } from "../src/store/schemas";

/**
 * Chunk 37 — Opt-in live Mem0 / Chroma memory integration tests.
 *
 * These tests open real network connections and are skipped unless credentials are
 * present in the environment. They never run in the default provider-free CI path:
 * `describe.skipIf` gates the entire file when neither MEM0_API_KEY nor CHROMA_URL
 * is set, so `npm test` skips them cleanly without failure.
 *
 * Manual opt-in:
 *   MEM0_API_KEY=... npm test -- tests/memoryLive.integration.test.ts
 *   CHROMA_URL=http://localhost:8000 npm test -- tests/memoryLive.integration.test.ts
 *   npm run smoke:memory
 */

const mem0ApiKey = process.env.MEM0_API_KEY?.trim() ?? "";
const chromaUrl = process.env.CHROMA_URL?.trim() ?? "";
const chromaApiKey = process.env.CHROMA_API_KEY?.trim() ?? "";

const hasMem0Credentials = mem0ApiKey.length > 0;
const hasChromaCredentials = chromaUrl.length > 0;
const hasAnyCredentials = hasMem0Credentials || hasChromaCredentials;

const KNOWN_SECRETS = [mem0ApiKey, chromaApiKey].filter((value) => value.length > 0);

function isOptionalPackageInstalled(packageName: string): boolean {
  const requireFromHere = createRequire(import.meta.url);
  try {
    requireFromHere(packageName);
    return true;
  } catch {
    return false;
  }
}

const mem0PackageInstalled = isOptionalPackageInstalled("mem0ai");
const chromaPackageInstalled = isOptionalPackageInstalled("chromadb");

/** Assert redacted serialized content never contains raw credential material. */
function assertRedactedNoSecrets(value: unknown): void {
  const redacted = redactSecrets(value);
  const serialized = JSON.stringify(redacted);
  for (const secret of KNOWN_SECRETS) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toMatch(/Bearer\s+[^\s,;]+/i);
}

function uniqueTestContent(label: string): string {
  return `${label} ${new Date().toISOString()} pid=${process.pid}`;
}

async function roundTripMemoryProvider(
  provider: {
    createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
    searchMemory(
      query?: string,
      options?: { layer?: "episodic"; limit?: number },
    ): Promise<MemoryEntry[]>;
    getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
    deleteMemoryEntry(id: string): Promise<boolean>;
  },
  content: string,
): Promise<void> {
  const created = await provider.createMemoryEntry({
    layer: "episodic",
    content,
    tags: ["rector-live-test", "integration"],
    source: "system",
    metadata: { suite: "memoryLive.integration" },
  });

  assertRedactedNoSecrets(created);
  expect(created.id).toBeTruthy();
  expect(redactString(created.content)).toContain("rector-live-test");

  const searchResults = await provider.searchMemory("rector-live-test", {
    layer: "episodic",
    limit: 10,
  });
  assertRedactedNoSecrets(searchResults);
  expect(searchResults.some((entry) => entry.id === created.id)).toBe(true);

  const fetched = await provider.getMemoryEntry(created.id);
  assertRedactedNoSecrets(fetched);
  expect(fetched?.id).toBe(created.id);
  expect(redactString(fetched?.content ?? "")).toContain("rector-live-test");

  const deleted = await provider.deleteMemoryEntry(created.id);
  expect(deleted).toBe(true);
  expect(await provider.getMemoryEntry(created.id)).toBeUndefined();
}

describe.skipIf(!hasAnyCredentials)("live Mem0 / Chroma memory integration (chunk 37)", () => {
  describe.skipIf(!hasMem0Credentials)("Mem0 live provider", () => {
    it.skipIf(!mem0PackageInstalled)(
      "round-trips create → search → get → delete with real mem0ai client",
      async () => {
        const provider = new Mem0MemoryProvider({
          id: `mem0:live-test-${Date.now()}`,
          apiKey: mem0ApiKey,
          run: defaultMemoryBudgetRun(),
        });
        provider.validateConfig();

        await roundTripMemoryProvider(provider, uniqueTestContent("mem0-live-round-trip"));
      },
      60_000,
    );

    it.skipIf(!mem0PackageInstalled)(
      "budget preflight passes with synthetic run before live operations",
      () => {
        const run = defaultMemoryBudgetRun();
        for (const op of Object.keys(MEMORY_OP_COST_USD) as Array<keyof typeof MEMORY_OP_COST_USD>) {
          const decision = evaluateMemoryBudget(run, {
            estimatedUsd: MEMORY_OP_COST_USD[op],
            provider: "mem0",
          });
          expect(decision.status).toBe("allowed");
          assertRedactedNoSecrets(decision);
        }
      },
    );
  });

  describe.skipIf(!hasChromaCredentials)("Chroma live provider", () => {
    it.skipIf(!chromaPackageInstalled)(
      "round-trips create → search → get → delete against CHROMA_URL",
      async () => {
        const provider = new ChromaMemoryProvider({
          id: `chroma:live-test-${Date.now()}`,
          config: { baseUrl: chromaUrl },
          apiKey: chromaApiKey || undefined,
          run: defaultMemoryBudgetRun(),
        });
        provider.validateConfig();

        await roundTripMemoryProvider(provider, uniqueTestContent("chroma-live-round-trip"));
      },
      60_000,
    );

    it.skipIf(!chromaPackageInstalled)(
      "budget preflight passes with synthetic run before live operations",
      () => {
        const run = defaultMemoryBudgetRun();
        for (const op of Object.keys(MEMORY_OP_COST_USD) as Array<keyof typeof MEMORY_OP_COST_USD>) {
          const decision = evaluateMemoryBudget(run, {
            estimatedUsd: MEMORY_OP_COST_USD[op],
            provider: "chroma",
          });
          expect(decision.status).toBe("allowed");
          assertRedactedNoSecrets(decision);
        }
      },
    );
  });
});