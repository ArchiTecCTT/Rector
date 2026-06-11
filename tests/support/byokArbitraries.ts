/**
 * Shared BYOK Alpha test harness (Phase 1 + Phase 2).
 *
 * Provides fast-check arbitraries and configurable test doubles used by the
 * BYOK property-based (P1–P9) and unit tests. Everything here is zero-network
 * and mock-only: no test that uses these utilities requires an API key or a
 * real provider call.
 *
 * Phase 1 building blocks:
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
 *
 * Phase 2 building blocks (ORN-35 → ORN-38):
 *  - adversarial workspace candidate paths — relative/absolute/`..`-laden/symlink
 *    (`arbWorkspacePathCase`, `arbAdversarialPathCase`, `arbSafeRelativePath`, ...)
 *  - an injectable in-memory `WorkspaceFs` double supporting `realpathSync`, read,
 *    list, and write with configurable symlink entries (`InMemoryWorkspaceFs`,
 *    `createWorkspaceFs`)
 *  - destructive vs. allowlisted vs. arbitrary-shell command strings
 *    (`arbAllowlistedCommand`, `arbDestructiveCommand`, `arbShellMetacharacterCommand`)
 *  - arbitrary failing DAGs, always-failing executors, and always-failing repair
 *    agents (`arbDag`, `arbFailingDag`, `makeAlwaysFailingExecutor`,
 *    `makeAlwaysFailingRepairAgent`, `makeNoRepairAgent`)
 *  - valid `SkepticReviewDraft` / `SynthesisDraft` generators plus adversarial /
 *    malformed variants (`arbValidSkepticDraft`, `arbMalformedSkepticJson`,
 *    `arbValidSynthesisDraft`, `arbCitationFreeSynthesisDraft`,
 *    `arbMalformedSynthesisJson`)
 *  - key-like secrets injectable (in redactable form) into prompts, command
 *    output, file content, and failure messages (`embedSecret`,
 *    `arbSecretChannelText`, `arbSecretInjectionCase`)
 *
 * Forward-compatibility note: the live skeptic/synthesizer schemas, the
 * `WorkspaceFs`/`SandboxApproval`/`LiveRepairAgent` contracts, and the workspace
 * denial-reason enum are introduced by later Phase 2 tasks (2.x/5.x/6.x/8.x).
 * To keep this wave-0 harness self-contained and type-correct, the
 * corresponding shapes are declared locally here. They mirror the design
 * exactly and are structurally compatible with the real types once those land.
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
import {
  SkepticFindingSeveritySchema,
  SkepticReviewVerdictSchema,
  type SkepticFinding,
  type SkepticReviewVerdict,
} from "../../src/orchestration/skeptic";
import { DagSchema, type Dag, type DagNodeType } from "../../src/protocol/dag";
import { DagExecutionResultSchema, type DagExecutionResult } from "../../src/orchestration/executorSimulator";
import type { HealingExecutor, ValidationFailure } from "../../src/orchestration/validationHealing";
import type { PatchOperation } from "../../src/sandbox";

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

// ===========================================================================
// Phase 2 (ORN-35 → ORN-38) arbitraries and test doubles
// ===========================================================================
//
// Everything below is zero-network and mock-only. The workspace filesystem is
// injected (`InMemoryWorkspaceFs`); providers are spies; the command runner and
// repair agents are doubles. No API key, no real disk, and no real process is
// required by any test that uses these utilities.

// ---------------------------------------------------------------------------
// Adversarial workspace candidate paths (ORN-37, Property 2)
// ---------------------------------------------------------------------------

/**
 * Workspace containment denial reasons, mirroring the design's
 * `SandboxDenialReasonSchema` path-resolution subset. Declared locally because
 * the real enum is introduced by task 2.1; the string literals are identical.
 */
export type WorkspaceDenialReason = "INVALID_PATH" | "ABSOLUTE_PATH" | "PATH_ESCAPE" | "SYMLINK_ESCAPE";

export type CandidatePathKind = "safe-relative" | "empty" | "absolute" | "dot-dot" | "symlink-escape";

