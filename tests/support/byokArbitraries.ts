/**
 * Shared BYOK Alpha Phase 1 test harness.
 *
 * Provides fast-check arbitraries and configurable test doubles used by the
 * BYOK property-based (P1–P9) and unit tests. Everything here is zero-network
 * and mock-only: no test that uses these utilities requires an API key or a
 * real provider call.
 *
 * Exposed building blocks:
 *  - arbitrary prompts (`arbPrompt`)
 *  - arbitrary key-like secret strings (`arbKeyLikeSecret`)
 *  - arbitrary budgets, including sub-threshold/denying ones (`arbBudget`,
 *    `arbAllowingBudget`, `arbSubThresholdBudget`)
 *  - schema-valid planner inputs and plans (`arbPlannerInput`, `arbValidPlan`,
 *    `arbSchemaValidPlan`)
 *  - arbitrary malformed / schema-invalid planner JSON (`arbMalformedPlannerJson`)
 *  - a configurable spy `LLMProvider` double with an invoke call counter,
 *    `estimateRequest`, and scripted responses (`SpyLLMProvider`)
 *  - a mocked `fetch` factory for the connection-test endpoint (`createFetchDouble`)
 */
import fc from "fast-check";

import {
  LLMResponseSchema,
  LLMUsageSchema,
  ProviderCapabilityMetadataSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ProviderCapabilityMetadata,
} from "../../src/providers/llm";
import {
  PlannerInputSchema,
  PlannerOutputSchema,
  createFakePlan,
  type PlannerInput,
  type PlannerOutput,
} from "../../src/orchestration/planner";
import { triageUserMessage, type TriageResult } from "../../src/orchestration/triage";
import { ContextPackSchema, type ContextPack } from "../../src/orchestration/contextBuilder";
import type { Budget, Run } from "../../src/store/schemas";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ROUTE_PROMPTS = [
  "What is Rector and how does it work?",
  "Explain the deterministic orchestration pipeline.",
  "Create an implementation plan for adding login, but do not edit files.",
  "Fix the TypeScript bug in src/api/server.ts and update tests.",
  "Add pagination to the /users endpoint and update the tests.",
  "Research current options for vector databases and compare sources.",
  "Build the entire feature end-to-end, run all tests, benchmark, and deploy.",
  "Can you do the thing?",
  "Refactor the budget module and add tests.",
];

/**
 * Arbitrary user prompt. Mixes canned route-bearing prompts (to exercise every
 * triage route) with lorem and free-form strings. Always resolves to a
 * non-empty, trimmed string.
 */
export const arbPrompt = (): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.constantFrom(...ROUTE_PROMPTS),
      fc.lorem({ maxCount: 12 }),
      fc.string({ minLength: 1, maxLength: 200 })
    )
    .map((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : "Explain Rector";
    });

// ---------------------------------------------------------------------------
// Key-like secrets
// ---------------------------------------------------------------------------

const SECRET_PREFIXES = ["sk-", "tok_", "key-", "pplx-", "ghp_", "xoxb-"];
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");

/**
 * Arbitrary API-key-like secret string. Composed only of a known prefix plus
 * URL/JSON-safe alphanumerics so a leaked substring can be reliably searched
 * for in serialized output without escaping concerns.
 */
export const arbKeyLikeSecret = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...SECRET_PREFIXES),
      fc.array(fc.constantFrom(...SECRET_ALPHABET), { minLength: 24, maxLength: 48 })
    )
    .map(([prefix, chars]) => `${prefix}${chars.join("")}`);

// ---------------------------------------------------------------------------
// Budgets and runs
// ---------------------------------------------------------------------------

/** A permissive budget that allows any reasonable positive provider estimate. */
export function generousBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    maxUsd: 10,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    maxModelCalls: 10,
    maxRuntimeMs: 600_000,
    maxHealingAttempts: 3,
    allowedProviders: [],
    approvalRequiredAboveUsd: 0,
    ...overrides,
  };
}

/** Arbitrary budget that allows a positive estimate (no approval gating). */
export const arbAllowingBudget = (): fc.Arbitrary<Budget> =>
  fc
    .record({
      maxUsd: fc.double({ min: 1, max: 1000, noNaN: true }),
      maxInputTokens: fc.integer({ min: 10_000, max: 1_000_000 }),
      maxOutputTokens: fc.integer({ min: 10_000, max: 1_000_000 }),
      maxModelCalls: fc.integer({ min: 2, max: 50 }),
      maxRuntimeMs: fc.integer({ min: 60_000, max: 600_000 }),
      maxHealingAttempts: fc.integer({ min: 1, max: 5 }),
    })
    .map((partial) => generousBudget(partial));

