import { describe, expect, it, vi } from "vitest";
import {
  ModuleRegistry,
  createBuiltinModuleRegistry,
  PUBLIC_MODULE_API_VERSION,
  type ModuleManifest,
} from "../src/modules";

const testManifest: ModuleManifest = {
  id: "@rector/test/sample",
  name: "Sample Module",
  version: "0.0.1",
  apiVersion: PUBLIC_MODULE_API_VERSION,
  tier: "optional",
  hooks: ["onBoot", "onExternalRunStart"],
  defaultEnabled: true,
  externalModeOnly: true,
};

describe("ModuleRegistry", () => {
  it("registers builtin placeholder modules", () => {
    const registry = createBuiltinModuleRegistry();
    const ids = registry.list().map((m) => m.id);
    expect(ids).toContain("@rector/builtin/neuro-preprocess");
    expect(ids).toContain("@rector/builtin/neuro-alive");
    expect(ids).toContain("@rector/builtin/memory-cloud");
    expect(ids.length).toBe(7);
  });

  it("rejects duplicate module ids", () => {
    const registry = new ModuleRegistry();
    registry.register({ manifest: testManifest });
    expect(() => registry.register({ manifest: testManifest })).toThrow(/already registered/);
  });

  it("skips external-only hooks in local mode", async () => {
    const registry = new ModuleRegistry();
    const onBoot = vi.fn();
    registry.register({
      manifest: { ...testManifest, hooks: ["onBoot"] },
      handlers: { onBoot },
    });

    await registry.invokeOnBoot({ mode: "local", store: {} as never });
    expect(onBoot).not.toHaveBeenCalled();
  });

  it("invokes onBoot for non-external-only modules in local mode", async () => {
    const registry = new ModuleRegistry();
    const onBoot = vi.fn();
    registry.register({
      manifest: {
        ...testManifest,
        externalModeOnly: false,
        hooks: ["onBoot"],
      },
      handlers: { onBoot },
    });

    await registry.invokeOnBoot({ mode: "local", store: {} as never });
    expect(onBoot).toHaveBeenCalledOnce();
  });

  it("disable prevents hook invocation", async () => {
    const registry = new ModuleRegistry();
    const onBoot = vi.fn();
    registry.register({
      manifest: {
        ...testManifest,
        externalModeOnly: false,
        hooks: ["onBoot"],
      },
      handlers: { onBoot },
    });
    registry.disable(testManifest.id);

    await registry.invokeOnBoot({ mode: "external", store: {} as never });
    expect(onBoot).not.toHaveBeenCalled();
  });

  it("cannot disable core-tier modules", () => {
    const registry = new ModuleRegistry();
    registry.register({
      manifest: { ...testManifest, tier: "core" },
    });
    expect(() => registry.disable(testManifest.id)).toThrow(/Cannot disable core/);
  });

  it("merges enrichContext results in registration order", async () => {
    const registry = new ModuleRegistry();
    registry.register({
      manifest: {
        ...testManifest,
        id: "@rector/test/a",
        externalModeOnly: false,
        hooks: ["enrichContext"],
      },
      handlers: {
        enrichContext: () => ({
          contextPack: {
            id: "ctx-a",
            conversationId: "c1",
            userIntentSummary: "a",
            memoryContext: "from-a",
          },
        }),
      },
    });
    registry.register({
      manifest: {
        ...testManifest,
        id: "@rector/test/b",
        externalModeOnly: false,
        hooks: ["enrichContext"],
      },
      handlers: {
        enrichContext: (input) => ({
          contextPack: {
            ...input.contextPack,
            memoryContext: `${input.contextPack.memoryContext ?? ""}-b`,
          },
        }),
      },
    });

    const base = {
      id: "ctx",
      conversationId: "c1",
      userIntentSummary: "intent",
    };
    const result = await registry.invokeEnrichContext(
      { contextPack: base, triage: {} as never, prompt: "hi" },
      "local",
    );
    expect(result.contextPack.memoryContext).toBe("from-a-b");
  });
});