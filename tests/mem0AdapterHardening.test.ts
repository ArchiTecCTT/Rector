import { describe, expect, it } from "vitest";

import { defaultMemoryBudgetRun } from "../src/memory/defaultRun";
import { Mem0MemoryProvider } from "../src/memory/mem0Adapter";
import { createFakeMem0Client, fixedNow } from "./support/memoryProviderContract";

describe("Mem0MemoryProvider hardening", () => {
  it.each(["id", "results", "array", "wrapped"] as const)("normalizes %s add result shape", async (addShape) => {
    const client = createFakeMem0Client({ addShape });
    const provider = new Mem0MemoryProvider({
      id: `mem0:${addShape}`,
      apiKey: "test-key",
      now: fixedNow,
      clientFactory: () => client,
    });

    const created = await provider.createMemoryEntry({
      layer: "core",
      content: "Mem0 normalized memory",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["normalized"],
      source: "test",
      metadata: { priority: "high" },
    });

    expect(created.id).toMatch(/^mem0-/);
    expect(created.layer).toBe("core");
    expect(created.metadata.priority).toBe("high");
    expect((await provider.getMemoryEntry(created.id))?.content).toContain("normalized");
  });

  it("redacts content and metadata before egress to the fake client", async () => {
    const client = createFakeMem0Client();
    const provider = new Mem0MemoryProvider({
      id: "mem0:redaction",
      apiKey: "test-key",
      now: fixedNow,
      clientFactory: () => client,
    });

    await provider.createMemoryEntry({
      layer: "episodic",
      content: "Store token=sk-1234567890SECRET safely",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["security"],
      source: "test",
      metadata: { apiKey: "sk-1234567890SECRET", visible: "ok" },
    });

    const addCall = client.calls.find((call) => call.op === "add")?.payload as {
      messages: Array<{ content: string }>;
      requestOptions: { metadata: Record<string, unknown> };
    };
    expect(addCall.messages[0]?.content).toContain("[REDACTED]");
    expect(addCall.messages[0]?.content).not.toContain("sk-1234567890SECRET");
    expect(addCall.requestOptions.metadata.meta_apiKey).toBe("[REDACTED]");
    expect(addCall.requestOptions.metadata.meta_visible).toBe("ok");
  });

  it("classifies and redacts client errors", async () => {
    const provider = new Mem0MemoryProvider({
      id: "mem0:error",
      apiKey: "test-key",
      now: fixedNow,
      clientFactory: () => {
        throw new Error("bad api_key=sk-1234567890SECRET");
      },
    });

    await expect(
      provider.createMemoryEntry({
        layer: "episodic",
        content: "will fail",
        timestamp: "2026-06-10T12:00:00.000Z",
        tags: [],
        source: "test",
        metadata: {},
      }),
    ).rejects.toThrow(/Mem0 createMemoryEntry failed: Mem0 client initialization failed: bad api_key=\[REDACTED\]/);
  });

  it("applies memory budget checks before external writes", async () => {
    const client = createFakeMem0Client();
    const provider = new Mem0MemoryProvider({
      id: "mem0:budget",
      apiKey: "test-key",
      now: fixedNow,
      clientFactory: () => client,
      run: defaultMemoryBudgetRun({ budget: { ...defaultMemoryBudgetRun().budget, maxUsd: 0 } }),
    });

    await expect(
      provider.createMemoryEntry({
        layer: "episodic",
        content: "budget denied",
        timestamp: "2026-06-10T12:00:00.000Z",
        tags: [],
        source: "test",
        metadata: {},
      }),
    ).rejects.toThrow(/Memory budget denied/);
    expect(client.calls).toEqual([]);
  });
});