const SUB_THRESHOLD_DIMENSIONS = ["maxUsd", "maxModelCalls", "maxInputTokens", "maxOutputTokens"] as const;

/**
 * Arbitrary sub-threshold budget. Zeroes exactly one hard limit while keeping
 * the others generous, so a positive provider estimate (`estimatedUsd > 0`,
 * `modelCalls >= 1`, `inputTokens >= 1`, `outputTokens >= 1`) is always denied
 * by `evaluateBudget`. `allowedProviders` is left empty (no provider
 * restriction) so denial comes solely from the chosen limit.
 */
export const arbSubThresholdBudget = (): fc.Arbitrary<Budget> =>
  fc.constantFrom(...SUB_THRESHOLD_DIMENSIONS).map((dimension) => {
    const budget = generousBudget();
    budget[dimension] = 0;
    return budget;
  });

/** General-purpose budget arbitrary (may allow or deny). */
export const arbBudget = (): fc.Arbitrary<Budget> =>
  fc.oneof(arbAllowingBudget(), arbSubThresholdBudget());

/** Builds an external-mode `Run` carrying the supplied budget. */
export function makeExternalRun(budget: Budget, overrides: Partial<Run> = {}): Run {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: "run-byok-test",
    conversationId: "conv-byok-test",
    userMessageId: "msg-byok-test",
    status: "running",
    phase: "PLANNING",
    route: "CODE_EDIT",
    complexity: "medium",
    budget,
    costEstimate: { usd: 0, modelCalls: 0, runtimeMs: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-byok-test",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Context packs, planner inputs, and plans
// ---------------------------------------------------------------------------

/** Builds a schema-valid `ContextPack` for the given triage result. */
export function makeContextPack(triage: TriageResult, intent = "Test user intent"): ContextPack {
  const summary = intent.replace(/\s+/g, " ").trim().slice(0, 240);
  return ContextPackSchema.parse({
    id: "ctx-byok-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: summary.length > 0 ? summary : "intent",
    conversationRef: { id: "conv-byok-test", title: "BYOK test", workspaceId: "local" },
    messageRefs: [
      { id: "msg-byok-test", role: "user", status: "completed", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    relevantDocs: [],
    relevantMemory: [],
    constraints: ["No provider calls in BYOK harness tests"],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [],
  });
}

/** Arbitrary triage result derived from an arbitrary prompt. */
export const arbTriage = (): fc.Arbitrary<TriageResult> => arbPrompt().map((prompt) => triageUserMessage(prompt));

/** Arbitrary, schema-valid planner input derived from an arbitrary prompt. */
export const arbPlannerInput = (): fc.Arbitrary<PlannerInput> =>
  arbPrompt().map((prompt) => {
    const triage = triageUserMessage(prompt);
    return PlannerInputSchema.parse({
      triage,
      contextPack: makeContextPack(triage, prompt),
      messageContent: prompt,
    });
  });

/**
 * Arbitrary plan that satisfies BOTH `PlannerOutputSchema` and the
 * `validatePlannerOutput` invariants (dependency + approval-gate rules). Built
 * from `createFakePlan` so it is held to the exact same safety bar as the fake
 * planner.
 */
export const arbValidPlan = (): fc.Arbitrary<PlannerOutput> => arbPlannerInput().map(createFakePlan);

const RISK_LEVELS = ["low", "medium", "high", "destructive"] as const;
const TASK_ID_POOL = ["alpha", "bravo", "charlie", "delta", "echo"];
const DANGLING_TASK_ID = "ghost-task";

/**
 * Arbitrary plan that is guaranteed to parse against `PlannerOutputSchema` but
 * may or may not satisfy `validatePlannerOutput` (it can contain dangling
 * dependency references or ungated high-risk tasks). Useful for asserting the
 * live planner enforces the deeper invariants, not just the schema.
 */
export const arbSchemaValidPlan = (): fc.Arbitrary<PlannerOutput> =>
  fc
    .uniqueArray(fc.constantFrom(...TASK_ID_POOL), { minLength: 1, maxLength: TASK_ID_POOL.length })
    .chain((ids) => {
      const idArb = fc.constantFrom(...ids);
      const refArb = fc.oneof(idArb, fc.constant(DANGLING_TASK_ID));

      const taskArbs = ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          title: fc.constant(`Task ${id}`),
          description: fc.constant(`Description for ${id}`),
          dependencies: fc.uniqueArray(refArb, { maxLength: 2 }),
          expectedArtifacts: fc.array(fc.constantFrom("artifact-a", "artifact-b"), { maxLength: 2 }),
          validation: fc.array(fc.constantFrom("check passes", "output verified"), {
            minLength: 1,
            maxLength: 2,
          }),
          risk: fc.constantFrom(...RISK_LEVELS),
          approvalRequired: fc.boolean(),
        })
      );

      const dependencyArb = fc.record({
        from: refArb,
        to: refArb,
        reason: fc.option(fc.constant("because"), { nil: undefined }),
      });

      const gateArb = fc.record({
        id: fc.constantFrom("gate-1", "gate-2"),
        type: fc.constantFrom("approval", "checkpoint", "clarification"),
        reason: fc.constant("requires approval"),
        required: fc.boolean(),
        taskIds: fc.uniqueArray(idArb, { maxLength: ids.length }),
      });

      return fc
        .record({
          goal: fc.constant("Generated plan goal"),
          assumptions: fc.array(fc.constantFrom("assumption a", "assumption b"), { maxLength: 2 }),
          tasks: fc.tuple(...taskArbs),
          dependencies: fc.array(dependencyArb, { maxLength: 3 }),
          validation: fc.record({
            summary: fc.constant("validation summary"),
            checks: fc.array(fc.constantFrom("c1", "c2"), { minLength: 1, maxLength: 2 }),
          }),
          riskLevel: fc.constantFrom(...RISK_LEVELS),
          approvalGates: fc.array(gateArb, { maxLength: 2 }),
        })
        .map((plan) => PlannerOutputSchema.parse({ ...plan, tasks: [...plan.tasks] }));
    });

/** Serializes a plan to the JSON a provider would return. */
export function planToJson(plan: PlannerOutput): string {
  return JSON.stringify(plan);
}

// ---------------------------------------------------------------------------
// Malformed / schema-invalid planner JSON
// ---------------------------------------------------------------------------

const PLANNER_REQUIRED_KEYS = [
  "goal",
  "assumptions",
  "tasks",
  "dependencies",
  "validation",
  "riskLevel",
  "approvalGates",
] as const;

const NON_OBJECT_JSON = ["123", "true", "false", "null", '"just a string"', "[]", "[1,2,3]", "{}"];

/**
 * Arbitrary malformed planner output. Produces three classes of failing
 * payloads:
 *  - strings that are not valid JSON at all,
 *  - valid JSON of the wrong top-level type (number, bool, null, array, {}),
 *  - a valid plan with one required field removed (valid JSON, invalid schema).
 *
 * Every value is guaranteed to fail `PlannerOutputSchema` (or `JSON.parse`).
 */
export const arbMalformedPlannerJson = (): fc.Arbitrary<string> =>
  fc.oneof(
    // Not valid JSON: a leading '<' guarantees JSON.parse throws.
    fc.string({ maxLength: 80 }).map((noise) => `<<<NOT_JSON ${noise}`),
    // Valid JSON, wrong shape.
    fc.constantFrom(...NON_OBJECT_JSON),
    // Valid JSON object missing a required planner field.
    fc.tuple(arbValidPlan(), fc.constantFrom(...PLANNER_REQUIRED_KEYS)).map(([plan, key]) => {
      const corrupted: Record<string, unknown> = { ...plan };
      delete corrupted[key];
      return JSON.stringify(corrupted);
    })
  );

// ---------------------------------------------------------------------------
// Spy LLM provider double
// ---------------------------------------------------------------------------

/** Default positive usage so budget preflights see a non-zero cost. */
export const DEFAULT_SPY_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  estimatedUsd: 0.01,
  modelCalls: 1,
});

