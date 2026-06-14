import { redactString } from "../security/redaction";
import {
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ModelRouter,
  type ModelRouterInput,
  type ModelSelection,
  type ProviderCapabilityMetadata,
} from "./llm";
import type { CredentialPool } from "./credentialPool";
import { TurnRetryState } from "./turnRetryState";

export type ProviderCallSite = "planner" | "skeptic" | "synthesizer" | "repair" | "triage";

export interface ProviderResilienceEvent {
  type: "PROVIDER_RETRY" | "PROVIDER_SUBSTITUTED" | "CREDENTIAL_ROTATED";
  site: ProviderCallSite;
  role?: string;
  payload: Record<string, unknown>;
}

export class ProviderResilienceError extends ProviderError {
  constructor(input: { provider: string; message: string; status?: number; details?: unknown }) {
    super({
      code: "PROVIDER_HTTP_ERROR",
      provider: input.provider,
      status: input.status,
      retryable: false,
      message: redactString(input.message),
      details: input.details,
    });
    Object.defineProperty(this, "name", { value: "ProviderResilienceError" });
  }
}

export interface CallWithResilienceInput<T> {
  site: ProviderCallSite;
  role?: string;
  primary: ModelSelection;
  fallback?: ModelSelection;
  credentialPool?: CredentialPool;
  retryState: TurnRetryState;
  abortSignal?: AbortSignal;
  retryDelayMs?: number;
  emitEvent?: (event: ProviderResilienceEvent) => void | Promise<void>;
  invoke: (selection: ModelSelection) => Promise<T>;
}

export async function callWithResilience<T>(
  input: CallWithResilienceInput<T>,
): Promise<{ result: T; selection: ModelSelection; substituted: boolean }> {
  let active = input.primary;

  try {
    return { result: await input.invoke(active), selection: active, substituted: false };
  } catch (error) {
    throwIfAbort(error);
    if (isRateLimitError(error) && input.retryState.tryMarkRetried429()) {
      await emit(input, "PROVIDER_RETRY", {
        reason: "rate_limit",
        providerId: providerIdOf(active),
        model: active.model,
        retryDelayMs: retryDelayMs(input),
      });
      await waitForRetry(retryDelayMs(input), input.abortSignal, active.provider.metadata.id);
      try {
        return { result: await input.invoke(active), selection: active, substituted: false };
      } catch (retryError) {
        error = retryError;
        throwIfAbort(error);
      }
    }

    if (isAuthError(error) && input.retryState.tryMarkRetriedAuth()) {
      const providerId = providerIdOf(active);
      const failedCredential = input.credentialPool?.acquire(providerId);
      if (failedCredential) {
        input.credentialPool?.markCooldown(providerId, failedCredential.secretRef, cooldownUntil());
      }
      const rotated = input.credentialPool?.acquire(providerId);
      if (rotated?.provider) {
        active = {
          ...active,
          provider: rotated.provider,
          model: modelForRotatedProvider(active, rotated.provider),
        };
      }
      await emit(input, "CREDENTIAL_ROTATED", {
        providerId,
        model: active.model,
        rotated: rotated !== undefined,
      });
      if (rotated) {
        try {
          return { result: await input.invoke(active), selection: active, substituted: false };
        } catch (retryError) {
          error = retryError;
          throwIfAbort(error);
        }
      }
    }

    if (input.fallback && input.retryState.tryMarkActivatedFallback()) {
      active = input.fallback;
      await emit(input, "PROVIDER_SUBSTITUTED", {
        role: input.role,
        primaryId: providerIdOf(input.primary),
        fallbackId: providerIdOf(input.fallback),
        primaryModel: input.primary.model,
        fallbackModel: input.fallback.model,
      });
      try {
        return { result: await input.invoke(active), selection: active, substituted: true };
      } catch (fallbackError) {
        error = fallbackError;
        throwIfAbort(error);
      }
    }

    throw classifyExhaustedError(error, active.provider.metadata.id);
  }
}

export interface BuildResilientModelRouterInput {
  inner: ModelRouter;
  credentialPool?: CredentialPool;
  providerResilienceEnabled?: boolean;
  retryDelayMs?: number;
  emitEvent?: (event: ProviderResilienceEvent) => void | Promise<void>;
}

export function buildResilientModelRouter(input: BuildResilientModelRouterInput): ModelRouter {
  if (input.providerResilienceEnabled === false) return input.inner;

  return {
    select(routerInput: ModelRouterInput = {}): ModelSelection {
      const selection = input.inner.select(routerInput);
      const site = siteForRouterInput(routerInput);
      if (!site) return selection;
      return resilientSelection(selection, site, roleForRouterInput(routerInput), input);
    },
  };
}

