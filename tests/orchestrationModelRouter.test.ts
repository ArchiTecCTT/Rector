import { describe, expect, it } from "vitest";

import {
  buildAssignmentAwareModelRouter,
  inferOrchestrationRole,
  resolveEffectiveAssignment,
  type OrchestrationModelAssignment,
} from "../src/providers/orchestrationAssignments";
import type { ModelRouter } from "../src/providers/llm";
import type { ProviderConfigState } from "../src/providers/config";
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
});
