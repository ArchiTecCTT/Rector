import type { ProviderConfigStore } from "../providers/configStore";
import { createLocalProviderConfigStore } from "../providers/configStore";
import { createLocalMemoryConfigStore, type MemoryConfigStore } from "../providers/memoryConfigStore";
import { createLocalMemoryAssignmentStore, type MemoryAssignmentStore } from "../providers/memoryAssignmentStore";
import {
  createLocalOrchestrationAssignmentStore,
  type OrchestrationAssignmentStore,
} from "../providers/orchestrationAssignments";
import { createLocalSecretStore, type SecretStore } from "./secretStore";
import { resolveUserDataDir } from "./userDataPaths";

export interface UserStores {
  secretStore: SecretStore;
  providerConfigStore: ProviderConfigStore;
  memoryConfigStore: MemoryConfigStore;
  orchestrationAssignmentStore: OrchestrationAssignmentStore;
  memoryAssignmentStore: MemoryAssignmentStore;
}

export interface UserStoresResolverOptions {
  authEnabled: boolean;
  encryptionKey: Buffer;
  defaultStores: UserStores;
}

/**
 * Build a resolver that returns shared default stores when auth is disabled, or
 * lazily constructs per-user disk-backed stores under `.rector/users/{id}/` when
 * auth is enabled.
 */
export function createUserStoresResolver(options: UserStoresResolverOptions): (userId: string) => UserStores {
  const cache = new Map<string, UserStores>();
  const { authEnabled, encryptionKey, defaultStores } = options;

  return function resolveUserStores(userId: string): UserStores {
    if (!authEnabled || userId === "default") {
      return defaultStores;
    }

    const cached = cache.get(userId);
    if (cached) return cached;

    const userDir = resolveUserDataDir(userId, true);
    const stores: UserStores = {
      secretStore: createLocalSecretStore({
        filePath: `${userDir}secrets.enc`,
        encryptionKey,
      }),
      providerConfigStore: createLocalProviderConfigStore({
        filePath: `${userDir}providers.json`,
      }),
      memoryConfigStore: createLocalMemoryConfigStore({
        filePath: `${userDir}memory-providers.json`,
      }),
      orchestrationAssignmentStore: createLocalOrchestrationAssignmentStore({
        filePath: `${userDir}orchestration-assignments.json`,
      }),
      memoryAssignmentStore: createLocalMemoryAssignmentStore({
        filePath: `${userDir}memory-assignments.json`,
      }),
    };
    cache.set(userId, stores);
    return stores;
  };
}