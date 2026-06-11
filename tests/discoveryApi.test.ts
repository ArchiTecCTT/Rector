/**
 * Task 9.2 — Discovery_API endpoint integration tests (design section C, Req 17).
 *
 * Exercises the two Discovery_API routes added in task 9.1 over a real Express
 * app (`createApp`) reached through a listening server, mirroring the
 * `providerConfigApi.test.ts` harness convention. The app is wired with the
 * default Model_Discovery_Service (NOT an injected double), so each request
 * flows route → service → per-kind adapter → `fetch`; only the network boundary
 * is mocked, keeping the test a true integration test that stays hermetic:
 *
 *  - the non-secret Provider_Config_Store is a `createInMemoryProviderConfigStore`,
 *  - the Secret_Store is the real `createLocalSecretStore` over an in-memory
 *    `SecretFs` double + a fixed 32-byte test key (genuine encrypt/decrypt, no disk),
 *  - the discovery network is replaced by a deterministic global `fetch` double
 *    that counts calls and never reaches a real endpoint. The route resolves the
 *    service with `fetchImpl: fetch` (the global), so swapping the global is how
 *    the discovery network is made deterministic and assertable.
 *
 * Coverage — both `GET /api/providers/:id/models` and
 * `POST /api/providers/:id/models/refresh`:
 *  - happy-path: a configured provider + a 2xx model list → 200, `ok:true`,
 *    normalized `candidates`, and an ISO `lastRefreshedAt` (Req 17.1, 17.2).
 *  - error: a configured provider + a 401 → 502, `ok:false`, a CLASSIFIED,
 *    redacted error (a category + a non-raw-body message) and no secret egress
 *    (Req 17.3).
 *  - not-found: an unknown provider id → 404, `ok:false`,
 *    `error.category:"not_found"`, and ZERO network calls (Req 17.4).
 *  - refresh bypasses the cache: a cached success is overwritten by a refresh
 *    that re-runs discovery against the live (now failing) network (Req 17.2).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createLocalSecretStore, type SecretFs, type SecretStore } from "../src/security/secretStore";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";

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
  const app = createApp(new TaskManager(), { secretStore, providerConfigStore: configStore });
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
 * `fetch`. The discovery routes resolve the service with `fetchImpl: fetch`
 * (the global), and these tests swap that global for a deterministic double; a
 * `node:http`-based client keeps the test's own requests independent of that
 * swap so only the server's internal discovery `fetch` is intercepted.
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

// ---------------------------------------------------------------------------
// Deterministic discovery `fetch` double
// ---------------------------------------------------------------------------

interface DiscoveryFetchDouble {
  fetchImpl: typeof fetch;
  /** Number of times the double was invoked (0 proves no network call). */
  readonly calls: number;
  /** Every URL the double was asked to fetch, in order. */
  readonly urls: string[];
}

/**
 * A deterministic `fetch` double for the discovery network. On a 2xx it returns
 * a Together-shaped model list (`{ data: [...] }`) the shared normalizer maps to
 * valid Model_Candidates; on a non-2xx it returns an empty body with that status
 * so the adapter classifies it (e.g. 401 → `auth_invalid`). It records its call
 * count and URLs so a "no network call" assertion is decisive.
 */
