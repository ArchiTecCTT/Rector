/**
 * Task 7.7 — Cloudflare Workers AI Discovery_Adapter filtering property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 10: Cloudflare default and deprecated filtering**
 * **Validates: Requirements 12.2, 12.3, 12.4**
 *
 * For any Cloudflare account catalog:
 *
 *   - the default result (no deprecated requested) SHALL contain only
 *     text-generation, chat, or embedding candidates (Req 12.2);
 *   - when deprecated models are not requested the result SHALL exclude every
 *     candidate marked deprecated (Req 12.3);
 *   - when deprecated models are requested the result SHALL include them
 *     (Req 12.4);
 *   - non-deprecated, kept-category candidates SHALL always be present in both
 *     modes.
 *
 * The targeted, example-based behaviors live in `discoveryCloudflareAdapter.test.ts`
 * (task 7.2); this is the exhaustive property covering arbitrary catalogs that
 * mix kept and dropped tasks with a random subset marked deprecated. The
 * adapter classifies a Cloudflare `task` from either a `{ name }` object or a
 * bare string, so the generator exercises both shapes. Every run is hermetic:
 * the catalog is served through an injected `fetchImpl`, never a real network
 * call.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import type { AdapterContext } from "../src/providers/discovery/adapters";

const ACCOUNT_ID = "acct-prop-10";

/**
 * Task names the adapter keeps: anything mentioning "embedding", "text
 * generation", or "chat" (`classifyTask`). Mixed casing exercises the
 * case-insensitive match.
 */
const KEPT_TASK_NAMES = [
  "Text Generation",
  "text generation",
  "Chat",
  "Conversational Chat",
  "Text Embeddings",
  "Embeddings",
  "Embedding",
] as const;

/**
 * Task names the adapter drops: none contain "embedding", "text generation",
 * or "chat", so `classifyTask` returns undefined for each.
 */
const DROPPED_TASK_NAMES = [
  "Image Classification",
  "Automatic Speech Recognition",
  "Object Detection",
  "Translation",
  "Text-to-Image",
  "Image Segmentation",
  "Summarization",
] as const;

/** One arbitrary catalog entry's intent, resolved to a concrete entry by index. */
interface EntrySpec {
  kept: boolean;
  keptTask: string;
  droppedTask: string;
  deprecated: boolean;
  taskAsObject: boolean;
}

const arbEntrySpec: fc.Arbitrary<EntrySpec> = fc.record({
  kept: fc.boolean(),
  keptTask: fc.constantFrom(...KEPT_TASK_NAMES),
  droppedTask: fc.constantFrom(...DROPPED_TASK_NAMES),
  deprecated: fc.boolean(),
  // Cloudflare entries carry `task` as `{ name }` or, defensively, a bare string.
  taskAsObject: fc.boolean(),
});

/** A stable, unique model name per index so candidates are individually trackable. */
const modelName = (index: number): string => `@cf/test/model-${index}`;

/** Build the `{ success, result }` catalog envelope from the per-entry specs. */
function buildCatalog(specs: readonly EntrySpec[]): unknown {
  const result = specs.map((spec, index) => {
    const taskName = spec.kept ? spec.keptTask : spec.droppedTask;
    const entry: Record<string, unknown> = {
      id: `uuid-${index}`,
      name: modelName(index),
      task: spec.taskAsObject ? { name: taskName } : taskName,
    };
    if (spec.deprecated) {
      entry.deprecated = true;
    }
    return entry;
  });
  return { success: true, result };
}

/** Names expected to survive filtering, split by deprecation. */
function expectedNames(specs: readonly EntrySpec[]): {
  keptNonDeprecated: Set<string>;
  keptDeprecated: Set<string>;
  dropped: Set<string>;
} {
  const keptNonDeprecated = new Set<string>();
  const keptDeprecated = new Set<string>();
  const dropped = new Set<string>();
  specs.forEach((spec, index) => {
    const name = modelName(index);
    if (!spec.kept) {
      dropped.add(name);
    } else if (spec.deprecated) {
      keptDeprecated.add(name);
    } else {
      keptNonDeprecated.add(name);
    }
  });
  return { keptNonDeprecated, keptDeprecated, dropped };
}

function record(): ProviderConfigRecord {
  return {
    id: "cloudflare:prop",
    kind: "cloudflare",
    label: "Cloudflare",
    cloudflare: { accountId: ACCOUNT_ID },
    secretRef: "cloudflare:prop",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ctx(catalog: unknown, includeDeprecated: boolean): AdapterContext {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    record: record(),
    secret: "cf-token",
    fetchImpl,
    includeDeprecated,
  };
}

/** The set of candidate model ids the adapter returns for a catalog + flag. */
async function discoveredIds(catalog: unknown, includeDeprecated: boolean): Promise<Set<string>> {
  const result = await cloudflareDiscoveryAdapter.discover(ctx(catalog, includeDeprecated));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return new Set();
  }
  return new Set(result.candidates.map((candidate) => candidate.modelId ?? ""));
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 10: Cloudflare default and deprecated filtering", () => {
  // Validates: Requirements 12.2, 12.3, 12.4
  it("keeps only text-generation/chat/embedding candidates and gates deprecated by the flag", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbEntrySpec, { minLength: 0, maxLength: 14 }), async (specs) => {
        const catalog = buildCatalog(specs);
        const { keptNonDeprecated, keptDeprecated, dropped } = expectedNames(specs);

        const defaultIds = await discoveredIds(catalog, false);
        const withDeprecatedIds = await discoveredIds(catalog, true);

        // Req 12.2 / 12.3: the default result is exactly the kept-category,
        // non-deprecated names — no dropped task and no deprecated model.
        expect(defaultIds).toEqual(keptNonDeprecated);
        for (const name of dropped) {
          expect(defaultIds.has(name)).toBe(false);
        }
        for (const name of keptDeprecated) {
          expect(defaultIds.has(name)).toBe(false);
        }

        // Req 12.4: requesting deprecated adds the kept-category deprecated
        // models on top of the non-deprecated ones, still excluding dropped.
        const expectedWithDeprecated = new Set([...keptNonDeprecated, ...keptDeprecated]);
        expect(withDeprecatedIds).toEqual(expectedWithDeprecated);
        for (const name of dropped) {
          expect(withDeprecatedIds.has(name)).toBe(false);
        }

        // Non-deprecated, kept-category candidates are always present in both modes.
        for (const name of keptNonDeprecated) {
          expect(defaultIds.has(name)).toBe(true);
          expect(withDeprecatedIds.has(name)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
