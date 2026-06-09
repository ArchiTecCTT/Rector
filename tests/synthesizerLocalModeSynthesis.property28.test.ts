/**
 * Feature: cloud-capable-transition, Property 28: Local-mode synthesis is
 * deterministic with zero provider calls.
 *
 * Validates: Requirements 7.5, 9.4
 *
 * Req 7.5: WHILE Orchestrator_Mode is `local`, WHEN a run resolves to a
 * Heavy_Developer_Route, THE Synthesizer SHALL return the deterministic
 * Legacy_Status_Response and SHALL make zero provider calls.
 *
 * Req 9.4: WHEN a run completes in Local_Mode, THE Synthesizer SHALL report
 * `providerCalls` equal to 0.
 *
 * `synthesizeHeavyDeveloperRoute` opens the live gate only for an external-mode
 * Heavy_Developer_Route with a valid designated flagship provider. In local mode
 * the gate is always closed regardless of the heavy route or the
 * `flagshipProviderIsValid` flag, so the synthesizer returns the deterministic
 * `synthesizeChatBrainstemResponse` (the `Status: ... Route: ... Evidence: ...`
 * Legacy_Status_Response for a heavy route) with `providerCalls === 0` and never
 * touches the provider.
 *
 * This property ranges over every Heavy_Developer_Route together with arbitrary,
 * internally-consistent run state and an arbitrary `flagshipProviderIsValid`
 * value, and asserts two things:
 *
 *   1. Zero provider calls — the injected counting double is never invoked
 *      (`invokeCount === 0` / `estimateCount === 0`) and the synthesis reports
 *      `providerCalls === 0`. The double is scripted with NO responses and the
 *      default `onOverflow: "throw"`, so any invocation would throw and falsify
 *      the property: the double genuinely "must never be called".
 *   2. Determinism — synthesizing the same input twice yields a deep-equal
 *      result, and that result equals the deterministic baseline
 *      `synthesizeChatBrainstemResponse(input)`.
 *
 * Everything is in-memory and mock-only: no API key, no network, no real
 * provider call.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import {
  synthesizeHeavyDeveloperRoute,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
  type SynthesizerGateContext,
} from "../src/orchestration/synthesizer";
import {
  SpyLLMProvider,
  arbPlannerInput,
  generousBudget,
  makeExternalRun,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The four Heavy_Developer_Routes (Req 7.1) — the gate-relevant routes for Req 7.5. */
const HEAVY_DEVELOPER_ROUTES = [
  TRIAGE_ROUTES.RESEARCH,
  TRIAGE_ROUTES.CODE_EDIT,
  TRIAGE_ROUTES.PLAN_ONLY,
  TRIAGE_ROUTES.LONG_RUNNING,
] as const;

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route
 * is forced to one of the four Heavy_Developer_Routes. The plan, skeptic review,
 * and crucible decision are derived bottom-up from an arbitrary planner input so
 * every dependent field stays consistent; only the triage `route` is overridden
 * (kept schema-valid) to pin the heavy-route condition.
 */
const arbHeavyRouteInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  fc
    .tuple(arbPlannerInput(), fc.constantFrom(...HEAVY_DEVELOPER_ROUTES))
    .map(([plannerInput, route]) => {
      const triage: TriageResult = { ...plannerInput.triage, route };
      const plannerOutput = createFakePlan(plannerInput);
      const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
      const crucibleDecision = arbitratePlanWithCrucible({
        plannerOutput,
        skepticReview,
        now: () => FIXED_TIMESTAMP,
      });

      return {
        traceId: "trace-prop28",
        triage,
        contextPack: plannerInput.contextPack,
        plannerOutput,
        skepticReview,
        crucibleDecision,
      };
    });

describe("Feature: cloud-capable-transition, Property 28: local-mode synthesis is deterministic with zero provider calls", () => {
  // Validates: Requirements 7.5, 9.4.
  it("returns the deterministic Legacy_Status_Response with zero provider calls in local mode, even with a valid flagship", async () => {
    await fc.assert(
      fc.asyncProperty(arbHeavyRouteInput(), fc.boolean(), async (input, flagshipProviderIsValid) => {
        // A counting double scripted with NO responses (default onOverflow: "throw"): any provider
        // invocation throws, so it genuinely "must never be called". Local mode must keep it untouched.
        const provider = new SpyLLMProvider();
        // Local mode closes the gate regardless of the heavy route or whether a flagship is valid.
        const gate: SynthesizerGateContext = { mode: "local", flagshipProviderIsValid };

        const firstRun = await synthesizeHeavyDeveloperRoute(input, {
          provider,
          run: makeExternalRun(generousBudget()),
          gate,
        });

        // Req 7.5 / 9.4: zero provider calls — the double was never invoked and never estimated, and
        // the synthesis reports providerCalls === 0.
        expect(provider.invokeCount).toBe(0);
        expect(provider.estimateCount).toBe(0);
        expect(firstRun.attempts).toBe(0);
        expect(firstRun.status).toBe("fallback");
        expect(firstRun.synthesis.providerCalls).toBe(0);
        expect(firstRun.citations).toEqual([]);

        // Req 7.5: the deterministic answer for a Heavy_Developer_Route is the Legacy_Status_Response.
        const baseline = synthesizeChatBrainstemResponse(input);
        expect(baseline.response.startsWith("Status:")).toBe(true);
        expect(firstRun.synthesis).toEqual(baseline);

        // Determinism: synthesizing the same input again with a fresh, never-called double yields a
        // deep-equal result.
        const secondProvider = new SpyLLMProvider();
        const secondRun = await synthesizeHeavyDeveloperRoute(input, {
          provider: secondProvider,
          run: makeExternalRun(generousBudget()),
          gate,
        });

        expect(secondProvider.invokeCount).toBe(0);
        expect(secondRun.synthesis).toEqual(firstRun.synthesis);
        expect(secondRun.synthesis.response).toBe(firstRun.synthesis.response);
      }),
      { numRuns: 200 }
    );
  });
});
