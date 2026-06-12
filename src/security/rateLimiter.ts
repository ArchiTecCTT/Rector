export type RateLimitRoute =
  | "chat"
  | "auth-login"
  | "provider-test-connection"
  | "memory-provider-test"
  | "general"
  | (string & {});

export interface RateLimitRule {
  windowMs: number;
  maxRequests: number;
  /** Deny requests when the limiter backend fails instead of bypassing it. */
  failClosed: boolean;
}

export type RateLimitRuleInput = Partial<RateLimitRule>;

export interface RateLimitConfig {
  /** Backward-compatible default window for chat requests and derived route defaults. */
  windowMs?: number;
  /** Backward-compatible default max for chat requests and derived route defaults. */
  maxRequests?: number;
  /** Global backend-failure posture. Defaults to fail closed. */
  failClosed?: boolean;
  chat?: RateLimitRuleInput;
  authLogin?: RateLimitRuleInput;
  providerTestConnection?: RateLimitRuleInput;
  memoryProviderTest?: RateLimitRuleInput;
  general?: RateLimitRuleInput;
}

export interface RateLimitPolicy {
  failClosed: boolean;
  routes: Record<string, RateLimitRule>;
}

export interface RateLimitDecision {
  key: string;
  route: string;
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
  disabled: boolean;
  reason?: string;
}

export interface RateLimiter {
  check(key: string, route: string, now: number): RateLimitDecision | Promise<RateLimitDecision>;
  commit(key: string, route: string, now: number): RateLimitDecision | Promise<RateLimitDecision>;
  reset?(key?: string, route?: string): void | Promise<void>;
}

export interface DistributedRateLimiter extends RateLimiter {
  readonly kind: "distributed";
}

