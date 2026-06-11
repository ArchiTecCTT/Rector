import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { redactString } from "../security/redaction";
import {
  ModuleConfigStateSchema,
  emptyModuleConfigState,
  type ModuleConfigState,
} from "./moduleConfig";
import type { ModuleRegistry } from "./registry";

export type ModuleConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ModuleConfigStore {
  getState(): Promise<ModuleConfigState>;
  setModuleEnabled(moduleId: string, enabled: boolean): Promise<ModuleConfigResult<ModuleConfigState>>;
}

export interface ModuleConfigFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

const defaultFs: ModuleConfigFs = {
  readFile: async (path) => {
    try {
      return await fsReadFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, data) => fsWriteFile(path, data, "utf8"),
  rename: (from, to) => fsRename(from, to),
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
};

export function createInMemoryModuleConfigStore(
  initial: ModuleConfigState = emptyModuleConfigState(),
): ModuleConfigStore {
  let state = ModuleConfigStateSchema.parse(initial);
  return {
    async getState() {
      return state;
    },
    async setModuleEnabled(moduleId, enabled) {
      const ids = new Set(state.disabledModuleIds);
      if (enabled) {
        ids.delete(moduleId);
      } else {
        ids.add(moduleId);
      }
      state = ModuleConfigStateSchema.parse({ disabledModuleIds: [...ids] });
      return { ok: true, value: state };
    },
  };
}

export function createLocalModuleConfigStore(options: {
  filePath: string;
  fsImpl?: ModuleConfigFs;
}): ModuleConfigStore {
  const fs = options.fsImpl ?? defaultFs;

  async function readState(): Promise<ModuleConfigState> {
    const raw = await fs.readFile(options.filePath);
    if (!raw) return emptyModuleConfigState();
    try {
      return ModuleConfigStateSchema.parse(JSON.parse(raw));
    } catch {
      return emptyModuleConfigState();
    }
  }

  async function writeState(state: ModuleConfigState): Promise<ModuleConfigResult<void>> {
    try {
      const dir = dirname(options.filePath);
      await fs.mkdir(dir);
      const tmp = `${options.filePath}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
      await fs.rename(tmp, options.filePath);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: redactString(error instanceof Error ? error.message : String(error)) };
    }
  }

  return {
    getState: readState,
    async setModuleEnabled(moduleId, enabled) {
      const state = await readState();
      const ids = new Set(state.disabledModuleIds);
      if (enabled) ids.delete(moduleId);
      else ids.add(moduleId);
      const next = ModuleConfigStateSchema.parse({ disabledModuleIds: [...ids] });
      const wrote = await writeState(next);
      if (!wrote.ok) return wrote;
      return { ok: true, value: next };
    },
  };
}

export async function applyModuleConfigToRegistry(
  registry: ModuleRegistry,
  store: ModuleConfigStore,
): Promise<void> {
  const state = await store.getState();
  for (const moduleId of state.disabledModuleIds) {
    if (!registry.list().some((manifest) => manifest.id === moduleId)) continue;
    try {
      registry.disable(moduleId);
    } catch {
      // Core-tier modules cannot be disabled; ignore persisted entry.
    }
  }
}