function resilientSelection(
  selection: ModelSelection,
  site: ProviderCallSite,
  role: string | undefined,
  input: BuildResilientModelRouterInput,
): ModelSelection {
  const retryState = new TurnRetryState();
  const fallback = selection.fallback
    ? {
        ...selection,
        provider: selection.fallback.provider,
        providerId: selection.fallback.providerId,
        model: selection.fallback.model,
        reason: selection.fallback.reason,
        fallback: undefined,
      }
    : undefined;
  const provider = new ResilientLLMProvider({
    primary: selection,
    fallback,
    site,
    role,
    credentialPool: input.credentialPool,
    retryState,
    retryDelayMs: input.retryDelayMs,
    emitEvent: input.emitEvent,
  });

  return { ...selection, provider };
}

class ResilientLLMProvider implements LLMProvider {
  readonly metadata: ProviderCapabilityMetadata;

  constructor(private readonly options: {
    primary: ModelSelection;
    fallback?: ModelSelection;
    site: ProviderCallSite;
    role?: string;
    credentialPool?: CredentialPool;
    retryState: TurnRetryState;
    retryDelayMs?: number;
    emitEvent?: (event: ProviderResilienceEvent) => void | Promise<void>;
  }) {
    this.metadata = options.primary.provider.metadata;
  }

  validateConfig(): void {
    this.options.primary.provider.validateConfig();
  }

  estimateRequest(request: LLMRequest) {
    return this.options.primary.provider.estimateRequest(request);
  }

  async invoke(request: LLMRequest, options: { abortSignal?: AbortSignal } = {}): Promise<LLMResponse> {
    const result = await callWithResilience({
      site: this.options.site,
      role: this.options.role,
      primary: this.options.primary,
      fallback: this.options.fallback,
      credentialPool: this.options.credentialPool,
      retryState: this.options.retryState,
      retryDelayMs: this.options.retryDelayMs,
      abortSignal: options.abortSignal,
      emitEvent: this.options.emitEvent,
      invoke: (selection) =>
        selection.provider.invoke({ ...request, model: selection.model }, { abortSignal: options.abortSignal }),
    });
    return result.result;
  }
}

function providerIdOf(selection: ModelSelection): string {
  return selection.providerId ?? selection.provider.metadata.id;
}

function modelForRotatedProvider(selection: ModelSelection, provider: LLMProvider): string {
  const models = Object.values(provider.metadata.models);
  if (models.includes(selection.model)) return selection.model;
  return provider.metadata.models[selection.modelRoute] ?? models[0] ?? selection.model;
}

async function emit(input: CallWithResilienceInput<unknown>, type: ProviderResilienceEvent["type"], payload: Record<string, unknown>): Promise<void> {
  await input.emitEvent?.({
    type,
    site: input.site,
    role: input.role,
    payload: {
      site: input.site,
      ...(input.role ? { role: input.role } : {}),
      ...payload,
    },
  });
}

function retryDelayMs(input: CallWithResilienceInput<unknown>): number {
  return input.retryDelayMs ?? 2_000;
}

function cooldownUntil(): Date {
  return new Date(Date.now() + 60_000);
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 429;
}

function isAuthError(error: unknown): boolean {
  return error instanceof ProviderError && (error.status === 401 || error.status === 403 || error.code === "CONFIG_INVALID");
}

function throwIfAbort(error: unknown): void {
  if (error instanceof ProviderError && error.code === "ABORTED") throw error;
  if (error instanceof Error && error.name === "AbortError") {
    throw new ProviderError({
      code: "ABORTED",
      provider: "provider-resilience",
      message: "Provider invocation aborted",
    });
  }
}

function classifyExhaustedError(error: unknown, provider: string): Error {
  if (error instanceof ProviderError) {
    return new ProviderResilienceError({
      provider: error.provider,
      status: error.status,
      message: error.message,
      details: error.details,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderResilienceError({ provider, message });
}

function waitForRetry(ms: number, signal: AbortSignal | undefined, provider: string): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ProviderError({
      code: "ABORTED",
      provider,
      message: "Provider retry wait aborted",
    }));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ProviderError({
        code: "ABORTED",
        provider,
        message: "Provider retry wait aborted",
      }));
    };
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function siteForRouterInput(input: ModelRouterInput): ProviderCallSite | undefined {
  const task = (input.task ?? "").toLowerCase();
  if (task.includes("planner")) return "planner";
  if (task.includes("skeptic")) return "skeptic";
  if (task.includes("synthesizer") || task.includes("synthesis") || task.includes("direct-answer")) return "synthesizer";
  if (task.includes("repair") || task.includes("healer")) return "repair";
  if (task.includes("triage")) return "triage";
  return undefined;
}

function roleForRouterInput(input: ModelRouterInput): string | undefined {
  const task = (input.task ?? "").toLowerCase();
  if (task.includes("direct-answer")) return "directAnswer";
  return siteForRouterInput(input);
}
