/**
 * Feature: cloud-capable-transition, Property 14: Manual_Model_List round-trips
 * with no secret in the record.
 *
 * Validates: Requirements 3.3
 *
 * Exercises the `openai-compatible` Manual_Model_List persistence on the real
 * Settings_API (`POST /api/providers` + `GET /api/providers`, the upsert in
 * `src/api/server.ts`) through a listening Express app, mirroring the harness
 * convention in `providerLabelValidation.property.test.ts` /
 * `providerConfigApi.test.ts`. Every store is an injected in-memory double, so
 * the property is fully hermetic — ZERO disk, network, or provider calls:
 *
 *  - the non-secret Provider_Config_Store is a `createInMemoryProviderConfigStore`,
 *  - the Secret_Store is the real `createLocalSecretStore` over an in-memory
 *    `SecretFs` double + a fixed test key (no disk).
 *
 * The single property asserts, across many inputs, that upserting an
 * `openai-compatible` provider carrying a Manual_Model_List AND an `apiKey`
 * secret:
 *  - round-trips the EXACT Manual_Model_List back through the
 *    Provider_Config_Store: `GET /api/providers` returns the same list and the
 *    persisted record holds the same list (Req 3.3, persistence half);
 *  - persists the secret ONLY through the Secret_Store: the persisted
 *    non-secret record carries no `apiKey` field and no substring of the secret
 *    value anywhere in the serialized Provider_Config_Store state (Req 3.3,
 *    secret-exclusion half), while the secret's presence is reported by the
 *    Secret_Store (`secretPresent === true`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fc from "fast-check";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import {
  createLocalSecretStore,
  type SecretFs,
  type SecretStore,
} from "../src/security/secretStore";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";

// ---------------------------------------------------------------------------
// In-memory doubles + harness (mirrors providerLabelValidation.property.test.ts)
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
  configStore: ProviderConfigStore;
}

async function startHarness(): Promise<Harness> {
  const secretStore = makeSecretStore();
  const configStore = createInMemoryProviderConfigStore();
  const app = createApp(new TaskManager(), { secretStore, providerConfigStore: configStore });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, server, base: `http://localhost:${port}`, configStore };
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

/** Minimal JSON request helper built on `node:http`. */
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
// Arbitraries — Manual_Model_List identifiers, labels, and secrets
// ---------------------------------------------------------------------------

/**
 * Characters allowed in a generated model identifier. Deliberately excludes
 * whitespace, `=`, `@`, and `:` so a generated identifier can never coincide
 * with one of the outbound-redaction patterns (`Bearer `/`Basic ` schemes,
 * `key=value` inline secrets, or `scheme://userinfo@` credential URLs) in
 * `redactString`. This keeps the round-trip assertion about persistence,
 * not about redaction transforming a legitimate model id. A model id like
 * `meta-llama/Llama-3-8b` or `gpt-4o.mini_v2` is representative and safe.
 */
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./".split("");
const HEAD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/** A non-empty, redaction-inert model identifier that starts with a letter. */
const arbModelId = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...HEAD_CHARS),
      fc.array(fc.constantFrom(...ID_CHARS), { minLength: 0, maxLength: 24 }),
    )
    .map(([head, rest]) => head + rest.join(""));

/** A Manual_Model_List with at least one identifier (the meaningful case). */
const arbManualModels = (): fc.Arbitrary<string[]> =>
  fc.array(arbModelId(), { minLength: 1, maxLength: 6 });

/** Any label string with at least one non-whitespace character (a valid label). */
const arbNonBlankLabel = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

/**
 * A long, high-entropy secret value with a distinctive `sk-` prefix. The length
 * (>= 27 hex chars) makes it astronomically unlikely to appear as a substring of
 * any generated label or model id, so the "no secret substring in the persisted
 * record" assertion isolates real leakage rather than a coincidental collision.
 */
const HEX_CHARS = "0123456789abcdef".split("");
const arbSecret = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 24, maxLength: 48 })
    .map((chars) => `sk-${chars.join("")}`);

/** Build an `openai-compatible` upsert body carrying a manual list + a secret. */
function openAICompatibleBody(
  id: string,
  label: string,
  manualModels: string[],
  apiKey: string,
): Record<string, unknown> {
  return {
    id,
    kind: "openai-compatible",
    label,
    baseUrl: "https://proxy.example.test/v1",
    manualModels,
    apiKey,
  };
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe("Settings_API — Property 14: Manual_Model_List round-trips with no secret in the record (Req 3.3)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  // Validates: Requirements 3.3
  it("persists and round-trips the Manual_Model_List while keeping every secret value out of the non-secret record", async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        arbNonBlankLabel(),
        arbManualModels(),
        arbSecret(),
        async (label, manualModels, apiKey) => {
          const id = `openai-compatible:prop14-${counter++}`;

          // Upsert a record carrying the Manual_Model_List AND a secret apiKey.
          const upsert = await api(harness.base, "/api/providers", {
            method: "POST",
            body: JSON.stringify(openAICompatibleBody(id, label, manualModels, apiKey)),
          });
          expect(upsert.status).toBe(200);
          // The secret is never echoed back in the upsert response (Req 3.3).
          expect(upsert.text).not.toContain(apiKey);

          // Round-trip half: GET returns the SAME Manual_Model_List for this record.
          const list = await api(harness.base, "/api/providers");
          expect(list.status).toBe(200);
          const returned = (list.data.providers ?? []).find((p: any) => p.id === id);
          expect(returned).toBeDefined();
          expect(returned.manualModels).toEqual(manualModels);
          // The secret lives in the Secret_Store — its presence is reported, but no
          // secret value appears anywhere in the GET payload.
          expect(returned.secretPresent).toBe(true);
          expect(list.text).not.toContain(apiKey);

          // Persistence half: the Provider_Config_Store holds the SAME list and the
          // persisted non-secret record carries no secret value at all (Req 3.3).
          const state = await harness.configStore.getState();
          const persisted = state.providers.find((r) => r.id === id);
          expect(persisted).toBeDefined();
          expect(persisted?.manualModels).toEqual(manualModels);
          // No `apiKey` field is ever written onto the non-secret record...
          expect(persisted && "apiKey" in persisted).toBe(false);
          // ...and no substring of the secret value appears anywhere in the
          // serialized Provider_Config_Store state.
          expect(JSON.stringify(state)).not.toContain(apiKey);
        },
      ),
      { numRuns: 120 },
    );
  });
});
