/**
 * Task 7.1 — shared discovery normalizer unit tests
 * (Requirements 10.4, 11.1, 11.2, 11.3, 14.2).
 *
 * These exercise {@link normalizeCandidate} directly with targeted raw inputs
 * to confirm the defensive mapping contract:
 *
 *   - a fully populated entry maps every required and optional field (Req 11);
 *   - an entry missing every optional field still yields a valid candidate and
 *     omits the optionals (Req 11.3, 14.2);
 *   - non-object/garbage raw values never throw and fall back to a generic
 *     display name (Req 14.2);
 *   - capability tags are derived from common shapes and merged with defaults
 *     (Req 11.5);
 *   - a truthy `deprecated` flag maps to the `deprecated` lifecycle (Req 11.4).
 *
 * The exhaustive cross-input guarantee (every entry parses against
 * `ModelCandidateSchema`) is covered by the Property 9 test (task 7.6); these
 * are targeted examples and edge cases.
 */
import { describe, expect, it } from "vitest";

import { normalizeCandidate, type NormalizeContext } from "../src/providers/discovery/adapters";
import { ModelCandidateSchema } from "../src/providers/discovery/types";

const TS = "2026-01-01T00:00:00.000Z";

function ctx(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    providerId: "openai-compatible:my-proxy",
    kind: "openai-compatible",
    source: "openai-compatible",
    lastRefreshedAt: TS,
    ...overrides,
  };
}

describe("normalizeCandidate", () => {
  it("maps a fully populated entry into every required and optional field", () => {
    const candidate = normalizeCandidate(
      {
        id: "gpt-4o-mini",
        display_name: "GPT-4o mini",
        capabilities: ["chat", "text-generation"],
        context_window: 128000,
        pricing: { inputPer1k: 0.15, outputPer1k: 0.6, currency: "USD" },
        lifecycle: "active",
      },
      ctx(),
    );

    expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(candidate).toMatchObject({
      providerId: "openai-compatible:my-proxy",
      kind: "openai-compatible",
      displayName: "GPT-4o mini",
      modelId: "gpt-4o-mini",
      contextWindow: 128000,
      pricing: { inputPer1k: 0.15, outputPer1k: 0.6, currency: "USD" },
      lifecycle: "active",
      requiresDeployment: false,
      requiresRegion: false,
    });
    expect(candidate.capabilities).toEqual(expect.arrayContaining(["chat", "text-generation"]));
  });

  it("omits optional fields when the entry provides none", () => {
    const candidate = normalizeCandidate({ id: "tiny" }, ctx());

    expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(candidate.displayName).toBe("tiny");
    expect(candidate.modelId).toBe("tiny");
    expect(candidate).not.toHaveProperty("contextWindow");
    expect(candidate).not.toHaveProperty("pricing");
    expect(candidate).not.toHaveProperty("lifecycle");
    expect(candidate).not.toHaveProperty("deploymentId");
  });

  it("never throws on a non-object raw value and falls back to a generic name", () => {
    for (const garbage of [null, undefined, 42, "model", [], { context_window: -1, pricing: 7 }]) {
      const candidate = normalizeCandidate(garbage, ctx());
      expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
      expect(candidate.displayName.length).toBeGreaterThan(0);
      expect(candidate).not.toHaveProperty("contextWindow");
      expect(candidate).not.toHaveProperty("pricing");
    }
  });

  it("derives capabilities from common shapes and merges defaults", () => {
    const candidate = normalizeCandidate(
      { id: "m", task: "embeddings", tasks: [{ name: "chat" }] },
      ctx({ defaultCapabilities: ["text-generation"] }),
    );

    expect(candidate.capabilities).toEqual(
      expect.arrayContaining(["embeddings", "chat", "text-generation"]),
    );
    // De-duplicated.
    expect(new Set(candidate.capabilities).size).toBe(candidate.capabilities.length);
  });

  it("maps a truthy deprecated flag to the deprecated lifecycle", () => {
    const candidate = normalizeCandidate({ id: "old", deprecated: true }, ctx());
    expect(candidate.lifecycle).toBe("deprecated");
  });

  it("carries adapter-supplied scope and deployment requirements", () => {
    const candidate = normalizeCandidate(
      { id: "gpt-4o" },
      ctx({
        kind: "azure-openai",
        scope: { endpoint: "https://r.openai.azure.com", region: "eastus" },
        requiresDeployment: true,
        requiresRegion: true,
      }),
    );

    expect(candidate.scope).toEqual({ endpoint: "https://r.openai.azure.com", region: "eastus" });
    expect(candidate.requiresDeployment).toBe(true);
    expect(candidate.requiresRegion).toBe(true);
  });
});
