import { describe, expect, it } from "vitest";
import { getLlmProviderRegistry } from "../src/modules/builtin/llmProviderModules";
import { getMemoryProviderRegistry } from "../src/modules/builtin/memoryProviderModules";

describe("provider module registries (Chunk 040)", () => {
  it("registers all builtin LLM provider kinds", () => {
    const kinds = getLlmProviderRegistry().kinds().sort();
    expect(kinds).toEqual(["azure-openai", "cloudflare", "openai-compatible", "together"]);
  });

  it("registers all builtin external memory provider kinds", () => {
    const kinds = getMemoryProviderRegistry().kinds().sort();
    expect(kinds).toEqual(["chroma", "mem0", "tidb-memory"]);
  });

  it("rejects mem0 construction when secret is missing", () => {
    expect(() =>
      getMemoryProviderRegistry().build(
        {
          id: "mem0:test",
          kind: "mem0",
          label: "Mem0",
          secretRef: "memory:mem0:test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        undefined,
        {},
      ),
    ).toThrow(/requires an API key/);
  });

  it("returns undefined for unknown memory kind (caller falls back to stub)", () => {
    const built = getMemoryProviderRegistry().build(
      {
        id: "x",
        kind: "unknown-cloud",
        label: "Unknown",
        secretRef: "ref",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      undefined,
      {},
    );
    expect(built).toBeUndefined();
  });
});