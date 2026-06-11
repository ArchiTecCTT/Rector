/**
 * Task 5.4 — Provider_Config_API tests (design section C7/C8).
 *
 * Exercises the BYOK CRUD + selection routes added in tasks 5.2/5.3 over a real
 * Express app (`createApp`) reached through a listening server, mirroring the
 * `chatApi.test.ts` harness convention. Every store is an injected in-memory
 * double so the tests are deterministic with ZERO disk, network, or provider
 * calls:
 *
 *  - the non-secret Provider_Config_Store is a `createInMemoryProviderConfigStore`,
 *  - the Secret_Store is the real `createLocalSecretStore` driven by an injectable
 *    in-memory `SecretFs` double + a fixed 32-byte test key (so the genuine
 *    encrypt/decrypt + atomic-write code path runs, but never touches disk),
 *  - the connection-test path's network is replaced by a deterministic global
 *    `fetch` double that counts its calls and never reaches a real endpoint.
 *
 * Coverage:
 *  - CRUD lifecycle: create / list / delete a provider record (Req 10.4, 10.6).
 *  - Write-once secret: a secret supplied on create persists; a later upsert
 *    WITHOUT `apiKey` retains it; responses expose `secretPresent` only and never
 *    the value (Req 11.2, 11.3, 11.6).
 *  - `secretPresent`-only responses: GET returns booleans, never values (Req 11.2).
 *  - Property 1 (no secret egress): for arbitrary generated keys, no response body
 *    from GET / POST / DELETE / active / test-connection contains the secret
 *    substring (Req 11.4, 11.6).
 *  - Unsupported/unknown provider id rejected pre-build on test-connection: 400,
 *    `networkAttempted:false`, and the fetch double sees zero calls (Req 15.6).
 *  - test-connection parity: a provider resolved from persisted config + secret
 *    performs the expected validate→single-ping behavior (Req 13.2, 15.1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import fc from "fast-check";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createLocalSecretStore, type SecretFs, type SecretStore } from "../src/security/secretStore";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { arbKeyLikeSecret, createFetchDouble, type FetchDouble } from "./support/byokArbitraries";

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
  configStore: ProviderConfigStore;
}

/** Start a fresh app on an ephemeral port with injected in-memory stores. */
async function startHarness(): Promise<Harness> {
  const secretStore = makeSecretStore();
  const configStore = createInMemoryProviderConfigStore();
  // createApp is now async (Chunk 34 wiring for memory provider resolution).
  // Await it so `app` is the real Application (not a Promise) for .listen etc.
  const app = await createApp(new TaskManager(), { secretStore, providerConfigStore: configStore });
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

/**
 * Minimal JSON request helper built on `node:http` rather than the global
 * `fetch`. The test-connection route resolves providers with `fetchImpl: fetch`
 * (the global), and some tests swap that global for a deterministic double; a
 * `node:http`-based client keeps the test's own requests independent of that
 * swap so only the server's internal provider ping is intercepted.
 */
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

/**
 * Swap the global `fetch` (which the test-connection route uses internally) for
 * a deterministic double for the duration of `fn`, then restore it. The route
 * builds providers with `fetchImpl: fetch`, so overriding the global is how the
 * route's network is made deterministic and assertable (calls counted).
 */
async function withGlobalFetch<T>(double: FetchDouble, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A minimal valid upsert body for a `together` preset record. */
function togetherBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "together:main", kind: "together", label: "Together Main", ...overrides };
}

