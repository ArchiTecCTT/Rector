import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  approvedSkillIdsFromDecision,
  arbitratePlanWithCrucible,
  evaluateSkillActivations,
  type SkillCatalogReader,
} from "../src/orchestration/crucible";
import {
  appendApprovedSkillContextToPack,
  type ContextPack,
  type SkillContextCatalog,
} from "../src/orchestration/contextBuilder";
import { PlannerOutputSchema, type PlannerOutput } from "../src/orchestration/planner";
import type { SkillManifest } from "../src/memory";
import type { SkepticReview } from "../src/orchestration/skeptic";

const NOW = "2026-06-13T00:00:00.000Z";

function manifest(id: string, risk: "low" | "medium" | "high", description = `${id} description`): SkillManifest {
  return {
    id,
    frontmatter: {
      name: id,
      description,
      metadata: { risk, tags: ["engineering"] },
    },
    skillPath: `skills/${id}/SKILL.md`,
    bundled: true,
    files: [{ relativePath: "SKILL.md", sizeBytes: 100 }],
  };
}

function catalog(skills: SkillManifest[], bodies: Record<string, string> = {}): SkillCatalogReader & SkillContextCatalog {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return {
    get: (id) => byId.get(id),
    readSkillBody: (manifestOrId) => {
      const id = typeof manifestOrId === "string" ? manifestOrId : manifestOrId.id;
      return bodies[id] ?? `Body for ${id}`;
    },
  };
}

function plan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return PlannerOutputSchema.parse({
    goal: "Implement a focused change",
    assumptions: ["Tests are hermetic."],
    tasks: [
      {
        id: "inspect",
        title: "Inspect",
        description: "Inspect relevant files.",
        dependencies: [],
        expectedArtifacts: ["notes"],
        validation: ["Files identified"],
        risk: "low",
        approvalRequired: false,
      },
    ],
    dependencies: [],
    validation: { summary: "Plan validates behavior", checks: ["Run targeted tests"] },
    riskLevel: "low",
    approvalGates: [],
    ...overrides,
  });
}

function soundReview(): SkepticReview {
  return {
    verdict: "SOUND",
    findings: [],
    planGoal: "Implement a focused change",
    createdAt: NOW,
  };
}

