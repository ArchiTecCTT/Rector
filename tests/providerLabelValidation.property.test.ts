/**
 * Feature: cloud-capable-transition, Property 13: Provider_Label validation
 * persists valid labels and rejects blank ones.
 *
 * Validates: Requirements 3.1, 3.2
 *
 * Exercises the `openai-compatible` Provider_Label rule on the real Settings_API
 * (`POST /api/providers`, the `UpsertProviderRequestSchema.superRefine` in
 * `src/api/server.ts`) through a listening Express app, mirroring the harness
 * convention in `providerConfigApi.test.ts`. Every store is an injected in-memory
 * double, so the property is fully hermetic — ZERO disk, network, or provider
 * calls:
 *
 *  - the non-secret Provider_Config_Store is a `createInMemoryProviderConfigStore`,
 *  - the Secret_Store is the real `createLocalSecretStore` over an in-memory
 *    `SecretFs` double + a fixed test key (no disk).
 *
 * The single property asserts both directions of the rule across many inputs:
 *  - a NON-BLANK label on an `openai-compatible` upsert is accepted (HTTP 200) and
 *    the exact label is persisted on the record in the Provider_Config_Store
 *    (Req 3.1);
 *  - a missing / empty / whitespace-only label is rejected with a validation error
 *    (HTTP 400) and NO record is persisted for that id (Req 3.2).
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
// Arbitraries — non-blank vs. blank labels
// ---------------------------------------------------------------------------

/** Any label string with at least one non-whitespace character (a valid label). */
const arbNonBlankLabel = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

/**
 * A blank label CASE for an `openai-compatible` upsert. Covers the three rejected
 * shapes the rule forbids:
 *  - `missing`: the `label` field is omitted entirely (undefined),
 *  - `empty`: an empty string `""`,
 *  - `whitespace`: a string composed solely of whitespace characters.
 * `label === null` marks the omitted case so the body builder can drop the field.
 */
type BlankLabelCase = { label: string | null; shape: "missing" | "empty" | "whitespace" };

const arbBlankLabelCase = (): fc.Arbitrary<BlankLabelCase> =>
  fc.oneof(
    fc.constant<BlankLabelCase>({ label: null, shape: "missing" }),
    fc.constant<BlankLabelCase>({ label: "", shape: "empty" }),
    fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), { minLength: 1, maxLength: 8 })
      .map<BlankLabelCase>((chars) => ({ label: chars.join(""), shape: "whitespace" })),
  );

/** Build an `openai-compatible` upsert body, dropping `label` when omitted. */
function openAICompatibleBody(id: string, label: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id,
    kind: "openai-compatible",
    baseUrl: "https://proxy.example.test/v1",
    model: "gpt-test",
  };
  if (label !== null) body.label = label;
  return body;
}

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe("Settings_API — Property 13: Provider_Label validation (Req 3.1, 3.2)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  // Validates: Requirements 3.1, 3.2
  it("persists an openai-compatible record with a non-blank label and rejects every blank label without persisting", async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        arbNonBlankLabel(),
        arbBlankLabelCase(),
        async (useValid, validLabel, blankCase) => {
          const id = `openai-compatible:prop13-${counter++}`;

          if (useValid) {
            // Req 3.1: a non-blank label is accepted and persisted verbatim.
            const res = await api(harness.base, "/api/providers", {
              method: "POST",
              body: JSON.stringify(openAICompatibleBody(id, validLabel)),
            });
            expect(res.status).toBe(200);
            expect(res.data.provider.label).toBe(validLabel);

            const state = await harness.configStore.getState();
            const persisted = state.providers.find((r) => r.id === id);
            expect(persisted).toBeDefined();
            expect(persisted?.label).toBe(validLabel);
          } else {
            // Req 3.2: a missing/empty/whitespace-only label is rejected (400) and
            // NO record is persisted for the id.
            const res = await api(harness.base, "/api/providers", {
              method: "POST",
              body: JSON.stringify(openAICompatibleBody(id, blankCase.label)),
            });
            expect(res.status).toBe(400);
            expect(typeof res.data.error).toBe("string");

            const state = await harness.configStore.getState();
            const persisted = state.providers.find((r) => r.id === id);
            expect(persisted).toBeUndefined();
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
