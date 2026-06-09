/**
 * Feature: cloud-capable-transition, Property 29: Incomplete TiDB config errors
 * naming the missing fields before any connection.
 *
 * Validates: Requirements 8.2
 *
 *   8.2 "IF the Persistence_Driver is `tidb` AND any of the required connection
 *        fields (host, port, database name, username, or password) is missing or
 *        empty, THEN THE Rector_Server SHALL raise a configuration error that
 *        names the missing field(s) before opening any network connection, and
 *        SHALL NOT begin listening on the configured port."
 *
 * For any `tidb` persistence config in which one or more of the required fields
 * (host, port, user, password, database) is missing OR blank (empty or
 * whitespace-only string / non-finite port), `createRectorStore`:
 *   - throws a `StoreConfigError` (raised by the config validator), and
 *   - the error names EXACTLY the missing/blank field(s), no more and no less, and
 *   - no network connection is attempted.
 *
 * The proof that no connection is attempted is layered:
 *   - The thrown error is a `StoreConfigError` (raised by `assertCompleteTiDBConfig`),
 *     NOT the missing-dependency error thrown later during TiDB driver
 *     construction — so the factory bailed at validation, before reaching the
 *     driver/connection path. The message therefore never mentions the optional
 *     `sync-mysql` driver package.
 *   - A `globalThis.fetch` spy proves zero network calls were attempted.
 *   - The factory throws before returning a store, so no store instance exists.
 *
 * Hermetic: fully deterministic, no real disk, network, or driver access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  createRectorStore,
  StoreConfigError,
  type PersistenceConfig,
} from "../src/store";

/** The TiDB connection fields that must ALL be present and non-blank. */
const REQUIRED_TIDB_FIELDS = ["host", "port", "user", "password", "database"] as const;
type RequiredTiDBField = (typeof REQUIRED_TIDB_FIELDS)[number];

/** A concrete, well-formed value for each required field (used when present). */
const PRESENT_VALUES: Record<RequiredTiDBField, string | number> = {
  host: "gateway.tidbcloud.example",
  port: 4000,
  user: "alpha-user",
  password: "not-a-real-password",
  database: "rector",
};

type TiDBConfig = NonNullable<PersistenceConfig["tidb"]>;
type FieldState =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "blank"; value: string | number };

/** Blank string values: empty or whitespace-only (treated as missing). */
const blankStringArb = fc
  .constantFrom("", " ", "   ", "\t", "\n", " \t \n ")
  .map((value): FieldState => ({ kind: "blank", value }));

/** Blank port values: non-finite numbers (treated as missing). */
const blankPortArb = fc
  .constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
  .map((value): FieldState => ({ kind: "blank", value }));

const stringFieldStateArb: fc.Arbitrary<FieldState> = fc.oneof(
  fc.constant<FieldState>({ kind: "present" }),
  fc.constant<FieldState>({ kind: "absent" }),
  blankStringArb,
);

const portFieldStateArb: fc.Arbitrary<FieldState> = fc.oneof(
  fc.constant<FieldState>({ kind: "present" }),
  fc.constant<FieldState>({ kind: "absent" }),
  blankPortArb,
);

/**
 * Generates a per-field state map in which AT LEAST ONE required field is
 * missing or blank (so a config error is always expected), plus a random `tls`
 * flag to confirm an extra optional field never substitutes for a required one.
 */
const incompleteConfigArb = fc
  .record({
    host: stringFieldStateArb,
    port: portFieldStateArb,
    user: stringFieldStateArb,
    password: stringFieldStateArb,
    database: stringFieldStateArb,
    withTls: fc.boolean(),
  })
  .filter((states) =>
    REQUIRED_TIDB_FIELDS.some((field) => states[field].kind !== "present"),
  );

/** Build the `tidb` block and the set of fields expected to be named missing. */
function buildConfig(states: {
  host: FieldState;
  port: FieldState;
  user: FieldState;
  password: FieldState;
  database: FieldState;
  withTls: boolean;
}): { tidb: TiDBConfig; expectedMissing: RequiredTiDBField[] } {
  const tidb: TiDBConfig = {};
  const expectedMissing: RequiredTiDBField[] = [];
  for (const field of REQUIRED_TIDB_FIELDS) {
    const state = states[field];
    if (state.kind === "present") {
      (tidb as Record<string, unknown>)[field] = PRESENT_VALUES[field];
    } else if (state.kind === "blank") {
      (tidb as Record<string, unknown>)[field] = state.value;
      expectedMissing.push(field);
    } else {
      // absent — omit the field entirely
      expectedMissing.push(field);
    }
  }
  if (states.withTls) tidb.tls = true;
  return { tidb, expectedMissing };
}

/** Parse the comma-separated field list that follows `missing:` in the message. */
function parseNamedMissing(message: string): string[] {
  const match = message.match(/missing:\s*([^.]*)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

describe("Persistence — Property 29: incomplete TiDB config errors naming the missing fields before any connection (Req 8.2)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    // Any network attempt must be loud: createRectorStore must reject first.
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => {
      throw new Error("network I/O attempted: createRectorStore must reject before any connection");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
  });

  it("names exactly the missing/blank fields and attempts no connection", () => {
    fc.assert(
      fc.property(incompleteConfigArb, (states) => {
        const { tidb, expectedMissing } = buildConfig(states);
        // The arbitrary guarantees at least one missing/blank field.
        expect(expectedMissing.length).toBeGreaterThan(0);

        const config: PersistenceConfig = { driver: "tidb", tidb };

        let caught: unknown;
        let store: unknown;
        try {
          store = createRectorStore(config);
        } catch (error) {
          caught = error;
        }

        // The factory threw before returning a store — nothing was constructed.
        expect(store).toBeUndefined();

        // It is a configuration error raised at validation, not a driver/network error.
        expect(caught).toBeInstanceOf(StoreConfigError);

        const message = (caught as Error).message;

        // Names EXACTLY the missing/blank fields — no more, no less.
        const named = parseNamedMissing(message);
        expect(new Set(named)).toEqual(new Set(expectedMissing));

        // Each present field must NOT be named as missing.
        const presentFields = REQUIRED_TIDB_FIELDS.filter(
          (field) => !expectedMissing.includes(field),
        );
        for (const field of presentFields) {
          expect(named).not.toContain(field);
        }

        // Raised BEFORE driver construction: never mentions the optional driver dep.
        expect(message).not.toContain("sync-mysql");

        // Zero network connections were attempted.
        expect(fetchSpy).not.toHaveBeenCalled();
      }),
      { numRuns: 200 },
    );
  });
});
