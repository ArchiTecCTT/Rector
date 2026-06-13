import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { redactString } from "../security/redaction";
import { SandboxEnvironmentKindSchema } from "../sandbox";

/**
 * Runtime settings persisted under `.rector/runtime-settings.json`.
 *
 * Mirrors the atomic temp-file + `rename` write technique used by
 * {@link createLocalProviderConfigStore} so a failed write never leaves a
 * partially written file on disk. An in-memory backing is provided for tests.
 */

export const RUNTIME_SETTINGS_SCHEMA_VERSION = "rector.runtime.v1" as const;

export const OrchestrationProfileSchema = z.enum(["unconfigured", "configured"]);
export type OrchestrationProfile = z.infer<typeof OrchestrationProfileSchema>;

export const RuntimeSettingsSchema = z.object({
  schemaVersion: z.literal(RUNTIME_SETTINGS_SCHEMA_VERSION),
  orchestrationProfile: OrchestrationProfileSchema,
  activeTemplateId: z.string().min(1).optional(),
  requireProvidersForChat: z.boolean(),
  sandboxEnvironment: SandboxEnvironmentKindSchema.default("stub"),
  contextCompressionEnabled: z.boolean().default(true),
  contextCompressionMaxGeneration: z.number().int().positive().default(3),
  providerResilienceEnabled: z.boolean().default(true),
  updatedAt: z.string().datetime(),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export const RuntimeSettingsPatchSchema = z
  .object({
    orchestrationProfile: OrchestrationProfileSchema.optional(),
    sandboxEnvironment: SandboxEnvironmentKindSchema.optional(),
    providerResilienceEnabled: z.boolean().optional(),
  })
  .strict();
export type RuntimeSettingsPatch = z.infer<typeof RuntimeSettingsPatchSchema>;

export type RuntimeSettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface RuntimeSettingsStore {
  get(): Promise<RuntimeSettings>;
  upsert(settings: RuntimeSettings): Promise<RuntimeSettingsResult<RuntimeSettings>>;
}

export interface RuntimeSettingsFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

export interface LocalRuntimeSettingsStoreOptions {
  filePath: string;
  fsImpl?: RuntimeSettingsFs;
}

export interface MigrateRuntimeSettingsLogger {
  warn(message: string): void;
}

function defaultRuntimeSettingsFs(): RuntimeSettingsFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      await mkdir(dirPath, { recursive: true });
    },
  };
}

function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

/** Fresh product defaults: orchestration is not configured until setup completes. */
export function defaultRuntimeSettings(now: string = new Date().toISOString()): RuntimeSettings {
  return {
    schemaVersion: RUNTIME_SETTINGS_SCHEMA_VERSION,
    orchestrationProfile: "unconfigured",
    requireProvidersForChat: true,
    sandboxEnvironment: "stub",
    contextCompressionEnabled: true,
    contextCompressionMaxGeneration: 3,
    providerResilienceEnabled: true,
    updatedAt: now,
  };
}

/**
 * One-time migration from the legacy `ORCHESTRATOR_MODE` env knob.
 *
 * - `ORCHESTRATOR_MODE=external` with at least one configured provider → configured
 * - `ORCHESTRATOR_MODE=local`, unset, or external with zero providers → unconfigured
 * - Emits a deprecation warning when `ORCHESTRATOR_MODE` is set to any value
 */
export function migrateRuntimeSettingsFromEnv(
  env: Record<string, string | undefined>,
  providerCount: number,
  logger?: MigrateRuntimeSettingsLogger,
): RuntimeSettings {
  const rawMode = env.ORCHESTRATOR_MODE;
  if (rawMode !== undefined && rawMode.trim() !== "") {
    logger?.warn(
      "ORCHESTRATOR_MODE is deprecated; configure orchestration via runtime settings instead.",
    );
  }

  const mode = rawMode?.trim();
  const orchestrationProfile: OrchestrationProfile =
    mode === "external" && providerCount >= 1 ? "configured" : "unconfigured";

  return {
    schemaVersion: RUNTIME_SETTINGS_SCHEMA_VERSION,
    orchestrationProfile,
    requireProvidersForChat: true,
    sandboxEnvironment: "stub",
    contextCompressionEnabled: true,
    contextCompressionMaxGeneration: 3,
    providerResilienceEnabled: true,
    updatedAt: new Date().toISOString(),
  };
}

/** Redacted, API-safe view of runtime settings (no secret material is present). */
export function redactRuntimeSettingsForEgress(settings: RuntimeSettings): RuntimeSettings {
  return {
    schemaVersion: settings.schemaVersion,
    orchestrationProfile: settings.orchestrationProfile,
    ...(settings.activeTemplateId
      ? { activeTemplateId: redactString(settings.activeTemplateId) }
      : {}),
    requireProvidersForChat: settings.requireProvidersForChat,
    sandboxEnvironment: settings.sandboxEnvironment,
    contextCompressionEnabled: settings.contextCompressionEnabled,
    contextCompressionMaxGeneration: settings.contextCompressionMaxGeneration,
    providerResilienceEnabled: settings.providerResilienceEnabled,
    updatedAt: settings.updatedAt,
  };
}

export function createLocalRuntimeSettingsStore(
  options: LocalRuntimeSettingsStoreOptions,
): RuntimeSettingsStore {
  const { filePath } = options;
  const fsImpl = options.fsImpl ?? defaultRuntimeSettingsFs();

  async function readSettings(): Promise<RuntimeSettings> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") {
      return defaultRuntimeSettings();
    }
    const parsed = RuntimeSettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return defaultRuntimeSettings();
    }
    return parsed.data;
  }

  async function writeSettings(settings: RuntimeSettings): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const serialized = JSON.stringify(settings, null, 2);
    await fsImpl.writeFile(tempPath, serialized);
    await fsImpl.rename(tempPath, filePath);
  }

  return {
    async get(): Promise<RuntimeSettings> {
      try {
        return await readSettings();
      } catch {
        return defaultRuntimeSettings();
      }
    },

    async upsert(settings: RuntimeSettings): Promise<RuntimeSettingsResult<RuntimeSettings>> {
      try {
        const next = RuntimeSettingsSchema.parse(settings);
        await writeSettings(next);
        return { ok: true, value: next };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

export function createInMemoryRuntimeSettingsStore(
  initial?: RuntimeSettings,
): RuntimeSettingsStore {
  let settings: RuntimeSettings = initial
    ? RuntimeSettingsSchema.parse(initial)
    : defaultRuntimeSettings();

  return {
    async get(): Promise<RuntimeSettings> {
      return structuredClone(settings);
    },

    async upsert(next: RuntimeSettings): Promise<RuntimeSettingsResult<RuntimeSettings>> {
      settings = RuntimeSettingsSchema.parse(next);
      return { ok: true, value: structuredClone(settings) };
    },
  };
}
