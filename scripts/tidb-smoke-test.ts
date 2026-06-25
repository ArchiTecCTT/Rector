#!/usr/bin/env tsx
// ============================================================
// TiDB Cloud persistence smoke test (manual, opt-in only).
//
// Performs a write-then-read-back cycle against the optional hosted
// TiDB Cloud persistence path and PASSES ONLY when the read-back
// record matches the written record field-for-field (Req 8.1, 8.2).
//
// This script is MANUAL and NEVER runs in CI: it is not referenced by
// any npm test/build/check script and is not invoked by the CI
// workflow. It opens a real network connection to TiDB Cloud and so
// requires real credentials, which the provider-free verification
// gates deliberately do not have (Req 8.3).
//
// It reuses the existing store factory path
// (createRectorStore / assertCompleteTiDBConfig / StoreConfigError),
// so a missing or incomplete TiDB connection block terminates BEFORE
// any network connection is attempted and reports the missing fields
// (Req 8.4); credential values never appear in any error (Req 8.5).
//
// SQLite remains the local default persistence driver; TiDB is never
// auto-selected and is only exercised when this script forces it
// (Req 8.6).
//
// Usage:
//   tsx --env-file=.env scripts/tidb-smoke-test.ts
//   npm run smoke:tidb            # convenience wrapper
//
// Required environment variables (see docs/deployment/tidb-smoke-test.md):
//   TIDB_HOST       TiDB Cloud host endpoint
//   TIDB_PORT       TiDB Cloud port (typically 4000)
//   TIDB_USER       Database user
//   TIDB_PASSWORD   Database password
//   TIDB_DATABASE   Target database/schema name
//   TIDB_TLS        Optional; TLS is on by default (TiDB Cloud requires it)
//
// Exit codes:
//   0  read-back matched the written record field-for-field
//   1  config invalid, write/read failed, or a field-for-field mismatch
// ============================================================

import { parseDeploymentEnvironment } from "../src/deployment";
import { createRectorStore, StoreConfigError, type RectorStore } from "../src/store";
import { redactString } from "../src/security/redaction.ts";

/** Deep, order-insensitive structural equality used for the field-for-field check. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
      return false;
    }
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }
  return false;
}

/** List the field names whose values differ between the written and read-back records. */
function diffFields(written: Record<string, unknown>, readBack: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(written), ...Object.keys(readBack)]);
  const mismatched: string[] = [];
  for (const key of keys) {
    if (!deepEqual(written[key], readBack[key])) mismatched.push(key);
  }
  return mismatched.sort();
}

async function main(): Promise<void> {
  // Reuse the canonical env parser, then FORCE the tidb driver so the smoke
  // test never silently passes against the in-memory baseline or local SQLite.
  const config = parseDeploymentEnvironment(process.env);
  const persistence = { ...config.persistence, driver: "tidb" as const };

  // createRectorStore validates the connection block via assertCompleteTiDBConfig
  // and throws StoreConfigError BEFORE opening any connection when it is incomplete.
  let store: RectorStore;
  try {
    store = createRectorStore(persistence);
  } catch (error) {
    if (error instanceof StoreConfigError) {
      // The message names the missing/invalid fields and contains no credential values.
      console.error(`FAIL: TiDB configuration is incomplete. ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Field-for-field write-then-read-back cycle on an isolated, uniquely-named record.
  const stamp = new Date().toISOString();
  const written = await store.createConversation({
    title: `tidb-smoke-test ${stamp}`,
    workspaceId: `smoke-${Date.now()}`,
    retentionPolicy: "ephemeral",
  });

  const readBack = await store.getConversation(written.id);

  if (!readBack) {
    console.error(`FAIL: wrote conversation ${written.id} but read-back returned no record.`);
    process.exitCode = 1;
    return;
  }

  const mismatched = diffFields(
    written as unknown as Record<string, unknown>,
    readBack as unknown as Record<string, unknown>
  );

  // Best-effort cleanup so repeated runs do not accumulate smoke-test rows.
  await store.deleteConversation(written.id).catch(() => undefined);

  if (mismatched.length > 0) {
    console.error(
      `FAIL: read-back record did not match field-for-field. Mismatched fields: ${mismatched.join(", ")}.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: TiDB write-then-read-back matched field-for-field (conversation ${written.id}).`);
}

main().catch((error: unknown) => {
  // Redact any value before printing so no credential can leak through an error.
  const message = redactString(error instanceof Error ? error.message : String(error));
  console.error(`FAIL: TiDB smoke test errored: ${message}`);
  process.exitCode = 1;
});
