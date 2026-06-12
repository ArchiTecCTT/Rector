import { describe, expect, it } from "vitest";

import {
  buildAssignmentAwareModelRouter,
  buildConfiguredAssignmentAwareRouter,
  createInMemoryOrchestrationAssignmentStore,
  inferOrchestrationRole,
  resolveEffectiveAssignment,
  type OrchestrationModelAssignment,
} from "../src/providers/orchestrationAssignments";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import type { ModelRouter } from "../src/providers/llm";
import type { ProviderConfigState } from "../src/providers/config";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";
import { SpyLLMProvider } from "./support/byokArbitraries";

const NOW = "2026-06-12T00:00:00.000Z";

function assignment(role: OrchestrationModelAssignment["role"], providerId: string, modelId?: string): OrchestrationModelAssignment {
  return {
    id: `default:default:${role}`,
    role,
    providerId,
    ...(modelId ? { modelId } : {}),
    fallbackProviderId: "deterministic",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function providerState(): ProviderConfigState {
  return {
    version: 1,
    activeRoutes: {},
    providers: [
      {
        id: "openai-compatible:planner",
        kind: "openai-compatible",
        label: "Planner endpoint",
        baseUrl: "https://planner.example.test/v1",
        model: "gpt-plan",
        secretRef: "openai-compatible:planner",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function secretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map<string, string>(Object.entries(initial));
  return {
    async setSecret(ref: string, value: string): Promise<SecretStoreResult<void>> {
      secrets.set(ref, value);
      return { ok: true, value: undefined };
    },
    async getSecret(ref: string): Promise<SecretStoreResult<string>> {
      const value = secrets.get(ref);
      return value === undefined ? { ok: false, error: "missing" } : { ok: true, value };
    },
    async hasSecret(ref: string): Promise<boolean> {
      return secrets.has(ref);
    },
  };
}

describe("OrchestrationModelRouter", () => {
  it("infers roles from existing ModelRouter task inputs", () => {
    expect(inferOrchestrationRole({ task: "preprocessor" })).toBe("preprocessor");
    expect(inferOrchestrationRole({ task: "planner" })).toBe("planner");
    expect(inferOrchestrationRole({ task: "skeptic" })).toBe("skeptic");
    expect(inferOrchestrationRole({ task: "repair" })).toBe("healer");
    expect(inferOrchestrationRole({ task: "direct-answer" })).toBe("directAnswer");
    expect(inferOrchestrationRole({ task: "unrelated" })).toBeUndefined();
  });

  it("preserves existing router behavior when no role assignment exists", () => {
    const baseProvider = new SpyLLMProvider({ id: "base", model: "base-model" });
    const assignedProvider = new SpyLLMProvider({ id: "assigned", model: "assigned-model" });
    const baseRouter: ModelRouter = {
      select: () => ({ provider: baseProvider, modelRoute: "flagship", model: "base-model", reason: "base" }),
    };

    const router = buildAssignmentAwareModelRouter({
      baseRouter,
      assignments: [],
      providerState: providerState(),
      providersByRole: { planner: assignedProvider },
    });

    const selection = router.select({ capability: "flagship", task: "planner" });
    expect(selection.provider.metadata.id).toBe("base");
    expect(selection.model).toBe("base-model");
  });

  it("selects the assigned provider and concrete model for a role", () => {
    const baseProvider = new SpyLLMProvider({ id: "base", model: "base-model" });
    const assignedProvider = new SpyLLMProvider({ id: "openai-compatible", model: "default-model" });
    const baseRouter: ModelRouter = {
      select: () => ({ provider: baseProvider, modelRoute: "flagship", model: "base-model", reason: "base" }),
    };

    const router = buildAssignmentAwareModelRouter({
      baseRouter,
      assignments: [assignment("planner", "openai-compatible:planner", "gpt-plan")],
      providerState: providerState(),
      providersByRole: { planner: assignedProvider },
    });

    const selection = router.select({ capability: "flagship", task: "planner" });
    expect(selection.provider).toBe(assignedProvider);
    expect(selection.modelRoute).toBe("flagship");
    expect(selection.model).toBe("gpt-plan");
    expect(selection.reason).toContain("orchestration assignment planner");
  });

  it("uses deterministic fallback when the assigned provider is unavailable", () => {
    const effective = resolveEffectiveAssignment({
      role: "planner",
      assignments: [assignment("planner", "missing-provider", "model-x")],
      providerState: providerState(),
    });

    expect(effective.providerId).toBe("deterministic");
    expect(effective.deterministicFallbackReason).toContain("missing-provider");
    expect(effective.warnings.some((warning) => warning.code === "provider_missing")).toBe(true);
    expect(effective.warnings.some((warning) => warning.code === "deterministic_fallback")).toBe(true);
  });

  it("maps disabled assignments to the fake local provider without calling the base router", () => {
    let baseCalls = 0;
    const baseProvider = new SpyLLMProvider({ id: "base", model: "base-model" });
    const baseRouter: ModelRouter = {
      select: () => {
        baseCalls += 1;
        return { provider: baseProvider, modelRoute: "flagship", model: "base-model", reason: "base" };
      },
    };

    const router = buildAssignmentAwareModelRouter({
      baseRouter,
      assignments: [assignment("ponder", "disabled")],
      providerState: providerState(),
    });

    const selection = router.select({ capability: "cheap", task: "ponder" });
    expect(selection.provider.metadata.id).toBe("fake");
    expect(selection.modelRoute).toBe("fake");
    expect(baseCalls).toBe(0);
  });

  it("builds configured assignment routing with assignment fallback and deterministic local fallback", async () => {
    const assignmentStore = createInMemoryOrchestrationAssignmentStore();
    const planner = await assignmentStore.upsertAssignment("planner", {
      providerId: "missing-primary",
      modelId: "missing-model",
      fallbackProviderId: "openai-compatible:planner",
      fallbackModelId: "gpt-plan",
    });
    const ponder = await assignmentStore.upsertAssignment("ponder", { providerId: "missing-ponder" });
    expect(planner.ok).toBe(true);
    expect(ponder.ok).toBe(true);

    let baseCalls = 0;
    const baseProvider = new SpyLLMProvider({ id: "base", model: "base-model" });
    const router = await buildConfiguredAssignmentAwareRouter({
      baseRouter: {
        select: () => {
          baseCalls += 1;
          return { provider: baseProvider, modelRoute: "flagship", model: "base-model", reason: "base" };
        },
      },
      assignmentStore,
      providerConfigStore: createInMemoryProviderConfigStore(providerState()),
      secrets: secretStore({ "openai-compatible:planner": "test-key" }),
      enableNetwork: false,
    });

    const plannerSelection = router.select({ capability: "flagship", task: "planner" });
    expect(plannerSelection.provider.metadata.id).toBe("openai-compatible");
    expect(plannerSelection.model).toBe("gpt-plan");
    expect(plannerSelection.reason).toContain("fallback -> openai-compatible:planner");

    const ponderSelection = router.select({ capability: "cheap", task: "ponder" });
    expect(ponderSelection.provider.metadata.id).toBe("fake");
    expect(ponderSelection.modelRoute).toBe("fake");
    expect(baseCalls).toBe(0);
  });
});