/**
 * A generated candidate path paired with the category it belongs to and the
 * denial reason `resolveWithinWorkspace` is expected to produce (or `null` when
 * the path is expected to resolve successfully).
 *
 * For `symlink-escape` cases, `symlink` carries the entry the injected
 * `WorkspaceFs` must be configured with so the realpath resolves outside the
 * root: register `{ [symlink.linkRelativePath]: symlink.targetAbsolutePath }`.
 */
export interface CandidatePathCase {
  path: string;
  kind: CandidatePathKind;
  expectedDenial: WorkspaceDenialReason | null;
  symlink?: { linkRelativePath: string; targetAbsolutePath: string };
}

const SAFE_PATH_SEGMENTS = ["src", "tests", "lib", "app", "utils", "index", "main", "handler", "config"];
const SAFE_FILE_EXTENSIONS = ["ts", "js", "json", "md", "txt"];

/** Arbitrary safe relative path (no leading slash, drive, `.` or `..` segment). */
export const arbSafeRelativePath = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.array(fc.constantFrom(...SAFE_PATH_SEGMENTS), { minLength: 0, maxLength: 3 }),
      fc.constantFrom(...SAFE_PATH_SEGMENTS),
      fc.constantFrom(...SAFE_FILE_EXTENSIONS)
    )
    .map(([dirs, file, ext]) => [...dirs, `${file}.${ext}`].join("/"));

/** Arbitrary empty/whitespace-only path (expected `INVALID_PATH`). */
export const arbEmptyPath = (): fc.Arbitrary<string> => fc.constantFrom("", "   ", "\t", "\n", "  \t ");

/** Arbitrary absolute POSIX or Windows path (expected `ABSOLUTE_PATH`). */
export const arbAbsolutePath = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbSafeRelativePath().map((relative) => `/${relative}`),
    fc.constantFrom("/etc/passwd", "/var/secrets/key", "/root/.ssh/id_rsa", "/"),
    arbSafeRelativePath().map((relative) => `C:\\${relative.replace(/\//g, "\\")}`),
    fc.constantFrom("C:\\Windows\\System32\\config", "D:\\data\\secret.txt", "\\\\server\\share")
  );

/** Arbitrary `..`-laden path that escapes via parent traversal (expected `PATH_ESCAPE`). */
export const arbDotDotPath = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom("..", "../", "../etc/passwd", "..\\..\\secret", "a/../../b"),
    arbSafeRelativePath().map((relative) => `../${relative}`),
    arbSafeRelativePath().map((relative) => `${relative}/../../escape`),
    fc
      .tuple(arbSafeRelativePath(), fc.integer({ min: 1, max: 4 }))
      .map(([relative, depth]) => `${Array.from({ length: depth }, () => "..").join("/")}/${relative}`)
  );

/**
 * Arbitrary symlink-escape case: a safe-looking relative path whose deepest
 * component is a symlink resolving to an absolute target outside the workspace
 * root. The test must register the `symlink` entry on its `WorkspaceFs` double.
 */
export const arbSymlinkEscapeCase = (): fc.Arbitrary<CandidatePathCase> =>
  fc
    .tuple(arbSafeRelativePath(), fc.constantFrom("/etc", "/var/secrets", "/root", "/tmp/outside"))
    .map(([linkRelativePath, outsideDir]) => ({
      path: linkRelativePath,
      kind: "symlink-escape" as const,
      expectedDenial: "SYMLINK_ESCAPE" as const,
      symlink: {
        linkRelativePath,
        targetAbsolutePath: `${outsideDir}/${linkRelativePath.split("/").pop() ?? "leaf"}`,
      },
    }));

/** A safe-relative case that should resolve successfully (`expectedDenial: null`). */
export const arbSafeRelativePathCase = (): fc.Arbitrary<CandidatePathCase> =>
  arbSafeRelativePath().map((path) => ({ path, kind: "safe-relative" as const, expectedDenial: null }));

/** Empty/whitespace case (`INVALID_PATH`). */
export const arbEmptyPathCase = (): fc.Arbitrary<CandidatePathCase> =>
  arbEmptyPath().map((path) => ({ path, kind: "empty" as const, expectedDenial: "INVALID_PATH" as const }));

/** Absolute-path case (`ABSOLUTE_PATH`). */
export const arbAbsolutePathCase = (): fc.Arbitrary<CandidatePathCase> =>
  arbAbsolutePath().map((path) => ({ path, kind: "absolute" as const, expectedDenial: "ABSOLUTE_PATH" as const }));

