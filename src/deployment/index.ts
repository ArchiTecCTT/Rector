import { z } from "zod";
import { redactSecrets } from "../security/redaction";

export const DEPLOYMENT_API_VERSION = "rector.deployment.v1alpha1";
export const REDACTED = "[REDACTED]";

const DeploymentTargetSchema = z.enum(["local", "heroku", "cloudflare"]);
const NodeEnvSchema = z.enum(["development", "test", "production"]);

const optionalTrimmedString = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}, z.string().min(1).optional());

const optionalHttpUrl = (name: string) =>
  optionalTrimmedString.refine((value) => value === undefined || /^https?:\/\//i.test(value), `${name} must be an absolute http(s) URL`);

const optionalMongoUri = optionalTrimmedString.refine(
  (value) => value === undefined || /^mongodb(?:\+srv)?:\/\//i.test(value),
  "MONGO_URI must start with mongodb:// or mongodb+srv://"
);

const optionalRedisUrl = optionalTrimmedString.refine(
  (value) => value === undefined || /^rediss?:\/\//i.test(value),
  "REDIS_URL must start with redis:// or rediss://"
);

const optionalBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean().optional());

const portValue = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return 3000;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).trim());
  return Number.isNaN(parsed) ? value : parsed;
}, z.number().int().min(1).max(65535));

export const DeploymentEnvironmentSchema = z.object({
  NODE_ENV: z.preprocess((value) => value ?? "development", NodeEnvSchema).default("development"),
  PORT: portValue.default(3000),
  DEPLOYMENT_TARGET: z.preprocess((value) => value ?? "local", DeploymentTargetSchema).default("local"),
  PUBLIC_APP_URL: optionalHttpUrl("PUBLIC_APP_URL"),
  API_BASE_URL: optionalHttpUrl("API_BASE_URL"),

  HEROKU_APP_NAME: optionalTrimmedString,
  HEROKU_RELEASE_VERSION: optionalTrimmedString,

  CLOUDFLARE_ACCOUNT_ID: optionalTrimmedString,
  CLOUDFLARE_PROJECT_NAME: optionalTrimmedString,
  CLOUDFLARE_PROXY_ENABLED: optionalBoolean.default(false),

  MONGO_URI: optionalMongoUri,
  MONGO_DB: optionalTrimmedString,
  REDIS_URL: optionalRedisUrl,

  CHROMA_URL: optionalHttpUrl("CHROMA_URL"),
  CHROMA_API_KEY: optionalTrimmedString,

  SENTRY_DSN: optionalHttpUrl("SENTRY_DSN"),
  POSTHOG_API_KEY: optionalTrimmedString,
  POSTHOG_HOST: optionalHttpUrl("POSTHOG_HOST"),
});
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

export const DeploymentConfigSchema = z.object({
  apiVersion: z.literal(DEPLOYMENT_API_VERSION),
  target: DeploymentTargetSchema,
  nodeEnv: NodeEnvSchema,
  port: z.number().int().min(1).max(65535),
  publicAppUrl: z.string().min(1).optional(),
  apiBaseUrl: z.string().min(1).optional(),
  heroku: z.object({
    appName: z.string().min(1).optional(),
    releaseVersion: z.string().min(1).optional(),
  }),
  cloudflare: z.object({
    accountId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    proxyEnabled: z.boolean(),
  }),
  persistence: z.object({
    mongoUri: z.string().min(1).optional(),
    mongoDb: z.string().min(1).optional(),
    redisUrl: z.string().min(1).optional(),
  }),
  memory: z.object({
    chromaUrl: z.string().min(1).optional(),
    chromaApiKey: z.string().min(1).optional(),
  }),
  telemetry: z.object({
    sentryDsn: z.string().min(1).optional(),
    postHogApiKey: z.string().min(1).optional(),
    postHogHost: z.string().min(1).optional(),
  }),
});
export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

export const DeploymentReadinessReportSchema = z.object({
  apiVersion: z.literal(DEPLOYMENT_API_VERSION),
  target: DeploymentTargetSchema,
  nodeEnv: NodeEnvSchema,
  port: z.number().int().min(1).max(65535),
  networkActions: z.literal(0),
  configuredServices: z.object({
    heroku: z.boolean(),
    cloudflare: z.boolean(),
    mongodb: z.boolean(),
    redis: z.boolean(),
    chroma: z.boolean(),
    sentry: z.boolean(),
    postHog: z.boolean(),
  }),
  redactedConfig: DeploymentConfigSchema,
});
export type DeploymentReadinessReport = z.infer<typeof DeploymentReadinessReportSchema>;

