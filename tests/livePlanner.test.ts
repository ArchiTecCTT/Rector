/**
 * Live planner property tests (ORN-34).
 *
 * Property 3: Budget denial precedes the network call.
 *
 * Validates Requirements 3.3 and 4.5 (the budget preflight runs before any
 * provider network call; ORN-34 performs a planner-level preflight before
 * `provider.invoke`). For arbitrary planner input paired with an arbitrary
 * sub-threshold budget — one that zeroes exactly one hard limit so any positive
 * estimate is denied by `evaluateBudget` — `runLivePlanner` must:
 *   - resolve (never throw) to `status: "blocked"`,
 *   - carry a `BUDGET_DENIED` blocker,
 *   - and leave the spy provider's `invoke` count at exactly 0
 *     (no network/provider call ever happened).
 *
 * The spy provider is given a positive default usage so its `estimateRequest`
 * returns a non-zero cost; the denial therefore comes solely from the
 * sub-threshold budget. Everything is in-memory and mock-only: no API key and
 * no network are used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  PlannerInputSchema,
  createFakePlan,
  runLivePlanner,
  validatePlannerOutput,
  type PlannerInput,
} from "../src/orchestration/planner";
import { ProviderError, type LLMUsage } from "../src/providers/llm";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbAllowingBudget,
  arbMalformedPlannerJson,
  arbPlannerInput,
  arbSchemaValidPlan,
  arbSubThresholdBudget,
  arbValidPlan,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  planToJson,
  type ScriptedResponse,
} from "./support/byokArbitraries";

describe("Property 3: budget denial precedes the network call", () => {
  // Validates: Requirements 3.3, 4.5.
  it("blocks with BUDGET_DENIED and never invokes the provider for sub-threshold budgets", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlannerInput(), arbSubThresholdBudget(), async (input, budget) => {
        // Positive default usage => a non-zero estimate that any zeroed hard
        // limit must deny. No scripted responses are needed because the
        // provider must never be invoked.
        const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE });
        const run = makeExternalRun(budget);

        const result = await runLivePlanner(input, { provider, run });

        // The preflight denied the call: structured blocker, no plan.
        expect(result.status).toBe("blocked");
        expect(result.blocker?.code).toBe("BUDGET_DENIED");
        expect(result.plan).toBeUndefined();

        // The decisive assertion: the provider was never invoked.
        expect(provider.invokeCount).toBe(0);

        // Denial occurs before the first call, so no attempt is recorded and
        // no usage accrues.
        expect(result.attempts).toBe(0);
        expect(result.usage.modelCalls).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Property 4: Invalid planner JSON after one repair yields a structured
 * blocker, never a crash.
 *
 * Validates Requirements 4.2, 4.3, and 3.5 (ORN-34 issues exactly one repair
 * prompt then refuses deterministically; the planner caps provider calls at
 * two; the surrounding run path turns the failure into a structured result
 * rather than an exception). For arbitrary planner input paired with arbitrary
 * malformed/schema-invalid provider output on BOTH attempts and a budget that
 * never denies, `runLivePlanner` must:
 *   - resolve (never throw) to `status: "blocked"`,
 *   - carry a `PLANNER_INVALID` blocker,
 *   - report `attempts === 2` (one initial call + exactly one repair),
 *   - leave the spy provider's `invoke` count at exactly 2,
 *   - and keep the blocker redacted: no raw model output leaks into the
 *     message/details, which are limited to Zod issue paths (schema field
 *     identifiers).
 *
 * The two scripted responses are independent malformed payloads (non-JSON,
 * wrong-typed JSON, or a plan missing a required field) so the property holds
 * across the full failure space. Everything is in-memory and mock-only.
 */