/** `..`-traversal case (`PATH_ESCAPE`). */
export const arbDotDotPathCase = (): fc.Arbitrary<CandidatePathCase> =>
  arbDotDotPath().map((path) => ({ path, kind: "dot-dot" as const, expectedDenial: "PATH_ESCAPE" as const }));

/**
 * Arbitrary adversarial candidate path (always denied): empty, absolute,
 * `..`-laden, or symlink-escape. Useful for asserting every adversarial path is
 * rejected with the correct `denialReason` and that no out-of-root I/O occurs.
 */
export const arbAdversarialPathCase = (): fc.Arbitrary<CandidatePathCase> =>
  fc.oneof(arbEmptyPathCase(), arbAbsolutePathCase(), arbDotDotPathCase(), arbSymlinkEscapeCase());

/**
 * Arbitrary candidate path of any category (safe or adversarial). The
 * `expectedDenial` field tells the test whether resolution should succeed
 * (`null`) or which `WorkspaceDenialReason` to expect.
 */
export const arbWorkspacePathCase = (): fc.Arbitrary<CandidatePathCase> =>
  fc.oneof(arbSafeRelativePathCase(), arbAdversarialPathCase());

// ---------------------------------------------------------------------------
// Injectable in-memory WorkspaceFs double (ORN-37)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem surface the safe workspace executor depends on. Declared
 * locally for this wave-0 harness; structurally compatible with the
 * `WorkspaceFs` contract introduced by task 2.1/2.3 (`fsImpl`).
 */
export interface WorkspaceFs {
  realpathSync(path: string): string;
  readFileSync(path: string, encoding?: "utf8"): string;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string): void;
}

export interface WorkspaceFsOptions {
  /** Absolute workspace root (the containment boundary). */
  root: string;
  /** File contents keyed by path relative to the root. */
  files?: Record<string, string>;
  /** Directory entry listings keyed by path relative to the root. */
  dirs?: Record<string, string[]>;
  /**
   * Symlink entries keyed by path relative to the root; the value is the
   * absolute real target (which may resolve outside the root to exercise
   * `SYMLINK_ESCAPE`).
   */
  symlinks?: Record<string, string>;
}

/** Normalizes a path to forward slashes and collapses duplicate separators. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

function joinPosix(root: string, relative: string): string {
  return toPosix(`${root}/${relative}`);
}

/** True when `candidate` equals `root` or is a descendant of it. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = toPosix(root);
  const normalizedCandidate = toPosix(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/**
 * Configurable, side-effect-free in-memory `WorkspaceFs`. Resolves symlinks via
 * a configurable map, serves file content and directory listings, and records
 * every `realpath`/read/list/write so tests can assert that no I/O ever touched
 * a path outside the workspace root.
 */
export class InMemoryWorkspaceFs implements WorkspaceFs {
  readonly root: string;
  readonly realpathCalls: string[] = [];
  readonly reads: string[] = [];
  readonly lists: string[] = [];
  readonly writes: Array<{ path: string; data: string }> = [];

  private readonly files = new Map<string, string>();
  private readonly dirs = new Map<string, string[]>();
  private readonly symlinks = new Map<string, string>();

  constructor(options: WorkspaceFsOptions) {
    this.root = toPosix(options.root);
    for (const [relative, content] of Object.entries(options.files ?? {})) {
      this.files.set(joinPosix(this.root, relative), content);
    }
    for (const [relative, entries] of Object.entries(options.dirs ?? {})) {
      this.dirs.set(joinPosix(this.root, relative), entries);
    }
    for (const [relative, target] of Object.entries(options.symlinks ?? {})) {
      this.symlinks.set(joinPosix(this.root, relative), toPosix(target));
    }
    if (!this.dirs.has(this.root)) this.dirs.set(this.root, []);
  }

  /** Registers a symlink keyed by a path relative to the root. */
  addSymlink(linkRelativePath: string, targetAbsolutePath: string): void {
    this.symlinks.set(joinPosix(this.root, linkRelativePath), toPosix(targetAbsolutePath));
  }

  /** Registers file content keyed by a path relative to the root. */
  addFile(relativePath: string, content: string): void {
    this.files.set(joinPosix(this.root, relativePath), content);
  }

