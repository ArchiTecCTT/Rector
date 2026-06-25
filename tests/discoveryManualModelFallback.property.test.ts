/**
 * Task 5.9 — OpenAI-compatible Discovery_Adapter manual-model fallback property test.
 *
 * **Feature: cloud-capable-transition, Property 12: Manual-model fallback builds one valid candidate per identifier**
 * **Validates: Requirements 3.5, 3.6**
 *
 * For any Manual_Model_List that contains at least one non-blank identifier,
 * whenever the `GET {baseUrl}/v1/models` endpoint is unusable — the request
 * throws (transport failure / abort-timeout), returns a non-OK HTTP status,
 * returns no usable entries (an empty or unrecognizable catalog), or no base
 * URL is configured at all — the {@link openaiCompatibleDiscoveryAdapter} SHALL
 * build the discovery result from the Manual_Model_List instead of returning a
 * Discovery_Error (Req 3.5), emitting exactly one Model_Candidate per
 * de-duplicated, non-blank identifier, each of which:
 *
 *   - validates against {@link ModelCandidateSchema} (Req 3.6);
 *   - carries a `modelId` equal to the trimmed identifier (matching model id);
 *   - preserves first-seen order with no duplicate identifier.
 *
 * The targeted, example-based behaviors live in
 * `discoveryOpenAICompatibleAdapter.test.ts`; this is the exhaustive property
 * covering arbitrary manual lists (mixing blanks, whitespace-padding, and
 * duplicates) against every flavor of unusable endpoint. Every run is hermetic:
 * the endpoint is served through an injected `fetchImpl`, never a real network
 * call, and the no-base-URL case installs a guard `fetchImpl` that fails if it
 * is ever invoked.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import type { AdapterContext } from "../src/providers/discovery/adapters";
import { ModelCandidateSchema } from "../src/providers/discovery/types";

const BASE_URL = "https://proxy.example.com";
const MANUAL_SOURCE = "openai-compatible:manual";

/** Leading/trailing whitespace used to pad a valid identifier (exercises trimming). */
const arbPad = fc.constantFrom("", " ", "  ", "\t", " \n ");

/** A core identifier that is non-blank once trimmed. */
const arbCore = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);

/** A valid manual identifier: a non-blank core optionally padded with whitespace. */
const arbValidEntry = fc.tuple(arbPad, arbCore, arbPad).map(([l, c, r]) => `${l}${c}${r}`);

/** A blank identifier the adapter must drop (empty or whitespace-only). */
const arbBlankEntry = fc.constantFrom("", " ", "   ", "\t", "\n", "  \t ");

/** One manual-list entry: weighted toward valid identifiers, with some blanks. */
const arbEntry = fc.oneof(
  { weight: 3, arbitrary: arbValidEntry },
  { weight: 1, arbitrary: arbBlankEntry },
);

/** A Manual_Model_List with at least one non-blank identifier (blanks/dupes allowed). */
const arbManualModels = fc
  .array(arbEntry, { minLength: 1, maxLength: 14 })
  .filter((list) => list.some((entry) => entry.trim().length > 0));

/** Non-OK HTTP statuses the endpoint may return. */
const arbStatus = fc.constantFrom(400, 401, 403, 404, 408, 429, 500, 502, 503);

/** The ways the `/v1/models` endpoint can be unusable, forcing the manual fallback. */
type EndpointMode =
  | { type: "throw" } // transport failure / aborted timeout
  | { type: "status"; status: number } // non-OK HTTP status
  | { type: "empty" } // 200 with no usable entries
  | { type: "garbage" } // 200 with an unrecognizable payload
  | { type: "invalidJson" } // 200 with a non-JSON body
  | { type: "noBaseUrl" }; // no base URL configured (no request is made)

const arbMode: fc.Arbitrary<EndpointMode> = fc.oneof(
  fc.constant<EndpointMode>({ type: "throw" }),
  arbStatus.map<EndpointMode>((status) => ({ type: "status", status })),
  fc.constant<EndpointMode>({ type: "empty" }),
  fc.constant<EndpointMode>({ type: "garbage" }),
  fc.constant<EndpointMode>({ type: "invalidJson" }),
  fc.constant<EndpointMode>({ type: "noBaseUrl" }),
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build the injected `fetchImpl` that renders an unusable endpoint for the mode. */
function buildFetch(mode: EndpointMode): typeof fetch {
  switch (mode.type) {
    case "throw":
      return (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
    case "status":
      return (async () => new Response("error body", { status: mode.status })) as unknown as typeof fetch;
    case "empty":
      return (async () => jsonResponse({ object: "list", data: [] })) as unknown as typeof fetch;
    case "garbage":
      return (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;
    case "invalidJson":
      return (async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
    case "noBaseUrl":
      // No base URL is configured, so the adapter must never issue a request.
      return (async () => {
        throw new Error("fetchImpl must not be called when no base URL is configured");
      }) as unknown as typeof fetch;
  }
}

function record(manualModels: string[], baseUrl: string | undefined): ProviderConfigRecord {
  return {
    id: "openai-compatible:prop12",
    kind: "openai-compatible",
    label: "Proxy",
    baseUrl,
    manualModels,
    secretRef: "openai-compatible:prop12",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ctx(manualModels: string[], mode: EndpointMode): AdapterContext {
  const baseUrl = mode.type === "noBaseUrl" ? undefined : BASE_URL;
  return {
    record: record(manualModels, baseUrl),
    secret: "sk-test",
    fetchImpl: buildFetch(mode),
    includeDeprecated: false,
  };
}

/**
 * The de-duplicated, trimmed, non-blank identifiers in first-seen order — the
 * exact set of candidates the adapter is required to emit from the fallback.
 */
function expectedIdentifiers(manualModels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of manualModels) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

describe("Feature: cloud-capable-transition, Property 12: Manual-model fallback builds one valid candidate per identifier", () => {
  // Validates: Requirements 3.5, 3.6
  it("emits exactly one schema-valid candidate per de-duplicated manual identifier when the endpoint is unusable", async () => {
    await fc.assert(
      fc.asyncProperty(arbManualModels, arbMode, async (manualModels, mode) => {
        const expected = expectedIdentifiers(manualModels);

        const result = await openaiCompatibleDiscoveryAdapter.discover(ctx(manualModels, mode));

        // Req 3.5: the unusable endpoint falls back to the manual list rather
        // than returning a Discovery_Error.
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        const ids = result.candidates.map((candidate) => candidate.modelId);

        // Req 3.6: exactly one candidate per de-duplicated identifier, in
        // first-seen order, with a matching model id.
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);

        for (let index = 0; index < result.candidates.length; index += 1) {
          const candidate = result.candidates[index];
          // Each emitted candidate validates against ModelCandidateSchema.
          expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
          // The candidate's model id matches its source identifier.
          expect(candidate.modelId).toBe(expected[index]);
          expect(candidate.displayName).toBe(expected[index]);
          expect(candidate.source).toBe(MANUAL_SOURCE);
        }
      }),
      { numRuns: 200 },
    );
  });
});