/** A single scripted provider reply: either content or a thrown error. */
export interface ScriptedResponse {
  content?: string;
  model?: string;
  finishReason?: LLMResponse["finishReason"];
  usage?: Partial<LLMUsage>;
  error?: Error;
}

export interface SpyProviderOptions {
  /** Provider id reported by metadata (default `"spy"`). */
  id?: string;
  /** Model id reported on responses (default `"spy-model-v1"`). */
  model?: string;
  /** Fixed usage or a function of the request returned by `estimateRequest`. */
  estimate?: LLMUsage | ((request: LLMRequest) => LLMUsage);
  /** Ordered scripted replies; a bare string is shorthand for `{ content }`. */
  responses?: Array<string | ScriptedResponse>;
  /** When set, `validateConfig()` throws this error. */
  validateConfigError?: Error;
  /** Behaviour when invoked more times than there are scripted responses. */
  onOverflow?: "throw" | "repeat-last";
}

function normalizeScripted(item: string | ScriptedResponse): ScriptedResponse {
  return typeof item === "string" ? { content: item } : item;
}

/**
 * Configurable spy `LLMProvider`. Records every request, exposes an `invoke`
 * call counter, returns scripted responses (or throws scripted errors), and
 * reports a configurable `estimateRequest`. Performs no network I/O.
 */
export class SpyLLMProvider implements LLMProvider {
  readonly metadata: ProviderCapabilityMetadata;

