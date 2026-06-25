import { describe, expect, it } from "vitest";

import {
  SpecialistSystemContractSchema,
  SpecialistTaskPacketSchema,
  SystemResultPacketSchema,
  validateSystemResultPacket,
  type SpecialistSystemContract,
  type SpecialistTaskPacket,
  type SystemResultPacket,
} from "../../src/systems/contracts";

const codingContract: SpecialistSystemContract = {
  schemaVersion: "rector.specialist-system.v1",
  systemId: "coding-specialist",
  domain: "coding",
  purpose: "Repository-aware coding work with validation-aware DAG execution.",
  inputSchema: { type: "object", properties: { userGoal: { type: "string" } } },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  supportedTaskKinds: ["implement", "diagnose", "refactor"],
  capabilityRefs: ["rg.search", "tsc.diagnose", "git.diff_summarize"],
  validatorRefs: ["tsc.noEmit", "vitest.run"],
  memoryProfile: {
    scope: "local_skill",
    remembers: ["prior coding episodes", "tool failure modes", "effective repo workflows"],
    forbids: ["global user identity facts", "another specialist's private memory"],
  },
  riskProfile: "medium",
  approvalPolicy: { mode: "on_risk" },
  budgetPolicy: { maxUsd: 5, maxRuntimeMs: 600000, maxToolCalls: 200 },
  evalSuiteRefs: ["coding.regression.v1"],
  admission: "experimental",
};

const codingTaskPacket: SpecialistTaskPacket = {
  taskId: "task-001",
  systemId: "coding-specialist",
  userGoal: "Add pagination to the /users endpoint.",
  successCriteria: ["limit/offset accepted", "pagination metadata returned"],
  constraints: ["no breaking API changes"],
  allowedScopes: ["src/api/**"],
  forbiddenScopes: ["src/security/**"],
  memoryPacketRefs: ["mem://packet/users-endpoint"],
  capabilityHints: ["rg.search"],
  validationRequirements: ["tsc.noEmit", "vitest.run"],
  budget: { maxUsd: 2, maxRuntimeMs: 300000, maxToolCalls: 80 },
  riskTolerance: "medium",
};

const codingResultPacket: SystemResultPacket = {
  taskId: "task-001",
  systemId: "coding-specialist",
  status: "succeeded",
  summary: "Added limit/offset pagination with metadata to /users.",
  evidenceRefs: ["artifact://offline/task-001/diff.txt"],
  artifactRefs: ["artifact://offline/task-001/patch.diff"],
  validationRefs: ["validation://tsc/task-001", "validation://vitest/task-001"],
  changes: { changedPaths: ["src/api/users.ts"], additions: 24, deletions: 3 },
  uncertainty: [],
  followUpQuestions: [],
  memoryCandidates: [
    { kind: "workflow", content: "Pagination recipe for Express routes worked.", evidenceRef: "artifact://offline/task-001/diff.txt" },
  ],
  cost: { usd: 0.42, inputTokens: 1200, outputTokens: 800, toolCalls: 12, runtimeMs: 45000 },
};

describe("specialist system contracts", () => {
  it("round-trips a full coding contract + task packet + result packet", () => {
    // Given: a complete coding-system contract, task packet, and result packet.
    // When: each is parsed by its schema.
    const contract = SpecialistSystemContractSchema.parse(codingContract);
    const task = SpecialistTaskPacketSchema.parse(codingTaskPacket);
    const result = SystemResultPacketSchema.parse(codingResultPacket);

    // Then: every value round-trips identically.
    expect(contract).toEqual(codingContract);
    expect(task).toEqual(codingTaskPacket);
    expect(result).toEqual(codingResultPacket);
  });

  it("rejects a contract with an out-of-enum riskProfile, naming the field", () => {
    // Given: a contract whose riskProfile is not in the enum.
    const malformed = { ...codingContract, riskProfile: "extreme" };

    // When: the contract is parsed.
    const parsed = SpecialistSystemContractSchema.safeParse(malformed);

    // Then: parsing fails and the error path names riskProfile.
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("riskProfile"))).toBe(true);
    }
  });

  it("rejects a result packet missing evidenceRefs", () => {
    // Given: a result packet with evidenceRefs removed.
    const { evidenceRefs: _evidenceRefs, ...withoutEvidence } = codingResultPacket;

    // When: the packet is parsed.
    const parsed = SystemResultPacketSchema.safeParse(withoutEvidence);

    // Then: parsing fails naming evidenceRefs.
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("evidenceRefs"))).toBe(true);
    }
  });

  it("rejects a result packet missing status", () => {
    // Given: a result packet with status removed.
    const { status: _status, ...withoutStatus } = codingResultPacket;

    // When: the packet is parsed.
    const parsed = SystemResultPacketSchema.safeParse(withoutStatus);

    // Then: parsing fails naming status.
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("status"))).toBe(true);
    }
  });

  it("validateSystemResultPacket returns ok:true for a good packet", () => {
    // Given: a valid result packet.
    // When: it is validated.
    const outcome = validateSystemResultPacket(codingResultPacket);

    // Then: the outcome is ok with the parsed value.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual(codingResultPacket);
    }
  });

  it("validateSystemResultPacket returns ok:false with a structured error for a bad packet", () => {
    // Given: a result packet with an invalid status enum value.
    const bad = { ...codingResultPacket, status: "exploded" };

    // When: it is validated.
    const outcome = validateSystemResultPacket(bad);

    // Then: the outcome is a structured failure carrying a ZodError naming status.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.issues.some((issue) => issue.path.includes("status"))).toBe(true);
    }
  });
});