function createDiscoveryFetchDouble(opts: { status?: number; body?: unknown } = {}): DiscoveryFetchDouble {
  const state = { calls: 0, urls: [] as string[] };
  const status = opts.status ?? 200;
  const body =
    opts.body ??
    {
      data: [
        { id: "meta-llama/Llama-3-8b-chat", display_name: "Llama 3 8B Chat", type: "chat" },
        { id: "togethercomputer/m2-bert-80M", display_name: "M2 BERT", type: "embeddings" },
      ],
    };

  const fetchImpl = (async (input: unknown) => {
    state.calls += 1;
    state.urls.push(String(input));
    if (status >= 200 && status < 300) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
    urls: state.urls,
  };
}

/**
 * Swap the global `fetch` (which the discovery routes use internally via
 * `fetchImpl: fetch`) for a deterministic double for the duration of `fn`, then
 * restore it. Overriding the global is how the route's network is made
 * deterministic and assertable (calls counted).
 */
async function withGlobalFetch<T>(double: DiscoveryFetchDouble, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const PROVIDER_ID = "together:main";
const SECRET = "sk-DISCOVERY-1234567890abcdefABCDEF";

/** Persist a `together` provider record (with a secret) so discovery resolves it. */
async function seedTogetherProvider(harness: Harness): Promise<void> {
  const created = await api(harness.base, "/api/providers", {
    method: "POST",
    body: JSON.stringify({ id: PROVIDER_ID, kind: "together", label: "Together Main", apiKey: SECRET }),
  });
  expect(created.status).toBe(200);
  expect(created.data.provider.secretPresent).toBe(true);
}

// ---------------------------------------------------------------------------
// GET /api/providers/:id/models
// ---------------------------------------------------------------------------

describe("Discovery_API — GET /api/providers/:id/models", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("happy-path: returns 200 with normalized candidates + an ISO lastRefreshedAt (Req 17.1)", async () => {
    await seedTogetherProvider(harness);
    const fetchDouble = createDiscoveryFetchDouble({ status: 200 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models`),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe(PROVIDER_ID);
    expect(Array.isArray(res.data.candidates)).toBe(true);
    expect(res.data.candidates).toHaveLength(2);
    // Candidates are normalized: each carries the provider id, kind, and a model id.
    for (const candidate of res.data.candidates) {
      expect(candidate.providerId).toBe(PROVIDER_ID);
      expect(candidate.kind).toBe("together");
      expect(typeof candidate.modelId).toBe("string");
    }
    // `lastRefreshedAt` is a parseable ISO-8601 timestamp.
    expect(typeof res.data.lastRefreshedAt).toBe("string");
    expect(Number.isNaN(Date.parse(res.data.lastRefreshedAt))).toBe(false);
    // Exactly one network call was made (the native /models list succeeded).
    expect(fetchDouble.calls).toBe(1);
    // The secret never appears in the response body.
    expect(res.text).not.toContain(SECRET);
  });

  it("error: maps a 401 to a 502 with a classified, redacted error and no secret egress (Req 17.3)", async () => {
    await seedTogetherProvider(harness);
    const fetchDouble = createDiscoveryFetchDouble({ status: 401 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models`),
    );

    expect(res.status).toBe(502);
    expect(res.data.ok).toBe(false);
    expect(res.data.providerId).toBe(PROVIDER_ID);
    // The error is classified (a known category) with a non-empty message and no raw body.
    expect(res.data.error.category).toBe("auth_invalid");
    expect(typeof res.data.error.message).toBe("string");
    expect(res.data.error.message.length).toBeGreaterThan(0);
    expect(res.data.lastRefreshedAt).toBeDefined();
    // A network call was attempted but the secret never leaks into the response.
    expect(fetchDouble.calls).toBe(1);
    expect(res.text).not.toContain(SECRET);
  });

  it("not-found: an unknown provider id returns 404 / not_found with ZERO network calls (Req 17.4)", async () => {
    // No provider seeded for this id.
    const fetchDouble = createDiscoveryFetchDouble({ status: 200 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/providers/does-not-exist/models"),
    );

    expect(res.status).toBe(404);
    expect(res.data.ok).toBe(false);
    expect(res.data.error.category).toBe("not_found");
    // The decisive assertion: the unknown id short-circuited with no network call.
    expect(fetchDouble.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/providers/:id/models/refresh
// ---------------------------------------------------------------------------

describe("Discovery_API — POST /api/providers/:id/models/refresh", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("happy-path: returns 200 with normalized candidates + an ISO lastRefreshedAt (Req 17.2)", async () => {
    await seedTogetherProvider(harness);
    const fetchDouble = createDiscoveryFetchDouble({ status: 200 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models/refresh`, {
        method: "POST",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe(PROVIDER_ID);
    expect(res.data.candidates).toHaveLength(2);
    expect(typeof res.data.lastRefreshedAt).toBe("string");
    expect(Number.isNaN(Date.parse(res.data.lastRefreshedAt))).toBe(false);
    expect(fetchDouble.calls).toBe(1);
    expect(res.text).not.toContain(SECRET);
  });

  it("error: maps a 401 to a 502 with a classified, redacted error (Req 17.3)", async () => {
    await seedTogetherProvider(harness);
    const fetchDouble = createDiscoveryFetchDouble({ status: 401 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models/refresh`, {
        method: "POST",
      }),
    );

    expect(res.status).toBe(502);
    expect(res.data.ok).toBe(false);
    expect(res.data.error.category).toBe("auth_invalid");
    expect(res.data.error.message.length).toBeGreaterThan(0);
    expect(fetchDouble.calls).toBe(1);
    expect(res.text).not.toContain(SECRET);
  });

  it("not-found: an unknown provider id returns 404 / not_found with ZERO network calls (Req 17.4)", async () => {
    const fetchDouble = createDiscoveryFetchDouble({ status: 200 });

    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/providers/does-not-exist/models/refresh", { method: "POST" }),
    );

    expect(res.status).toBe(404);
    expect(res.data.ok).toBe(false);
    expect(res.data.error.category).toBe("not_found");
    expect(fetchDouble.calls).toBe(0);
  });

  it("refresh bypasses the cache: re-runs discovery against the live network, overwriting a cached success (Req 17.2)", async () => {
    await seedTogetherProvider(harness);

    // 1. A GET succeeds and caches the success result.
    const okDouble = createDiscoveryFetchDouble({ status: 200 });
    const firstGet = await withGlobalFetch(okDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models`),
    );
    expect(firstGet.status).toBe(200);
    expect(firstGet.data.ok).toBe(true);
    expect(okDouble.calls).toBe(1);

    // 2. A second GET within TTL is served from cache — no new network call.
    const cachedGet = await withGlobalFetch(okDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models`),
    );
    expect(cachedGet.status).toBe(200);
    expect(cachedGet.data.ok).toBe(true);
    expect(okDouble.calls).toBe(1);

    // 3. A refresh BYPASSES the cache and re-runs discovery against the now-failing
    //    network, returning (and caching) the live error result.
    const failDouble = createDiscoveryFetchDouble({ status: 401 });
    const refreshed = await withGlobalFetch(failDouble, () =>
      api(harness.base, `/api/providers/${encodeURIComponent(PROVIDER_ID)}/models/refresh`, {
        method: "POST",
      }),
    );
    expect(refreshed.status).toBe(502);
    expect(refreshed.data.ok).toBe(false);
    expect(refreshed.data.error.category).toBe("auth_invalid");
    // The refresh did hit the network (proving it bypassed the cached success).
    expect(failDouble.calls).toBe(1);
  });
});
