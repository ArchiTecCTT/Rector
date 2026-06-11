import { describe, it, expect } from "vitest";

import { runChat, type ChatRunArgs, type ChatRunResult } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import { makeContextPack } from "./support/byokArbitraries";

/**
 * Feature: productization-alpha, Task 11.2 — Local_Mode baseline pass-rate guard.
 *
 * Requirement 5.5: when the Prompt_Set is updated, it SHALL maintain a Local_Mode regression
 * baseline pass rate greater than or equal to the pass rate recorded immediately before the update.
 * Requirement 5.6: if a Prompt_Set update reduces the Local_Mode regression baseline pass rate
 * below the pre-update pass rate, THE System SHALL reject the update and retain the previous
 * Prompt_Set version.
 *
 * The provider-free deterministic Local_Mode is the regression baseline. This guard measures the
 * pass rate of a fixed, version-controlled set of Local_Mode regression cases and compares it
 * against the recorded pre-update baseline. "Reject the update" is realized as a failing gate: if
 * the measured (post-change) pass rate drops below the recorded baseline, `evaluatePromptUpdate`
 * reports the update as rejected and the previous prompt set as retained, and the gate assertion
 * fails so the change cannot merge.
 *
 * Everything is in-memory and provider-free: no API key and no outbound network call is made.
 */

/**
 * The Local_Mode regression baseline pass rate recorded immediately before any prompt change.
 * Local_Mode is deterministic and provider-free, so the baseline suite passes at 100%. A prompt
 * (or any other) change that lowers this measured rate must be rejected per Requirement 5.6.
 */
const LOCAL_MODE_BASELINE_PASS_RATE = 1;

/** A single deterministic Local_Mode regression case. */
interface LocalModeRegressionCase {
  /** Stable, human-readable case name. */
  readonly name: string;
  /** The user prompt that drives the deterministic local run. */
  readonly prompt: string;
  /** The triage route the deterministic pipeline must resolve and synthesize for. */
  readonly expectedRoute: string;
  /** The deterministic synthesis status the provider-free baseline produces for this route. */
  readonly expectedSynthesisStatus: string;
}

/**
 * The version-controlled Local_Mode regression suite. Each prompt exercises a distinct deterministic
 * triage route through the full brainstem (TRIAGE → … → DONE). The expected route and synthesis
 * status are the byte-stable outcomes the provider-free baseline produces today, so a drift in any
 * of them lowers the measured pass rate and signals a real regression in the baseline.
 */
const LOCAL_MODE_REGRESSION_CASES: readonly LocalModeRegressionCase[] = [
  {
    name: "direct-answer/explain",
    prompt: "Explain the Rector vertical slice.",
    expectedRoute: "DIRECT_ANSWER",
    expectedSynthesisStatus: "VALIDATED",
  },
  {
    name: "needs-clarification/what-is",
    prompt: "What is Rector and how does it work?",
    expectedRoute: "NEEDS_CLARIFICATION",
    expectedSynthesisStatus: "VALIDATED",
  },
  {
    name: "plan-only/architecture",
    prompt: "Give me an architecture design proposal/plan without editing any code.",
    expectedRoute: "PLAN_ONLY",
    expectedSynthesisStatus: "NEEDS_DECISION",
  },
  {
    name: "code-edit/refactor",
    prompt: "Please implement a refactor to add changes to src/index.ts and write tests.",
    expectedRoute: "CODE_EDIT",
    expectedSynthesisStatus: "NEEDS_DECISION",
  },
] as const;

/** Builds a fresh, schema-valid `ChatRunArgs` for a prompt, exactly as the chat endpoint does in local mode. */
async function buildArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "prompt-hardening baseline",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const observability = createInMemoryObservabilityTrace({ provider: "local" });

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };
}

/**
 * Decides whether a regression case passed: the deterministic local run must reach DONE/completed,
 * resolve the expected route, produce the expected deterministic synthesis status, and make zero
 * provider calls (provider-free).
 */
function regressionCasePasses(testCase: LocalModeRegressionCase, result: ChatRunResult): boolean {
  const { run, synthesis, observabilitySummary } = result;
  return (
    run.phase === "DONE" &&
    run.status === "completed" &&
    synthesis.route === testCase.expectedRoute &&
    synthesis.status === testCase.expectedSynthesisStatus &&
    synthesis.providerCalls === 0 &&
    observabilitySummary.modelCallCount === 0
  );
}