  /** Number of times `invoke` has been called. */
  invokeCount = 0;
  /** Number of times `estimateRequest` has been called. */
  estimateCount = 0;
  /** Every request passed to `invoke`, in order. */
  readonly requests: LLMRequest[] = [];

  private readonly model: string;
  private readonly responses: Array<string | ScriptedResponse>;
  private readonly estimate?: LLMUsage | ((request: LLMRequest) => LLMUsage);
  private readonly validateConfigError?: Error;
  private readonly onOverflow: "throw" | "repeat-last";

  constructor(options: SpyProviderOptions = {}) {
    const id = options.id ?? "spy";
    this.model = options.model ?? "spy-model-v1";
    this.metadata = ProviderCapabilityMetadataSchema.parse({
      id,
      displayName: `Spy Provider (${id})`,
      routes: ["cheap", "fast", "flagship", "research"],
      models: { cheap: this.model, fast: this.model, flagship: this.model, research: this.model },
      supportsJson: true,
      supportsStreaming: false,
      maxContextTokens: 128_000,
      estimatedUsdPer1kInputTokens: 0.001,
      estimatedUsdPer1kOutputTokens: 0.001,
    });
    this.responses = options.responses ?? [];
    this.estimate = options.estimate;
    this.validateConfigError = options.validateConfigError;
    this.onOverflow = options.onOverflow ?? "throw";
  }

  validateConfig(): void {
    if (this.validateConfigError) throw this.validateConfigError;
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    this.estimateCount += 1;
    if (typeof this.estimate === "function") return LLMUsageSchema.parse(this.estimate(request));
    if (this.estimate) return LLMUsageSchema.parse(this.estimate);
    return DEFAULT_SPY_USAGE;
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const index = this.invokeCount;
    this.invokeCount += 1;

    const scripted = this.resolveScripted(index);
    if (scripted.error) throw scripted.error;

    const merged: LLMUsage = { ...DEFAULT_SPY_USAGE, ...(scripted.usage ?? {}) };
    if (
      scripted.usage &&
      scripted.usage.totalTokens === undefined &&
      (scripted.usage.inputTokens !== undefined || scripted.usage.outputTokens !== undefined)
    ) {
      merged.totalTokens = merged.inputTokens + merged.outputTokens;
    }

    return LLMResponseSchema.parse({
      provider: this.metadata.id,
      model: scripted.model ?? this.model,
      content: scripted.content ?? "",
      finishReason: scripted.finishReason ?? "stop",
      usage: LLMUsageSchema.parse(merged),
    });
  }

  private resolveScripted(index: number): ScriptedResponse {
    if (index < this.responses.length) return normalizeScripted(this.responses[index]);
    if (this.responses.length > 0 && this.onOverflow === "repeat-last") {
      return normalizeScripted(this.responses[this.responses.length - 1]);
    }
    throw new Error(`SpyLLMProvider: no scripted response for invoke #${index + 1}`);
  }
}

// ---------------------------------------------------------------------------
// Mocked fetch factory (connection test)
// ---------------------------------------------------------------------------

export interface FetchDoubleOptions {
  /** HTTP status to return (default 200). */
  status?: number;
  /** Explicit JSON body; overrides `content`/`model` defaults. */
  jsonBody?: unknown;
  /** Assistant content for the default OpenAI-compatible body (default "pong"). */
  content?: string;
  /** Model id reported in the default body (default "spy-model-v1"). */
  model?: string;
  /** When set, the fetch impl rejects with this error (simulated network failure). */
  throwError?: Error;
}

export interface FetchDouble {
  /** A `fetch`-compatible implementation to inject into a provider. */
  fetchImpl: typeof fetch;
  /** Number of times the fetch impl has been called. */
  calls: number;
  /** Recorded calls in order. */
  requests: Array<{ url: string; init?: RequestInit }>;
}

/**
 * Creates a mocked `fetch` for connection-test and provider-network tests. By
 * default it returns a single OpenAI-compatible 200 response with `"pong"`
 * content. No real network call ever occurs.
 */
export function createFetchDouble(options: FetchDoubleOptions = {}): FetchDouble {
  const double: FetchDouble = {
    // Replaced immediately below; cast keeps the public type clean.
    fetchImpl: (() => {
      throw new Error("fetch double not initialized");
    }) as unknown as typeof fetch,
    calls: 0,
    requests: [],
  };

  double.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    double.calls += 1;
    double.requests.push({ url: String(input), init });

    if (options.throwError) throw options.throwError;

    const status = options.status ?? 200;
    const body =
      options.jsonBody ??
      {
        model: options.model ?? "spy-model-v1",
        choices: [
          { message: { role: "assistant", content: options.content ?? "pong" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };

    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return double;
}
