import { EventEmitter } from "node:events";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  OrchestrationConfigError,
  createDeploymentReadinessReport,
  createGracefulShutdownHandler,
  parseDeploymentEnvironment,
  parseOrchestrationConfig,
  redactDeploymentConfig,
} from "../src/deployment";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

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

// ---------------------------------------------------------------------------
// Property 8: External mode defaults safely and never requires keys for `npm test`
// Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6
// ---------------------------------------------------------------------------

describe("Property 8: orchestration config defaults safely and never leaks secrets", () => {
  // Runs `parse` under a fetch spy and asserts orchestration parsing performs
  // zero network I/O (Requirement 1.6) regardless of the outcome.
  function withoutNetwork<T>(parse: () => T): T {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = parse();
      expect(fetchSpy).not.toHaveBeenCalled();
      return result;
    } finally {
      fetchSpy.mockRestore();
    }
  }

  // Unset / empty / whitespace-only ORCHESTRATOR_MODE resolves to external with an empty
  // provider list (unconfigured baseline), even when key-like secrets are present in the env.
  it("resolves unset, empty, or whitespace mode to external without leaking env secrets", () => {
    const arbBlankMode = fc.oneof(
      fc.constant<string | undefined>(undefined),
      fc.constantFrom("", " ", "   ", "\t", "\n", "\r\n", " \t \n "),
    );

    fc.assert(
      fc.property(arbBlankMode, arbKeyLikeSecret(), (mode, secret) => {
        const env: Record<string, string | undefined> = {
          ORCHESTRATOR_MODE: mode,
          // Secrets in the environment must never surface in the returned config.
          TOGETHER_API_KEY: secret,
          CLOUDFLARE_API_TOKEN: secret,
          AZURE_OPENAI_API_KEY: secret,
        };

        const config = withoutNetwork(() => parseOrchestrationConfig(env));

        expect(config.mode).toBe("external");
        expect(config.configuredProviders).toEqual([]);
        expect(JSON.stringify(config)).not.toContain(secret);
      }),
    );
  });

  // (b) Requirement 1.2: external mode with no validated provider throws a redacted
  // OrchestrationConfigError (caught here, never a crash) whose message and setupHint
  // expose no secret value, and the parse performs zero network I/O (1.6).
  it("throws a redacted EXTERNAL_MODE_NO_PROVIDER error when no provider validates", () => {
    fc.assert(
      fc.property(arbKeyLikeSecret(), (secret) => {
        // Each provider is left incompletely configured so none validates: cloudflare is
        // missing CLOUDFLARE_ACCOUNT_ID and azure is missing its endpoint/deployment, while
        // together has no key at all. The injected secret therefore reaches the
        // parser but must not appear in the resulting error.
        const env: Record<string, string | undefined> = {
          ORCHESTRATOR_MODE: "external",
          CLOUDFLARE_API_TOKEN: secret,
          AZURE_OPENAI_API_KEY: secret,
        };

        let caught: unknown;
        withoutNetwork(() => {
          try {
            parseOrchestrationConfig(env);
          } catch (error) {
            caught = error;
          }
        });

        expect(caught).toBeInstanceOf(OrchestrationConfigError);
        const error = caught as OrchestrationConfigError;
        expect(error.code).toBe("EXTERNAL_MODE_NO_PROVIDER");
        expect(error.message).not.toContain(secret);
        expect(error.setupHint).not.toContain(secret);
        // The hint should still guide the operator using env key NAMES only.
        expect(error.setupHint).toContain("TOGETHER_API_KEY");
      }),
    );
  });

  // (d) Requirement 1.4: any non-blank value that does not exactly match a known mode is
  // rejected with a redacted ORCHESTRATOR_MODE_INVALID error, with no secret leakage and
  // zero network I/O (1.6).
  it("rejects unknown, non-blank modes with a redacted ORCHESTRATOR_MODE_INVALID error", () => {
    const arbInvalidMode = fc
      .string({ minLength: 1, maxLength: 24 })
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value !== "local" && value !== "external");

    fc.assert(
      fc.property(arbInvalidMode, arbKeyLikeSecret(), (mode, secret) => {
        const env: Record<string, string | undefined> = {
          ORCHESTRATOR_MODE: mode,
          TOGETHER_API_KEY: secret,
        };

        let caught: unknown;
        withoutNetwork(() => {
          try {
            parseOrchestrationConfig(env);
          } catch (error) {
            caught = error;
          }
        });

        expect(caught).toBeInstanceOf(OrchestrationConfigError);
        const error = caught as OrchestrationConfigError;
        expect(error.code).toBe("ORCHESTRATOR_MODE_INVALID");
        expect(error.message).not.toContain(secret);
        expect(error.setupHint).not.toContain(secret);
      }),
    );
  });

  // Requirement 1.5: external mode with at least one validated provider returns that
  // provider in the configured list, without reading any secret value into the config and
  // without touching the network (1.6).
  it("lists validated providers in external mode without leaking the configured secret", () => {
    fc.assert(
      fc.property(arbKeyLikeSecret(), (secret) => {
        const env: Record<string, string | undefined> = {
          ORCHESTRATOR_MODE: "external",
          // A non-empty key plus the default https base URL validates the Together provider.
          TOGETHER_API_KEY: secret,
        };

        const config = withoutNetwork(() => parseOrchestrationConfig(env));

        expect(config.mode).toBe("external");
        expect(config.configuredProviders).toContain("together");
        expect(JSON.stringify(config)).not.toContain(secret);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseOrchestrationConfig (example-based, concrete cases)
// Validates: Requirements 1.2, 1.3, 1.5, 1.6
// ---------------------------------------------------------------------------

describe("parseOrchestrationConfig (unit)", () => {
  // A concrete, fixed secret value reused across the redaction assertions so we
  // can search for an exact substring in serialized output and error fields.
  const SECRET = "sk-unit-test-1234567890ABCDEFghijklmnop";

  // Requirement 1.1 (supporting context for the unit suite): an unset
  // ORCHESTRATOR_MODE resolves to the provider-free local default, and the
  // parse performs zero network I/O (Requirement 1.6).
  it("defaults to external with an empty provider list when ORCHESTRATOR_MODE is unset", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const config = parseOrchestrationConfig({});

      expect(config).toEqual({ mode: "external", configuredProviders: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // Requirement 1.4: an explicit unknown mode is rejected with
  // ORCHESTRATOR_MODE_INVALID (no fallback to local).
  it("throws ORCHESTRATOR_MODE_INVALID for an unknown mode value like 'hybrid'", () => {
    let caught: unknown;
    try {
      parseOrchestrationConfig({ ORCHESTRATOR_MODE: "hybrid" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrchestrationConfigError);
    expect((caught as OrchestrationConfigError).code).toBe("ORCHESTRATOR_MODE_INVALID");
  });

  // Requirement 1.4: mode matching is case-sensitive, so "LOCAL" is rejected
  // rather than silently coerced to the local default.
  it("rejects a wrong-case mode 'LOCAL' with ORCHESTRATOR_MODE_INVALID (case-sensitive)", () => {
    let caught: unknown;
    try {
      parseOrchestrationConfig({ ORCHESTRATOR_MODE: "LOCAL" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrchestrationConfigError);
    expect((caught as OrchestrationConfigError).code).toBe("ORCHESTRATOR_MODE_INVALID");
  });

  // Requirement 1.5 + 1.6: external mode with one validated provider lists that
  // provider id and performs zero network I/O.
  it("lists the configured provider in external mode when its env validates", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const config = parseOrchestrationConfig({
        ORCHESTRATOR_MODE: "external",
        // A non-empty key plus the default https base URL validates Together.
        TOGETHER_API_KEY: "together-dummy-key",
      });

      expect(config.mode).toBe("external");
      expect(config.configuredProviders).toContain("together");
      // Only the configured provider is listed; partially configured providers
      // (none here) do not appear.
      expect(config.configuredProviders).toEqual(["together"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // Requirement 1.2: external mode with no validated provider throws
  // EXTERNAL_MODE_NO_PROVIDER with a redacted hint that names required env KEY
  // names (never values) to guide setup.
  it("throws EXTERNAL_MODE_NO_PROVIDER when external mode has no validated provider", () => {
    let caught: unknown;
    try {
      // No provider env supplied at all, so none validate.
      parseOrchestrationConfig({ ORCHESTRATOR_MODE: "external" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrchestrationConfigError);
    const error = caught as OrchestrationConfigError;
    expect(error.code).toBe("EXTERNAL_MODE_NO_PROVIDER");
    // The hint guides the operator with env key NAMES for every supported provider.
    expect(error.setupHint).toContain("TOGETHER_API_KEY");
    expect(error.setupHint).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(error.setupHint).toContain("AZURE_OPENAI_API_KEY");
  });

  // Requirement 1.3: the concrete secret value supplied via env must NOT appear
  // anywhere in the returned configuration (success path).
  it("never includes a secret value in the returned external-mode config", () => {
    const config = parseOrchestrationConfig({
      ORCHESTRATOR_MODE: "external",
      TOGETHER_API_KEY: SECRET,
    });

    expect(config.mode).toBe("external");
    expect(config.configuredProviders).toEqual(["together"]);
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  // Requirement 1.3: the concrete secret value supplied via env must NOT appear
  // in the thrown error's message or setupHint (failure path). Cloudflare is
  // partially configured (token present, account id missing) so it carries the
  // secret into the parser but still fails validation.
  it("never leaks a secret value in the EXTERNAL_MODE_NO_PROVIDER error message or setupHint", () => {
    let caught: unknown;
    try {
      parseOrchestrationConfig({
        ORCHESTRATOR_MODE: "external",
        CLOUDFLARE_API_TOKEN: SECRET,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrchestrationConfigError);
    const error = caught as OrchestrationConfigError;
    expect(error.code).toBe("EXTERNAL_MODE_NO_PROVIDER");
    expect(error.message).not.toContain(SECRET);
    expect(error.setupHint).not.toContain(SECRET);
  });
});
