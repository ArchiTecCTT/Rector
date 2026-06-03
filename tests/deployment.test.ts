import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentReadinessReport,
  createGracefulShutdownHandler,
  parseDeploymentEnvironment,
  redactDeploymentConfig,
} from "../src/deployment";

class FakeServer {
  closeCalls = 0;
  constructor(private readonly behavior: "close" | "hang" | "error" = "close") {}

  close(callback: (error?: Error) => void): void {
    this.closeCalls += 1;
    if (this.behavior === "hang") return;
    queueMicrotask(() => callback(this.behavior === "error" ? new Error("close failed") : undefined));
  }
}

class FakeProcess extends EventEmitter {
  off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(eventName, listener);
  }
}

describe("deployment environment helpers", () => {
  it("parses local and Heroku-style deployment env without network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const config = parseDeploymentEnvironment({
      NODE_ENV: "production",
      PORT: "8080",
      DEPLOYMENT_TARGET: "heroku",
      HEROKU_APP_NAME: "rector-alpha",
      HEROKU_RELEASE_VERSION: "v24",
      PUBLIC_APP_URL: "https://rector-alpha.example.test",
      API_BASE_URL: "https://api.rector-alpha.example.test",
      CLOUDFLARE_ACCOUNT_ID: "cf-account",
      CLOUDFLARE_PROJECT_NAME: "rector-ui",
      CLOUDFLARE_PROXY_ENABLED: "true",
      MONGO_URI: "mongodb+srv://rector:mongodb-password@mongo.example.test/rector",
      MONGO_DB: "rector_core",
      REDIS_URL: "rediss://:redis-password@redis.example.test:6380",
      CHROMA_URL: "https://chroma.example.test",
      CHROMA_API_KEY: "chroma-secret",
      SENTRY_DSN: "https://public@sentry.example.test/1",
      POSTHOG_API_KEY: "phc_secret",
      POSTHOG_HOST: "https://eu.posthog.com",
    });

    expect(config).toMatchObject({
      target: "heroku",
      nodeEnv: "production",
      port: 8080,
      heroku: { appName: "rector-alpha", releaseVersion: "v24" },
      cloudflare: { accountId: "cf-account", projectName: "rector-ui", proxyEnabled: true },
      persistence: { mongoDb: "rector_core" },
      telemetry: { postHogHost: "https://eu.posthog.com" },
    });
    expect(config.persistence.mongoUri).toContain("mongodb+srv://");
    expect(config.persistence.redisUrl).toContain("rediss://");
    expect(config.memory.chromaUrl).toBe("https://chroma.example.test");
    expect(config.telemetry.sentryDsn).toBe("https://public@sentry.example.test/1");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects invalid ports and service URLs", () => {
    expect(() => parseDeploymentEnvironment({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => parseDeploymentEnvironment({ PUBLIC_APP_URL: "ftp://rector.example.test" })).toThrow(/PUBLIC_APP_URL/);
    expect(() => parseDeploymentEnvironment({ REDIS_URL: "http://redis.example.test" })).toThrow(/REDIS_URL/);
    expect(() => parseDeploymentEnvironment({ CHROMA_URL: "not-a-url" })).toThrow(/CHROMA_URL/);
    expect(() => parseDeploymentEnvironment({ POSTHOG_HOST: "not-a-url" })).toThrow(/POSTHOG_HOST/);
  });

  it("redacts deployment config secrets and credential-bearing URLs", () => {
    const config = parseDeploymentEnvironment({
      DEPLOYMENT_TARGET: "heroku",
      MONGO_URI: "mongodb://rector:mongodb-password@mongo.example.test/rector",
      REDIS_URL: "redis://:redis-password@redis.example.test:6379",
      CHROMA_URL: "https://chroma.example.test",
      CHROMA_API_KEY: "chroma-secret",
      SENTRY_DSN: "https://public@sentry.example.test/1",
      POSTHOG_API_KEY: "phc_secret",
    });

    const redacted = redactDeploymentConfig(config);
    const json = JSON.stringify(redacted);

    expect(json).not.toContain("mongodb-password");
    expect(json).not.toContain("redis-password");
    expect(json).not.toContain("chroma-secret");
    expect(json).not.toContain("phc_secret");
    expect(json).not.toContain("public@sentry.example.test");
    expect(redacted.persistence.mongoUri).toContain("[REDACTED]");
    expect(redacted.persistence.redisUrl).toContain("[REDACTED]");
    expect(redacted.memory.chromaApiKey).toBe("[REDACTED]");
    expect(redacted.telemetry.sentryDsn).toBe("[REDACTED]");
    expect(redacted.telemetry.postHogApiKey).toBe("[REDACTED]");
  });

  it("creates a redacted readiness report for optional services", () => {
    const config = parseDeploymentEnvironment({
      DEPLOYMENT_TARGET: "cloudflare",
      CLOUDFLARE_PROXY_ENABLED: "true",
      MONGO_URI: "mongodb://rector:mongodb-password@mongo.example.test/rector",
      REDIS_URL: "redis://localhost:6379",
      CHROMA_URL: "http://localhost:8000",
      SENTRY_DSN: "https://public@sentry.example.test/1",
      POSTHOG_API_KEY: "phc_secret",
    });

    const report = createDeploymentReadinessReport(config);

    expect(report.target).toBe("cloudflare");
    expect(report.networkActions).toBe(0);
    expect(report.configuredServices).toEqual({
      heroku: false,
      cloudflare: true,
      mongodb: true,
      redis: true,
      chroma: true,
      sentry: true,
      postHog: true,
    });
    expect(JSON.stringify(report.redactedConfig)).not.toContain("phc_secret");
  });
});

describe("graceful shutdown helper", () => {
  it("closes the server once and exits successfully for repeated shutdown calls", async () => {
    const server = new FakeServer();
    const exits: number[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = createGracefulShutdownHandler({
      server,
      timeoutMs: 50,
      exit: (code) => exits.push(code),
      logger,
    });

    const first = await handler.shutdown("SIGTERM");
    const second = await handler.shutdown("SIGINT");

    expect(first).toMatchObject({ signal: "SIGTERM", code: 0, timedOut: false });
    expect(second).toEqual(first);
    expect(server.closeCalls).toBe(1);
    expect(exits).toEqual([0]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });

  it("installs and removes signal listeners without shutting down during tests", () => {
    const server = new FakeServer();
    const processLike = new FakeProcess();
    const handler = createGracefulShutdownHandler({
      server,
      signals: ["SIGTERM", "SIGINT"],
      exit: () => undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    handler.install(processLike);
    expect(processLike.listenerCount("SIGTERM")).toBe(1);
    expect(processLike.listenerCount("SIGINT")).toBe(1);

    handler.uninstall();
    expect(processLike.listenerCount("SIGTERM")).toBe(0);
    expect(processLike.listenerCount("SIGINT")).toBe(0);
    expect(server.closeCalls).toBe(0);
  });

  it("reports timeout failures and exits with code 1", async () => {
    const server = new FakeServer("hang");
    const exits: number[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = createGracefulShutdownHandler({
      server,
      timeoutMs: 1,
      exit: (code) => exits.push(code),
      logger,
    });

    const result = await handler.shutdown("SIGTERM");

    expect(result).toMatchObject({ signal: "SIGTERM", code: 1, timedOut: true });
    expect(result.error?.message).toContain("timed out");
    expect(exits).toEqual([1]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
