import { describe, expect, it } from "vitest";

import { FACT_SCHEMA_VERSION, createFactId, createFactScope, createFactTrust, diffFacts, factsEqual, type RectorFact } from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";

function fact(intent: string, overrides: Partial<RectorFact> = {}): RectorFact {
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "intent",
    runId: "run-diff",
    createdAt: CREATED_AT,
    producer: "system",
    provenance: [{ sourceType: "system" as const, systemId: "phase-2b-diff-test" }],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/diff.ts"] }),
    redactionState: "none",
    intent,
    ...overrides,
  } as Omit<RectorFact, "factId">;
  return { ...draft, factId: overrides.factId ?? createFactId(draft) } as RectorFact;
}

describe("fact diff", () => {
  it("reports added, removed, and changed facts by factId", () => {
    const unchanged = fact("unchanged");
    const removed = fact("removed");
    const changedBefore = fact("changed before");
    const changedAfter = { ...changedBefore, intent: "changed after" } as RectorFact;
    const added = fact("added");

    const diff = diffFacts([unchanged, removed, changedBefore], [changedAfter, added, unchanged]);

    expect(diff.added.map((entry) => entry.factId)).toEqual([added.factId]);
    expect(diff.removed.map((entry) => entry.factId)).toEqual([removed.factId]);
    expect(diff.changed).toEqual([{ factId: changedBefore.factId, before: changedBefore, after: changedAfter }]);
    expect(diff.unchanged.map((entry) => entry.factId)).toEqual([unchanged.factId]);
  });

  it("treats canonical JSON key order as equal", () => {
    const left = fact("same canonical", { trust: { level: "schema_valid", validationRefs: [], reason: "stable" } });
    const right = JSON.parse(JSON.stringify(left)) as RectorFact;

    expect(factsEqual([left], [right])).toBe(true);
  });

  it("rejects duplicate fact IDs in either side", () => {
    const duplicate = fact("duplicate");

    expect(() => diffFacts([duplicate, duplicate], [])).toThrow(/Duplicate factId/);
    expect(() => diffFacts([], [duplicate, duplicate])).toThrow(/Duplicate factId/);
  });

  it("does not treat corrections as mutations of superseded facts", () => {
    const original = fact("old claim");
    const correction = fact("new claim", { supersedesFactId: original.factId });

    const diff = diffFacts([original], [original, correction]);

    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([correction]);
    expect(diff.removed).toEqual([]);
  });
});
