import { describe, expect, it } from "vitest";

import { BUILT_IN_TEMPLATES, scanTemplateForSecrets, validateRectorTemplate } from "../src/templates";
import { ORCHESTRATION_ROLES } from "../src/providers/orchestrationAssignments";
import { MEMORY_ROLES } from "../src/providers/memoryAssignments";

describe("template schema and built-ins", () => {
  it("validates every built-in template", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const result = validateRectorTemplate(template);
      expect(result, `${template.id} should validate`).toEqual({ ok: true, issues: [] });
      expect(scanTemplateForSecrets(template).ok).toBe(true);
    }
  });

  it("Local Free is zero-provider, zero-network, zero-cost baseline", () => {
    const local = BUILT_IN_TEMPLATES.find((template) => template.id === "local-free");
    expect(local).toBeDefined();
    expect(local?.requiredProviderKinds).toEqual([]);
    expect(local?.sandboxPolicy?.network).toBe("disabled");
    expect(local?.budgets?.estimatedCostTier).toBe("free");
    expect(local?.budgets?.maxUsdPerRun).toBe(0);
    expect(local?.orchestrationAssignments.map((assignment) => assignment.role).sort()).toEqual(
      [...ORCHESTRATION_ROLES].sort(),
    );
    expect(local?.memoryAssignments.map((assignment) => assignment.role).sort()).toEqual([...MEMORY_ROLES].sort());
    expect(
      local?.orchestrationAssignments.every((assignment) =>
        assignment.providerId === "deterministic" || assignment.providerId === "disabled",
      ),
    ).toBe(true);
  });

  it("rejects duplicate role assignments", () => {
    const local = BUILT_IN_TEMPLATES.find((template) => template.id === "local-free");
    expect(local).toBeDefined();
    const invalid = {
      ...local!,
      id: "bad-duplicate",
      orchestrationAssignments: [
        local!.orchestrationAssignments[0],
        { ...local!.orchestrationAssignments[0] },
      ],
    };
    const result = validateRectorTemplate(invalid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("duplicate orchestration role"))).toBe(true);
  });

  it("rejects local templates that carry external provider assignments", () => {
    const local = BUILT_IN_TEMPLATES.find((template) => template.id === "local-free")!;
    const invalid = {
      ...local,
      id: "bad-local-external-provider",
      orchestrationAssignments: [
        { ...local.orchestrationAssignments[0], providerId: "openai-compatible:cheap" },
        ...local.orchestrationAssignments.slice(1),
      ],
      memoryAssignments: [
        { ...local.memoryAssignments[0], providerRecordId: "mem0:main", providerKind: "mem0" },
        ...local.memoryAssignments.slice(1),
      ],
    };

    const result = validateRectorTemplate(invalid);

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === "orchestrationAssignments.0.providerId")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "memoryAssignments.0.providerRecordId")).toBe(true);
    expect(result.issues.some((issue) => issue.path === "memoryAssignments.0.providerKind")).toBe(true);
  });
});
