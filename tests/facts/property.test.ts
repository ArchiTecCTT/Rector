import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FACT_SCHEMA_VERSION, RectorFactSchema, createFactId, createFactScope, createFactTrust, isSafeFactPath, userProvenance, type RectorFact } from "../../src/facts";

const createdAt = "2026-06-28T00:00:00.000Z";

function factForIntent(intent: string): RectorFact {
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "intent" as const,
    runId: "run-property",
    createdAt,
    producer: "user" as const,
    provenance: [userProvenance("msg-property")],
    trust: createFactTrust("raw"),
    scope: createFactScope(),
    redactionState: "none" as const,
    intent,
  };
  return RectorFactSchema.parse({ ...draft, factId: createFactId(draft) });
}

describe("fact protocol properties", () => {
  it("schema-valid facts serialize to JSON and parse back losslessly", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), (intent) => {
        const parsed = RectorFactSchema.parse(factForIntent(intent));
        const reparsed = RectorFactSchema.parse(JSON.parse(JSON.stringify(parsed)) as unknown);
        expect(reparsed).toEqual(parsed);
      }),
      { numRuns: 100 },
    );
  });

  it("deterministic IDs are stable for arbitrary intent text", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), (intent) => {
        const first = factForIntent(intent);
        const second = factForIntent(intent);
        expect(first.factId).toBe(second.factId);
      }),
      { numRuns: 100 },
    );
  });

  it("paths containing parent traversal or empty segments are always rejected", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 8 }).filter((segment) => !segment.includes("/") && !segment.includes("\\")), { minLength: 1, maxLength: 5 }), (segments) => {
        expect(isSafeFactPath([...segments, "..", "x.ts"].join("/"))).toBe(false);
        expect(isSafeFactPath([...segments, "", "x.ts"].join("/"))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
