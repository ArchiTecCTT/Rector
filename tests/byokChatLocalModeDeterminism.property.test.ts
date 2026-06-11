/**
 * Task 2.4 — Local_Mode determinism property test (BYOK chat UX and model discovery).
 *
 * Feature: byok-chat-ux-and-model-discovery, Property 3: Local_Mode replies are deterministic and provider-free
 *
 * **Property 3: Local_Mode replies are deterministic and provider-free**
 * **Validates: Requirements 6.1, 6.2, 6.3, 27.2**
 *
 * For any `BrainstemSynthesisInput` evaluated in Local_Mode, two evaluations SHALL produce identical
 * `response` text, the result SHALL contain no provider-specific content, and `providerCalls` SHALL
 * equal 0.
 *
 * Local_Mode synthesis is the provider-free deterministic path
 * `synthesizeChatBrainstemResponse(input)` in `src/orchestration/synthesizer.ts`: it routes the
 * `Main_Assistant_Message` text through the pure, route-aware builders
 * (`buildClarificationResponse` / `buildDeterministicDirectAnswer` / legacy status string) and
 * always reports `providerCalls === 0`. This test exercises the synthesizer across every triage
 * route (the arbitrary prompt set spans `DIRECT_ANSWER`, `NEEDS_CLARIFICATION`, `PLAN_ONLY`,
 * `CODE_EDIT`, `RESEARCH`, `LONG_RUNNING`) and asserts:
 *
 *   - Determinism (Req 6.1, 6.2): two evaluations of the identical input produce a byte-identical
 *     `response` and an otherwise-identical synthesis object.
 *   - Provider-free (Req 6.3, 27.2): `providerCalls === 0` for both evaluations.
 *   - No provider-specific content (Req 6.3): a provider-name sentinel injected into the input's
 *     `availableProviders.configured` never appears in the produced `response`, proving the
 *     Local_Mode synthesizer ignores configured-provider data rather than echoing it. The sentinel
 *     injection keeps the assertion meaningful (non-vacuous): the un-redacted input genuinely
 *     carries the sentinel.
 *
 * Everything is in-memory and provider-free: no API key is read and zero provider/network calls
 * occur (asserted via `providerCalls === 0`).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { ContextPackSchema } from "../src/orchestration/contextBuilder";
import {
  buildDeterministicDirectAnswer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { arbPlannerInput } from "./support/byokArbitraries";

/** Fixed timestamp so the crucible decision is itself deterministic across the two evaluations. */
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * A unique, redactable provider-name sentinel woven through several supported provider kinds. It is
 * injected into `availableProviders.configured`; the Local_Mode synthesizer must never echo it into
 * the user-facing `response`.
 */
const PROVIDER_SENTINEL = "PROVIDER_SENTINEL_together_azure_cloudflare_openai_ZZZ";

/**
 * Arbitrary, fully-grounded `BrainstemSynthesisInput` whose triage route varies across the full
 * route set (driven by the canned + free-form prompt arbitrary). Built bottom-up from an arbitrary
 * planner input so every dependent field is internally consistent (plan → skeptic review → crucible
 * decision), then the context pack is replaced with one carrying the provider sentinel so the
 * "no provider-specific content" assertion is meaningful.
 */
const arbLocalSynthesisInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  arbPlannerInput().map((plannerInput) => {
    const plannerOutput = createFakePlan(plannerInput);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => FIXED_TIMESTAMP,
    });

    const contextPack = ContextPackSchema.parse({
      ...plannerInput.contextPack,
      availableProviders: {
        ...plannerInput.contextPack.availableProviders,
        configured: [PROVIDER_SENTINEL],
      },
    });

    return {
      traceId: "trace-local-determinism",
      triage: plannerInput.triage,
      contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

describe("Property 3: Local_Mode replies are deterministic and provider-free", () => {
  // Feature: byok-chat-ux-and-model-discovery, Property 3: Local_Mode replies are deterministic and provider-free
  // Validates: Requirements 6.1, 6.2, 6.3, 27.2.
  it("produces identical, provider-free replies for identical Local_Mode input", () => {
    fc.assert(
      fc.property(arbLocalSynthesisInput(), (input) => {
        // Sanity: the input genuinely carries the provider sentinel, so the leak assertion below is
        // meaningful rather than vacuous.
        expect(JSON.stringify(input)).toContain(PROVIDER_SENTINEL);

        // Two independent Local_Mode evaluations of the identical input.
        const first = synthesizeChatBrainstemResponse(input);
        const second = synthesizeChatBrainstemResponse(input);

        // Req 6.1, 6.2: identical input yields byte-identical response text and an otherwise
        // identical synthesis object (deterministic, reproducible Local_Mode reply).
        expect(second.response).toBe(first.response);
        expect(second).toEqual(first);

        // Req 6.3, 27.2: Local_Mode makes zero provider/network calls.
        expect(first.providerCalls).toBe(0);
        expect(second.providerCalls).toBe(0);

        // Req 6.3: no provider-specific content — the configured-provider sentinel never leaks into
        // the user-facing reply.
        expect(first.response).not.toContain(PROVIDER_SENTINEL);

        // Req 6.1/6.3: the deterministic DIRECT_ANSWER reply is exactly the pure builder's output,
        // which carries no provider content by construction.
        if (input.triage.route === "DIRECT_ANSWER") {
          expect(first.response).toBe(buildDeterministicDirectAnswer(input));
        }
      }),
      { numRuns: 100 },
    );
  });
});
