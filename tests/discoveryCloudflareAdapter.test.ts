/**
 * Task 7.2 — Cloudflare Workers AI Discovery_Adapter unit tests
 * (Requirements 12.1, 12.2, 12.3, 12.4).
 *
 * These exercise {@link cloudflareDiscoveryAdapter} against a mocked `fetch` to
 * confirm:
 *
 *   - it requests the account-scoped catalog at
 *     `GET {baseUrl}/accounts/{account_id}/ai/models/search` with a bearer
 *     secret (Req 12.1);
 *   - the default result keeps only text-generation, chat, and embedding models
 *     and drops other tasks (Req 12.2);
 *   - deprecated models are omitted by default and included when requested,
 *     while non-deprecated candidates always remain (Req 12.3, 12.4);
 *   - failures are returned as a classified DiscoveryError rather than thrown.
 *
 * Property 10 (task 7.7) covers the general filtering property; these examples
 * stay targeted and non-overlapping. Tests are hermetic: every request goes
 * through an injected `fetchImpl`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const BASE_URL = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = "acct-123";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "cloudflare:main",
    kind: "cloudflare",
    label: "Cloudflare",
    cloudflare: { accountId: ACCOUNT_ID },
    secretRef: "cloudflare:main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(fetchImpl: typeof fetch, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    record: record(),
    secret: "cf-token",
    fetchImpl,
    includeDeprecated: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A representative catalog mixing kept tasks, a dropped task, and a deprecation. */
function catalog(): unknown {
  return {
    success: true,
    result: [
      { id: "uuid-1", name: "@cf/meta/llama-3.1-8b-instruct", task: { name: "Text Generation" } },
      { id: "uuid-2", name: "@cf/baai/bge-base-en-v1.5", task: { name: "Text Embeddings" } },
      { id: "uuid-3", name: "@cf/microsoft/resnet-50", task: { name: "Image Classification" } },
      {
        id: "uuid-4",
        name: "@cf/meta/llama-2-7b-chat-int8",
        task: { name: "Text Generation" },
        deprecated: true,
      },
    ],
  };
}

describe("cloudflareDiscoveryAdapter", () => {
  it("requests the account-scoped catalog with a bearer secret", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog())) as unknown as typeof fetch;

    await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}/ai/models/search`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer cf-token" }),
      }),
    );
  });

  it("keeps only text-generation, chat, and embedding models and drops deprecated by default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog())) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.candidates.map((candidate) => candidate.modelId);
      // Image Classification is filtered out; the deprecated chat model is dropped.
      expect(ids).toEqual(["@cf/meta/llama-3.1-8b-instruct", "@cf/baai/bge-base-en-v1.5"]);
      expect(result.candidates[0]).toMatchObject({
        providerId: "cloudflare:main",
        kind: "cloudflare",
        source: "cloudflare",
        scope: { accountId: ACCOUNT_ID },
        requiresDeployment: false,
        requiresRegion: false,
      });
      expect(result.candidates[0].capabilities).toEqual(expect.arrayContaining(["text-generation", "chat"]));
      expect(result.candidates[1].capabilities).toContain("embeddings");
    }
  });

  it("includes deprecated models when requested while keeping non-deprecated ones", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog())) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl, { includeDeprecated: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.candidates.map((candidate) => candidate.modelId);
      expect(ids).toEqual([
        "@cf/meta/llama-3.1-8b-instruct",
        "@cf/baai/bge-base-en-v1.5",
        "@cf/meta/llama-2-7b-chat-int8",
      ]);
      const deprecated = result.candidates.find((candidate) => candidate.modelId === "@cf/meta/llama-2-7b-chat-int8");
      expect(deprecated?.lifecycle).toBe("deprecated");
    }
  });

  it("returns a classified endpoint_invalid error when no account id is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog())) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(
      ctx(fetchImpl, { record: record({ cloudflare: {} }) }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("endpoint_invalid");
    }
  });

  it("classifies an auth failure rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("auth_invalid");
    }
  });

  it("classifies a transport failure as a network error instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network_error");
    }
  });

  it("returns an unsupported_response error for an unrecognizable body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;

    const result = await cloudflareDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("unsupported_response");
    }
  });
});