export function parseDeploymentEnvironment(env: Record<string, unknown> = process.env): DeploymentConfig {
  const parsed = DeploymentEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid deployment environment: ${details}`);
  }

  const input = parsed.data;
  return DeploymentConfigSchema.parse({
    apiVersion: DEPLOYMENT_API_VERSION,
    target: input.DEPLOYMENT_TARGET,
    nodeEnv: input.NODE_ENV,
    port: input.PORT,
    publicAppUrl: input.PUBLIC_APP_URL,
    apiBaseUrl: input.API_BASE_URL,
    heroku: {
      appName: input.HEROKU_APP_NAME,
      releaseVersion: input.HEROKU_RELEASE_VERSION,
    },
    cloudflare: {
      accountId: input.CLOUDFLARE_ACCOUNT_ID,
      projectName: input.CLOUDFLARE_PROJECT_NAME,
      proxyEnabled: input.CLOUDFLARE_PROXY_ENABLED,
    },
    persistence: {
      mongoUri: input.MONGO_URI,
      mongoDb: input.MONGO_DB,
      redisUrl: input.REDIS_URL,
    },
    memory: {
      chromaUrl: input.CHROMA_URL,
      chromaApiKey: input.CHROMA_API_KEY,
    },
    telemetry: {
      sentryDsn: input.SENTRY_DSN,
      postHogApiKey: input.POSTHOG_API_KEY,
      postHogHost: input.POSTHOG_HOST,
    },
  });
}

export const buildDeploymentConfig = parseDeploymentEnvironment;

export function redactDeploymentConfig(configInput: DeploymentConfig): DeploymentConfig {
  const config = DeploymentConfigSchema.parse(configInput);
  const redacted = redactSecrets(config) as DeploymentConfig;

  redacted.persistence.mongoUri = redactCredentialUrl(config.persistence.mongoUri);
  redacted.persistence.redisUrl = redactCredentialUrl(config.persistence.redisUrl);
  if (config.memory.chromaApiKey) redacted.memory.chromaApiKey = REDACTED;
  if (config.telemetry.sentryDsn) redacted.telemetry.sentryDsn = REDACTED;
  if (config.telemetry.postHogApiKey) redacted.telemetry.postHogApiKey = REDACTED;

  return DeploymentConfigSchema.parse(redacted);
}

export function createDeploymentReadinessReport(configInput: DeploymentConfig): DeploymentReadinessReport {
  const config = DeploymentConfigSchema.parse(configInput);
  return DeploymentReadinessReportSchema.parse({
    apiVersion: DEPLOYMENT_API_VERSION,
    target: config.target,
    nodeEnv: config.nodeEnv,
    port: config.port,
    networkActions: 0,
    configuredServices: {
      heroku: Boolean(config.heroku.appName || config.target === "heroku"),
      cloudflare: Boolean(config.cloudflare.accountId || config.cloudflare.projectName || config.cloudflare.proxyEnabled || config.target === "cloudflare"),
      mongodb: Boolean(config.persistence.mongoUri),
      redis: Boolean(config.persistence.redisUrl),
      chroma: Boolean(config.memory.chromaUrl),
      sentry: Boolean(config.telemetry.sentryDsn),
      postHog: Boolean(config.telemetry.postHogApiKey || config.telemetry.postHogHost),
    },
    redactedConfig: redactDeploymentConfig(config),
  });
}

export interface CloseableServer {
  close(callback: (error?: Error) => void): void;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM" | string;

export interface ShutdownLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ShutdownProcessLike {
  on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  off?(eventName: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(eventName: string, listener: (...args: unknown[]) => void): unknown;
}

export interface GracefulShutdownResult {
  signal: ShutdownSignal;
  code: 0 | 1;
  timedOut: boolean;
  error?: Error;
}

export interface GracefulShutdownHandlerOptions {
  server: CloseableServer;
  signals?: ShutdownSignal[];
  timeoutMs?: number;
  logger?: ShutdownLogger;
  exit?: (code: 0 | 1) => void;
}

export interface GracefulShutdownHandler {
  isShuttingDown(): boolean;
  shutdown(signal?: ShutdownSignal): Promise<GracefulShutdownResult>;
  install(processLike?: ShutdownProcessLike): void;
  uninstall(): void;
}

export function createGracefulShutdownHandler(options: GracefulShutdownHandlerOptions): GracefulShutdownHandler {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: 0 | 1) => process.exit(code));
  const listeners = new Map<ShutdownSignal, (...args: unknown[]) => void>();
  let installedProcess: ShutdownProcessLike | undefined;
  let shutdownPromise: Promise<GracefulShutdownResult> | undefined;

  const shutdown = (signal: ShutdownSignal = "manual"): Promise<GracefulShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;

    logger.info(`Rector graceful shutdown started after ${signal}`);
    shutdownPromise = closeServerWithTimeout(options.server, timeoutMs)
      .then((result) => {
        const finalResult: GracefulShutdownResult = { signal, ...result };
        if (finalResult.error) {
          logger.error(`Rector graceful shutdown failed: ${finalResult.error.message}`);
        } else {
          logger.info("Rector graceful shutdown completed");
        }
        exit(finalResult.code);
        return finalResult;
      });

    return shutdownPromise;
  };

  return {
    isShuttingDown: () => shutdownPromise !== undefined,
    shutdown,
    install(processLike: ShutdownProcessLike = process): void {
      if (installedProcess) return;
      installedProcess = processLike;
      for (const signal of signals) {
        const listener = () => {
          void shutdown(signal);
        };
        listeners.set(signal, listener);
        processLike.on(signal, listener);
      }
    },
    uninstall(): void {
      if (!installedProcess) return;
      for (const [signal, listener] of listeners) {
        if (installedProcess.off) installedProcess.off(signal, listener);
        else installedProcess.removeListener?.(signal, listener);
      }
      listeners.clear();
      installedProcess = undefined;
    },
  };
}

function closeServerWithTimeout(server: CloseableServer, timeoutMs: number): Promise<Omit<GracefulShutdownResult, "signal">> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Omit<GracefulShutdownResult, "signal">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ code: 1, timedOut: true, error: new Error(`HTTP server close timed out after ${timeoutMs}ms`) });
    }, timeoutMs);

    server.close((error?: Error) => {
      if (error) {
        finish({ code: 1, timedOut: false, error });
        return;
      }
      finish({ code: 0, timedOut: false });
    });
  });
}

function redactCredentialUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]*@)/gi, (_match, scheme: string) => `${scheme}${REDACTED}@`);
}
