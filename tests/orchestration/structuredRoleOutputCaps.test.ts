import { afterEach, describe, expect, it } from "vitest";

import {
  createFakePlan,
  runLivePlanner,
  type PlannerInput,
} from "../../src/orchestration/planner";
import {
  clampStructuredRoleMaxOutputTokens,
  DEFAULT_LIVE_HARNESS_STRUCTURED_ROLE_MAX_OUTPUT_TOKENS,
  resolveStructuredRoleMaxOutputTokens,
  structuredRoleOutputCapPolicyForHarnessScenario,
} from "../../src/orchestration/structuredRoleOutputCaps";
import { arbitratePlanWithCrucible } from "../../src/orchestration/crucible";
import { reviewPlanWithSkeptic, runLiveSkeptic } from "../../src/orchestration/skeptic";
import { runLiveSynthesizer, type BrainstemSynthesisInput } from "../../src/orchestration/synthesizer";
import { triageUserMessage } from "../../src/orchestration/triage";
import { OpenAICompatibleProvider } from "../../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  synthesisDraftToJson,
} from "../support/byokArbitraries";

function plannerInput(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

describe("structuredRoleOutputCaps policy", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("uses scenario caps for harness roles when env overrides are absent", () => {
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 900 });
    expect(resolveStructuredRoleMaxOutputTokens("planner", policy)).toBe(900);
    expect(resolveStructuredRoleMaxOutputTokens("skeptic", policy)).toBe(900);
    expect(resolveStructuredRoleMaxOutputTokens("synthesizer", policy)).toBe(900);
    expect(resolveStructuredRoleMaxOutputTokens("repair", policy)).toBe(900);
  });

  it("prefers harness env overrides over scenario caps", () => {
    process.env.RECTOR_LIVE_HARNESS_PLANNER_MAX_OUTPUT_TOKENS = "2048";
    process.env.RECTOR_LIVE_HARNESS_REPAIR_MAX_OUTPUT_TOKENS = "512";
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 900 });
    expect(resolveStructuredRoleMaxOutputTokens("planner", policy)).toBe(2048);
    expect(resolveStructuredRoleMaxOutputTokens("repair", policy)).toBe(512);
  });

  it("returns undefined when no policy is attached (product default path)", () => {
    expect(resolveStructuredRoleMaxOutputTokens("planner", undefined)).toBeUndefined();
  });

  it("clamps to run budget maxOutputTokens", () => {
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 4_096 });
    const run = makeExternalRun({ ...generousBudget(), maxOutputTokens: 600 });
    expect(resolveStructuredRoleMaxOutputTokens("planner", policy, run)).toBe(600);
  });

  it("falls back to harness default when role cap omitted inside policy", () => {
    const cap = clampStructuredRoleMaxOutputTokens(DEFAULT_LIVE_HARNESS_STRUCTURED_ROLE_MAX_OUTPUT_TOKENS);
    expect(cap).toBe(4_096);
  });
});

describe("structured role cap propagation to provider requests", () => {
  it("omits maxOutputTokens on live planner calls without an opted-in policy", async () => {
    const input = plannerInput("Fix src/api/server.ts and update tests.");
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [JSON.stringify(createFakePlan(input))],
    });
    const run = makeExternalRun(generousBudget());

    await runLivePlanner(input, { provider, run });

    expect(provider.requests[0]?.maxOutputTokens).toBeUndefined();
  });

  it("propagates harness planner caps to spy invoke and estimate preflight", async () => {
    const input = plannerInput("Fix src/api/server.ts and update tests.");
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 1_000 });
    const provider = new SpyLLMProvider({
      estimate: (request) => ({
        ...DEFAULT_SPY_USAGE,
        outputTokens: request.maxOutputTokens ?? 0,
        totalTokens: DEFAULT_SPY_USAGE.inputTokens + (request.maxOutputTokens ?? 0),
      }),
      responses: [JSON.stringify(createFakePlan(input))],
    });
    const run = makeExternalRun(generousBudget());

    await runLivePlanner(input, { provider, run, structuredRoleOutputCaps: policy });

    expect(provider.requests[0]?.maxOutputTokens).toBe(1_000);
    expect(provider.estimateCount).toBeGreaterThan(0);
  });

  it("uses repair cap on planner repair attempt", async () => {
    const input = plannerInput("Fix src/api/server.ts and update tests.");
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 900 });
    policy.repair = 777;
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: ["not-json", JSON.stringify(createFakePlan(input))],
      onOverflow: "repeat-last",
    });
    const run = makeExternalRun(generousBudget());

    await runLivePlanner(input, { provider, run, structuredRoleOutputCaps: policy });

    expect(provider.requests[0]?.maxOutputTokens).toBe(900);
    expect(provider.requests[1]?.maxOutputTokens).toBe(777);
  });

  it("propagates harness skeptic caps instead of provider 512 default", async () => {
    const prompt = "Create an implementation plan for adding login, but do not edit files.";
    const triage = triageUserMessage(prompt);
    const contextPack = makeContextPack(triage, prompt);
    const plan = createFakePlan(plannerInput(prompt));
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 900 });
    const skepticJson = JSON.stringify({
      verdict: "SOUND",
      findings: [],
      planGoal: plan.goal,
    });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [skepticJson],
    });
    const run = makeExternalRun(generousBudget());

    await runLiveSkeptic(
      { plannerOutput: plan, contextPack, triage },
      { provider, run, structuredRoleOutputCaps: policy },
    );

    expect(provider.requests[0]?.maxOutputTokens).toBe(900);
  });

  it("propagates harness synthesizer caps instead of provider 512 default", async () => {
    const policy = structuredRoleOutputCapPolicyForHarnessScenario({ maxOutputTokens: 1_000 });
    const prompt = "Research vector databases and compare tradeoffs.";
    const triage = triageUserMessage(prompt);
    const contextPack = makeContextPack(triage, prompt);
    const plannerOutput = createFakePlan(plannerInput(prompt));
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const input: BrainstemSynthesisInput = {
      traceId: "trace-structured-cap",
      triage,
      contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        synthesisDraftToJson({
          response: "Here is a concise research summary with citations.",
          citations: [{ kind: "file", ref: "docs/README.md", detail: "project overview" }],
        }),
      ],
    });
    const run = makeExternalRun(generousBudget());

    await runLiveSynthesizer(input, { provider, run, structuredRoleOutputCaps: policy });

    expect(provider.requests[0]?.maxOutputTokens).toBe(1_000);
  });

  it("OpenAI-compatible buildRequest still defaults to 512 without explicit cap", () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "test-model",
    });
    const built = provider.buildRequest({
      messages: [{ role: "user", content: "hello" }],
    });
    const body = JSON.parse(String(built.init.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(512);
  });
});