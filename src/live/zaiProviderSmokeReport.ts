import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getZaiLiveEvidenceDir, sanitizeEvidenceStringLeaves } from "../evidence";
import {
  ProviderError,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers";
import { redactString } from "../security/redaction";
import {
  isAcceptableLiveEvidenceProvider,
  isZaiCompatibleHost,
  type DiscoveredLiveProvider,
  type LiveProviderDiscoveryResult,
  type LiveProviderRejection,
} from "./liveProviderDiscovery";
import { discoverLiveProviderFromRepo } from "./repoLiveProviderDiscovery";

export const ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION = "rector.zai-provider-smoke.v1";

const SmokeTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict();

const SmokeErrorSchema = z
  .object({
    kind: z.enum(["provider_config", "provider_http", "provider_timeout", "provider_json", "provider_unknown"]),
    message: z.string().min(1),
    host: z.string().min(1).optional(),
    providerCode: z.string().min(1).optional(),
    status: z.number().int().positive().optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const ZaiProviderSmokeReportSchema = z
  .object({
    schemaVersion: z.literal(ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    status: z.enum(["passed", "failed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    skippedReason: z.string().min(1).optional(),
    providerId: z.string().min(1).nullable(),
    adapterId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    host: z.string().min(1).nullable(),
    tokenUsage: SmokeTokenUsageSchema,
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    error: SmokeErrorSchema.optional(),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type ZaiProviderSmokeReport = Readonly<z.infer<typeof ZaiProviderSmokeReportSchema>>;

export interface ZaiProviderSmokeOptions {
  readonly outputDir?: string;
  readonly repoRoot?: string;
  readonly write?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly providerDiscovery?: (env: Record<string, string | undefined>) => Promise<LiveProviderDiscoveryResult> | LiveProviderDiscoveryResult;
  readonly timeoutMs?: number;
  readonly mkdir?: typeof fs.mkdir;
  readonly writeFile?: typeof fs.writeFile;
}

const ZERO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0, modelCalls: 0 };
const REPORT_JSON = "provider-smoke.json";
const REPORT_MD = "provider-smoke.md";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function runZaiProviderSmoke(options: ZaiProviderSmokeOptions = {}): Promise<ZaiProviderSmokeReport> {
  const env = options.env ?? process.env;
  const outputDir = options.outputDir ?? getZaiLiveEvidenceDir(options.repoRoot);
  const write = options.write ?? true;
  const mkdir = options.mkdir ?? fs.mkdir;
  const writeFile = options.writeFile ?? fs.writeFile;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  if (env.RECTOR_ZAI_PROVIDER_SMOKE !== "1") {
    return writeReport(
      skippedReport(generatedAt, "RECTOR_ZAI_PROVIDER_SMOKE must equal 1; Z.ai provider smoke is opt-in."),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const discoveryWasInjected = options.providerDiscovery !== undefined;
  const discovery =
    options.providerDiscovery
    ?? ((currentEnv: Record<string, string | undefined>) => discoverLiveProviderFromRepo(options.repoRoot, currentEnv));
  const discovered = await discovery(env);
  const selected = discovered.selected;
  if (!selected) {
    if (discovered.rejections.length > 0) {
      return writeReport(
        failedReportFromRejection(generatedAt, discovered.rejections[0]),
        { outputDir, write, mkdir, writeFile },
      );
    }
    return writeReport(
      skippedReport(generatedAt, "No configured Z.ai OpenAI-compatible live provider was available."),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const liveEvidenceStatus = discoveryWasInjected || !selected.liveEvidence ? "test_only_injected" : "live_provider";
  const configError = validateSelectedProvider(selected);
  if (configError) {
    return writeReport(
      baseReport(generatedAt, "failed", liveEvidenceStatus, selected, ZERO_USAGE, 0, configError),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const started = Date.now();
  let response: LLMResponse | undefined;
  try {
    response = await invokeWithTimeout(selected, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - started);
    return writeReport(
      baseReport(generatedAt, "failed", liveEvidenceStatus, selected, ZERO_USAGE, latencyMs, classifyProviderError(error, selected.host)),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const latencyMs = Math.max(0, Date.now() - started);
  const jsonError = validateJsonContent(response.content, selected.host);
  if (jsonError) {
    return writeReport(
      baseReport(generatedAt, "failed", liveEvidenceStatus, selected, response.usage, latencyMs, jsonError),
      { outputDir, write, mkdir, writeFile },
    );
  }

  return writeReport(
    baseReport(generatedAt, "passed", liveEvidenceStatus, selected, response.usage, latencyMs),
    { outputDir, write, mkdir, writeFile },
  );
}

function buildSmokeRequest(selected: DiscoveredLiveProvider): LLMRequest {
  return {
    task: "zai-provider-smoke",
    route: "PROVIDER_SMOKE",
    modelRoute: "cheap",
    model: selected.modelId,
    maxOutputTokens: 64,
    temperature: 0,
    responseFormat: { type: "json_object" },
    metadata: { nonMutating: true, createdBy: "zai-provider-smoke" },
    messages: [
      { role: "system", content: "Return only a compact JSON object. Do not use Markdown." },
      { role: "user", content: "Return {\"ok\":true,\"provider\":\"zai\"}." },
    ],
  };
}

async function invokeWithTimeout(selected: DiscoveredLiveProvider, timeoutMs: number): Promise<LLMResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await selected.provider.invoke(buildSmokeRequest(selected), { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function validateSelectedProvider(selected: DiscoveredLiveProvider): z.infer<typeof SmokeErrorSchema> | undefined {
  if (selected.requestedProvider !== "zai" || selected.adapterId !== "openai-compatible" || selected.provider.metadata.id !== "openai-compatible") {
    return {
      kind: "provider_config",
      message: "Z.ai smoke requires an OpenAI-compatible provider selection.",
      host: selected.host,
    };
  }
  if (!isZaiCompatibleHost(selected.host)) {
    return {
      kind: "provider_config",
      message: "Z.ai smoke requires a Z.ai-compatible base URL host.",
      host: selected.host,
    };
  }
  if (!isAcceptableLiveEvidenceProvider({ provider: selected.provider, providerId: selected.providerId, displayName: selected.displayName })) {
    return {
      kind: "provider_config",
      message: "Provider identity is a deterministic, fake, spy, mock, fixture, scripted, or test-double provider.",
      host: selected.host,
    };
  }
  try {
    selected.provider.validateConfig();
    return undefined;
  } catch (error) {
    return {
      kind: "provider_config",
      message: safeMessage(error),
      host: selected.host,
      providerCode: error instanceof ProviderError ? error.code : undefined,
    };
  }
}

function classifyProviderError(error: unknown, host: string): z.infer<typeof SmokeErrorSchema> {
  if (error instanceof ProviderError) {
    if (error.code === "PROVIDER_HTTP_ERROR") {
      return {
        kind: "provider_http",
        message: safeMessage(error),
        host,
        providerCode: error.code,
        ...(error.status ? { status: error.status } : {}),
        retryable: error.retryable,
      };
    }
    if (error.code === "ABORTED") {
      return { kind: "provider_timeout", message: safeMessage(error), host, providerCode: error.code };
    }
    if (error.code === "CONFIG_INVALID" || error.code === "NETWORK_DISABLED") {
      return { kind: "provider_config", message: safeMessage(error), host, providerCode: error.code };
    }
    if (error.code === "PROVIDER_RESPONSE_INVALID") {
      return { kind: "provider_json", message: safeMessage(error), host, providerCode: error.code };
    }
    return { kind: "provider_unknown", message: safeMessage(error), host, providerCode: error.code };
  }
  if (isAbortLike(error)) {
    return { kind: "provider_timeout", message: safeMessage(error), host };
  }
  return { kind: "provider_unknown", message: safeMessage(error), host };
}

function validateJsonContent(content: string, host: string): z.infer<typeof SmokeErrorSchema> | undefined {
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "provider_json", message: "Provider smoke response was JSON but not an object.", host };
    }
    return undefined;
  } catch {
    return { kind: "provider_json", message: "Provider smoke response was not parseable JSON.", host };
  }
}

function failedReportFromRejection(generatedAt: string, rejection: LiveProviderRejection): ZaiProviderSmokeReport {
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "failed",
    liveEvidenceStatus: "skipped",
    providerId: null,
    adapterId: null,
    modelId: null,
    host: rejection.host ?? null,
    tokenUsage: tokenUsage(ZERO_USAGE),
    estimatedCostUsd: 0,
    latencyMs: 0,
    error: {
      kind: "provider_config",
      message: messageForRejection(rejection),
      ...(rejection.host ? { host: rejection.host } : {}),
    },
    notes: [
      "Z.ai smoke was explicitly enabled but provider discovery rejected the configuration.",
      "Only the host is recorded; API keys, auth headers, and base URL paths are not persisted.",
    ],
  });
}

function skippedReport(generatedAt: string, skippedReason: string): ZaiProviderSmokeReport {
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "skipped",
    liveEvidenceStatus: "skipped",
    skippedReason,
    providerId: null,
    adapterId: null,
    modelId: null,
    host: null,
    tokenUsage: tokenUsage(ZERO_USAGE),
    estimatedCostUsd: 0,
    latencyMs: 0,
    notes: [
      "Z.ai provider smoke did not run model calls.",
      "Set RECTOR_LIVE_PROVIDER=zai and RECTOR_ZAI_PROVIDER_SMOKE=1 with OpenAI-compatible Z.ai credentials to run it.",
    ],
  });
}

function baseReport(
  generatedAt: string,
  status: "passed" | "failed",
  liveEvidenceStatus: "live_provider" | "test_only_injected",
  selected: DiscoveredLiveProvider,
  usage: LLMUsage,
  latencyMs: number,
  error?: z.infer<typeof SmokeErrorSchema>,
): ZaiProviderSmokeReport {
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status,
    liveEvidenceStatus,
    providerId: selected.providerId,
    adapterId: selected.adapterId,
    modelId: selected.modelId,
    host: selected.host,
    tokenUsage: tokenUsage(usage),
    estimatedCostUsd: usage.estimatedUsd,
    latencyMs,
    ...(error ? { error } : {}),
    notes: [
      "Z.ai smoke performs one non-mutating JSON-only chat completion.",
      liveEvidenceStatus === "live_provider"
        ? "Provider was discovered from explicit live configuration and passed the test-double predicate."
        : "Provider was dependency-injected for contract tests and must not be counted as live verification.",
      "Report fields intentionally omit auth headers, API keys, and base URL paths.",
    ],
  });
}

async function writeReport(
  report: ZaiProviderSmokeReport,
  io: { readonly outputDir: string; readonly write: boolean; readonly mkdir: typeof fs.mkdir; readonly writeFile: typeof fs.writeFile },
): Promise<ZaiProviderSmokeReport> {
  const safeReport = ZaiProviderSmokeReportSchema.parse(sanitizeEvidenceStringLeaves(report));
  if (!io.write) return safeReport;
  await io.mkdir(io.outputDir, { recursive: true });
  await io.writeFile(path.join(io.outputDir, REPORT_JSON), `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
  await io.writeFile(path.join(io.outputDir, REPORT_MD), renderZaiProviderSmokeMarkdown(safeReport), "utf8");
  return safeReport;
}

export function renderZaiProviderSmokeMarkdown(report: ZaiProviderSmokeReport): string {
  const lines: string[] = [];
  lines.push("# Z.ai Provider Smoke", "");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Live evidence status: ${report.liveEvidenceStatus}`);
  if (report.skippedReason) lines.push(`- Skipped reason: ${safeMarkdown(report.skippedReason)}`);
  lines.push(`- Provider: ${safeMarkdown(report.providerId ?? "n/a")}`);
  lines.push(`- Adapter: ${safeMarkdown(report.adapterId ?? "n/a")}`);
  lines.push(`- Model: ${safeMarkdown(report.modelId ?? "n/a")}`);
  lines.push(`- Host: ${safeMarkdown(report.host ?? "n/a")}`);
  lines.push(`- Tokens: ${report.tokenUsage.totalTokens}`);
  lines.push(`- Cost USD: ${report.estimatedCostUsd.toFixed(6)}`);
  lines.push(`- Latency ms: ${report.latencyMs}`);
  if (report.error) {
    lines.push("", "## Error", "");
    lines.push(`- Kind: ${report.error.kind}`);
    lines.push(`- Message: ${safeMarkdown(report.error.message)}`);
    if (report.error.status) lines.push(`- HTTP status: ${report.error.status}`);
    if (report.error.retryable !== undefined) lines.push(`- Retryable: ${report.error.retryable}`);
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`> ${safeMarkdown(note)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function tokenUsage(usage: LLMUsage): z.infer<typeof SmokeTokenUsageSchema> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    modelCalls: usage.modelCalls,
  };
}

function messageForRejection(rejection: LiveProviderRejection): string {
  if (rejection.message) return redactString(rejection.message);
  if (rejection.reason === "zai_host_required") return "Z.ai live provider requires a Z.ai-compatible base URL host.";
  if (rejection.reason === "missing_env") return "Z.ai live provider requires OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL, and OPENAI_COMPATIBLE_MODEL.";
  if (rejection.reason === "runtime_not_configured") return "Runtime settings are not configured.";
  if (rejection.reason === "no_configured_zai_provider") return "No configured Z.ai OpenAI-compatible provider was found.";
  return `Z.ai live provider discovery failed: ${rejection.reason}`;
}

function safeMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

function safeMarkdown(value: string): string {
  return value.replace(/[|\n\r]/g, " ").slice(0, 240);
}
