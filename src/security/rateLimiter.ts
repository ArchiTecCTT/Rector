import rateLimit, { type IncrementResponse, type Store } from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";

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

interface BucketCheckContext {
  rule: RateLimitRule;
  now: number;
  bucketKey: string;
  disabled: boolean;
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

/** Classify an HTTP request into a rate-limit route bucket. */
export function classifyRateLimitRoute(method: string, requestPath: string): string | undefined {
  if (method === "POST" && requestPath.startsWith("/api/chat/")) return "chat";
  if (requestPath.startsWith("/api/auth/")) return "auth-login";
  if (method === "POST" && requestPath === "/api/setup/test-connection") return "provider-test-connection";
  if (method === "POST" && /^\/api\/memory-providers\/[^/]+\/test-connection$/.test(requestPath)) {
    return "memory-provider-test";
  }
  if (requestPath.startsWith("/api/")) return "general";
  return undefined;
}

export function rateLimitErrorMessage(route: string): string {
  switch (route) {
    case "chat":
      return "Too many chat requests";
    case "auth-login":
      return "Too many authentication requests";
    case "provider-test-connection":
      return "Too many provider test requests";
    case "memory-provider-test":
      return "Too many memory provider test requests";
    case "general":
      return "Too many requests";
    default:
      return "Too many requests";
  }
}

export function rateLimitBucketKey(route: string, identity: string): string {
  return `${route}\u0000${identity}`;
}

function parseRateLimitBucketKey(key: string): { route: string; identity: string } {
  const index = key.indexOf("\u0000");
  if (index < 0) return { route: "general", identity: key };
  return { route: key.slice(0, index), identity: key.slice(index + 1) };
}

export class RectorRateLimitStore implements Store {
  readonly localKeys = true;

  constructor(
    private readonly limiter: RateLimiter,
    private readonly policy: RateLimitPolicy,
  ) {}

  async increment(key: string): Promise<IncrementResponse> {
    const { route, identity } = parseRateLimitBucketKey(key);
    const committed = await this.limiter.commit(identity, route, Date.now());
    if (committed.disabled) {
      return { totalHits: 0, resetTime: undefined };
    }
    if (!committed.allowed) {
      return { totalHits: committed.limit + 1, resetTime: new Date(committed.resetAt) };
    }
    return {
      totalHits: committed.limit - committed.remaining,
      resetTime: new Date(committed.resetAt),
    };
  }

  async decrement(_key: string): Promise<void> {}

