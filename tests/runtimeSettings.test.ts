import { describe, expect, it } from "vitest";

import {
  RuntimeSettingsSchema,
  createInMemoryRuntimeSettingsStore,
  createLocalRuntimeSettingsStore,
  defaultRuntimeSettings,
  migrateRuntimeSettingsFromEnv,
  type RuntimeSettings,
  type RuntimeSettingsFs,
} from "../src/config/runtimeSettings";

const FILE_PATH = ".rector/runtime-settings.json";
const FIXED_TS = "2026-06-12T00:00:00.000Z";

class InMemoryRuntimeSettingsFs implements RuntimeSettingsFs {
  readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const data = this.files.get(fromPath);
    if (data === undefined) throw new Error("ENOENT: temp file missing during rename");
    this.files.set(toPath, data);
    this.files.delete(fromPath);
  }

  async mkdir(_dirPath: string): Promise<void> {
    // Directories are implicit in this in-memory model.
  }
}

function newStore(fsImpl: RuntimeSettingsFs) {
  return createLocalRuntimeSettingsStore({ filePath: FILE_PATH, fsImpl });
}

describe("runtime settings defaults", () => {
  it("default is unconfigured", () => {
    expect(defaultRuntimeSettings(FIXED_TS)).toEqual({
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "unconfigured",
      requireProvidersForChat: true,
      updatedAt: FIXED_TS,
    });
  });
});

describe("migrateRuntimeSettingsFromEnv", () => {
  it("migrates ORCHESTRATOR_MODE=external with providers to configured", () => {
    const warnings: string[] = [];
    const migrated = migrateRuntimeSettingsFromEnv(
      { ORCHESTRATOR_MODE: "external" },
      2,
      { warn: (message) => warnings.push(message) },
    );

    expect(migrated.orchestrationProfile).toBe("configured");
    expect(migrated.requireProvidersForChat).toBe(true);
    expect(migrated.schemaVersion).toBe("rector.runtime.v1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ORCHESTRATOR_MODE is deprecated");
  });

  it("migrates ORCHESTRATOR_MODE=local to unconfigured", () => {
    const migrated = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: "local" }, 3);
    expect(migrated.orchestrationProfile).toBe("unconfigured");
  });

  it("migrates unset ORCHESTRATOR_MODE to unconfigured", () => {
    const migrated = migrateRuntimeSettingsFromEnv({}, 1);
    expect(migrated.orchestrationProfile).toBe("unconfigured");
  });

  it("migrates external mode with zero providers to unconfigured", () => {
    const migrated = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: "external" }, 0);
    expect(migrated.orchestrationProfile).toBe("unconfigured");
  });
});

describe("RuntimeSettingsStore persistence", () => {
  it("starts from defaults when no backing file exists", async () => {
    const store = newStore(new InMemoryRuntimeSettingsFs());
    const settings = await store.get();
    expect(settings.schemaVersion).toBe("rector.runtime.v1");
    expect(settings.orchestrationProfile).toBe("unconfigured");
    expect(settings.requireProvidersForChat).toBe(true);
    expect(settings.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("roundtrips persisted local store settings with injectable fs", async () => {
    const fsImpl = new InMemoryRuntimeSettingsFs();
    const store = newStore(fsImpl);
    const settings: RuntimeSettings = {
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "configured",
      activeTemplateId: "template:default",
      requireProvidersForChat: true,
      updatedAt: FIXED_TS,
    };

    const upserted = await store.upsert(settings);
    expect(upserted).toEqual({ ok: true, value: settings });
    expect(await store.get()).toEqual(settings);
    expect(RuntimeSettingsSchema.parse(JSON.parse(fsImpl.files.get(FILE_PATH) ?? ""))).toEqual(settings);
  });

  it("in-memory store roundtrips upserts", async () => {
    const store = createInMemoryRuntimeSettingsStore();
    const next = {
      ...defaultRuntimeSettings(FIXED_TS),
      orchestrationProfile: "configured" as const,
    };
    const result = await store.upsert(next);
    expect(result.ok).toBe(true);
    expect(await store.get()).toEqual(next);
  });
});