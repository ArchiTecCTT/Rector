import {
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers/llm";
import { evaluateBudget, type BudgetUsage } from "../security/budget";
import { redactOutbound, redactSecrets } from "../security/redaction";
import type { Run } from "../store";
import {
  buildDeterministicDirectAnswer,
  type BrainstemSynthesisInput,
} from "./synthesizer";

/**
 * Reason a live direct answer fell back to the deterministic Local_Mode text:
 * - `no_provider`  — no `slm`-role provider was configured for External_Mode (Req 8.2).
 * - `denied`       — the `Budget_Gate` denied the call before it was sent (Req 7.3).
 * - `provider_error` — the provider invocation failed, or the assembled answer could not be
 *   safely redacted, so the raw provider body is never surfaced (Req 8.1, 8.3).
 */
export type LiveDirectAnswerFallback = "denied" | "provider_error" | "no_provider";

/**
 * Dependencies for {@link runLiveDirectAnswer}. The provider is the resolved `slm`-role provider
 * (absent when none is configured); `run` carries the budget the preflight gates against; the
 * `evaluateBudget` / `redactOutbound` functions are injected (defaulting to the real
 * implementations) so tests can exercise budget denial and redaction failure deterministically and
 * the seam mirrors the existing `runLiveSynthesizer` discipline.
 */
export interface LiveDirectAnswerDeps {
  /** Resolved `slm`-role provider, if any. Absent → `no_provider` fallback (Req 8.2). */
  provider?: LLMProvider;
  /** Optional concrete model/deployment selected by the orchestration assignment router. */
  model?: string;
  /** The run whose budget gates the call. Required to evaluate the budget preflight. */
  run: Run;
  abortSignal?: AbortSignal;
  /** Budget preflight, injectable for tests; defaults to the real {@link evaluateBudget}. */
  evaluateBudget?: typeof evaluateBudget;
  /** Outbound redaction, injectable for tests; defaults to the real {@link redactOutbound}. */
  redactOutbound?: typeof redactOutbound;
}

/**
 * Outcome of {@link runLiveDirectAnswer}.
 *
 * `response` is the cheap-model answer on success and the deterministic Local_Mode direct-answer
 * text on every fallback path. `providerCalls` is `1` only on a successful, redacted provider answer
 * and `0` on every fallback path (budget denial, provider error, missing provider) so the
 * `DIRECT_ANSWER` step reports zero provider calls whenever it falls back (Req 7.3, 8.1, 8.2).
 * `fallback` is present only when the deterministic text was returned. `cost` carries the
 * accumulated provider usage and is present only on a successful provider answer.
 */
export interface LiveDirectAnswerResult {
  response: string;
  providerCalls: number;
  fallback?: LiveDirectAnswerFallback;
  cost?: { estimatedUsd: number; modelCalls: number };
}

/**
 * External_Mode cheap-model direct answer for the `DIRECT_ANSWER` route, mirroring the discipline of
 * {@link runLiveSynthesizer} (budget preflight → invoke → redact → fallback):
 *
 * 1. No configured provider → `no_provider` fallback with `providerCalls === 0`, no call made
 *    (Req 8.2).
 * 2. A budget preflight runs BEFORE any provider call; a denial → `denied` fallback with
 *    `providerCalls === 0`, no call made (Req 7.2, 7.3).
 * 3. The provider is invoked once; any error → `provider_error` fallback with `providerCalls === 0`,
 *    and the raw provider body never reaches the result (Req 8.1).
 * 4. The assembled answer is routed through `redactOutbound` so raw provider error text and secret
 *    values never appear; a redaction failure suppresses the provider answer and falls back
 *    (Req 8.3).
 *
 * On every fallback the deterministic {@link buildDeterministicDirectAnswer} text is returned, so the
 * user always receives a usable answer (Req 8.1, 8.2). No exception escapes for budget/provider/
 * redaction failures.
 */
export async function runLiveDirectAnswer(
  input: BrainstemSynthesisInput,
  deps: LiveDirectAnswerDeps
): Promise<LiveDirectAnswerResult> {
  const { provider, run } = deps;
  const evaluate = deps.evaluateBudget ?? evaluateBudget;
  const redact = deps.redactOutbound ?? redactOutbound;

  // Req 8.2: no configured slm-role provider → deterministic fallback, zero calls.
  if (!provider) {
    return fallbackResult(input, "no_provider");
  }

  // The cheap-model request. A malformed input that throws while building the prompt routes to the
  // deterministic fallback rather than escaping (never throws out of this function).
  let request: LLMRequest;
  try {
    request = buildDirectAnswerRequest(input, deps.model);
  } catch {
    return fallbackResult(input, "provider_error");
  }

  // Req 7.2: a budget preflight runs BEFORE any provider call.
  let estimate: LLMUsage;
  try {
    estimate = provider.estimateRequest(request);
  } catch {
    return fallbackResult(input, "provider_error");
  }

  const decision = evaluate(run, preflightUsage(provider, estimate, run));
  if (decision.status !== "allowed") {
    // Req 7.3: budget denial → deterministic fallback, zero provider calls.
    return fallbackResult(input, "denied");
  }

  let response: LLMResponse;
  try {
    response = await provider.invoke(request, { abortSignal: deps.abortSignal });
  } catch {
    // Req 8.1: any provider error → deterministic fallback; the raw provider body never reaches
    // the result. providerCalls stays 0 for this step.
    return fallbackResult(input, "provider_error");
  }

  // Req 8.3: route the assembled answer through redactOutbound so raw provider text and secret
  // values never appear. A redaction failure suppresses the provider answer and falls back.
  const redactedResponse = redact(response.content);
  if (!redactedResponse.ok) {
    return fallbackResult(input, "provider_error");
  }

  const answer = redactedResponse.value.trim();
  if (answer.length === 0) {
    // An empty provider answer is not usable; fall back to the deterministic text.
    return fallbackResult(input, "provider_error");
  }

  return {
    response: answer,
    providerCalls: 1,
    cost: { estimatedUsd: response.usage.estimatedUsd, modelCalls: response.usage.modelCalls },
  };
}

/**
 * The deterministic Local_Mode direct-answer result (Req 8.1, 8.2). `providerCalls` is always 0 and
 * `cost` is omitted because no provider answer is surfaced on this path.
 */
function fallbackResult(
  input: BrainstemSynthesisInput,
  fallback: LiveDirectAnswerFallback
): LiveDirectAnswerResult {
  return {
    response: buildDeterministicDirectAnswer(input),
    providerCalls: 0,
    fallback,
  };
}

/**
 * Builds the single cheap-model (`slm` role → `cheap` route) direct-answer request. The user intent
 * is redacted before it reaches the prompt so no configured secret can be echoed to the provider
 * (Req 8.3); the response is requested as plain text and bounded so the answer stays short (Req 5.3).
 */
function buildDirectAnswerRequest(input: BrainstemSynthesisInput, model?: string): LLMRequest {
  const intent = redactSecrets((input.contextPack.userIntentSummary ?? "").trim());
  return {
    messages: [
      {
        role: "system",
        content: [
          "You are Rector answering a simple, self-contained user question directly.",
          "Reply with a concise, polite answer of at most 6 sentences.",
          "Do not include status, route, trace, or evidence prose.",
          "Never include secrets, API keys, credentials, tokens, or environment variable values.",
        ].join("\n"),
      },
      {
        role: "user",
        content: intent.length > 0 ? intent : "Answer the user's simple question directly.",
      },
    ],
    modelRoute: "cheap",
    ...(model ? { model } : {}),
    responseFormat: { type: "text" },
    task: "direct-answer",
  };
}

/**
 * Shapes the pre-flight {@link BudgetUsage} for the cheap-model call, layering this call's estimate
 * onto the run's committed cost so the preflight gates the projected total (mirrors the accumulation
 * the live synthesizer performs).
 */
function preflightUsage(provider: LLMProvider, estimate: LLMUsage, run: Run): BudgetUsage {
  return {
    provider: provider.metadata.id,
    estimatedUsd: committedNumber(run.actualCost?.usd, run.costEstimate.usd) + estimate.estimatedUsd,
    inputTokens: committedNumber(run.actualTokens?.input, run.tokenEstimate.input) + estimate.inputTokens,
    outputTokens: committedNumber(run.actualTokens?.output, run.tokenEstimate.output) + estimate.outputTokens,
    modelCalls: committedNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + estimate.modelCalls,
    runtimeMs: committedNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

function committedNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}
