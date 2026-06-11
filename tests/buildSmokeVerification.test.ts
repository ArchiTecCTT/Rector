/**
 * Build / smoke verification tests (cloud-capable-transition, task 15.3).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 *
 * The build/test acceptance criteria (Req 11.1–11.4) are ultimately proven by
 * `npm run build` and `npm test` both exiting zero with the optional cloud
 * client dependencies (`sync-mysql`, `@e2b/code-interpreter`) ABSENT. This file
 * contributes the two in-suite smoke checks that make that end-to-end guarantee
 * concrete and hermetic:
 *
 *  1. The MySQL-dialect DDL is emitted for all six entity tables
 *     (conversations, messages, runs, run_events, artifacts, memories) when a
 *     `SqlRectorStore` is built over an injected `mysql`-dialect `SqlDriver`
 *     double — no real database, no network, and with the optional TiDB MySQL
 *     driver absent (the injected driver short-circuits `createTiDBDriver`).
 *
 *  2. The local + memory server (`createApp` with the default / `memory`
 *     persistence and `local` orchestration mode) boots and serves a basic
 *     request with the optional cloud client dependencies absent.
 *
 * Everything here is fully hermetic: no network, no container, no real cloud
 * database, no API key, and no reliance on either optional dependency being
 * installed (the suite first asserts both are genuinely absent).
 */
import http from "node:http";
import { createRequire } from "node:module";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import {
  createRectorStore,
  SqlRectorStore,
  type RectorStore,
  type SqlDriver,
} from "../src/store";

// The two optional cloud client peer dependencies that must NOT be required for
// the build, the local test suite, or the local + memory server to work.
const OPTIONAL_MYSQL_CLIENT = "sync-mysql";
const OPTIONAL_E2B_CLIENT = "@e2b/code-interpreter";

// The six entity tables the store maps and the Startup_Migration provisions.
const ENTITY_TABLES = ["conversations", "messages", "runs", "run_events", "artifacts", "memories"] as const;

/**
 * A recording `mysql`-dialect `SqlDriver` double. It captures every DDL string
 * the store runs on construction (the only statements `migrate()` issues) so the
 * test can assert the MySQL-dialect table layout, and performs no file or
 * network I/O. The read/write methods are inert no-ops because constructing the
 * store touches only `exec` (the DDL).
 */
function recordingMysqlDriver(): SqlDriver & { ddl: string[]; closed: boolean } {
  const ddl: string[] = [];
  const driver = {
    dialect: "mysql" as const,
    ddl,
    closed: false,
    exec(sql: string): void {
      ddl.push(sql.replace(/\s+/g, " ").trim());
    },
    run(): void {
      /* no write occurs while constructing the store */
    },
    get<T = unknown>(): T | undefined {
      return undefined;
    },
    all<T = unknown>(): T[] {
      return [] as T[];
    },
    close(): void {
      driver.closed = true;
    },
  };
  return driver;
}

describe("optional cloud dependencies are absent (task 15.3 precondition)", () => {
  const requireFromHere = createRequire(import.meta.url);

  // These guard the hermeticity of the whole file: the smoke checks below only
  // prove Req 11.3/11.4 ("optional cloud deps absent") if the deps really are
  // absent. If either is ever installed, this fails loudly rather than silently
  // weakening the guarantee.
  it("does not resolve the optional TiDB MySQL driver", () => {
    expect(() => requireFromHere.resolve(OPTIONAL_MYSQL_CLIENT)).toThrow();
  });

  it("does not resolve the optional E2B client", () => {
    expect(() => requireFromHere.resolve(OPTIONAL_E2B_CLIENT)).toThrow();
  });
});

describe("MySQL-dialect DDL is emitted for all six tables (task 15.3, Req 11.3)", () => {
  it("provisions every entity table with the MySQL dialect over an injected driver", () => {
    const driver = recordingMysqlDriver();

    // `createRectorStore` with an injected driver builds a `SqlRectorStore`
    // (not the in-memory store) over it, regardless of any configured driver,
    // and never reaches `createTiDBDriver` — so the optional `sync-mysql`
    // package is not required.
    const store = createRectorStore({ driver: "memory" }, { driver });
    expect(store).toBeInstanceOf(SqlRectorStore);

    // Exactly the six entity tables were provisioned, one DDL statement each.
    expect(driver.ddl).toHaveLength(ENTITY_TABLES.length);

    for (const table of ENTITY_TABLES) {
      const statement = driver.ddl.find((sql) =>
        new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, "i").test(sql)
      );
      expect(statement, `missing DDL for ${table}`).toBeTruthy();
      // MySQL-dialect typing the store selects when `dialect === "mysql"`:
      // VARCHAR ids/filters and a native JSON payload column.
      expect(statement).toContain("CREATE TABLE IF NOT EXISTS");
      expect(statement).toMatch(/id VARCHAR\(255\) PRIMARY KEY/i);
      expect(statement).toMatch(/payload JSON NOT NULL/i);
      // Idempotent provisioning so a re-boot never errors on existing tables.
      expect(statement).toMatch(/IF NOT EXISTS/i);
    }

    store satisfies RectorStore;
    driver.close();
  });
});

describe("local + memory server boots and serves with optional cloud deps absent (task 15.3, Req 11.4)", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    // Default options: no persistence config (=> in-memory store, no DB
    // connection) and no orchestration wiring (=> local mode). This is exactly
    // the provider-free local baseline an operator runs with the optional cloud
    // clients absent.
    app = createApp(new TaskManager());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function api(path: string, opts?: RequestInit) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return { status: res.status, data: data as Record<string, any> };
  }

  it("serves the redacted setup-status readiness summary", async () => {
    // A pure, network-free read served entirely from the in-memory baseline.
    const res = await api("/api/setup/status");
    expect(res.status).toBe(200);
    expect(res.data).toBeTypeOf("object");
  });

  it("creates and reads back a conversation against the in-memory store", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Smoke 15.3", workspaceId: "smoke-workspace" }),
    });
    expect(created.status).toBe(201);
    expect(created.data.id).toMatch(/^conv-/);

    const fetched = await api(`/api/chat/conversations/${created.data.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.data.conversation.id).toBe(created.data.id);
    expect(Array.isArray(fetched.data.messages)).toBe(true);
  });
});
