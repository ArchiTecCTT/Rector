import { describe, expect, it, vi } from "vitest";

import {
  ORCHESTRATION_ROLES,
  createInMemoryOrchestrationAssignmentStore,
  createLocalOrchestrationAssignmentStore,
  createOrchestrationModelRouter,
  providerOptionsFromConfigState,
  resolveEffectiveAssignment,
  type OrchestrationAssignmentFs,
  type OrchestrationAssignmentState,
} from "../src/providers/orchestrationAssignments";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import type { ProviderConfigState } from "../src/providers/config";

const NOW = "2026-06-12T00:00:00.000Z";

function providerState(): ProviderConfigState {
  return {
    version: 1,
    activeRoutes: {},
    providers: [
      {
        id: "cloudflare",
        kind: "cloudflare",
        label: "Cloudflare Workers AI",
        model: "@cf/meta/llama-3.1-8b-instruct",
        cloudflare: { accountId: "acct" },
        secretRef: "cloudflare",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "openai-compatible:main",
        kind: "openai-compatible",
        label: "OpenAI compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "gpt-json",
        manualModels: ["gpt-json", "gpt-prose"],
        secretRef: "openai-compatible:main",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

describe("orchestration model assignment schema and store", () => {
  it("declares the canonical orchestration roles", () => {
    expect(ORCHESTRATION_ROLES).toEqual([
      "triage",
      "preprocessor",
      "planner",
      "skeptic",
      "crucible",
      "deepPlanner",
      "taskDecomposer",
      "validator",
      "healer",
      "synthesizer",
      "directAnswer",
      "ponder",
      "embedding",
      "reranker",
    ]);
  });

  it("roundtrips an assignment without storing secret fields", async () => {
    const store = createInMemoryOrchestrationAssignmentStore();
    const result = await store.upsertAssignment(
      "planner",
      {
        providerId: "openai-compatible:main",
        modelId: "gpt-json",
        fallbackProviderId: "deterministic",
        maxUsdPerCall: 0.25,
        maxTokens: 4096,
        timeoutMs: 30_000,
        requiresJsonMode: true,
      },
      { userId: "alice", workspaceId: "repo" },
    );

    expect(result.ok).toBe(true);
    const assignments = await store.listAssignments({ userId: "alice", workspaceId: "repo" });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      role: "planner",
      providerId: "openai-compatible:main",
      modelId: "gpt-json",
      fallbackProviderId: "deterministic",
      userId: "alice",
      workspaceId: "repo",
    });
    const serialized = JSON.stringify(assignments[0]);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("sk-");
  });

  it("isolates assignments by user/workspace scope", async () => {
    const store = createInMemoryOrchestrationAssignmentStore();
    await store.upsertAssignment("planner", { providerId: "deterministic" }, { userId: "alice", workspaceId: "a" });
    await store.upsertAssignment("planner", { providerId: "disabled" }, { userId: "bob", workspaceId: "a" });
    await store.upsertAssignment("planner", { providerId: "openai-compatible:main" }, { userId: "alice", workspaceId: "b" });

    expect((await store.getAssignment("planner", { userId: "alice", workspaceId: "a" }))?.providerId).toBe("deterministic");
    expect((await store.getAssignment("planner", { userId: "bob", workspaceId: "a" }))?.providerId).toBe("disabled");
    expect((await store.getAssignment("planner", { userId: "alice", workspaceId: "b" }))?.providerId).toBe("openai-compatible:main");
  });

  it("does not collapse read failures into an empty persisted assignment state", async () => {
    const writeFile = vi.fn<OrchestrationAssignmentFs["writeFile"]>();
    const fsImpl: OrchestrationAssignmentFs = {
      readFile: vi.fn(async () => {
        throw new Error("disk read failed");
      }),
      writeFile,
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    };
    const store = createLocalOrchestrationAssignmentStore({ filePath: "/tmp/orchestration-assignments.json", fsImpl });

    await expect(store.getState()).rejects.toThrow("disk read failed");
    const result = await store.upsertAssignment("planner", { providerId: "deterministic" });

    expect(result.ok).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("falls back from workspace scope to the user's default workspace assignment", async () => {
    const store = createInMemoryOrchestrationAssignmentStore();
    await store.upsertAssignment(
      "planner",
      { providerId: "openai-compatible:main", modelId: "gpt-json" },
      { userId: "alice" },
    );
    const router = createOrchestrationModelRouter({
      store,
      providerConfigStore: createInMemoryProviderConfigStore(providerState()),
    });

    const effective = await router.resolve("planner", { userId: "alice", workspaceId: "repo" });

    expect(effective.providerId).toBe("openai-compatible:main");
    expect(effective.source).toBe("workspace-default");
    expect(effective.assignment?.workspaceId).toBeUndefined();
  });

  it("uses the deterministic fallback source when built-in templates are excluded", () => {
    const effective = resolveEffectiveAssignment({ role: "planner", includeBuiltInDefault: false });

    expect(effective.providerId).toBe("deterministic");
    expect(effective.source).toBe("deterministic-fallback");
  });

  it("does not select an unconfigured fallback provider", () => {
    const effective = resolveEffectiveAssignment({
      role: "planner",
      assignments: [
        {
          id: "default:default:planner",
          role: "planner",
          providerId: "missing-primary",
          fallbackProviderId: "missing-fallback",
          fallbackModelId: "fallback-model",
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      providerState: providerState(),
    });

    expect(effective.providerId).toBe("deterministic");
    expect(effective.deterministicFallbackReason).toContain("missing-fallback");
    expect(effective.warnings.filter((warning) => warning.code === "provider_missing").map((warning) => warning.providerId)).toEqual([
      "missing-primary",
      "missing-fallback",
    ]);
  });

  it("resolves deterministic local fallback with zero providers", () => {
    const effective = resolveEffectiveAssignment({ role: "planner" });
    expect(effective.providerId).toBe("deterministic");
    expect(effective.modelRoute).toBe("flagship");
    expect(effective.budgetProjection.estimatedUsdPerCall).toBe(0);
    expect(effective.warnings).toEqual([]);
  });

  it("reports capability blockers for JSON-required roles without JSON mode and no repair fallback", () => {
    const state = providerState();
    const assignmentState: OrchestrationAssignmentState = {
      version: 1,
      assignments: [
        {
          id: "default:default:preprocessor",
          role: "preprocessor",
          providerId: "cloudflare",
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };

    const effective = resolveEffectiveAssignment({
      role: "preprocessor",
      assignments: assignmentState.assignments,
      providerState: state,
    });

    expect(effective.providerId).toBe("cloudflare");
    expect(effective.warnings.some((warning) => warning.code === "json_mode_missing" && warning.severity === "blocker")).toBe(true);
  });

  it("returns sanitized provider/model options with no secret references", () => {
    const options = providerOptionsFromConfigState(providerState());
    expect(options.map((option) => option.id)).toEqual(["cloudflare", "openai-compatible:main"]);
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).toContain("gpt-json");
  });
});