  realpathSync(path: string): string {
    this.realpathCalls.push(path);
    return this.resolveSymlinks(toPosix(path));
  }

  readFileSync(path: string): string {
    const resolved = this.resolveSymlinks(toPosix(path));
    this.reads.push(resolved);
    const content = this.files.get(resolved);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file in workspace double: ${resolved}`);
    }
    return content;
  }

  readdirSync(path: string): string[] {
    const resolved = this.resolveSymlinks(toPosix(path));
    this.lists.push(resolved);
    return this.dirs.get(resolved) ?? [];
  }

  writeFileSync(path: string, data: string): void {
    const resolved = this.resolveSymlinks(toPosix(path));
    this.writes.push({ path: resolved, data });
    this.files.set(resolved, data);
  }

  /** Paths from any read/list/write whose resolved target escaped the root. */
  accessedOutsideRoot(): string[] {
    const accessed = [...this.reads, ...this.lists, ...this.writes.map((write) => write.path)];
    return accessed.filter((path) => !isWithinRoot(this.root, path));
  }

  private resolveSymlinks(input: string): string {
    let current = input;
    for (let i = 0; i < 64; i += 1) {
      let matched: string | undefined;
      for (const key of this.symlinks.keys()) {
        if ((current === key || current.startsWith(`${key}/`)) && (matched === undefined || key.length > matched.length)) {
          matched = key;
        }
      }
      if (matched === undefined) break;
      const target = this.symlinks.get(matched) as string;
      current = toPosix(`${target}${current.slice(matched.length)}`);
    }
    return current;
  }
}

/** Convenience factory for an {@link InMemoryWorkspaceFs}. */
export function createWorkspaceFs(options: WorkspaceFsOptions): InMemoryWorkspaceFs {
  return new InMemoryWorkspaceFs(options);
}

// ---------------------------------------------------------------------------
// Command strings: allowlisted, destructive, arbitrary-shell (ORN-37, P3/P4)
// ---------------------------------------------------------------------------

/** A non-shell command invocation (program + argv). */
export interface CommandCase {
  command: string;
  args: string[];
}

/** Default safe command allowlist used by the harness doubles and tests. */
export const ALLOWLISTED_COMMANDS = ["npm:test", "npm:build", "npm:lint", "tsc", "node", "git:status"] as const;

/** Arbitrary allowlisted command (no destructive args). */
export const arbAllowlistedCommand = (): fc.Arbitrary<CommandCase> =>
  fc
    .tuple(
      fc.constantFrom(...ALLOWLISTED_COMMANDS),
      fc.array(fc.constantFrom("--silent", "--ci", "src", "tests", "--run"), { maxLength: 3 })
    )
    .map(([command, args]) => ({ command, args }));

/**
 * Destructive command/arg combinations covering the design's denylist examples
 * (rm -rf, del /f, format, mkfs, dd, git clean -fdx, ...). Each must be blocked
 * with `DESTRUCTIVE_COMMAND_BLOCKED` regardless of allowlist membership.
 */
const DESTRUCTIVE_COMMANDS: CommandCase[] = [
  { command: "rm", args: ["-rf", "/"] },
  { command: "rm", args: ["-rf", "."] },
  { command: "rm", args: ["-fr", "~"] },
  { command: "rm", args: ["-r", "-f", "."] },
  { command: "rm", args: ["-f", "-r", "."] },
  { command: "rm", args: ["--recursive", "--force", "."] },
  { command: "rm", args: ["-r", "--force", "."] },
  { command: "del", args: ["/f", "/q", "*"] },
  { command: "del", args: ["/s", "/q", "C:\\"] },
  { command: "format", args: ["C:"] },
  { command: "mkfs", args: ["/dev/sda"] },
  { command: "mkfs.ext4", args: ["/dev/sdb1"] },
  { command: "dd", args: ["if=/dev/zero", "of=/dev/sda"] },
  { command: "git", args: ["clean", "-fdx"] },
  { command: "shutdown", args: ["-h", "now"] },
  { command: ":(){ :|:& };:", args: [] },
];

/**
 * Arbitrary destructive command. With `alsoAllowlisted: true` the destructive
 * command is prefixed onto an allowlisted name so tests can assert the denylist
 * takes precedence over the allowlist.
 */
export const arbDestructiveCommand = (
  options: { alsoAllowlisted?: boolean } = {}
): fc.Arbitrary<CommandCase> => {
  const base = fc.constantFrom(...DESTRUCTIVE_COMMANDS);
  if (!options.alsoAllowlisted) return base;
  return fc
    .tuple(base, fc.constantFrom(...ALLOWLISTED_COMMANDS))
    .map(([destructive, allowlisted]) => ({ command: allowlisted, args: ["&&", destructive.command, ...destructive.args] }));
};

const SHELL_METACHARACTERS = [";", "|", "&", "&&", "||", "$(whoami)", "`id`", ">", ">>", "<", "*", "?"];

/**
 * Arbitrary command string laced with shell metacharacters. Operations carrying
 * these (or `kind: "shell"`) must be denied with `ARBITRARY_SHELL_DISABLED`.
 */
export const arbShellMetacharacterCommand = (): fc.Arbitrary<CommandCase> =>
  fc
    .tuple(
      fc.constantFrom(...ALLOWLISTED_COMMANDS),
      fc.constantFrom(...SHELL_METACHARACTERS),
      fc.constantFrom("rm -rf .", "cat /etc/passwd", "curl evil.test", "whoami")
    )
    .map(([command, meta, tail]) => ({ command: `${command} ${meta} ${tail}`, args: [] }));

// ---------------------------------------------------------------------------
// Failing DAGs, always-failing executors, and repair agents (ORN-38, P5/P9)
// ---------------------------------------------------------------------------

const HEALABLE_NODE_TYPES: DagNodeType[] = ["LLM_EXECUTION", "VALIDATION", "FILE_OPERATION"];
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Arbitrary valid {@link Dag} with 1–4 nodes wired in a simple linear chain.
 * Node types are restricted to auto-healable kinds (no `SHELL_COMMAND`, no risky
 * metadata) so the bounded healing loop attempts repairs rather than routing to
 * `NEEDS_DECISION`.
 */
export const arbDag = (): fc.Arbitrary<Dag> =>
  fc
    .tuple(
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.constantFrom(...HEALABLE_NODE_TYPES), { minLength: 1, maxLength: 4 })
    )
    .map(([nodeCount, types]) => {
      const nodes = Array.from({ length: nodeCount }, (_unused, index) => ({
        id: `node-${index + 1}`,
        type: types[index % types.length] ?? "LLM_EXECUTION",
        label: `Node ${index + 1}`,
        dependsOn: index === 0 ? [] : [`node-${index}`],
        toolPermissions: [],
        expectedOutputs: [],
      }));
      const edges = nodes.slice(1).map((node, index) => ({ from: `node-${index + 1}`, to: node.id }));
      return DagSchema.parse({
        id: "dag-byok-test",
        runId: "run-byok-test",
        version: "1",
        nodes,
        edges,
        createdAt: FIXED_TIMESTAMP,
      });
    });

/**
 * Builds a `DagExecutionResult` in which every node failed with a transient
 * `INJECTED_FAILURE`. Transient failures are auto-healable, so a healing loop
 * driving this result will attempt (bounded) repairs and end in `FAILED` on
 * exhaustion rather than `NEEDS_DECISION`.
 */
export function makeFailingExecutionResult(dag: Dag, now: () => string = () => FIXED_TIMESTAMP): DagExecutionResult {
  const at = now();
  const nodeResults = dag.nodes.map((node) => ({
    nodeId: node.id,
    status: "FAILED" as const,
    attempts: 1,
    startedAt: at,
    completedAt: at,
    durationMs: 1,
    error: {
      code: "INJECTED_FAILURE" as const,
      message: `Node ${node.id} failed (injected for healing tests)`,
      nodeId: node.id,
    },
    dependencies: [...node.dependsOn].sort(),
  }));

  return DagExecutionResultSchema.parse({
    dagId: dag.id,
    runId: dag.runId,
    status: "FAILED",
    startedAt: at,
    completedAt: at,
    durationMs: 1,
    nodeResults,
    events: [
      { sequence: 1, type: "DAG_STARTED", at },
      { sequence: 2, type: "DAG_COMPLETED", status: "FAILED", at },
    ],
    error: { code: "INJECTED_FAILURE", message: "DAG failed (injected for healing tests)" },
  });
}

/** Arbitrary failing DAG: a valid DAG paired with its all-failed execution result. */
export const arbFailingDag = (): fc.Arbitrary<{ dag: Dag; executionResult: DagExecutionResult }> =>
  arbDag().map((dag) => ({ dag, executionResult: makeFailingExecutionResult(dag) }));

/** A `HealingExecutor` double that always reports failure, with an invocation counter. */
export interface CountingExecutor {
  /** The executor to pass as `input.executor`. */
  executor: HealingExecutor;
  /** Number of times the executor has been invoked. */
  readonly calls: number;
}

/**
 * Creates a {@link HealingExecutor} that never succeeds: every invocation
 * returns an all-failed (`INJECTED_FAILURE`) result for the supplied DAG. Used
 * to prove the healing loop terminates within its bound (Property 5).
 */
export function makeAlwaysFailingExecutor(now: () => string = () => FIXED_TIMESTAMP): CountingExecutor {
  let calls = 0;
  const handle: CountingExecutor = {
    executor: (dag: Dag) => {
      calls += 1;
      return makeFailingExecutionResult(dag, now);
    },
    get calls() {
      return calls;
    },
  };
  return handle;
}

/**
 * A repair patch proposal produced by a {@link RepairAgentDouble}. Mirrors the
 * design's `RepairPatchProposal` (introduced by task 8.1).
 */
export interface RepairPatchProposal {
  path: string;
  operation: PatchOperation;
  content: string;
  rationale: string;
}

/**
 * A live repair agent double. Mirrors the design's `LiveRepairAgent` contract
 * (introduced by task 8.1): it proposes a patch from already-redacted failed
 * output and never touches disk itself.
 */
export type RepairAgentDouble = (input: {
  failure: ValidationFailure;
  failedOutput: string;
  contextPack: ContextPack;
  run: Run;
}) => Promise<RepairPatchProposal | undefined>;

/** A repair-agent double with an invocation counter. */
export interface CountingRepairAgent {
  agent: RepairAgentDouble;
  readonly calls: number;
}

/**
 * Creates a repair agent that always returns a (safe relative) patch proposal
 * but never actually fixes the failure — the executor keeps failing. Drives the
 * bounded-healing (Property 5) and patch-provenance (Property 9) tests.
 */
export function makeAlwaysFailingRepairAgent(
  options: { path?: string; operation?: PatchOperation } = {}
): CountingRepairAgent {
  let calls = 0;
  const path = options.path ?? "src/index.ts";
  const operation = options.operation ?? "update";
  const handle: CountingRepairAgent = {
    agent: async () => {
      calls += 1;
      return {
        path,
        operation,
        content: `// repair attempt ${calls}\n`,
        rationale: `Attempted repair #${calls} (always-failing double)`,
      };
    },
    get calls() {
      return calls;
    },
  };
  return handle;
}

