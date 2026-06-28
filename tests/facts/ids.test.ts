import { describe, expect, it } from "vitest";

import { FACT_SCHEMA_VERSION, canonicalizeJson, createFactId } from "../../src/facts";

function semanticInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "intent",
    runId: "run-a",
    createdAt: "2026-06-28T00:00:00.000Z",
    producer: "user",
    trust: { level: "raw", validationRefs: [] },
    scope: { scopeType: "run", workspacePaths: [], graphRefs: [], taskIds: [] },
    redactionState: "none",
    provenance: [],
    intent: "Implement Phase 2A facts",
    ...overrides,
  };
}

describe("fact IDs", () => {
  it("are deterministic and stable across run IDs and timestamps", () => {
    const first = createFactId(semanticInput({ runId: "run-one", createdAt: "2026-06-28T00:00:00.000Z" }));
    const second = createFactId(semanticInput({ runId: "run-two", createdAt: "2027-01-01T00:00:00.000Z" }));

    expect(first).toBe(second);
    expect(first).toMatch(/^fact_[a-f0-9]{40}$/);
  });

  it("changes when semantically relevant fields change", () => {
    const first = createFactId(semanticInput({ intent: "Implement fact contracts" }));
    const second = createFactId(semanticInput({ intent: "Implement fact ledger" }));
    const trustChanged = createFactId(semanticInput({ trust: { level: "schema_valid", validationRefs: [] } }));

    expect(first).not.toBe(second);
    expect(first).not.toBe(trustChanged);
  });

  it("canonicalizes object key order before hashing", () => {
    const left = createFactId({ b: 2, a: { d: 4, c: 3 } });
    const right = createFactId({ a: { c: 3, d: 4 }, b: 2 });

    expect(left).toBe(right);
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("rejects non JSON-compatible values", () => {
    expect(() => createFactId({ value: () => 1 })).toThrow(/JSON-compatible/);
    expect(() => createFactId({ value: Number.NaN })).toThrow(/finite JSON numbers/);
  });

  it("rejects prototype pollution keys before hashing", () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;

    expect(() => createFactId(polluted)).toThrow(/prototype pollution/);
  });
});
