import { describe, expect, it } from "vitest";

import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { defaultMemoryBudgetRun } from "../src/memory/defaultRun";
import { createFakeChromaClient, fixedNow } from "./support/memoryProviderContract";

describe("ChromaMemoryProvider hardening", () => {
  it("validates base URL and generated collection name before client creation", async () => {
    const invalid = new ChromaMemoryProvider({
      id: "../../bad collection id with spaces",
      config: { baseUrl: "not-a-url" },
      now: fixedNow,
      clientFactory: () => createFakeChromaClient(),
    });

    expect(() => invalid.validateConfig()).toThrow(/valid http\(s\) URL/);
    await expect(invalid.searchMemory("anything")).rejects.toThrow(/Chroma searchMemory failed/);

    const fake = createFakeChromaClient();
    const valid = new ChromaMemoryProvider({
      id: "../../bad collection id with spaces",
      config: { baseUrl: "http://localhost:8000" },
      now: fixedNow,
      clientFactory: () => fake,
    });
    await valid.createMemoryEntry({
      layer: "episodic",
      content: "collection validation",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: [],
      source: "test",
      metadata: {},
    });

    const collectionCall = fake.calls.find((call) => call.op === "getOrCreateCollection")?.payload as { name: string };
    expect(collectionCall.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$/);
    expect(collectionCall.name).not.toContain("..");
  });

  it("normalizes query distances, filters metadata by layer, and enforces limits", async () => {
    const fake = createFakeChromaClient();
    const provider = new ChromaMemoryProvider({
      id: "chroma:query",
      config: { baseUrl: "http://localhost:8000" },
      apiKey: "test-key",
      now: fixedNow,
      clientFactory: () => fake,
    });

    await provider.createMemoryEntry({
      layer: "episodic",
      content: "alpha vector memory one",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["alpha"],
      source: "test",
      metadata: { ticket: "A" },
    });
    await provider.createMemoryEntry({
      layer: "episodic",
      content: "alpha vector memory two",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["alpha"],
      source: "test",
      metadata: { ticket: "B" },
    });
    await provider.createMemoryEntry({
      layer: "core",
      content: "alpha vector memory core",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["alpha"],
      source: "test",
      metadata: { ticket: "C" },
    });

    const results = await provider.searchMemory("alpha", { layer: "episodic", limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.layer).toBe("episodic");

    const queryCall = fake.calls.find((call) => call.op === "query")?.payload as {
      nResults: number;
      where: Record<string, unknown>;
    };
    expect(queryCall.nResults).toBe(1);
    expect(queryCall.where).toEqual({ layer: "episodic" });
  });

  it("redacts documents and metadata before Chroma egress", async () => {
    const fake = createFakeChromaClient();
    const provider = new ChromaMemoryProvider({
      id: "chroma:redaction",
      config: { baseUrl: "http://localhost:8000" },
      now: fixedNow,
      clientFactory: () => fake,
    });

    await provider.createMemoryEntry({
      layer: "episodic",
      content: "Persist password=swordfish safely",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["security"],
      source: "test",
      metadata: { token: "sk-1234567890SECRET", visible: "ok" },
    });

    const addCall = fake.calls.find((call) => call.op === "add")?.payload as {
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    };
    expect(addCall.documents[0]).toContain("password=[REDACTED]");
    expect(addCall.documents[0]).not.toContain("swordfish");
    expect(addCall.metadatas[0]?.meta_token).toBe("[REDACTED]");
    expect(addCall.metadatas[0]?.meta_visible).toBe("ok");
  });

  it("applies budget checks before Chroma calls", async () => {
    const fake = createFakeChromaClient();
    const provider = new ChromaMemoryProvider({
      id: "chroma:budget",
      config: { baseUrl: "http://localhost:8000" },
      now: fixedNow,
      clientFactory: () => fake,
      run: defaultMemoryBudgetRun({ budget: { ...defaultMemoryBudgetRun().budget, maxUsd: 0 } }),
    });

    await expect(
      provider.searchMemory("alpha"),
    ).rejects.toThrow(/Memory budget denied/);
    expect(fake.calls).toEqual([]);
  });
});
