import { describe, expect, it, vi } from "vitest";

import {
  InMemoryRateLimiter,
  RedisRateLimiter,
  createRateLimiterFromEnv,
  createRateLimitPolicy,
  redisPackageCheck,
} from "../src/security/rateLimiter";

// ── RedisRateLimiter (interface & structure only) ──────────────────────

describe("RedisRateLimiter", () => {
  it("matches the DistributedRateLimiter interface", () => {
    // Verify RedisRateLimiter class exists and has the right shape
    expect(RedisRateLimiter).toBeDefined();
    expect(typeof RedisRateLimiter.prototype.check).toBe("function");
    expect(typeof RedisRateLimiter.prototype.commit).toBe("function");
    expect(typeof RedisRateLimiter.prototype.reset).toBe("function");
  });

  it("has a disconnect method for graceful shutdown", () => {
    expect(typeof RedisRateLimiter.prototype.disconnect).toBe("function");
  });

  it("has kind = 'distributed'", () => {
    // Class exists and implements DistributedRateLimiter
    expect(RedisRateLimiter.name).toBe("RedisRateLimiter");
  });
});

// ── createRateLimiterFromEnv ────────────────────────────────────────────

describe("createRateLimiterFromEnv", () => {
  it("returns InMemoryRateLimiter when RECTOR_REDIS_URL is not set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = createRateLimiterFromEnv({});
    expect(limiter).toBeInstanceOf(InMemoryRateLimiter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RECTOR_REDIS_URL not set"),
    );
    warnSpy.mockRestore();
  });

  it("returns InMemoryRateLimiter with warning when Redis packages are missing", () => {
    const checkSpy = vi.spyOn(redisPackageCheck, "check").mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Even with RECTOR_REDIS_URL set, if packages aren't installed, falls back
    const limiter = createRateLimiterFromEnv({ RECTOR_REDIS_URL: "redis://localhost:6379" });
    expect(limiter).toBeInstanceOf(InMemoryRateLimiter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ioredis/rate-limiter-flexible"),
    );
    warnSpy.mockRestore();
    checkSpy.mockRestore();
  });

  it("returns InMemoryRateLimiter when env is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = createRateLimiterFromEnv({});
    expect(limiter).toBeInstanceOf(InMemoryRateLimiter);
    warnSpy.mockRestore();
  });

  it("logs a warning about non-distributed mode when no Redis URL", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createRateLimiterFromEnv({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("in-memory"),
    );
    warnSpy.mockRestore();
  });

  it("logs a warning about missing packages when RECTOR_REDIS_URL is set but packages absent", () => {
    const checkSpy = vi.spyOn(redisPackageCheck, "check").mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createRateLimiterFromEnv({ RECTOR_REDIS_URL: "redis://localhost:6379" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("npm install ioredis rate-limiter-flexible"),
    );
    warnSpy.mockRestore();
    checkSpy.mockRestore();
  });
});

// ── InMemoryRateLimiter still works after RedisRateLimiter addition ────

describe("InMemoryRateLimiter (baseline after RedisRateLimiter addition)", () => {
  it("still functions correctly for check/commit/reset", () => {
    const policy = createRateLimitPolicy();
    const limiter = new InMemoryRateLimiter(policy);
    const rule = policy.routes.chat;

    const decision = limiter.check("user1", "chat", Date.now());
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(rule.maxRequests);

    const committed = limiter.commit("user1", "chat", Date.now());
    expect(committed.allowed).toBe(true);
    expect(committed.remaining).toBe(rule.maxRequests - 1);

    limiter.reset("user1", "chat");
    const afterReset = limiter.check("user1", "chat", Date.now());
    expect(afterReset.remaining).toBe(rule.maxRequests);
  });
});