/** A minimal valid upsert body for an `openai-compatible` record (test-connection ready). */
function openAICompatibleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "My Proxy",
    baseUrl: "https://proxy.example.test/v1",
    model: "gpt-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("Provider_Config_API — CRUD lifecycle", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("creates, lists, and deletes a provider record", async () => {
    // Create.
    const created = await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ label: "Created" })),
    });
    expect(created.status).toBe(200);
    expect(created.data.provider.id).toBe("together:main");
    expect(created.data.provider.label).toBe("Created");
    expect(created.data.provider.kind).toBe("together");
    // No secret supplied → presence is false.
    expect(created.data.provider.secretPresent).toBe(false);

    // List (the "get" surface) returns the record + an activeRoutes map.
    const listed = await api(harness.base, "/api/providers");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.data.providers)).toBe(true);
    expect(listed.data.providers).toHaveLength(1);
    expect(listed.data.providers[0].id).toBe("together:main");
    expect(listed.data.activeRoutes).toEqual({});

    // Delete.
    const deleted = await api(harness.base, "/api/providers/together:main", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.data).toEqual({ removed: true, id: "together:main" });

    // Gone.
    const afterDelete = await api(harness.base, "/api/providers");
    expect(afterDelete.data.providers).toHaveLength(0);
  });

  it("upserts by id rather than duplicating, and sets an active route", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ label: "First" })),
    });
    const updated = await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ label: "Second" })),
    });
    expect(updated.status).toBe(200);
    expect(updated.data.provider.label).toBe("Second");

    const listed = await api(harness.base, "/api/providers");
    expect(listed.data.providers).toHaveLength(1);

    const active = await api(harness.base, "/api/providers/active", {
      method: "POST",
      body: JSON.stringify({ role: "flagship", providerId: "together:main" }),
    });
    expect(active.status).toBe(200);
    expect(active.data.activeRoutes).toEqual({ flagship: "together:main" });
  });

  it("returns 404 when deleting an unknown provider id", async () => {
    const res = await api(harness.base, "/api/providers/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Write-once secret + secretPresent-only responses
// ---------------------------------------------------------------------------

describe("Provider_Config_API — write-once secret + secretPresent-only", () => {
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

    // Create WITH apiKey → the secret is persisted and stripped from the record.
    const created = await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ apiKey: secret })),
    });
    expect(created.status).toBe(200);
    expect(created.data.provider.secretPresent).toBe(true);
    // The response never carries the secret value, nor an `apiKey` field.
    expect(created.text).not.toContain(secret);
    expect(created.data.provider.apiKey).toBeUndefined();

    // The Secret_Store holds the value (keyed by the record id / secretRef).
    const storedAfterCreate = await harness.secretStore.getSecret("together:main");
    expect(storedAfterCreate).toEqual({ ok: true, value: secret });

    // Upsert again WITHOUT apiKey → the existing secret is retained unchanged.
    const updated = await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ label: "Renamed, no key" })),
    });
    expect(updated.status).toBe(200);
    expect(updated.data.provider.label).toBe("Renamed, no key");
    expect(updated.data.provider.secretPresent).toBe(true);
    expect(updated.text).not.toContain(secret);

    const storedAfterUpsert = await harness.secretStore.getSecret("together:main");
    expect(storedAfterUpsert).toEqual({ ok: true, value: secret });
  });

  it("replaces only the secret via POST /api/providers/:id/secret without echoing it", async () => {
    const first = "sk-FIRST-aaaaaaaaaaaaaaaaaaaa";
    const second = "sk-SECOND-bbbbbbbbbbbbbbbbbbbb";

    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ apiKey: first })),
    });

    const replaced = await api(harness.base, "/api/providers/together:main/secret", {
      method: "POST",
      body: JSON.stringify({ apiKey: second }),
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data).toEqual({ id: "together:main", secretPresent: true });
    expect(replaced.text).not.toContain(second);

    const stored = await harness.secretStore.getSecret("together:main");
    expect(stored).toEqual({ ok: true, value: second });
  });

  it("returns 404 when setting a secret for an unknown provider id", async () => {
    const res = await api(harness.base, "/api/providers/missing/secret", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-irrelevant-000000000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/providers reports secretPresent booleans only, never values", async () => {
    const withKey = "sk-PRESENT-cccccccccccccccccccc";

    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ id: "together:keyed", apiKey: withKey })),
    });
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ id: "together:bare" })),
    });

    const listed = await api(harness.base, "/api/providers");
    expect(listed.status).toBe(200);
    const byId = Object.fromEntries(listed.data.providers.map((p: any) => [p.id, p]));
    expect(byId["together:keyed"].secretPresent).toBe(true);
    expect(byId["together:bare"].secretPresent).toBe(false);
    // Every listed record exposes a boolean and no secret-bearing field.
    for (const provider of listed.data.providers) {
      expect(typeof provider.secretPresent).toBe("boolean");
      expect(provider.apiKey).toBeUndefined();
    }
    expect(listed.text).not.toContain(withKey);
  });
});

// ---------------------------------------------------------------------------
// test-connection: unsupported-id pre-build rejection + resolved-provider parity
// ---------------------------------------------------------------------------