describe("Property 4: invalid planner JSON after one repair yields a structured blocker", () => {
  // Validates: Requirements 4.2, 4.3, 3.5.
  it("blocks with PLANNER_INVALID after exactly two invoke calls and never throws", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPlannerInput(),
        arbMalformedPlannerJson(),
        arbMalformedPlannerJson(),
        arbAllowingBudget(),
        async (input, firstMalformed, secondMalformed, budget) => {
          // Both attempts return malformed/schema-invalid output. A generous
          // budget guarantees the preflight allows both calls, so the only
          // reason the planner stops is the single-repair refusal.
          const provider = new SpyLLMProvider({
            estimate: DEFAULT_SPY_USAGE,
            responses: [firstMalformed, secondMalformed],
          });
          const run = makeExternalRun(budget);

          // Must resolve, never throw, even for arbitrary malformed output.
          const result = await runLivePlanner(input, { provider, run });

          // Structured blocker, no plan.
          expect(result.status).toBe("blocked");
          expect(result.blocker?.code).toBe("PLANNER_INVALID");
          expect(result.plan).toBeUndefined();

          // Exactly one initial call + one repair = two provider invocations.
          expect(result.attempts).toBe(2);
          expect(provider.invokeCount).toBe(2);

          // Redaction: the blocker carries only a known redacted message
          // template and Zod issue paths (schema field identifiers) — never the
          // raw model output. The non-JSON arbitraries embed a unique sentinel
          // (`<<<NOT_JSON`) that must never survive into the returned blocker.
          // (Tiny JSON literals like `[]`/`{}`/`null` are intentionally NOT
          // substring-checked: they collide with ordinary serialized JSON and
          // are never echoed because the blocker is built from issue paths.)
          expect(result.blocker?.message.startsWith("Planner output")).toBe(true);

          const serializedBlocker = JSON.stringify(result.blocker);
          expect(serializedBlocker).not.toContain("<<<NOT_JSON");

          const details = result.blocker?.details as { issues?: unknown } | undefined;
          if (details?.issues !== undefined) {
            expect(Array.isArray(details.issues)).toBe(true);
            for (const issue of details.issues as unknown[]) {
              // Each detail is a schema field identifier (Zod issue path),
              // e.g. "goal", "tasks.0.id", "(root)", or "(invariant)".
              expect(typeof issue).toBe("string");
              expect(issue as string).toMatch(/^[\w().[\]]+$/);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Property 5: Valid planner JSON (possibly after repair) passes the same safety
 * bar as the fake plan.
 *
 * Validates Requirements 4.1 and 4.6 (ORN-34 holds live provider output to the
 * exact same validation bar as `createFakePlan`: the parsed JSON must satisfy
 * `PlannerOutputSchema` AND the `validatePlannerOutput` invariants — dependency
 * references resolve and every high-risk/approval-required task is gated —
 * before the planner returns `status: "ok"`).
 *
 * The oracle is the planner's own deeper gate, the exported
 * `validatePlannerOutput`, which the live planner runs internally after the
 * schema parse. It signals acceptance by RETURNING the parsed plan and
 * rejection by THROWING. The test arbitrary `arbSchemaValidPlan()` always
 * parses against `PlannerOutputSchema` but MAY violate those deeper invariants
 * (dangling dependency refs, ungated unsafe tasks), so it exercises both sides
 * of the oracle.
 *
 * For an arbitrary schema-valid plan P scripted as the spy provider's reply on
 * BOTH attempts (so a repair would re-see the same plan and reach the same
 * verdict) and a budget that never denies, `runLivePlanner` resolves to:
 *   - oracle accepts P  =>  status "ok" AND result.plan deep-equals P;
 *   - oracle rejects P  =>  status "blocked" AND blocker.code "PLANNER_INVALID".
 *
 * This is the strict parity: live output is `ok` if and only if the same safety
 * bar that gates the fake plan accepts it. Everything is in-memory and
 * mock-only: no API key and no network are used.
 */
describe("Property 5: valid planner JSON passes the same safety bar as the fake plan", () => {
  /** Runs the oracle: true when `validatePlannerOutput` accepts the plan. */
  function oracleAccepts(plan: Parameters<typeof planToJson>[0]): boolean {
    try {
      validatePlannerOutput(plan);
      return true;
    } catch {
      return false;
    }
  }

  // Validates: Requirements 4.1, 4.6.
  it("returns ok iff validatePlannerOutput accepts the plan, with parity on the verdict", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlannerInput(), arbSchemaValidPlan(), arbAllowingBudget(), async (input, plan, budget) => {
        // The provider scripts the SAME schema-valid plan on both the initial
        // and the repair attempt: a repair (if one happens) re-sees identical
        // content and the deterministic oracle reaches the identical verdict.
        const planJson = planToJson(plan);
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [planJson, planJson],
        });
        const run = makeExternalRun(budget);

        const accepted = oracleAccepts(plan);
        const result = await runLivePlanner(input, { provider, run });

        if (accepted) {
          // Oracle accepts => the live planner must accept too, returning the
          // exact plan it validated.
          expect(result.status).toBe("ok");
          expect(result.blocker).toBeUndefined();
          expect(result.plan).toEqual(plan);
          expect(provider.invokeCount).toBeGreaterThanOrEqual(1);
        } else {
          // Oracle rejects => the live planner must refuse with a structured
          // PLANNER_INVALID blocker and yield no plan, even after the repair.
          expect(result.status).toBe("blocked");
          expect(result.blocker?.code).toBe("PLANNER_INVALID");
          expect(result.plan).toBeUndefined();
        }
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Property 6: At most one repair (at most 2 provider calls).
 *
 * Validates Requirement 4.2 (ORN-34's single-repair retry bound). The live
 * planner performs one initial provider call plus AT MOST one repair call, so
 * `provider.invoke` is called no more than twice over any single
 * `runLivePlanner` invocation — regardless of which outcome path the run takes.
 *
 * This property must hold across EVERY outcome path, so the spy's scripted
 * responses vary over an `fc.oneof` of response shapes:
 *   - valid-first-try   => [validPlanJson]            (1 call, status "ok")
 *   - valid-after-repair => [malformed, validPlanJson] (2 calls, status "ok")
 *   - invalid-after-repair => [malformed, malformed]   (2 calls, PLANNER_INVALID)
 *   - provider-error    => [{ error: ProviderError }]  (1 call, PROVIDER_ERROR)
 *
 * The spy is configured with `onOverflow: "repeat-last"` so a hypothetical
 * THIRD call would return content instead of throwing an overflow error. That
 * makes `invokeCount <= 2` (and `attempts <= 2`) the meaningful assertion: if
 * the planner ever attempted a third call the count — not an overflow throw —
 * would catch the regression.
 *
 * Budgets are drawn from `arbAllowingBudget()` so the preflight never denies a
 * call (a denied budget yields 0 calls, which also satisfies <= 2 but is not
 * the interesting case; it is covered by Property 3). Everything is in-memory
 * and mock-only: no API key and no network are used.
 */
describe("Property 6: at most one repair (at most 2 provider calls)", () => {
  /**
   * Arbitrary scripted response list spanning every outcome path the live
   * planner can take. `arbValidPlan()` is held to the same safety bar as the
   * fake plan, so the valid scripts deterministically reach status "ok".
   */
  const arbResponseScript = (): fc.Arbitrary<Array<string | ScriptedResponse>> =>
    fc.oneof(
      // valid-first-try: one call, returns "ok".
      arbValidPlan().map((plan) => [planToJson(plan)]),
      // valid-after-repair: malformed then valid => two calls, returns "ok".
      fc
        .tuple(arbMalformedPlannerJson(), arbValidPlan())
        .map(([malformed, plan]) => [malformed, planToJson(plan)]),
      // invalid-after-repair: malformed twice => two calls, PLANNER_INVALID.
      fc
        .tuple(arbMalformedPlannerJson(), arbMalformedPlannerJson())
        .map(([first, second]) => [first, second]),
      // provider-error: the first call throws => one call, PROVIDER_ERROR.
      fc.constant([
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            message: "simulated provider failure",
          }),
        } satisfies ScriptedResponse,
      ])
    );

  // Validates: Requirements 4.2.
  it("never invokes the provider more than twice over any single invocation", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPlannerInput(),
        arbResponseScript(),
        arbAllowingBudget(),
        async (input, responses, budget) => {
          // `repeat-last` means a hypothetical 3rd call returns content rather
          // than throwing, so the call COUNT is the meaningful guard.
          const provider = new SpyLLMProvider({
            estimate: DEFAULT_SPY_USAGE,
            responses,
            onOverflow: "repeat-last",
          });
          const run = makeExternalRun(budget);

          // Must resolve, never throw, on every scripted outcome path.
          const result = await runLivePlanner(input, { provider, run });

          // The single-repair bound: one initial call + at most one repair.
          expect(provider.invokeCount).toBeLessThanOrEqual(2);
          expect(result.attempts).toBeLessThanOrEqual(2);

          // The reported attempt count must match the observed invocations,
          // so the bound is enforced on the real call path, not just on a
          // self-reported field.
          expect(result.attempts).toBe(provider.invokeCount);
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Concrete example/unit tests for `runLivePlanner` (Task 3.7).
 *
 * These complement the property tests above with fixed, hand-built inputs that
 * pin down specific behaviours of the live planner contract:
 *   - valid plan on the first try,
 *   - valid plan after exactly one repair (and the repair prompt is sent),
 *   - provider-error mapping to a PROVIDER_ERROR blocker (never throws),
 *   - LLM usage accumulation across attempts,
 *   - input-schema validation (PlannerInputSchema.parse throws on bad input),
 *   - the `json_object` response format on every request,
 *   - redaction of blocker details (Zod issue paths only) and of secrets in a
 *     provider-error message.
 *
 * Everything is in-memory and mock-only: no API key and no network are used.
 *
 * Validates: Requirements 4.1, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12.
 */
describe("runLivePlanner unit tests (concrete examples)", () => {
  /** Builds a single fixed, schema-valid PlannerInput for example-based tests. */
  function makeFixedInput(
    prompt = "Add pagination to the /users endpoint and update the tests."
  ): PlannerInput {
    const triage = triageUserMessage(prompt);
    return PlannerInputSchema.parse({
      triage,
      contextPack: makeContextPack(triage, prompt),
      messageContent: prompt,
    });
  }

  // Validates: Requirement 4.1 (valid output passes the safety bar on first try).
  it("returns ok with the exact plan on a valid first try (one invoke)", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [planToJson(validPlan)],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("ok");
    expect(result.plan).toEqual(validPlan);
    expect(result.blocker).toBeUndefined();
    expect(provider.invokeCount).toBe(1);
    expect(result.attempts).toBe(1);
  });

  // Validates: Requirements 4.1, 4.2 (one repair turns a malformed first reply
  // into a valid plan; the repair prompt is actually sent to the provider).
  it("returns ok after exactly one repair and sends the repair prompt", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);
    const malformedFirst = "this is not valid json";
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [malformedFirst, planToJson(validPlan)],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("ok");
    expect(result.plan).toEqual(validPlan);
    expect(provider.invokeCount).toBe(2);
    expect(result.attempts).toBe(2);

    // The first request is the plain prompt (system + user); the second is the
    // repair prompt, which replays the prior turn and appends the validator
    // error summary, so it has more messages and differs from the first.
    const firstMessages = provider.requests[0].messages;
    const secondMessages = provider.requests[1].messages;
    expect(firstMessages).toHaveLength(2);
    expect(secondMessages).toHaveLength(4);

    // The rejected reply is replayed back to the model verbatim.
    expect(secondMessages[2]).toEqual({ role: "assistant", content: malformedFirst });

    // The final repair instruction carries the rejection notice + structured repair card.
    const repairInstruction = secondMessages[secondMessages.length - 1].content;
    expect(repairInstruction).toContain("Your previous response was rejected by the validator.");
    expect(repairInstruction).toContain("Strict JSON repair cards");
    expect(repairInstruction).toContain("kind/code: json_syntax / json_syntax_error");
    expect(secondMessages).not.toEqual(firstMessages);
  });

  // Validates: Requirement 4.11 (a thrown provider error becomes a redacted
  // PROVIDER_ERROR blocker; the planner never throws).
  it("maps a thrown provider error to a PROVIDER_ERROR blocker without throwing", async () => {
    const input = makeFixedInput();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            message: "Together AI request failed with HTTP 503",
          }),
        },
      ],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.plan).toBeUndefined();
    // The provider was invoked once (the failing call) and counted as an attempt.
    expect(provider.invokeCount).toBe(1);
    expect(result.attempts).toBe(1);
  });

  // Validates: Requirement 4.12 (usage is accumulated across every provider call).
  it("accumulates LLM usage across both attempts (malformed then valid)", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);

    const firstUsage: LLMUsage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedUsd: 0.002,
      modelCalls: 1,
    };
    const secondUsage: LLMUsage = {
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      estimatedUsd: 0.003,
      modelCalls: 1,
    };

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        { content: "still not json", usage: firstUsage },
        { content: planToJson(validPlan), usage: secondUsage },
      ],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("ok");
    expect(provider.invokeCount).toBe(2);
    // Usage is the element-wise sum of both calls' usage.
    expect(result.usage.inputTokens).toBe(firstUsage.inputTokens + secondUsage.inputTokens);
    expect(result.usage.outputTokens).toBe(firstUsage.outputTokens + secondUsage.outputTokens);
    expect(result.usage.totalTokens).toBe(firstUsage.totalTokens + secondUsage.totalTokens);
    expect(result.usage.modelCalls).toBe(firstUsage.modelCalls + secondUsage.modelCalls);
    expect(result.usage.estimatedUsd).toBeCloseTo(firstUsage.estimatedUsd + secondUsage.estimatedUsd, 10);
  });

  // Validates: Requirement 4.9 (input is validated against PlannerInputSchema
  // before any prompt is built; malformed input is a caller precondition
  // violation and rejects via the schema parse).
  it("rejects (throws) when the input violates PlannerInputSchema", async () => {
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE });
    const run = makeExternalRun(generousBudget());

    // Missing required `triage` and `contextPack` fields.
    const badInput = { messageContent: "no triage or context here" } as unknown as PlannerInput;

    await expect(runLivePlanner(badInput, { provider, run })).rejects.toThrow();
    // The schema parse happens before any prompt construction or provider call.
    expect(provider.invokeCount).toBe(0);
    expect(provider.estimateCount).toBe(0);
  });

  // Validates: Requirement 4.10 (every provider call requests a json_object
  // response format).
  it("requests a json_object response format on the provider call", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [planToJson(validPlan)],
    });
    const run = makeExternalRun(generousBudget());

    await runLivePlanner(input, { provider, run });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].responseFormat?.type).toBe("json_object");
    expect(provider.requests[0].modelRoute).toBe("flagship");
  });

  // Validates: Requirements 4.6, 4.5/4.11 (redaction). On the PLANNER_INVALID
  // path the blocker details carry only Zod issue paths (schema field
  // identifiers), never raw model output.
  it("redacts PLANNER_INVALID details to schema field identifiers only (no raw model output)", async () => {
    const input = makeFixedInput();
    // Valid JSON object, but schema-invalid AND carrying a unique sentinel that
    // must never leak into the returned blocker.
    const sentinel = "SECRET_SENTINEL_sk-abc123";
    const schemaInvalid = JSON.stringify({ unexpected: sentinel, tasks: "not-an-array" });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [schemaInvalid, schemaInvalid],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PLANNER_INVALID");
    expect(provider.invokeCount).toBe(2);

    // The raw model content (sentinel) never appears anywhere in the blocker.
    const serializedBlocker = JSON.stringify(result.blocker);
    expect(serializedBlocker).not.toContain(sentinel);

    // details.issues are schema field identifiers (Zod issue paths) only.
    const details = result.blocker?.details as { issues?: unknown } | undefined;
    expect(details?.issues).toBeDefined();
    expect(Array.isArray(details?.issues)).toBe(true);
    for (const issue of details?.issues as unknown[]) {
      expect(typeof issue).toBe("string");
      expect(issue as string).toMatch(/^[\w().[\]]+$/);
    }
    // A top-level missing-field issue path like "goal" is reported.
    expect(details?.issues as string[]).toContain("goal");
  });

  // Validates: Requirement 4.11 + 4.5 (a secret-like Bearer token in a provider
  // error message is redacted out of the returned blocker message).
  it("redacts a secret-like Bearer token from a PROVIDER_ERROR blocker message", async () => {
    const input = makeFixedInput();
    const secret = "sk-supersecretkey1234567890";
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            message: `Upstream rejected request with header Authorization: Bearer ${secret}`,
          }),
        },
      ],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    // The raw secret never survives into the redacted blocker message.
    expect(result.blocker?.message).not.toContain(secret);
    expect(result.blocker?.message).toContain("[REDACTED]");
  });

  // Validates: Requirements 4.7, 4.8 (budget preflight precedes the provider
  // call; a denied budget yields BUDGET_DENIED with zero invocations).
  it("does not persist model-derived diagnostic messages in PLANNER_INVALID blocker details", async () => {
    const input = makeFixedInput();
    const taskSentinel = "MODEL_TASK_ID_sentinel_abc123";
    const schemaInvalidPlan = JSON.stringify({
      goal: "Do something",
      assumptions: ["one"],
      tasks: [
        {
          id: taskSentinel,
          title: "Bad task",
          description: "References a missing dependency",
          dependencies: ["missing.parent.task"],
          expectedArtifacts: ["notes"],
          validation: ["check"],
          risk: "low",
          approvalRequired: false,
        },
      ],
      dependencies: [{ from: taskSentinel, to: "missing.parent.task" }],
      validation: { summary: "x", checks: ["y"] },
      riskLevel: "low",
      approvalGates: [],
    });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [schemaInvalidPlan, schemaInvalidPlan],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PLANNER_INVALID");

    const serialized = JSON.stringify(result.blocker);
    expect(serialized).not.toContain(taskSentinel);

    const details = result.blocker?.details as {
      diagnostics?: Array<Record<string, unknown>>;
      evidenceStatus?: string;
    };
    expect(details?.evidenceStatus).toBe("test_only_injected");
    expect(details?.diagnostics?.every((entry) => !("message" in entry))).toBe(true);
  });

  it("reports test_only_injected strict JSON evidence for spy provider passes", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [planToJson(validPlan)],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("ok");
    expect(result.strictJsonEvidenceStatus).toBe("test_only_injected");
    expect(result.strictJsonClassification).toBe("first_pass");
  });

  it("blocks schema-valid planner JSON when provider output is truncated (finishReason length)", async () => {
    const input = makeFixedInput();
    const validPlan = createFakePlan(input);
    const validJson = planToJson(validPlan);
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        { content: validJson, finishReason: "length" },
        { content: validJson, finishReason: "length" },
      ],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PLANNER_INVALID");
    expect(result.plan).toBeUndefined();
    expect(provider.invokeCount).toBe(2);
    expect(result.strictJsonAttempts?.some((attempt) =>
      attempt.diagnostics.some((diagnostic) => diagnostic.code === "provider_output_truncated"),
    )).toBe(true);
  });

  it("denies via budget preflight before invoking the provider", async () => {
    const input = makeFixedInput();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [planToJson(createFakePlan(input))],
    });
    // Zero the model-call ceiling so any positive estimate is denied.
    const run = makeExternalRun(generousBudget({ maxModelCalls: 0 }));

    const result = await runLivePlanner(input, { provider, run });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("BUDGET_DENIED");
    expect(provider.invokeCount).toBe(0);
    expect(result.attempts).toBe(0);
  });
});
