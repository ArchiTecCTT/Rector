import type { LLMRequest } from "./llm";

export type OpenAiCompatibleStrictJsonHostPolicy = "zai" | "regolo" | "none";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Host policy for Z.ai GLM OpenAI-compatible endpoints (live harness / strict JSON). */
export function isZaiOpenAiCompatibleHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "api.z.ai" || normalized.endsWith(".z.ai");
}

/** Host policy for Regolo OpenAI-compatible endpoints (live harness / strict JSON). */
export function isRegoloOpenAiCompatibleHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "api.regolo.ai" || normalized.endsWith(".regolo.ai");
}

export function hostFromOpenAiCompatibleBaseUrl(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

export function resolveOpenAiCompatibleStrictJsonHostPolicy(baseUrl: string): OpenAiCompatibleStrictJsonHostPolicy {
  const host = hostFromOpenAiCompatibleBaseUrl(baseUrl);
  if (!host) return "none";
  if (isZaiOpenAiCompatibleHost(host)) return "zai";
  if (isRegoloOpenAiCompatibleHost(host)) return "regolo";
  return "none";
}

/**
 * Provider-policy-gated body extensions for strict JSON jobs on OpenAI-compatible adapters.
 * Unknown hosts receive no non-standard keys.
 */
export function buildOpenAiCompatibleStrictJsonBodyExtensions(
  request: Pick<LLMRequest, "responseFormat" | "providerOptions">,
  baseUrl: string,
): Record<string, unknown> {
  if (request.responseFormat?.type !== "json_object") {
    return {};
  }
  if (request.providerOptions?.strictJsonMinimizeReasoning !== true) {
    return {};
  }

  const hostPolicy = resolveOpenAiCompatibleStrictJsonHostPolicy(baseUrl);
  if (hostPolicy === "zai") {
    return { thinking: { type: "disabled" } };
  }
  if (hostPolicy === "regolo") {
    return { reasoning_effort: "low" };
  }
  return {};
}