import {
  SpecialistSystemContractSchema,
  type SpecialistSystemContract,
} from "./contracts";

/**
 * SystemRegistry (Phase 0.5, Todo 7).
 *
 * A validation + storage registry for specialist system contracts. It validates each contract
 * against {@link SpecialistSystemContractSchema} and rejects duplicate `systemId`s.
 *
 * SCOPE: validation + storage ONLY. This registry does NOT execute specialists, route tasks, or
 * embed an ExecutiveRouter — specialist execution and routing arrive in Phase 11/12. Here we only
 * prove that committed specialist contracts are well-formed and uniquely identified.
 */

/** Structured failure for a contract that fails schema validation (no throw at the parse seam). */
export class SpecialistContractValidationError extends Error {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(issues: readonly { readonly path: string; readonly message: string }[]) {
    const detail = issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    super(`Invalid specialist system contract: ${detail}`);
    this.name = "SpecialistContractValidationError";
    this.issues = issues;
  }
}

/** Thrown when a contract is registered with a systemId that is already present. */
export class DuplicateSystemIdError extends Error {
  readonly systemId: string;

  constructor(systemId: string) {
    super(`Duplicate specialist systemId already registered: ${systemId}`);
    this.name = "DuplicateSystemIdError";
    this.systemId = systemId;
  }
}

export class SystemRegistry {
  private readonly contracts = new Map<string, SpecialistSystemContract>();

  /**
   * Validate and store a specialist contract.
   * @throws {SpecialistContractValidationError} when the value fails schema validation.
   * @throws {DuplicateSystemIdError} when the systemId is already registered.
   */
  register(contract: unknown): SpecialistSystemContract {
    const parsed = SpecialistSystemContractSchema.safeParse(contract);
    if (!parsed.success) {
      throw new SpecialistContractValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    const validated = parsed.data;
    if (this.contracts.has(validated.systemId)) {
      throw new DuplicateSystemIdError(validated.systemId);
    }
    this.contracts.set(validated.systemId, validated);
    return validated;
  }

  /** Return the registered contract for a systemId, or undefined when absent. */
  get(systemId: string): SpecialistSystemContract | undefined {
    return this.contracts.get(systemId);
  }

  /** Return all registered contracts in deterministic order (sorted by systemId). */
  list(): readonly SpecialistSystemContract[] {
    return [...this.contracts.values()].sort((left, right) =>
      left.systemId < right.systemId ? -1 : left.systemId > right.systemId ? 1 : 0,
    );
  }

  /** Number of registered contracts. */
  get size(): number {
    return this.contracts.size;
  }
}