describe("Provider_Config_API — test-connection", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("rejects an unknown provider id pre-build with 400 / networkAttempted:false and zero fetch calls", async () => {
    const fetchDouble = createFetchDouble();
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "not-configured" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.data.ok).toBe(false);
    expect(res.data.code).toBe("CONFIG_INVALID");
    expect(res.data.networkAttempted).toBe(false);
    // The decisive assertion: no provider was built and no network call occurred.
    expect(fetchDouble.calls).toBe(0);
  });

  it("pings a provider resolved from persisted config + secret (validate→single ping)", async () => {
    // Persist a together record + its secret so the route resolves a real provider.
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ apiKey: "sk-CONN-dddddddddddddddddddd" })),
    });

    const fetchDouble = createFetchDouble({ status: 200, model: "together-resolved-model", content: "pong" });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "together:main" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe("together:main");
    expect(res.data.model).toBe("together-resolved-model");
    expect(res.data.networkAttempted).toBe(true);
    // Exactly one ping — validate first, then a single network call.
    expect(fetchDouble.calls).toBe(1);
  });

  it("maps an HTTP failure from the resolved provider to a redacted, networkAttempted:true result", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(openAICompatibleBody({ apiKey: "sk-CONN-eeeeeeeeeeeeeeeeeeee" })),
    });

    const fetchDouble = createFetchDouble({ status: 401 });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai-compatible:proxy" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.networkAttempted).toBe(true);
    expect(fetchDouble.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property 1 — no secret egress across every Provider_Config_API response
// ---------------------------------------------------------------------------

describe("Provider_Config_API — Property 1: no secret egress (Req 11.4, 11.6)", () => {
  let harness: Harness;
  // A deterministic global fetch double so the test-connection ping never hits a
  // real endpoint and returns a fixed, secret-free body for every iteration.
  const fetchDouble = createFetchDouble({ status: 200, model: "leak-test-model", content: "pong" });
  let restoreFetch: typeof fetch;

  beforeAll(async () => {
    harness = await startHarness();
    restoreFetch = globalThis.fetch;
    globalThis.fetch = fetchDouble.fetchImpl;
  });
  afterAll(async () => {
    globalThis.fetch = restoreFetch;
    if (harness) await stopHarness(harness);
  });

  // Validates: Requirements 11.4, 11.6 (Correctness Property 1 — no secret egress).
  // NOTE: This property performs multiple sequential API roundtrips per sample (40 runs).
  // Explicit long timeout prevents intermittent 5s it() timeouts on slower envs/CI while
  // keeping numRuns reasonable (already limited to 40). Mirrors the pattern we will use
  // for equivalent Memory_Provider_API secret-egress properties in Chunk 34.
  it("never returns a submitted API key in any GET/POST/DELETE/active/test-connection response body", async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), async (secret) => {
        const id = `openai-compatible:leak-${counter++}`;
        const bodies: string[] = [];

        // POST upsert WITH the generated secret.
        bodies.push(
          (
            await api(harness.base, "/api/providers", {
              method: "POST",
              body: JSON.stringify(openAICompatibleBody({ id, apiKey: secret })),
            })
          ).text,
        );

        // GET list (secretPresent booleans only).
        bodies.push((await api(harness.base, "/api/providers")).text);

        // POST /:id/secret — write/replace the secret.
        bodies.push(
          (
            await api(harness.base, `/api/providers/${encodeURIComponent(id)}/secret`, {
              method: "POST",
              body: JSON.stringify({ apiKey: secret }),
            })
          ).text,
        );

        // POST /active — designate the provider for a role.
        bodies.push(
          (
            await api(harness.base, "/api/providers/active", {
              method: "POST",
              body: JSON.stringify({ role: "flagship", providerId: id }),
            })
          ).text,
        );

        // POST test-connection — resolved provider + secret, pinged via the double.
        bodies.push(
          (
            await api(harness.base, "/api/setup/test-connection", {
              method: "POST",
              body: JSON.stringify({ providerId: id }),
            })
          ).text,
        );

        // DELETE — remove the record + secret.
        bodies.push(
          (await api(harness.base, `/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" })).text,
        );

        // The decisive invariant: no response body contains the secret substring.
        for (const body of bodies) {
          expect(body).not.toContain(secret);
        }
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
