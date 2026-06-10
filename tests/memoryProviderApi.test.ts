/**
 * Chunk 36 — Memory_Provider_API tests (mirrors providerConfigApi.test.ts).
 *
 * Exercises the memory provider CRUD + selection routes over a real Express app
 * (`createApp`) reached through a listening server. Every store is an injected
 * in-memory double so the tests are deterministic with ZERO disk and network:
 *
 *  - the non-secret Memory_Config_Store is a `createInMemoryMemoryConfigStore`,
 *  - the Secret_Store is the real `createLocalSecretStore` driven by an injectable
 *    in-memory `SecretFs` double + a fixed 32-byte test key.
 *
 * Coverage:
 *  - CRUD lifecycle: create / list / delete a memory provider record.
 *  - Write-once secret: a secret supplied on create persists; a later upsert
 *    WITHOUT `apiKey` retains it; responses expose `secretPresent` only.
 *  - `secretPresent`-only responses: GET returns booleans, never values.
 *  - Property 1 (no secret egress): for arbitrary generated keys, no response body
 *    from GET / POST / DELETE / active / test-connection contains the secret.
 *  - test-connection: local kinds always succeed; external kinds validate config.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import fc from "fast-check";

import { createApp } from "../src/api/server";
import type { MemoryProvider } from "../src/memory/provider";
import { TaskManager } from "../src/thalamus/router";
import { createLocalSecretStore, type SecretFs, type SecretStore } from "../src/security/secretStore";
import {
  createInMemoryMemoryConfigStore,
  type MemoryConfigStore,
} from "../src/providers/memoryConfigStore";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

// ---------------------------------------------------------------------------
// In-memory doubles + harness
// ---------------------------------------------------------------------------

/** A path→data Map backing the real local Secret_Store code path without disk. */
function createInMemorySecretFs(): SecretFs {
  const files = new Map<string, string>();
  return {
    async readFile(path: string): Promise<string | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      const data = files.get(fromPath);
      if (data === undefined) {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      files.set(toPath, data);
      files.delete(fromPath);
    },
    async mkdir(): Promise<void> {
      // No directories to track in the in-memory double.
    },
  };
}

/** A real encrypted Secret_Store over an in-memory backing + a fixed test key. */
function makeSecretStore(): SecretStore {
  return createLocalSecretStore({
    filePath: ".rector/secrets.enc",
    encryptionKey: Buffer.alloc(32, 7),
    fsImpl: createInMemorySecretFs(),
  });
}

interface Harness {
  app: express.Application;
  server: http.Server;
  base: string;
  secretStore: SecretStore;
  configStore: MemoryConfigStore;
}

/** Start a fresh app on an ephemeral port with injected in-memory stores. */
async function startHarness(): Promise<Harness> {
  const secretStore = makeSecretStore();
  const configStore = createInMemoryMemoryConfigStore();
  const app = await createApp(new TaskManager(), { secretStore, memoryConfigStore: configStore });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, server, base: `http://localhost:${port}`, secretStore, configStore };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface ApiResult {
  status: number;
  data: any;
  text: string;
}

