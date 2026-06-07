import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  createRectorStore,
  StoreConfigError,
  type PersistenceConfig,
} from "../src/store";

/**
 * Task 8.3 — Pre-I/O rejection of incomplete persistence config property test.
 *
 * **Property 13: Incomplete persistence config is rejected before I/O**
 * **Validates: Requirements 8.4**
 *
 * For any incomplete subset of the required TiDB connection fields,
 * `createRectorStore` raises a `StoreConfigError` that names the missing
 * fields, opens no network connection, and persists no records.
 *
 * The proof that no I/O is attempted is layered:
 *  - The thrown error is a `StoreConfigError` (raised by `assertCompleteTiDBConfig`),
 *    NOT the generic missing-dependency error thrown later by TiDB driver
 *    construction. The error message therefore names the missing fields and
 *    never mentions the optional `sync-mysql` driver package — confirming the
 *    factory bailed at config validation, before the driver path was reached.
 *  - A `globalThis.fetch` spy proves zero network calls were attempted.
 *  - The factory throws before returning a store, so there is no store instance
 *    on which any record could be persisted.
 *
 * Fully deterministic and network-free: no real provider or network calls.
 */

/** The TiDB connection fields that must ALL be present for the hosted path. */
const REQUIRED_TIDB_FIELDS = ["host", "port", "user", "password", "database"] as const;
type RequiredTiDBField = (typeof REQUIRED_TIDB_FIELDS)[number];

/** A concrete, well-formed value for each required field (used only when present). */
const FIELD_VALUES: Record<RequiredTiDBField, string | number> = {
  host: "gateway.tidbcloud.example",
  port: 4000,
  user: "alpha-user",
  password: "not-a-real-password",
  database: "rector",
};

type TiDBConfig = NonNullable<PersistenceConfig["tidb"]>;

/**
 * Builds a TiDB connection block that includes exactly the supplied fields and
 * omits the rest. Optionally carries the non-required `tls` flag to exercise the
 * fact that an extra optional field never substitutes for a missing required one.
 */
function buildIncompleteTiDB(included: RequiredTiDBField[], withTls: boolean): TiDBConfig {
  const tidb: TiDBConfig = {};
  for (const field of included) {
    (tidb as Record<string, unknown>)[field] = FIELD_VALUES[field];
  }
  if (withTls) tidb.tls = true;
  return tidb;
}

/**
 * Generates a PROPER subset of the required fields (length < 5) so at least one
 * required field is always missing, plus a random `tls` flag. An empty subset
 * (entirely-absent block) is included in the input space.
 */
const incompleteConfigArb: fc.Arbitrary<{ included: RequiredTiDBField[]; withTls: boolean }> = fc
  .record({
    included: fc.subarray([...REQUIRED_TIDB_FIELDS]).filter(
      (fields) => fields.length < REQUIRED_TIDB_FIELDS.length,
    ),
    withTls: fc.boolean(),
  });

describe("incomplete persistence config rejected before I/O (Property 13)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    // Spy on global fetch to prove the factory attempts zero network I/O. Any
    // invocation would throw, making an accidental network attempt loud.
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => {
      throw new Error("network I/O attempted: createRectorStore must reject before any connection");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
  });

  // Feature: productization-alpha, Property 13: Incomplete persistence config is rejected before I/O
  it("raises StoreConfigError naming the missing fields, with no network connection and no store constructed", () => {
    fc.assert(
      fc.property(incompleteConfigArb, ({ included, withTls }) => {
        const missing = REQUIRED_TIDB_FIELDS.filter((field) => !included.includes(field));
        // The proper-subset constraint guarantees at least one missing field.
        expect(missing.length).toBeGreaterThan(0);

        const tidb = buildIncompleteTiDB(included, withTls);
        // An empty included set models an entirely-absent block: pass undefined
        // for `tidb` in that case to also cover the no-block branch.
        const config: PersistenceConfig =
          included.length === 0 && !withTls
            ? { driver: "tidb" }
            : { driver: "tidb", tidb };

        let caught: unknown;
        let store: unknown;
        try {
          store = createRectorStore(config);
        } catch (error) {
          caught = error;
        }

        // The factory threw before returning any store instance — nothing exists
        // on which a record could be persisted.
        expect(store).toBeUndefined();

        // It is a configuration error raised at validation, not a driver/network error.
        expect(caught).toBeInstanceOf(StoreConfigError);

        const message = (caught as Error).message;
        // Names the missing fields...
        expect(message).toMatch(/missing/i);
        for (const field of missing) {
          expect(message).toContain(field);
        }
        // ...and was raised BEFORE driver construction, so it never mentions the
        // optional TiDB driver dependency.
        expect(message).not.toContain("sync-mysql");

        // Zero network connections were attempted.
        expect(fetchSpy).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});
