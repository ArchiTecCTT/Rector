import { createInMemoryRuntimeSettingsStore, defaultRuntimeSettings } from "../../src/config/runtimeSettings";
import type { ProviderConfigState } from "../../src/providers/config";
import { createInMemoryProviderConfigStore } from "../../src/providers/configStore";
import { createInMemoryOrchestrationAssignmentStore } from "../../src/providers/orchestrationAssignments";
import { REQUIRED_ORCHESTRATION_ROLES } from "../../src/setup/readiness";
import type { SecretStore, SecretStoreResult } from "../../src/security/secretStore";
import type { RuntimeSettingsStore } from "../../src/config/runtimeSettings";

export const CONFIGURED_PRODUCT_NOW = "2026-06-12T00:00:00.000Z";
export const CONFIGURED_PRODUCT_SECRET = "sk-configured-product-test-secret";

export function configuredProviderState(): ProviderConfigState {
  return {
    version: 1,
    activeRoutes: {},
    providers: [
      {
        id: "openai-compatible:main",
        kind: "openai-compatible",
        label: "OpenAI compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "gpt-json",
        manualModels: ["gpt-json", "gpt-prose"],
        secretRef: "openai-compatible:main",
        createdAt: CONFIGURED_PRODUCT_NOW,
        updatedAt: CONFIGURED_PRODUCT_NOW,
      },
    ],
  };
}

export function configuredSecretStore(secrets: Record<string, string> = {}): SecretStore {
  const present = new Map<string, string>(Object.entries({
    "openai-compatible:main": CONFIGURED_PRODUCT_SECRET,
    ...secrets,
  }));
  return {
    async setSecret(ref: string, value: string): Promise<SecretStoreResult<void>> {
      present.set(ref, value);
      return { ok: true, value: undefined };
    },
    async getSecret(ref: string): Promise<SecretStoreResult<string>> {
      const value = present.get(ref);
      return value === undefined
        ? { ok: false, error: "missing" }
        : { ok: true, value };
    },
    async hasSecret(ref: string): Promise<boolean> {
      return present.has(ref);
    },
    async deleteSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
  };
}

export function configuredRuntimeSettingsStore(): RuntimeSettingsStore {
  return createInMemoryRuntimeSettingsStore({
    ...defaultRuntimeSettings(CONFIGURED_PRODUCT_NOW),
    orchestrationProfile: "configured",
    activeTemplateId: "__test_profile__",
  });
}

export async function seedRequiredOrchestrationAssignments(
  assignmentStore: ReturnType<typeof createInMemoryOrchestrationAssignmentStore>,
  providerId = "openai-compatible:main",
  modelId = "gpt-json",
): Promise<void> {
  for (const role of REQUIRED_ORCHESTRATION_ROLES) {
    const result = await assignmentStore.upsertAssignment(role, { providerId, modelId });
    if (!result.ok) {
      throw new Error(`Failed to seed ${role} assignment: ${result.error}`);
    }
  }
}

export interface ConfiguredProductStores {
  secretStore: SecretStore;
  providerConfigStore: ReturnType<typeof createInMemoryProviderConfigStore>;
  orchestrationAssignmentStore: ReturnType<typeof createInMemoryOrchestrationAssignmentStore>;
  runtimeSettingsStore: RuntimeSettingsStore;
}

export async function createConfiguredProductStores(): Promise<ConfiguredProductStores> {
  const secretStore = configuredSecretStore();
  const providerConfigStore = createInMemoryProviderConfigStore(configuredProviderState());
  const orchestrationAssignmentStore = createInMemoryOrchestrationAssignmentStore();
  await seedRequiredOrchestrationAssignments(orchestrationAssignmentStore);
  const runtimeSettingsStore = configuredRuntimeSettingsStore();
  return {
    secretStore,
    providerConfigStore,
    orchestrationAssignmentStore,
    runtimeSettingsStore,
  };
}