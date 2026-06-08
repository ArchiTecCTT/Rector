/**
 * Task 11.2 — Model_Probe integration test (design Area D, Req 22.1, 22.2, 29.1).
 *
 * Exercises the per-model Model_Probe end-to-end through the existing
 * connection-test path (`POST /api/setup/test-connection`) over a real Express
 * app (`createApp`) reached through a listening server, mirroring the
 * `providerConfigApi.test.ts` harness convention. The Model_Probe is the
 * model-and-deployment-aware connection test added in task 11.1: when the
 * Setup_UI tests a selected Model_Candidate it threads the candidate's `model`
 * (and, for Azure OpenAI, its `deployment`) so the single ping targets exactly
 * that candidate rather than the record's default route (Req 22.1, 22.2).
 *
 * Everything is hermetic and mock-only (Req 29.1):
 *  - the non-secret Provider_Config_Store is an in-memory double,
 *  - the Secret_Store is the real encrypted store over an in-memory backing,
 *  - the provider network is a deterministic global `fetch` double that records
 *    every outgoing request (URL + body) and never reaches a real endpoint.
 *
 * The decisive assertions inspect the recorded outgoing request to prove the
 * single ping was aimed at the SELECTED candidate:
 *  - openai-compatible / together: the request body `model` equals the selected
 *    candidate model (not the record's persisted default),
 *  - azure-openai: the selected deployment name appears in the request URL path,
 *  - and, without targeting, the ping falls back to the record default — so the
 *    targeting is what changes where the probe lands.
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
import { createFetchDouble, type FetchDouble } from "./support/byokArbitraries";

// ---------------------------------------------------------------------------
// In-memory doubles + harness (mirrors providerConfigApi.test.ts)
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
 * `fetch`. The test-connection route resolves providers with `fetchImpl: fetch`
 * (the global), which `withGlobalFetch` swaps for a deterministic double; a
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
 * route's network is made deterministic and recordable.
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

/** Parse the recorded outgoing ping body so we can assert which model it targeted. */
function recordedRequestBody(double: FetchDouble, index = 0): Record<string, unknown> {
  const recorded = double.requests[index];
  expect(recorded).toBeDefined();
  const raw = recorded.init?.body;
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

/** A minimal valid upsert body for an `openai-compatible` record (probe-ready). */
function openAICompatibleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "My Proxy",
    baseUrl: "https://proxy.example.test/v1",
    model: "record-default-model",
    ...overrides,
  };
}

/** A minimal valid upsert body for a `together` record (probe-ready). */
function togetherBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "together:main",
    kind: "together",
    label: "Together Main",
    baseUrl: "https://api.together.test/v1",
    ...overrides,
  };
}

/** A minimal valid upsert body for an `azure-openai` record with a default deployment. */
function azureBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "azure-openai:main",
    kind: "azure-openai",
    label: "Azure Main",
    azure: {
      endpoint: "https://my-azure.openai.azure.test",
      apiVersion: "2024-10-21",
      deployment: "record-default-deployment",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model_Probe — end-to-end through the connection-test path
// ---------------------------------------------------------------------------

describe("Model_Probe — per-model connection test (Req 22.1, 22.2, 29.1)", () => {
  let harness: Harness;
  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  // Req 22.1/22.2: a single probe targeting the selected candidate's model. The
  // outgoing ping body carries the SELECTED model, not the record default, and
  // exactly one network call is made.
  it("targets the selected model on an openai-compatible probe (single ping)", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(openAICompatibleBody({ apiKey: "sk-PROBE-aaaaaaaaaaaaaaaaaaaa" })),
    });

    const selectedModel = "candidate-flagship-xl";
    const fetchDouble = createFetchDouble({ status: 200, model: selectedModel, content: "pong" });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai-compatible:proxy", model: selectedModel }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe("openai-compatible:proxy");
    expect(res.data.networkAttempted).toBe(true);
    // Exactly one minimal ping.
    expect(fetchDouble.calls).toBe(1);
    // The decisive assertion: the ping targeted the SELECTED candidate model.
    expect(recordedRequestBody(fetchDouble).model).toBe(selectedModel);
  });

  // Req 22.2: without targeting, the same path falls back to the record default,
  // proving that the `model` input is what redirects the probe.
  it("falls back to the record default model when no candidate is selected", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(openAICompatibleBody({ apiKey: "sk-PROBE-bbbbbbbbbbbbbbbbbbbb" })),
    });

    const fetchDouble = createFetchDouble({ status: 200, model: "record-default-model", content: "pong" });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai-compatible:proxy" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(fetchDouble.calls).toBe(1);
    expect(recordedRequestBody(fetchDouble).model).toBe("record-default-model");
  });

  // Req 22.1/22.2: Together is route-aware; the probe sets the request model so
  // the selected candidate is targeted on the single ping.
  it("targets the selected model on a together probe", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(togetherBody({ apiKey: "sk-PROBE-cccccccccccccccccccc" })),
    });

    const selectedModel = "meta-llama/Llama-3.3-70B-Instruct-Turbo";
    const fetchDouble = createFetchDouble({ status: 200, model: selectedModel, content: "pong" });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "together:main", model: selectedModel }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(fetchDouble.calls).toBe(1);
    expect(recordedRequestBody(fetchDouble).model).toBe(selectedModel);
  });

  // Req 22.1/22.2: Azure addresses a candidate by deployment NAME, which lands in
  // the request URL path. The probe threads `deployment` so the selected
  // deployment is pinged rather than the record default.
  it("targets the selected deployment on an azure-openai probe (URL path)", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(azureBody({ apiKey: "sk-PROBE-dddddddddddddddddddd" })),
    });

    const selectedDeployment = "gpt-4o-prod-deployment";
    const fetchDouble = createFetchDouble({ status: 200, model: "gpt-4o", content: "pong" });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "azure-openai:main", deployment: selectedDeployment }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.networkAttempted).toBe(true);
    expect(fetchDouble.calls).toBe(1);
    // The decisive assertion: the single ping is aimed at the SELECTED deployment.
    const recordedUrl = fetchDouble.requests[0].url;
    expect(recordedUrl).toContain(`/openai/deployments/${encodeURIComponent(selectedDeployment)}/`);
    expect(recordedUrl).not.toContain("record-default-deployment");
  });

  // Req 22.2/29.1: a probe failure still flows through the reused path with a
  // single ping, networkAttempted:true, and a classified, redacted result — all
  // against the mocked provider (no live call).
  it("maps a failing probe on the selected model to a redacted, networkAttempted result", async () => {
    await api(harness.base, "/api/providers", {
      method: "POST",
      body: JSON.stringify(openAICompatibleBody({ apiKey: "sk-PROBE-eeeeeeeeeeeeeeeeeeee" })),
    });

    const selectedModel = "candidate-needs-access";
    const fetchDouble = createFetchDouble({ status: 403 });
    const res = await withGlobalFetch(fetchDouble, () =>
      api(harness.base, "/api/setup/test-connection", {
        method: "POST",
        body: JSON.stringify({ providerId: "openai-compatible:proxy", model: selectedModel }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.networkAttempted).toBe(true);
    expect(res.data.category).toBeDefined();
    expect(fetchDouble.calls).toBe(1);
    // Even on failure, the single ping was aimed at the selected candidate.
    expect(recordedRequestBody(fetchDouble).model).toBe(selectedModel);
  });
});