interface SuiteOutcome {
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly failures: string[];
}

/** Runs every Local_Mode regression case and returns the measured pass rate. */
async function runLocalModeRegressionSuite(
  cases: readonly LocalModeRegressionCase[] = LOCAL_MODE_REGRESSION_CASES,
): Promise<SuiteOutcome> {
  const failures: string[] = [];
  let passed = 0;

  for (const testCase of cases) {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, testCase.prompt);
    const result = await runChat(store, args, { mode: "local" });
    if (regressionCasePasses(testCase, result)) {
      passed += 1;
    } else {
      failures.push(testCase.name);
    }
  }

  const total = cases.length;
  return { total, passed, passRate: total === 0 ? 1 : passed / total, failures };
}

/** The decision the prompt-hardening gate makes (Requirements 5.5, 5.6). */
interface PromptUpdateDecision {
  /** Accepted iff the post-change pass rate is at least the pre-change baseline. */
  readonly accepted: boolean;
  /** Which prompt set stands after the decision. */
  readonly promptSetRetained: "updated" | "previous";
}

/**
 * The prompt-hardening gate. An update is accepted only when it maintains a Local_Mode regression
 * pass rate greater than or equal to the rate recorded immediately before the update (Req 5.5). A
 * drop rejects the update and the previous prompt set stands (Req 5.6).
 */
function evaluatePromptUpdate(beforePassRate: number, afterPassRate: number): PromptUpdateDecision {
  const accepted = afterPassRate >= beforePassRate;
  return { accepted, promptSetRetained: accepted ? "updated" : "previous" };
}

describe("Local_Mode baseline pass-rate guard (productization-alpha task 11.2)", () => {
  it("measures a 100% Local_Mode regression pass rate that meets the recorded baseline (Req 5.5)", async () => {
    const outcome = await runLocalModeRegressionSuite();

    // The suite must be non-trivial so the guard is meaningful.
    expect(outcome.total).toBeGreaterThanOrEqual(3);
    // No case may regress; the provider-free baseline is deterministic.
    expect(outcome.failures).toEqual([]);
    // The measured (post-change) rate must be at least the recorded pre-change baseline.
    expect(outcome.passRate).toBeGreaterThanOrEqual(LOCAL_MODE_BASELINE_PASS_RATE);
  });

  it("accepts a prompt update when the measured pass rate holds at the baseline (Req 5.5)", async () => {
    const outcome = await runLocalModeRegressionSuite();

    // Feed the measured rate as the post-change rate and the recorded constant as the pre-change
    // baseline: an unchanged-or-better rate accepts the update and the updated prompt set stands.
    const decision = evaluatePromptUpdate(LOCAL_MODE_BASELINE_PASS_RATE, outcome.passRate);
    expect(decision.accepted).toBe(true);
    expect(decision.promptSetRetained).toBe("updated");
  });

  it("rejects a prompt update that drops the Local_Mode pass rate and retains the previous prompt set (Req 5.6)", () => {
    // A prompt change that lowers the baseline pass rate (e.g. one regression case now fails).
    const droppedRate = (LOCAL_MODE_REGRESSION_CASES.length - 1) / LOCAL_MODE_REGRESSION_CASES.length;
    expect(droppedRate).toBeLessThan(LOCAL_MODE_BASELINE_PASS_RATE);

    const decision = evaluatePromptUpdate(LOCAL_MODE_BASELINE_PASS_RATE, droppedRate);

    // The gate fails the update, so the previous prompt set stands (Req 5.6).
    expect(decision.accepted).toBe(false);
    expect(decision.promptSetRetained).toBe("previous");
  });

  it("accepts an update that improves the pass rate above the prior baseline (Req 5.5)", () => {
    // A prior baseline below 100% that the update raises is accepted.
    const priorBaseline = 0.5;
    const improvedRate = 1;
    const decision = evaluatePromptUpdate(priorBaseline, improvedRate);

    expect(decision.accepted).toBe(true);
    expect(decision.promptSetRetained).toBe("updated");
  });

  it("treats an exactly-equal pass rate as maintained, not a drop (Req 5.5 boundary)", () => {
    const decision = evaluatePromptUpdate(0.75, 0.75);
    expect(decision.accepted).toBe(true);
    expect(decision.promptSetRetained).toBe("updated");
  });
});
