import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DuplicateSystemIdError,
  SpecialistContractValidationError,
  SystemRegistry,
} from "../../src/systems/registry";
import type { SpecialistSystemContract } from "../../src/systems/contracts";
import { runSpecialistSystemContracts } from "../../scripts/evals/run-specialist-system-contracts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROFILES_DIR = path.join(REPO_ROOT, "src", "systems", "specialistProfiles");
const CODING_PROFILE_PATH = path.join(PROFILES_DIR, "coding.profile.json");

function validCodingContract(overrides: Partial<SpecialistSystemContract> = {}): SpecialistSystemContract {
  return {
    schemaVersion: "rector.specialist-system.v1",
    systemId: "coding-specialist",
    domain: "coding",
    purpose: "Repository-aware coding specialist.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    supportedTaskKinds: ["implement"],
    capabilityRefs: ["rg.search", "tsc.diagnose"],
    validatorRefs: ["tsc.noEmit"],
    memoryProfile: { scope: "local_skill", remembers: ["episodes"], forbids: ["global identity"] },
    riskProfile: "medium",
    approvalPolicy: { mode: "on_risk" },
    budgetPolicy: { maxUsd: 5, maxRuntimeMs: 600000, maxToolCalls: 200 },
    evalSuiteRefs: ["coding.regression.v1"],
    admission: "draft",
    ...overrides,
  };
}

describe("SystemRegistry", () => {
  it("registers a valid coding contract and returns it via get/list", () => {
    // Given: an empty registry and a valid coding contract.
    const registry = new SystemRegistry();
    const contract = validCodingContract();

    // When: the contract is registered.
    const stored = registry.register(contract);

    // Then: it is retrievable and present in the deterministic list.
    expect(stored).toEqual(contract);
    expect(registry.get("coding-specialist")).toEqual(contract);
    expect(registry.list()).toEqual([contract]);
    expect(registry.size).toBe(1);
  });

  it("returns contracts from list() sorted by systemId", () => {
    // Given: two valid contracts registered out of sorted order.
    const registry = new SystemRegistry();
    registry.register(validCodingContract({ systemId: "writing-specialist", domain: "writing" }));
    registry.register(validCodingContract({ systemId: "coding-specialist" }));

    // When: list() is read.
    const ids = registry.list().map((contract) => contract.systemId);

    // Then: order is deterministic (alphabetical by systemId).
    expect(ids).toEqual(["coding-specialist", "writing-specialist"]);
  });

  it("rejects a duplicate systemId naming the duplicate", () => {
    // Given: a registry already holding the coding contract.
    const registry = new SystemRegistry();
    registry.register(validCodingContract());

    // When/Then: registering a second contract with the same systemId throws DuplicateSystemIdError.
    expect(() => registry.register(validCodingContract({ purpose: "different but same id" }))).toThrow(
      DuplicateSystemIdError,
    );
    try {
      registry.register(validCodingContract());
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateSystemIdError);
      expect((error as Error).message).toContain("coding-specialist");
    }
  });

  it("fails validation for a contract missing inputSchema", () => {
    // Given: a contract with inputSchema removed.
    const registry = new SystemRegistry();
    const { inputSchema: _inputSchema, ...withoutInput } = validCodingContract();

    // When/Then: registration throws a validation error whose message references inputSchema.
    expect(() => registry.register(withoutInput)).toThrow(SpecialistContractValidationError);
    try {
      registry.register(withoutInput);
    } catch (error) {
      expect(error).toBeInstanceOf(SpecialistContractValidationError);
      expect((error as SpecialistContractValidationError).issues.some((issue) => issue.path.includes("inputSchema"))).toBe(
        true,
      );
    }
  });

  it("fails validation for a riskProfile not in the enum", () => {
    // Given: a contract with an out-of-enum riskProfile.
    const registry = new SystemRegistry();
    const malformed = { ...validCodingContract(), riskProfile: "extreme" };

    // When/Then: registration throws a validation error referencing riskProfile.
    expect(() => registry.register(malformed)).toThrow(SpecialistContractValidationError);
    try {
      registry.register(malformed);
    } catch (error) {
      expect((error as SpecialistContractValidationError).issues.some((issue) => issue.path.includes("riskProfile"))).toBe(
        true,
      );
    }
  });

  it("loads and validates the committed coding.profile.json from disk", () => {
    // Given: the committed coding specialist profile on disk.
    const raw: unknown = JSON.parse(readFileSync(CODING_PROFILE_PATH, "utf8"));
    const registry = new SystemRegistry();

    // When: it is registered.
    const contract = registry.register(raw);

    // Then: it validates and carries the expected coding identity.
    expect(contract.systemId).toBe("coding-specialist");
    expect(contract.domain).toBe("coding");
    expect(contract.schemaVersion).toBe("rector.specialist-system.v1");
  });
});

describe("run-specialist-system-contracts runner", () => {
  it("validates all committed profiles and reports allValid", async () => {
    // Given: the committed specialist profiles directory.
    // When: the runner validates every profile.
    const output = await runSpecialistSystemContracts({ profilesDir: PROFILES_DIR });

    // Then: at least the coding profile is present and all profiles are valid.
    expect(output.results.length).toBeGreaterThanOrEqual(1);
    expect(output.allValid).toBe(true);
    expect(output.results.every((result) => result.ok)).toBe(true);
    expect(output.results.some((result) => result.systemId === "coding-specialist")).toBe(true);
  });
});