function contextPack(): ContextPack {
  return {
    id: "ctx-skill-test",
    createdAt: NOW,
    userIntentSummary: "Use a skill",
    conversationRef: { id: "conv-skill", workspaceId: "local" },
    messageRefs: [{ id: "msg-skill", role: "user", status: "completed", createdAt: NOW }],
    relevantDocs: [],
    relevantMemory: [],
    constraints: [],
    availableProviders: { configured: ["spy"], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: [],
    triage: {
      route: "PLAN_ONLY",
      confidence: 0.9,
      complexity: "medium",
      reasons: ["test"],
      riskFlags: [],
    },
    artifactHandles: [],
    inlineContext: [],
  };
}

describe("skill crucible and context integration", () => {
  it("requests planner revision for an unknown skill", () => {
    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan({ requestedSkills: ["missing-skill"] }),
      skepticReview: soundReview(),
      skillsCatalog: catalog([]),
      contextPack: contextPack(),
      now: () => NOW,
    });

    expect(decision.verdict).toBe("NEEDS_REVISION");
    expect(decision.trace?.reasonCode).toBe("SKILL_POLICY_REVISION");
    expect(decision.trace?.skillActivation[0]).toMatchObject({
      skillId: "missing-skill",
      decision: "denied",
    });
  });

  it("blocks high-risk skill activation without a required approval gate", () => {
    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan({ requestedSkills: ["dangerous-skill"] }),
      skepticReview: soundReview(),
      skillsCatalog: catalog([manifest("dangerous-skill", "high")]),
      contextPack: contextPack(),
      now: () => NOW,
    });

    expect(decision.verdict).toBe("NEEDS_REVISION");
    expect(decision.revisionRequest?.requiredChanges.join(" ")).toContain("approval");
    expect(decision.trace?.skillActivation[0]?.decision).toBe("denied");
  });

  it("approves known low-risk skills and injects only approved skill context", () => {
    const skills = catalog(
      [manifest("engineering-plan", "low"), manifest("unknown-denied", "low")],
      { "engineering-plan": "Plan first. token=supersecret-value must be redacted." },
    );
    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan({ requestedSkills: ["engineering-plan"] }),
      skepticReview: soundReview(),
      skillsCatalog: skills,
      contextPack: contextPack(),
      now: () => NOW,
    });

    const pack = appendApprovedSkillContextToPack(contextPack(), {
      skillsCatalog: skills,
      approvedSkillIds: approvedSkillIdsFromDecision(decision),
    });

    expect(decision.verdict).toBe("ACCEPTED");
    expect(pack.inlineContext).toHaveLength(1);
    expect(pack.inlineContext[0]?.kind).toBe("skill");
    expect(pack.inlineContext[0]?.content).toContain("engineering-plan");
    expect(JSON.stringify(pack)).not.toContain("supersecret-value");
  });

  it("keeps denied skill content out of context", () => {
    const skills = catalog([manifest("dangerous-skill", "high")], {
      "dangerous-skill": "Denied body should never enter context.",
    });
    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan({ requestedSkills: ["dangerous-skill"] }),
      skepticReview: soundReview(),
      skillsCatalog: skills,
      contextPack: contextPack(),
      now: () => NOW,
    });

    const pack = appendApprovedSkillContextToPack(contextPack(), {
      skillsCatalog: skills,
      approvedSkillIds: approvedSkillIdsFromDecision(decision),
    });

    expect(decision.verdict).toBe("NEEDS_REVISION");
    expect(JSON.stringify(pack)).not.toContain("Denied body");
    expect(pack.inlineContext).toHaveLength(0);
  });

  it("denies skills beyond the per-run cap", () => {
    const manifests = Array.from({ length: 6 }, (_, index) => manifest(`skill-${index}`, "low"));
    const decisions = evaluateSkillActivations(
      plan({ requestedSkills: manifests.map((skill) => skill.id) }),
      { catalog: catalog(manifests), maxSkills: 5 },
    );

    expect(decisions.filter((decision) => decision.decision === "approved")).toHaveLength(5);
    expect(decisions[5]).toMatchObject({ skillId: "skill-5", decision: "denied" });
  });

  it("defers command prerequisites when sandbox allowlist data is unavailable", () => {
    const needsCommand = {
      ...manifest("needs-npm", "low"),
      frontmatter: {
        ...manifest("needs-npm", "low").frontmatter,
        prerequisites: { commands: ["npm test"] },
      },
    };

    const decisions = evaluateSkillActivations(
      plan({ requestedSkills: ["needs-npm"] }),
      { catalog: catalog([needsCommand]) },
    );

    expect(decisions[0]).toMatchObject({ skillId: "needs-npm", decision: "deferred" });
  });

  it("denies unmet command prerequisites when sandbox allowlist data is present", () => {
    const needsCommand = {
      ...manifest("needs-npm", "low"),
      frontmatter: {
        ...manifest("needs-npm", "low").frontmatter,
        prerequisites: { commands: ["npm test"] },
      },
    };

    const decisions = evaluateSkillActivations(
      plan({ requestedSkills: ["needs-npm"] }),
      { catalog: catalog([needsCommand]), allowlistedCommands: ["node"] },
    );

    expect(decisions[0]).toMatchObject({ skillId: "needs-npm", decision: "denied" });
  });

  it("Property 47d-1: total injected skill chars stay within maxSkillContextChars", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.constantFrom("alpha", "beta", "gamma", " "), { minLength: 1, maxLength: 80 }).map((parts) => parts.join("")),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 1, max: 600 }),
        (bodies, cap) => {
          const manifests = bodies.map((_, index) => manifest(`skill-${index}`, "low"));
          const bodyById = Object.fromEntries(bodies.map((body, index) => [`skill-${index}`, body]));
          const pack = appendApprovedSkillContextToPack(contextPack(), {
            skillsCatalog: catalog(manifests, bodyById),
            approvedSkillIds: manifests.map((skill) => skill.id),
            maxSkillContextChars: cap,
          });

          const totalSkillChars = pack.inlineContext
            .filter((entry) => entry.kind === "skill")
            .reduce((total, entry) => total + entry.content.length, 0);
          expect(totalSkillChars).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 100 },
    );
  });
});