interface ApiOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function api(base: string, path: string, opts: ApiOptions = {}): Promise<ApiResult> {
  return new Promise<ApiResult>((resolve, reject) => {
    const url = new URL(`${base}${path}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const data = text ? JSON.parse(text) : {};
          resolve({ status: res.statusCode ?? 0, data, text });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A minimal valid upsert body for a local-inmemory record. */
function localInMemoryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "local-inmemory:default",
    kind: "local-inmemory",
    label: "Local (in-memory)",
    config: {},
    ...overrides,
  };
}

/** A minimal valid upsert body for a mem0 record (test-connection ready with apiKey). */
function mem0Body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "mem0:main",
    kind: "mem0",
    label: "Mem0 Main",
    config: { baseUrl: "https://api.mem0.test" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("Memory_Provider_API — CRUD lifecycle", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("creates, lists, and deletes a memory provider record", async () => {
    const created = await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(localInMemoryBody({ label: "Created" })),
    });
    expect(created.status).toBe(200);
    expect(created.data.provider.id).toBe("local-inmemory:default");
    expect(created.data.provider.label).toBe("Created");
    expect(created.data.provider.kind).toBe("local-inmemory");
    // `secretRef` is redacted in outbound responses (key name contains "secret").
    expect(created.data.provider.secretPresent).toBe(false);

    const listed = await api(harness.base, "/api/memory-providers");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.data.providers)).toBe(true);
    expect(listed.data.providers).toHaveLength(1);
    expect(listed.data.providers[0].id).toBe("local-inmemory:default");
    expect(listed.data.activeMemoryProviderId).toBeUndefined();

    const deleted = await api(harness.base, "/api/memory-providers/local-inmemory:default", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(deleted.data).toEqual({ removed: true, id: "local-inmemory:default" });

    const afterDelete = await api(harness.base, "/api/memory-providers");
    expect(afterDelete.data.providers).toHaveLength(0);
  });

  it("upserts by id rather than duplicating, and sets the active provider", async () => {
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(localInMemoryBody({ label: "First" })),
    });
    const updated = await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(localInMemoryBody({ label: "Second" })),
    });
    expect(updated.status).toBe(200);
    expect(updated.data.provider.label).toBe("Second");

    const listed = await api(harness.base, "/api/memory-providers");
    expect(listed.data.providers).toHaveLength(1);

    const active = await api(harness.base, "/api/memory-providers/active", {
      method: "POST",
      body: JSON.stringify({ providerId: "local-inmemory:default" }),
    });
    expect(active.status).toBe(200);
    expect(active.data.activeMemoryProviderId).toBe("local-inmemory:default");
  });

  it("returns 404 when deleting an unknown memory provider id", async () => {
    const res = await api(harness.base, "/api/memory-providers/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Write-once secret + secretPresent-only responses
// ---------------------------------------------------------------------------

describe("Memory_Provider_API — write-once secret + secretPresent-only", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("persists a secret on create and retains it across a keyless upsert (write-once)", async () => {
    const secret = "sk-WRITE-ONCE-1234567890abcdef";

    const created = await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body({ apiKey: secret })),
    });
    expect(created.status).toBe(200);
    expect(created.data.provider.secretPresent).toBe(true);
    expect(created.text).not.toContain(secret);
    expect(created.data.provider.apiKey).toBeUndefined();

    const storedAfterCreate = await harness.secretStore.getSecret("memory:mem0:main");
    expect(storedAfterCreate).toEqual({ ok: true, value: secret });

    const updated = await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body({ label: "Renamed, no key" })),
    });
    expect(updated.status).toBe(200);
    expect(updated.data.provider.label).toBe("Renamed, no key");
    expect(updated.data.provider.secretPresent).toBe(true);
    expect(updated.text).not.toContain(secret);

    const storedAfterUpsert = await harness.secretStore.getSecret("memory:mem0:main");
    expect(storedAfterUpsert).toEqual({ ok: true, value: secret });
  });

  it("replaces only the secret via POST /api/memory-providers/:id/secret without echoing it", async () => {
    const first = "sk-FIRST-aaaaaaaaaaaaaaaaaaaa";
    const second = "sk-SECOND-bbbbbbbbbbbbbbbbbbbb";

    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body({ apiKey: first })),
    });

    const replaced = await api(harness.base, "/api/memory-providers/mem0:main/secret", {
      method: "POST",
      body: JSON.stringify({ apiKey: second }),
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data).toEqual({ id: "mem0:main", secretPresent: true });
    expect(replaced.text).not.toContain(second);

    const stored = await harness.secretStore.getSecret("memory:mem0:main");
    expect(stored).toEqual({ ok: true, value: second });
  });

  it("returns 404 when setting a secret for an unknown memory provider id", async () => {
    const res = await api(harness.base, "/api/memory-providers/missing/secret", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-irrelevant-000000000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/memory-providers reports secretPresent booleans only, never values", async () => {
    const withKey = "sk-PRESENT-cccccccccccccccccccc";

    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body({ id: "mem0:keyed", apiKey: withKey })),
    });
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(localInMemoryBody({ id: "local-inmemory:bare" })),
    });

    const listed = await api(harness.base, "/api/memory-providers");
    expect(listed.status).toBe(200);
    const byId = Object.fromEntries(listed.data.providers.map((p: any) => [p.id, p]));
    expect(byId["mem0:keyed"].secretPresent).toBe(true);
    expect(byId["local-inmemory:bare"].secretPresent).toBe(false);
    for (const provider of listed.data.providers) {
      expect(typeof provider.secretPresent).toBe("boolean");
      expect(provider.apiKey).toBeUndefined();
    }
    expect(listed.text).not.toContain(withKey);
  });
});

// ---------------------------------------------------------------------------
// test-connection
// ---------------------------------------------------------------------------

describe("Memory_Provider_API — test-connection", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("returns 404 for an unknown memory provider id", async () => {
    const res = await api(harness.base, "/api/memory-providers/not-configured/test-connection", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("always succeeds for local-inmemory without network", async () => {
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(localInMemoryBody()),
    });

    const res = await api(harness.base, "/api/memory-providers/local-inmemory:default/test-connection", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe("local-inmemory:default");
    expect(res.data.kind).toBe("local-inmemory");
    expect(res.data.networkAttempted).toBe(false);
  });

  it("validates a mem0 provider resolved from persisted config + secret", async () => {
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body({ apiKey: "sk-CONN-dddddddddddddddddddd" })),
    });

    const res = await api(harness.base, "/api/memory-providers/mem0:main/test-connection", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe("mem0:main");
    expect(res.data.kind).toBe("mem0");
    expect(res.data.networkAttempted).toBe(false);
  });

  it("reports CONFIG_INVALID when mem0 has no stored secret", async () => {
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body()),
    });

    const res = await api(harness.base, "/api/memory-providers/mem0:main/test-connection", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.code).toBe("CONFIG_INVALID");
    expect(res.data.networkAttempted).toBe(false);
  });

  it("uses injectable resolveTestMemoryProvider double and redacts validateConfig errors", async () => {
    const secret = "sk-INJECTABLE-TEST-CONNECTION-1234567890";
    const doubleHarness = await startHarnessWithResolver(async () =>
      ({
        id: "mem0:main",
        kind: "mem0",
        metadata: { id: "mem0:main", kind: "mem0" },
        validateConfig() {
          throw new Error(`invalid apiKey=${secret}`);
        },
        createMemoryEntry: async () => {
          throw new Error("not used");
        },
        getMemoryEntry: async () => undefined,
        listMemoryEntries: async () => [],
        updateMemoryEntry: async () => undefined,
        deleteMemoryEntry: async () => false,
        searchMemory: async () => [],
        pruneMemory: async () => ({ pruned: 0, summarized: 0 }),
      }) satisfies MemoryProvider,
    );

    await api(doubleHarness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify(mem0Body()),
    });

    const res = await api(doubleHarness.base, "/api/memory-providers/mem0:main/test-connection", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.code).toBe("CONFIG_INVALID");
    expect(res.text).not.toContain(secret);
    await stopHarness(doubleHarness);
  });
});

async function startHarnessWithResolver(
  resolver: (
    providerId: string,
    configStore: MemoryConfigStore,
    secrets: SecretStore,
  ) => Promise<MemoryProvider | undefined>,
): Promise<Harness> {
  const secretStore = makeSecretStore();
  const configStore = createInMemoryMemoryConfigStore();
  const app = await createApp(new TaskManager(), {
    secretStore,
    memoryConfigStore: configStore,
    resolveTestMemoryProvider: resolver,
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, server, base: `http://localhost:${port}`, secretStore, configStore };
}

// ---------------------------------------------------------------------------
// Property 1 — no secret egress across every Memory_Provider_API response
// ---------------------------------------------------------------------------

describe("Memory_Provider_API — Property 1: no secret egress", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it(
    "never returns a submitted API key in any GET/POST/DELETE/active/test-connection response body",
    async () => {
      let counter = 0;
      await fc.assert(
        fc.asyncProperty(arbKeyLikeSecret(), async (secret) => {
          const id = `mem0:leak-${counter++}`;
          const bodies: string[] = [];

          bodies.push(
            (
              await api(harness.base, "/api/memory-providers", {
                method: "POST",
                body: JSON.stringify(
                  mem0Body({
                    id,
                    config: { baseUrl: "https://api.mem0.test" },
                    apiKey: secret,
                  }),
                ),
              })
            ).text,
          );

          bodies.push((await api(harness.base, "/api/memory-providers")).text);

          bodies.push(
            (
              await api(harness.base, `/api/memory-providers/${encodeURIComponent(id)}/secret`, {
                method: "POST",
                body: JSON.stringify({ apiKey: secret }),
              })
            ).text,
          );

          bodies.push(
            (
              await api(harness.base, "/api/memory-providers/active", {
                method: "POST",
                body: JSON.stringify({ providerId: id }),
              })
            ).text,
          );

          bodies.push(
            (
              await api(harness.base, `/api/memory-providers/${encodeURIComponent(id)}/test-connection`, {
                method: "POST",
                body: JSON.stringify({}),
              })
            ).text,
          );

          bodies.push(
            (await api(harness.base, `/api/memory-providers/${encodeURIComponent(id)}`, { method: "DELETE" }))
              .text,
          );

          for (const body of bodies) {
            expect(body).not.toContain(secret);
          }
        }),
        { numRuns: 40 },
      );
    },
    120_000,
  );
});