/**
 * Creates a repair agent that never offers a repair (always resolves
 * `undefined`), exercising the "no safe repair available" branch.
 */
export function makeNoRepairAgent(): CountingRepairAgent {
  let calls = 0;
  const handle: CountingRepairAgent = {
    agent: async () => {
      calls += 1;
      return undefined;
    },
    get calls() {
      return calls;
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Skeptic review drafts: valid + adversarial/malformed (ORN-35, P7)
// ---------------------------------------------------------------------------

/**
 * The critique draft a provider returns for the live skeptic. The control plane
 * stamps deterministic fields and recomputes the verdict, so this draft carries
 * only `{ verdict, findings }`. Mirrors the design's `SkepticReviewDraftSchema`
 * (introduced by task 5.2).
 */
export interface SkepticReviewDraft {
  verdict: SkepticReviewVerdict;
  findings: SkepticFinding[];
}

const SKEPTIC_CATEGORIES = ["safety", "validation-coverage", "missing-dependency", "failure-mode", "scope"];

/** Arbitrary schema-valid {@link SkepticFinding} (all required fields non-empty). */
export const arbSkepticFinding = (): fc.Arbitrary<SkepticFinding> =>
  fc
    .record({
      index: fc.integer({ min: 1, max: 999 }),
      severity: fc.constantFrom(...SkepticFindingSeveritySchema.options),
      category: fc.constantFrom(...SKEPTIC_CATEGORIES),
      hasTask: fc.boolean(),
    })
    .map(({ index, severity, category, hasTask }) => {
      const finding: SkepticFinding = {
        id: `finding-${index}`,
        severity,
        category,
        message: `${category} concern #${index}`,
        evidence: `Evidence for ${category} concern #${index}`,
        recommendation: `Address the ${category} concern #${index}`,
      };
      if (hasTask) finding.taskId = `task-${index}`;
      return finding;
    });

/**
 * Arbitrary valid skeptic draft. The `verdict` is chosen independently of the
 * findings (advisory) precisely so tests can confirm the control plane
 * recomputes it from finding severities rather than trusting the model.
 */
export const arbValidSkepticDraft = (): fc.Arbitrary<SkepticReviewDraft> =>
  fc.record({
    verdict: fc.constantFrom(...SkepticReviewVerdictSchema.options),
    findings: fc.array(arbSkepticFinding(), { maxLength: 4 }),
  });

/** Serializes a skeptic draft to the JSON a provider would return. */
export function skepticDraftToJson(draft: SkepticReviewDraft): string {
  return JSON.stringify(draft);
}

/**
 * Arbitrary malformed skeptic provider output. Produces:
 *  - strings that are not valid JSON,
 *  - valid JSON of the wrong top-level type,
 *  - a draft with an invalid verdict enum value,
 *  - a draft whose finding is missing a required field,
 *  - a draft whose finding has an invalid severity.
 * Every value fails `SkepticReviewDraftSchema` (or `JSON.parse`).
 */
export const arbMalformedSkepticJson = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string({ maxLength: 80 }).map((noise) => `<<<NOT_JSON ${noise}`),
    fc.constantFrom("123", "true", "null", '"verdict"', "[]", "[1,2,3]", "{}"),
    arbValidSkepticDraft().map((draft) => JSON.stringify({ ...draft, verdict: "DEFINITELY_FINE" })),
    arbSkepticFinding().map((finding) => {
      const broken: Record<string, unknown> = { ...finding };
      delete broken.message;
      return JSON.stringify({ verdict: "SOUND", findings: [broken] });
    }),
    arbSkepticFinding().map((finding) =>
      JSON.stringify({ verdict: "NEEDS_REVISION", findings: [{ ...finding, severity: "CATASTROPHIC" }] })
    )
  );

// ---------------------------------------------------------------------------
// Synthesis drafts: valid + citation-free + malformed (ORN-36, P6)
// ---------------------------------------------------------------------------

export type SynthesisCitationKind = "file" | "command" | "test" | "failure" | "risk" | "artifact";

/** A typed evidence citation. Mirrors the design's `SynthesisCitationSchema`. */
export interface SynthesisCitation {
  kind: SynthesisCitationKind;
  ref: string;
  detail: string;
}

/**
 * The answer draft a provider returns for the live synthesizer (`{ response,
 * citations }`). Mirrors the design's `SynthesisDraftSchema` (task 6.2).
 */
export interface SynthesisDraft {
  response: string;
  citations: SynthesisCitation[];
}

const SYNTHESIS_CITATION_KINDS: SynthesisCitationKind[] = ["file", "command", "test", "failure", "risk", "artifact"];

/** Arbitrary schema-valid {@link SynthesisCitation} (non-empty fields). */
export const arbSynthesisCitation = (): fc.Arbitrary<SynthesisCitation> =>
  fc
    .record({
      kind: fc.constantFrom(...SYNTHESIS_CITATION_KINDS),
      index: fc.integer({ min: 1, max: 999 }),
    })
    .map(({ kind, index }) => ({
      kind,
      ref: `${kind}-ref-${index}`,
      detail: `Evidence detail for ${kind} #${index}`,
    }));

/** Arbitrary valid synthesis draft with at least one citation. */
export const arbValidSynthesisDraft = (): fc.Arbitrary<SynthesisDraft> =>
  fc
    .record({
      response: fc.constantFrom(
        "The change compiles and all tests pass.",
        "Implemented the fix and validated it against the failing case.",
        "Completed the task; see cited evidence for details."
      ),
      citations: fc.array(arbSynthesisCitation(), { minLength: 1, maxLength: 4 }),
    })
    .map(({ response, citations }) => ({ response, citations }));

/**
 * Arbitrary synthesis draft with a non-empty response but an empty `citations`
 * array. When the run carried evidence, the live synthesizer must treat this as
 * invalid and route it to repair-then-fallback.
 */
export const arbCitationFreeSynthesisDraft = (): fc.Arbitrary<SynthesisDraft> =>
  fc
    .constantFrom(
      "Everything looks good.",
      "Done, no further action needed.",
      "The implementation is complete."
    )
    .map((response) => ({ response, citations: [] }));

/** Serializes a synthesis draft to the JSON a provider would return. */
export function synthesisDraftToJson(draft: SynthesisDraft): string {
  return JSON.stringify(draft);
}

/**
 * Arbitrary malformed synthesizer provider output. Produces:
 *  - strings that are not valid JSON,
 *  - valid JSON of the wrong top-level type,
 *  - a draft with an empty (invalid) response,
 *  - a draft with a malformed citation (missing `ref`).
 * Every value fails `SynthesisDraftSchema` (or `JSON.parse`).
 */
export const arbMalformedSynthesisJson = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string({ maxLength: 80 }).map((noise) => `<<<NOT_JSON ${noise}`),
    fc.constantFrom("123", "true", "null", '"response"', "[]", "{}"),
    fc.constant(JSON.stringify({ response: "", citations: [] })),
    arbSynthesisCitation().map((citation) => {
      const broken: Record<string, unknown> = { ...citation };
      delete broken.ref;
      return JSON.stringify({ response: "ok", citations: [broken] });
    })
  );

// ---------------------------------------------------------------------------
// Secret injection helpers (cross-cutting redaction, Property 6)
// ---------------------------------------------------------------------------
//
// `redactString`/`redactSecrets` only strip secrets that appear in a redactable
// context (e.g. `Bearer <secret>`, `api_key=<secret>`, a credential URI, or a
// sensitive object key). These helpers embed an arbitrary key-like secret in
// exactly such a context so the no-secret-leak property is meaningful: after
// redaction the secret substring must be gone.

/** The channels a secret can be injected into across the external loop. */
export type SecretChannel = "prompt" | "command-output" | "file-content" | "failure-message";

/**
 * Embeds `secret` into a single redactable string. The optional `channel` only
 * flavors the surrounding text; every variant keeps the secret in a form
 * `redactString` is expected to remove.
 */
export function embedSecret(secret: string, channel: SecretChannel = "prompt"): string {
  const label =
    channel === "command-output"
      ? "stdout"
      : channel === "file-content"
        ? "config"
        : channel === "failure-message"
          ? "error"
          : "prompt";
  return `[${label}] Authorization: Bearer ${secret}`;
}

/** Arbitrary redactable string carrying `secret` (varied across redaction patterns). */
export const arbSecretChannelText = (secret: string): fc.Arbitrary<string> =>
  fc.constantFrom(
    `Authorization: Bearer ${secret}`,
    `api_key=${secret}`,
    `token=${secret}`,
    `password=${secret}`,
    `https://user:${secret}@internal.test/resource`,
    `Basic ${secret}`
  );

/**
 * A secret paired with the channel it was injected into and a redactable text
 * carrying it. Drives the no-secret-leak property: inject `redactableText` into
 * the corresponding boundary, then assert `secret` is absent from all output.
 */
export interface SecretInjectionCase {
  secret: string;
  channel: SecretChannel;
  redactableText: string;
}

/** Arbitrary secret-injection case across an arbitrary channel. */
export const arbSecretInjectionCase = (): fc.Arbitrary<SecretInjectionCase> =>
  arbKeyLikeSecret().chain((secret) =>
    fc
      .tuple(
        fc.constantFrom<SecretChannel>("prompt", "command-output", "file-content", "failure-message"),
        arbSecretChannelText(secret)
      )
      .map(([channel, redactableText]) => ({ secret, channel, redactableText }))
  );

/**
 * Builds an object whose values carry `secret` under sensitive keys and in
 * redactable text, exercising `redactSecrets` over structured payloads.
 */
export function secretBearingRecord(secret: string): Record<string, unknown> {
  return {
    apiKey: secret,
    token: secret,
    note: `Authorization: Bearer ${secret}`,
    connectionString: `postgres://user:${secret}@db.test/app`,
  };
}