interface Bucket {
  resetAt: number;
  count: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CHAT_MAX = 60;

export function createRateLimitPolicy(
  config: RateLimitConfig = {},
  env: Record<string, string | undefined> = process.env,
): RateLimitPolicy {
  const baseWindowMs = positiveInt(config.windowMs, numberFromEnv(env, "CHAT_RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS));
  const baseMaxRequests = intOrFallback(config.maxRequests, numberFromEnv(env, "CHAT_RATE_LIMIT_MAX", DEFAULT_CHAT_MAX));
  const failClosed = config.failClosed ?? booleanFromEnv(env, "RATE_LIMIT_FAIL_CLOSED", true);

  const baseRule = { windowMs: baseWindowMs, maxRequests: baseMaxRequests, failClosed };
  const derivedGeneralMax = Math.max(10, Math.max(0, baseMaxRequests) * 5);
  const derivedTestMax = Math.max(5, Math.max(0, baseMaxRequests));

  return {
    failClosed,
    routes: {
      chat: buildRouteRule(baseRule, env, {
        windowMs: "CHAT_RATE_LIMIT_WINDOW_MS",
        maxRequests: "CHAT_RATE_LIMIT_MAX",
      }, config.chat),
      "auth-login": buildRouteRule({ ...baseRule, maxRequests: derivedGeneralMax }, env, {
        windowMs: "AUTH_LOGIN_RATE_LIMIT_WINDOW_MS",
        maxRequests: "AUTH_LOGIN_RATE_LIMIT_MAX",
      }, config.authLogin),
      "provider-test-connection": buildRouteRule({ ...baseRule, maxRequests: derivedTestMax }, env, {
        windowMs: "PROVIDER_TEST_RATE_LIMIT_WINDOW_MS",
        maxRequests: "PROVIDER_TEST_RATE_LIMIT_MAX",
      }, config.providerTestConnection),
      "memory-provider-test": buildRouteRule({ ...baseRule, maxRequests: derivedTestMax }, env, {
        windowMs: "MEMORY_PROVIDER_TEST_RATE_LIMIT_WINDOW_MS",
        maxRequests: "MEMORY_PROVIDER_TEST_RATE_LIMIT_MAX",
      }, config.memoryProviderTest),
      general: buildRouteRule({ ...baseRule, maxRequests: derivedGeneralMax }, env, {
        windowMs: "API_RATE_LIMIT_WINDOW_MS",
        maxRequests: "API_RATE_LIMIT_MAX",
      }, config.general),
    },
  };
}

export function rateLimitRuleFor(policy: RateLimitPolicy, route: string): RateLimitRule {
  return policy.routes[route] ?? policy.routes.general;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly policy: RateLimitPolicy = createRateLimitPolicy()) {}

  check(key: string, route: string, now: number): RateLimitDecision {
    const rule = rateLimitRuleFor(this.policy, route);
    const normalizedNow = normalizeNow(now);
    if (rule.maxRequests <= 0) return disabledDecision(key, route, normalizedNow);

    this.sweep(normalizedNow);
    const bucketKey = this.bucketKey(key, route);
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= normalizedNow) {
      return allowedDecision(key, route, rule, normalizedNow + rule.windowMs, rule.maxRequests);
    }

    if (bucket.count >= rule.maxRequests) {
      return deniedDecision(key, route, rule, bucket.resetAt, bucket.resetAt - normalizedNow);
    }

    return allowedDecision(key, route, rule, bucket.resetAt, rule.maxRequests - bucket.count);
  }

  commit(key: string, route: string, now: number): RateLimitDecision {
    const rule = rateLimitRuleFor(this.policy, route);
    const normalizedNow = normalizeNow(now);
    if (rule.maxRequests <= 0) return disabledDecision(key, route, normalizedNow);

    this.sweep(normalizedNow);
    const bucketKey = this.bucketKey(key, route);
    const current = this.buckets.get(bucketKey);
    if (!current || current.resetAt <= normalizedNow) {
      const bucket = { resetAt: normalizedNow + rule.windowMs, count: 1 };
      this.buckets.set(bucketKey, bucket);
      return allowedDecision(key, route, rule, bucket.resetAt, Math.max(0, rule.maxRequests - 1));
    }

    if (current.count >= rule.maxRequests) {
      return deniedDecision(key, route, rule, current.resetAt, current.resetAt - normalizedNow);
    }

    current.count += 1;
    return allowedDecision(key, route, rule, current.resetAt, Math.max(0, rule.maxRequests - current.count));
  }

  reset(key?: string, route?: string): void {
    if (!key && !route) {
      this.buckets.clear();
      return;
    }

    for (const bucketKey of [...this.buckets.keys()]) {
      const [bucketRoute, bucketIdentity] = splitBucketKey(bucketKey);
      if (route && bucketRoute !== route) continue;
      if (key && bucketIdentity !== key) continue;
      this.buckets.delete(bucketKey);
    }
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private bucketKey(key: string, route: string): string {
    return `${route}\u0000${key}`;
  }
}

export function createUnavailableDistributedRateLimiter(
  message = "Distributed rate limiter backend is not configured.",
): DistributedRateLimiter {
  return {
    kind: "distributed",
    async check(): Promise<RateLimitDecision> {
      throw new Error(message);
    },
    async commit(): Promise<RateLimitDecision> {
      throw new Error(message);
    },
    async reset(): Promise<void> {},
  };
}

interface RateLimitRuleEnvKeys {
  windowMs: string;
  maxRequests: string;
}

function buildRouteRule(
  base: RateLimitRule,
  env: Record<string, string | undefined>,
  envKeys: RateLimitRuleEnvKeys,
  override: RateLimitRuleInput = {},
): RateLimitRule {
  return mergeRule(
    base,
    {
      windowMs: numberFromEnv(env, envKeys.windowMs, base.windowMs),
      maxRequests: numberFromEnv(env, envKeys.maxRequests, base.maxRequests),
    },
    override,
  );
}

function mergeRule(base: RateLimitRule, envRule: Partial<RateLimitRule>, override: RateLimitRuleInput = {}): RateLimitRule {
  return {
    windowMs: positiveInt(override.windowMs, positiveInt(envRule.windowMs, base.windowMs)),
    maxRequests: intOrFallback(override.maxRequests, intOrFallback(envRule.maxRequests, base.maxRequests)),
    failClosed: override.failClosed ?? envRule.failClosed ?? base.failClosed,
  };
}

function allowedDecision(
  key: string,
  route: string,
  rule: RateLimitRule,
  resetAt: number,
  remaining: number,
): RateLimitDecision {
  return {
    key,
    route,
    allowed: true,
    limit: rule.maxRequests,
    remaining: Math.max(0, remaining),
    resetAt,
    retryAfterMs: 0,
    disabled: false,
  };
}

function deniedDecision(
  key: string,
  route: string,
  rule: RateLimitRule,
  resetAt: number,
  retryAfterMs: number,
): RateLimitDecision {
  return {
    key,
    route,
    allowed: false,
    limit: rule.maxRequests,
    remaining: 0,
    resetAt,
    retryAfterMs: Math.max(0, retryAfterMs),
    disabled: false,
    reason: "RATE_LIMITED",
  };
}

function disabledDecision(key: string, route: string, now: number): RateLimitDecision {
  return {
    key,
    route,
    allowed: true,
    limit: 0,
    remaining: 0,
    resetAt: now,
    retryAfterMs: 0,
    disabled: true,
  };
}

function splitBucketKey(value: string): [route: string, key: string] {
  const index = value.indexOf("\u0000");
  if (index < 0) return ["general", value];
  return [value.slice(0, index), value.slice(index + 1)];
}

function normalizeNow(now: number): number {
  return Number.isFinite(now) ? Math.max(0, Math.floor(now)) : Date.now();
}

function numberFromEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : Math.trunc(fallback);
}

function intOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : Math.trunc(fallback);
}
