import { describe, it, expect } from "vitest";
import {
  PLANNER_SYSTEM_RULES,
  PLANNER_JSON_CONTRACT,
  SKEPTIC_SYSTEM_RULES,
  SYNTHESIZER_SYSTEM_RULES,
  REPAIR_SYSTEM_RULES,
} from "../src/orchestration/prompts";

/**
 * Feature: productization-alpha, Task 11.1 — Prompt-hardening safety-constraint gate.
 *
 * Requirement 5.2: when the Prompt_Set is updated, every safety constraint that was present
 * before the update must be retained, verified by this suite passing at 100%.
 * Requirement 5.3: if a Prompt_Set update drops a safety constraint, the System rejects the
 * update — realized here as a failing gate (a dropped constraint fails its assertion below, so
 * the change does not pass and the previous prompt set stands).
 * Requirement 5.7: the "never include secrets" lines are asserted for every live agent so the
 * redaction/no-secret bar can never be silently edited out of a prompt.
 *
 * Each entry is an exact safety line/invariant that currently exists in the live prompt set.
 * Dropping or rewording any of these in `src/orchestration/prompts.ts` fails this suite, which is
 * the prompt-hardening gate: a prompt edit that weakens safety cannot merge.
 */

/** The non-negotiable "no secrets" instruction, asserted once per live agent (Requirement 5.7). */
const NO_SECRETS_PLANNER =
  "Never include secrets, API keys, credentials, or environment variable values in the plan.";
const NO_SECRETS_ANY_FIELD =
  "Never include secrets, API keys, credentials, tokens, or environment variable values in any field.";

interface PromptConstraintGroup {
  /** Human-readable name of the prompt surface under test. */
  readonly name: string;
  /** The prompt constant whose safety lines must be preserved. */
  readonly source: string;
  /** Exact safety lines/invariants that must remain present verbatim. */
  readonly constraints: readonly string[];
}

const SAFETY_CONSTRAINTS: readonly PromptConstraintGroup[] = [
  {
    name: "PLANNER_SYSTEM_RULES",
    source: PLANNER_SYSTEM_RULES,
    constraints: [
      // The planner never executes; the symbolic control plane validates/budgets/runs.
      "You do NOT execute anything: a deterministic control plane validates, budgets, and runs the plan.",
      // No secrets ever leak through a proposed plan.
      NO_SECRETS_PLANNER,
      // Smallest-safe-plan bias keeps blast radius minimal.
      "Prefer the smallest safe plan that satisfies the request; do not invent unrelated work.",
    ],
  },
  {
    name: "PLANNER_JSON_CONTRACT",
    source: PLANNER_JSON_CONTRACT,
    constraints: [
      // Hard approval-gate invariant: unsafe tasks must be covered by a required approval gate.
      "must be covered by a required",
      "required plan-level gate",
      // Underspecified requests yield a required clarification gate instead of guessing.
      'return zero tasks and a required gate of type',
      '"clarification"',
    ],
  },
  {
    name: "SKEPTIC_SYSTEM_RULES",
    source: SKEPTIC_SYSTEM_RULES,
    constraints: [
      // The skeptic only critiques; it never executes, edits, or approves.
      "You do NOT execute, edit, or approve anything: a deterministic control plane consumes your critique.",
      // No secrets in any critique field.
      NO_SECRETS_ANY_FIELD,
      // Findings must be evidence-grounded, not invented.
      "Ground every finding in concrete evidence drawn from the plan or context; do not invent issues.",
      // The control plane recomputes the verdict, so honest severities are required.
      "The control plane recomputes the final verdict from your finding severities, so report findings honestly.",
    ],
  },
  {
    name: "SYNTHESIZER_SYSTEM_RULES",
    source: SYNTHESIZER_SYSTEM_RULES,
    constraints: [
      // The synthesizer only writes the answer; it never executes, edits, or approves.
      "You do NOT execute, edit, or approve anything: a deterministic control plane validates your answer and may fall back to a deterministic answer.",
      // Claims must be grounded in run state, never invented.
      "Ground every claim in the run state below. Do not invent files, commands, tests, results, or risks that are not present in it.",
      // Evidence must be cited when execution/validation occurred.
      "When the run carried any execution or validation evidence, you MUST include at least one citation.",
      // Failed validation output must never be hidden.
      "Never hide or omit failed validation output; report failures honestly and surface unresolved risks.",
      // No secrets in any answer field.
      NO_SECRETS_ANY_FIELD,
    ],
  },
  {
    name: "REPAIR_SYSTEM_RULES",
    source: REPAIR_SYSTEM_RULES,
    constraints: [
      // The repair agent only proposes; it never executes, writes, or approves.
      "You do NOT execute, write, or approve anything: a deterministic control plane validates your proposal,",
      // Smallest-safe-patch bias keeps blast radius minimal.
      "Propose the smallest safe patch that addresses the failure; do not invent unrelated changes.",
      // Path containment: no absolute paths, no traversal, no leading slash.
      "Target only a safe relative path inside the workspace (no absolute paths, no '..' segments, no leading slash).",
      // No secrets in any patch field.
      NO_SECRETS_ANY_FIELD,
    ],
  },
] as const;

describe("prompt safety-constraint gate (productization-alpha task 11.1)", () => {
  for (const group of SAFETY_CONSTRAINTS) {
    describe(group.name, () => {
      it.each(group.constraints)("retains the safety constraint: %s", (constraint) => {
        expect(group.source).toContain(constraint);
      });
    });
  }

  it("asserts a 'never include secrets' line for every live agent prompt (Requirement 5.7)", () => {
    expect(PLANNER_SYSTEM_RULES).toContain(NO_SECRETS_PLANNER);
    expect(SKEPTIC_SYSTEM_RULES).toContain(NO_SECRETS_ANY_FIELD);
    expect(SYNTHESIZER_SYSTEM_RULES).toContain(NO_SECRETS_ANY_FIELD);
    expect(REPAIR_SYSTEM_RULES).toContain(NO_SECRETS_ANY_FIELD);
  });

  it("covers all four live agent rule sets plus the planner approval-gate invariant", () => {
    const covered = SAFETY_CONSTRAINTS.map((group) => group.name);
    expect(covered).toEqual([
      "PLANNER_SYSTEM_RULES",
      "PLANNER_JSON_CONTRACT",
      "SKEPTIC_SYSTEM_RULES",
      "SYNTHESIZER_SYSTEM_RULES",
      "REPAIR_SYSTEM_RULES",
    ]);
  });
});