  async resetKey(key: string): Promise<void> {
    const { route, identity } = parseRateLimitBucketKey(key);
    await this.limiter.reset?.(identity, route);
  }
}

export interface ApiRateLimitMiddlewareOptions {
  rateLimit?: RateLimitConfig;
  rateLimiter?: RateLimiter;
  env?: Record<string, string | undefined>;
  resolveKey: (req: Request) => string;
  onStoreFailure?: (res: Response, error: unknown) => void;
}

/** Build an express-rate-limit middleware instance (CodeQL-recognized). */
export function buildExpressRateLimitMiddleware(options: ApiRateLimitMiddlewareOptions): RequestHandler {
  const policy = createRateLimitPolicy(options.rateLimit, options.env);
  const limiter = options.rateLimiter ?? new InMemoryRateLimiter(policy);
  const store = new RectorRateLimitStore(limiter, policy);
  const resolveRoute = (req: Request): string => classifyRateLimitRoute(req.method, req.path) ?? "general";

  return rateLimit({
    windowMs: policy.routes.general.windowMs,
    limit: (req) => rateLimitRuleFor(policy, resolveRoute(req)).maxRequests,
    keyGenerator: (req) => rateLimitBucketKey(resolveRoute(req), options.resolveKey(req)),
    skip: (req) => classifyRateLimitRoute(req.method, req.path) === undefined,
    store,
    standardHeaders: false,
    legacyHeaders: true,
    handler: (req, res) => {
      res.status(429).json({ error: rateLimitErrorMessage(resolveRoute(req)) });
    },
    passOnStoreError: false,
  });
}

export function createApiRateLimitMiddleware(options: ApiRateLimitMiddlewareOptions): RequestHandler {
  const policy = createRateLimitPolicy(options.rateLimit, options.env);
  const limiterMiddleware = buildExpressRateLimitMiddleware(options);
  const resolveRoute = (req: Request): string => classifyRateLimitRoute(req.method, req.path) ?? "general";

  return (req: Request, res: Response, next: NextFunction) => {
    limiterMiddleware(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      const route = resolveRoute(req);
      const rule = rateLimitRuleFor(policy, route);
      if (!rule.failClosed) {
        next();
        return;
      }
      if (options.onStoreFailure) {
        options.onStoreFailure(res, error);
        return;
      }
      res.status(503).json({ error: "Rate limiter unavailable" });
    });
  };
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly policy: RateLimitPolicy = createRateLimitPolicy()) {}

  check(key: string, route: string, now: number): RateLimitDecision {
    const context = this.bucketContext(key, route, now);
    if (context.disabled) return disabledDecision(key, route, context.now);
    const bucket = this.activeBucket(context.bucketKey, context.now);
    return bucket
      ? decisionForExistingBucket(key, route, context.rule, bucket, context.now)
      : allowedDecision(key, route, context.rule, context.now + context.rule.windowMs, context.rule.maxRequests);
  }

  commit(key: string, route: string, now: number): RateLimitDecision {
    const context = this.bucketContext(key, route, now);
    if (context.disabled) return disabledDecision(key, route, context.now);
    const bucket = this.activeBucket(context.bucketKey, context.now);
    if (!bucket) return this.createBucketDecision(key, route, context);
    if (bucket.count >= context.rule.maxRequests) {
      return deniedDecision(key, route, context.rule, bucket.resetAt, bucket.resetAt - context.now);
    }
    bucket.count += 1;
    return allowedDecision(key, route, context.rule, bucket.resetAt, Math.max(0, context.rule.maxRequests - bucket.count));
  }

  private bucketContext(key: string, route: string, now: number): BucketCheckContext {
    const rule = rateLimitRuleFor(this.policy, route);
    const normalizedNow = normalizeNow(now);
    if (rule.maxRequests <= 0) {
      return { rule, now: normalizedNow, bucketKey: "", disabled: true };
    }
    this.sweep(normalizedNow);
    return { rule, now: normalizedNow, bucketKey: this.bucketKey(key, route), disabled: false };
  }

  private activeBucket(bucketKey: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(bucketKey);
    return bucket && bucket.resetAt > now ? bucket : undefined;
  }

  private createBucketDecision(key: string, route: string, context: BucketCheckContext): RateLimitDecision {
    const bucket = { resetAt: context.now + context.rule.windowMs, count: 1 };
    this.buckets.set(context.bucketKey, bucket);
    return allowedDecision(key, route, context.rule, bucket.resetAt, Math.max(0, context.rule.maxRequests - 1));
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

/**
 * Redis-backed distributed rate limiter using rate-limiter-flexible + ioredis.
 *
 * Requires `rate-limiter-flexible` and `ioredis` to be installed (optional peer deps).
 * If they are missing, construction throws — callers should use {@link createRateLimiterFromEnv}
 * which guards against missing packages.
 *
 * Types are intentionally `any` to avoid compile-time module resolution when the optional
 * dependencies are not installed.
 */
export class RedisRateLimiter implements DistributedRateLimiter {
  readonly kind = "distributed" as const;

  private readonly _limiter: any;
  private readonly _redis: any;
  private readonly _keyPrefix: string;
  private readonly policy: RateLimitPolicy;

  constructor(
    redisUrl: string,
    policy: RateLimitPolicy = createRateLimitPolicy(),
    options?: {
      /** Key prefix in Redis to avoid collisions. */
      prefix?: string;
    },
  ) {
    // Dynamic require — these packages are optional and may not be installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RateLimiterRedis } = require("rate-limiter-flexible");

    this.policy = policy;
    this._keyPrefix = options?.prefix ?? "rl";
    this._redis = new IORedis.default(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this._limiter = new RateLimiterRedis({
      storeClient: this._redis,
      keyPrefix: this._keyPrefix,
      points: 0, // overridden per-route in check/commit
      duration: 1, // overridden per-route in check/commit
    });
  }

  async check(key: string, route: string, now: number): Promise<RateLimitDecision> {
    return this._performOperation(key, route, now, false);
  }

  async commit(key: string, route: string, now: number): Promise<RateLimitDecision> {
    return this._performOperation(key, route, now, true);
  }

  async reset(key?: string, route?: string): Promise<void> {
    if (!key && !route) {
      const stream = this._redis.scanStream({ match: `${this._keyPrefix}:*`, count: 100 });
      const keys: string[] = [];
      for await (const batch of stream as AsyncIterable<string[]>) {
        keys.push(...batch);
      }
      if (keys.length > 0) {
        await this._redis.del(...keys);
      }
      return;
    }

    const matchKey = route
      ? `${this._keyPrefix}:${route}\u0000${key ?? "*"}`
      : `${this._keyPrefix}:*\u0000${key}`;
    const stream = this._redis.scanStream({ match: matchKey, count: 100 });
    const keys: string[] = [];
    for await (const batch of stream as AsyncIterable<string[]>) {
      keys.push(...batch);
    }
    if (keys.length > 0) {
      await this._redis.del(...keys);
    }
  }

  /** Disconnect the Redis client. Call on graceful shutdown. */
  async disconnect(): Promise<void> {
    await this._redis.quit();
  }

  private async _performOperation(
    key: string,
    route: string,
    now: number,
    consumePoint: boolean,
  ): Promise<RateLimitDecision> {
    const rule = rateLimitRuleFor(this.policy, route);
    if (rule.maxRequests <= 0) {
      return disabledDecision(key, route, normalizeNow(now));
    }

    const redisKey = `${route}\u0000${key}`;
    const durationSec = Math.ceil(rule.windowMs / 1000);

    try {
      const limiterForRoute = new (this._limiter.constructor as any)({
        storeClient: this._redis,
        keyPrefix: this._keyPrefix,
        points: rule.maxRequests,
        duration: durationSec,
      });

      let result: any;
      if (consumePoint) {
        result = await limiterForRoute.consume(redisKey, 1);
      } else {
        // Peek: check remaining without consuming a point
        const res = await limiterForRoute.get(redisKey);
        if (res) {
          result = res;
        } else {
          // No record exists yet — fully available
          return {
            key,
            route,
            allowed: true,
            limit: rule.maxRequests,
            remaining: rule.maxRequests,
            resetAt: now + rule.windowMs,
            retryAfterMs: 0,
            disabled: false,
          };
        }
      }

      const remaining = result.remainingPoints ?? 0;
      const msBeforeNext = result.msBeforeNext ?? rule.windowMs;
      const resetAt = now + msBeforeNext;

      if (remaining <= 0) {
        return {
          key,
          route,
          allowed: false,
          limit: rule.maxRequests,
          remaining: 0,
          resetAt,
          retryAfterMs: Math.max(0, msBeforeNext),
          disabled: false,
          reason: "RATE_LIMITED",
        };
      }

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
    } catch (error: unknown) {
      if (error && typeof error === "object" && "msBeforeNext" in error) {
        // RateLimiterRes when rate-limited
        const rlRes = error as { msBeforeNext: number; remainingPoints: number; consumedPoints: number };
        return {
          key,
          route,
          allowed: false,
          limit: rule.maxRequests,
          remaining: 0,
          resetAt: now + rlRes.msBeforeNext,
          retryAfterMs: Math.max(0, rlRes.msBeforeNext),
          disabled: false,
          reason: "RATE_LIMITED",
        };
      }

      // Redis/backend failure
      if (rule.failClosed) {
        throw error;
      }
      // Fail open: allow the request
      console.warn(`[RATE_LIMIT] Redis error, failing open: ${error instanceof Error ? error.message : String(error)}`);
      return {
        key,
        route,
        allowed: true,
        limit: rule.maxRequests,
        remaining: rule.maxRequests,
        resetAt: now + rule.windowMs,
        retryAfterMs: 0,
        disabled: false,
        reason: "RATE_LIMIT_BACKEND_ERROR",
      };
    }
  }
}

/**
 * Helper object to check if the optional Redis packages (ioredis and rate-limiter-flexible) are installed.
 * Defined as an object property to allow mocking in tests.
 */
export const redisPackageCheck = {
  check(): boolean {
    try {
      require.resolve("ioredis");
      require.resolve("rate-limiter-flexible");
      return true;
    } catch {
      return false;
    }
  }
};

/**
 * Create the appropriate rate limiter based on environment.
 * If RECTOR_REDIS_URL is set and the optional packages are available, returns a Redis-backed limiter.
 * Otherwise returns an InMemoryRateLimiter with a startup warning.
 */
export function createRateLimiterFromEnv(
  env: Record<string, string | undefined> = process.env,
  policy: RateLimitPolicy = createRateLimitPolicy(env),
): RateLimiter {
  const redisUrl = env.RECTOR_REDIS_URL;
  if (redisUrl) {
    if (redisPackageCheck.check()) {
      console.log("[RATE_LIMIT] Using Redis distributed rate limiter");
      return new RedisRateLimiter(redisUrl, policy);
    } else {
      console.warn(
        "[RATE_LIMIT] RECTOR_REDIS_URL is set but ioredis/rate-limiter-flexible are not installed. " +
          "Falling back to in-memory rate limiter. Install optional deps: npm install ioredis rate-limiter-flexible",
      );
      return new InMemoryRateLimiter(policy);
    }
  }
  console.warn("[RATE_LIMIT] RECTOR_REDIS_URL not set — using in-memory rate limiter (not distributed across instances)");
  return new InMemoryRateLimiter(policy);
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

function decisionForExistingBucket(
  key: string,
  route: string,
  rule: RateLimitRule,
  bucket: Bucket,
  now: number,
): RateLimitDecision {
  if (bucket.count >= rule.maxRequests) {
    return deniedDecision(key, route, rule, bucket.resetAt, bucket.resetAt - now);
  }
  return allowedDecision(key, route, rule, bucket.resetAt, rule.maxRequests - bucket.count);
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
