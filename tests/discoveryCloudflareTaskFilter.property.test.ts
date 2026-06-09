/**
 * Task 5.4 — Cloudflare Workers AI Discovery_Adapter task-filter property test.
 *
 * **Feature: cloud-capable-transition, Property 7: Cloudflare retains only allowed-task entries**
 * **Validates: Requirements 2.3**
 *
 * For any Cloudflare catalog response, the Cloudflare_Discovery_Adapter's
 * retained entries are exactly those whose task is one of `text-generation`,
 * `chat`, or `embeddings`, and no entry with any other task survives.
 *
 * The generator builds an arbitrary catalog whose entries carry *varied* task
 * values: allowed tasks in assorted casings / whitespace forms (the adapter
 * canonicalizes a human "Text Generation" to "text-generation"), interleaved
 * with disallowed tasks — a curated set of real Cloudflare tasks plus fully
 * arbitrary strings that never canonicalize to an allowed token. Each entry's
 * task is presented as either a bare string or a `{ name }` object, since the
 * adapter accepts both shapes. Every entry is non-deprecated so this property
 * isolates the task filter (Req 2.3) from the deprecated gating (Req 12.x).
 *
 * The oracle is the per-entry `allowed` tag, so the assertions never re-derive
 * the adapter's classification from its own output. Every run is hermetic: the
 * catalog is served through an injected `fetchImpl`, never a real network call.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const ACCOUNT_ID = "acct-prop-7";

/**
 * The exact canonical task tokens the adapter retains (Req 2.3). The adapter
 * canonicalizes a raw task by trimming, lower-casing, and collapsing internal
 * whitespace runs to single hyphens before an exact match against this set.
 */
const ALLOWED_CANONICAL = new Set(["text-generation", "chat", "embeddings"]);

/** Canonicalize a raw task token exactly as the adapter does (the test oracle). */
function canonicalizeTask(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Allowed task values in varied surface forms — exact tokens, human casing,
 * surrounding whitespace, and space-for-hyphen — each canonicalizing to one of
 * the three retained tokens.
 */
const ALLOWED_TASK_FORMS = [
  "text-generation",
  "Text Generation",
  "  text generation  ",
  "TEXT-GENERATION",
  "chat",
  "Chat",
  " CHAT ",
  "embeddings",
  "Embeddings",
  "  EMBEDDINGS",
] as const;

/**
 * Disallowed task values — real Cloudflare catalog tasks that are not one of the
 * three retained categories. None canonicalize to an allowed token.
 */
const DISALLOWED_TASK_FORMS = [
  "Image Classification",
  "Automatic Speech Recognition",
  "Object Detection",
  "Translation",
  "Text-to-Image",
  "Image Segmentation",
  "Summarization",
  "Image-to-Text",
  "Text Classification",
  "embedding", // singular — not the exact "embeddings" token
] as const;

/** One arbitrary catalog entry's intent, resolved to a concrete entry by index. */
interface EntrySpec {
  allowed: boolean;
  /** Task surface form when `allowed` is true. */
  allowedTask: string;
  /** Task surface form when `allowed` is false (curated or arbitrary string). */
  disallowedTask: string;
  /** Present the task as a `{ name }` object (true) or a bare string (false). */
  taskAsObject: boolean;
}

/**
 * An arbitrary disallowed task: either a curated real task or a fully arbitrary
 * string that does not canonicalize to an allowed token. An empty/whitespace
 * string is a valid disallowed task too (the adapter discards an unclassifiable
 * task), so only the allowed tokens are filtered out.
 */
const arbDisallowedTask: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...DISALLOWED_TASK_FORMS),
  fc.string({ maxLength: 24 }).filter((s) => !ALLOWED_CANONICAL.has(canonicalizeTask(s))),
);

const arbEntrySpec: fc.Arbitrary<EntrySpec> = fc.record({
  allowed: fc.boolean(),
  allowedTask: fc.constantFrom(...ALLOWED_TASK_FORMS),
  disallowedTask: arbDisallowedTask,
  taskAsObject: fc.boolean(),
});

/** A stable, unique model name per index so candidates are individually trackable. */
const modelName = (index: number): string => `@cf/test/model-${index}`;

/** Build the `{ success, result }` catalog envelope from the per-entry specs. */
function buildCatalog(specs: readonly EntrySpec[]): unknown {
  const result = specs.map((spec, index) => {
    const taskName = spec.allowed ? spec.allowedTask : spec.disallowedTask;
    const entry: Record<string, unknown> = {
      id: `uuid-${index}`,
      name: modelName(index),
      task: spec.taskAsObject ? { name: taskName } : taskName,
    };
    return entry;
  });
  return { success: true, result };
}

/** The model names expected to survive filtering, split by the `allowed` tag. */
function expectedNames(specs: readonly EntrySpec[]): { retained: Set<string>; discarded: Set<string> } {
  const retained = new Set<string>();
  const discarded = new Set<string>();
  specs.forEach((spec, index) => {
    (spec.allowed ? retained : discarded).add(modelName(index));
  });
  return { retained, discarded };
}

function record(): ProviderConfigRecord {
  return {
    id: "cloudflare:prop-7",
    kind: "cloudflare",
    label: "Cloudflare",
    cloudflare: { accountId: ACCOUNT_ID },
    secretRef: "cloudflare:prop-7",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ctx(catalog: unknown): AdapterContext {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    record: record(),
    secret: "cf-token",
    fetchImpl,
    includeDeprecated: false,
  };
}

/** The set of candidate model ids the adapter returns for a catalog. */
async function discoveredIds(catalog: unknown): Promise<Set<string>> {
  const result = await cloudflareDiscoveryAdapter.discover(ctx(catalog));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return new Set();
  }
  return new Set(result.candidates.map((candidate) => candidate.modelId ?? ""));
}

describe("Feature: cloud-capable-transition, Property 7: Cloudflare retains only allowed-task entries", () => {
  // Validates: Requirements 2.3
  it("retains exactly the text-generation/chat/embeddings entries and discards every other task", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbEntrySpec, { minLength: 0, maxLength: 16 }), async (specs) => {
        const catalog = buildCatalog(specs);
        const { retained, discarded } = expectedNames(specs);

        const ids = await discoveredIds(catalog);

        // The retained set is exactly the allowed-task entries — nothing more,
        // nothing less (Req 2.3).
        expect(ids).toEqual(retained);

        // No entry carrying any other task value survives.
        for (const name of discarded) {
          expect(ids.has(name)).toBe(false);
        }

        // Every allowed-task entry is present.
        for (const name of retained) {
          expect(ids.has(name)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
