import fs from "node:fs/promises";
import path from "node:path";

import { getZaiLiveEvidenceDir, sanitizeEvidenceStringLeaves } from "../evidence";
import { resolveZaiLiveEnvCoordinates } from "./liveProviderDiscovery";
import { dedupeZaiModelsPreserveOrder, parseZaiModelsList } from "./zaiModelsEnv";
import { redactString } from "../security/redaction";

export const ZAI_MODEL_PROBE_REPORT_SCHEMA = "rector.zai-model-probe.v1";

export type ModelProbeClassification =
  | "callable"
  | "invalid_model_id"
  | "auth_failure"
  | "quota_or_rate_limit"
  | "provider_outage"
  | "timeout"
  | "request_rejected"
  | "environment_missing"
  | "unknown_failure";

export type ModelJsonCapability = "supported" | "unsupported" | "not_probed";

export interface ModelProbeRow {
  readonly modelId: string;
  readonly correctedModelId?: string;
  readonly classification: ModelProbeClassification;
  readonly httpStatus?: number;
  readonly latencyMs: number;
  readonly totalTokens?: number;
  readonly message: string;
  readonly jsonCapability?: ModelJsonCapability;
  readonly jsonCapabilityLatencyMs?: number;
  readonly jsonCapabilityHttpStatus?: number;
}

export interface ModelProbeReport {
  readonly schemaVersion: typeof ZAI_MODEL_PROBE_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly baseUrlHost: string;
  readonly modelsProbed: number;
  readonly callable: number;
  readonly failed: number;
  readonly estimatedModelCalls: number;
  readonly jsonCapabilityProbed: boolean;
  readonly rows: readonly ModelProbeRow[];
}

export type ZaiModelProbeFetch = typeof fetch;

function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid-base-url";
  }
}

export function classifyZaiProbeHttpFailure(status: number, bodyText: string): ModelProbeClassification {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "quota_or_rate_limit";
  if (status >= 500) return "provider_outage";
  if (
    status === 400
    || status === 404
    || /model.*(not found|does not exist|invalid|unknown|unavailable)/i.test(bodyText)
    || /invalid.*model/i.test(lower)
    || /model_not_found/i.test(lower)
  ) {
    return "invalid_model_id";
  }
  if (status === 402 || /quota|balance|insufficient/i.test(lower)) return "quota_or_rate_limit";
  return "request_rejected";
}

function parseTotalTokens(rawText: string): number | undefined {
  try {
    const parsed = JSON.parse(rawText) as { usage?: { total_tokens?: number } };
    if (typeof parsed.usage?.total_tokens === "number") return parsed.usage.total_tokens;
  } catch {
    // ignore
  }
  return undefined;
}

function extractAssistantContent(rawText: string): string | undefined {
  try {
    const parsed = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function contentLooksLikeJsonObject(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

async function postChatCompletion(input: {
  readonly fetchImpl: ZaiModelProbeFetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly body: Record<string, unknown>;
}): Promise<{ readonly ok: boolean; readonly status: number; readonly rawText: string; readonly latencyMs: number }> {
  const started = Date.now();
  const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  timer.unref?.();

  try {
    const response = await input.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Date.now() - started);
    const rawText = await response.text();
    return { ok: response.ok, status: response.status, rawText, latencyMs };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error("timeout"), { code: "timeout" as const });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeZaiModelCallability(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: ZaiModelProbeFetch;
}): Promise<ModelProbeRow> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const started = Date.now();

  try {
    const result = await postChatCompletion({
      fetchImpl,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      timeoutMs: input.timeoutMs,
      body: {
        model: input.modelId,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 4,
        temperature: 0,
      },
    });

    const safeMessage = redactString(result.rawText.slice(0, 2000));

    if (result.ok) {
      return {
        modelId: input.modelId,
        classification: "callable",
        httpStatus: result.status,
        latencyMs: result.latencyMs,
        totalTokens: parseTotalTokens(result.rawText),
        message: "chat completion succeeded",
      };
    }

    return {
      modelId: input.modelId,
      classification: classifyZaiProbeHttpFailure(result.status, safeMessage),
      httpStatus: result.status,
      latencyMs: result.latencyMs,
      message: safeMessage || `HTTP ${result.status}`,
    };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - started);
    if (error instanceof Error && (error.message === "timeout" || error.name === "AbortError")) {
      return {
        modelId: input.modelId,
        classification: "timeout",
        latencyMs,
        message: "request timed out",
      };
    }
    const message = redactString(error instanceof Error ? error.message : String(error));
    return {
      modelId: input.modelId,
      classification: "unknown_failure",
      latencyMs,
      message,
    };
  }
}

export async function probeZaiModelJsonCapability(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: ZaiModelProbeFetch;
}): Promise<Pick<ModelProbeRow, "jsonCapability" | "jsonCapabilityLatencyMs" | "jsonCapabilityHttpStatus">> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const started = Date.now();

  try {
    const result = await postChatCompletion({
      fetchImpl,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      timeoutMs: input.timeoutMs,
      body: {
        model: input.modelId,
        messages: [{ role: "user", content: 'Return JSON only: {"ok":true}' }],
        max_tokens: 16,
        temperature: 0,
        response_format: { type: "json_object" },
      },
    });

    const latencyMs = Math.max(0, Date.now() - started);
    if (!result.ok) {
      return {
        jsonCapability: "unsupported",
        jsonCapabilityLatencyMs: latencyMs,
        jsonCapabilityHttpStatus: result.status,
      };
    }

    const content = extractAssistantContent(result.rawText);
    if (content && contentLooksLikeJsonObject(content)) {
      return {
        jsonCapability: "supported",
        jsonCapabilityLatencyMs: latencyMs,
        jsonCapabilityHttpStatus: result.status,
      };
    }

    return {
      jsonCapability: "unsupported",
      jsonCapabilityLatencyMs: latencyMs,
      jsonCapabilityHttpStatus: result.status,
    };
  } catch {
    const latencyMs = Math.max(0, Date.now() - started);
    return {
      jsonCapability: "unsupported",
      jsonCapabilityLatencyMs: latencyMs,
    };
  }
}

export function resolveZaiModelProbeJsonCapability(env: Record<string, string | undefined> = process.env): boolean {
  return truthyEnv(env.ZAI_MATRIX_PROBE_JSON) || truthyEnv(env.ZAI_MODEL_PROBE_JSON);
}

export async function runZaiModelProbe(options: {
  readonly env?: Record<string, string | undefined>;
  readonly models?: readonly string[];
  readonly timeoutMs?: number;
  readonly write?: boolean;
  readonly repoRoot?: string;
  readonly probeJsonCapability?: boolean;
  readonly fetchImpl?: ZaiModelProbeFetch;
} = {}): Promise<ModelProbeReport> {
  const env = options.env ?? process.env;
  const coords = resolveZaiLiveEnvCoordinates(env);
  const generatedAt = new Date().toISOString();
  const probeJsonCapability = options.probeJsonCapability ?? resolveZaiModelProbeJsonCapability(env);

  if (!coords.apiKey || !coords.baseUrl) {
    const report: ModelProbeReport = {
      schemaVersion: ZAI_MODEL_PROBE_REPORT_SCHEMA,
      generatedAt,
      baseUrlHost: hostFromBaseUrl(coords.baseUrl || ""),
      modelsProbed: 0,
      callable: 0,
      failed: 0,
      estimatedModelCalls: 0,
      jsonCapabilityProbed: false,
      rows: [{
        modelId: "(none)",
        classification: "environment_missing",
        latencyMs: 0,
        message: "ZAI_API_KEY and ZAI_BASE_URL (or OPENAI_COMPATIBLE_* fallback) are required",
        jsonCapability: "not_probed",
      }],
    };
    if (options.write !== false) await writeZaiModelProbeReport(report, options.repoRoot);
    return report;
  }

  const fromEnv = dedupeZaiModelsPreserveOrder(parseZaiModelsList(env.ZAI_MODELS));
  const models = options.models?.length
    ? [...options.models]
    : fromEnv.length > 0
      ? fromEnv
      : coords.model
        ? [coords.model]
        : [];

  const timeoutMs = options.timeoutMs ?? 45_000;
  const rows: ModelProbeRow[] = [];
  let estimatedModelCalls = 0;

  for (const modelId of models) {
    const row = await probeZaiModelCallability({
      baseUrl: coords.baseUrl,
      apiKey: coords.apiKey,
      modelId,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    estimatedModelCalls += 1;

    let jsonFields: Pick<ModelProbeRow, "jsonCapability" | "jsonCapabilityLatencyMs" | "jsonCapabilityHttpStatus"> = {
      jsonCapability: "not_probed",
    };

    if (probeJsonCapability && row.classification === "callable") {
      jsonFields = await probeZaiModelJsonCapability({
        baseUrl: coords.baseUrl,
        apiKey: coords.apiKey,
        modelId,
        timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      estimatedModelCalls += 1;
    }

    rows.push({ ...row, ...jsonFields });
  }

  const callable = rows.filter((r) => r.classification === "callable").length;
  const report: ModelProbeReport = {
    schemaVersion: ZAI_MODEL_PROBE_REPORT_SCHEMA,
    generatedAt,
    baseUrlHost: hostFromBaseUrl(coords.baseUrl),
    modelsProbed: models.length,
    callable,
    failed: models.length - callable,
    estimatedModelCalls,
    jsonCapabilityProbed: probeJsonCapability,
    rows,
  };

  if (options.write !== false) await writeZaiModelProbeReport(report, options.repoRoot);
  return report;
}

export function callableModelsFromProbeReport(report: ModelProbeReport): string[] {
  return report.rows
    .filter((row) => row.classification === "callable")
    .map((row) => row.modelId);
}

export async function writeZaiModelProbeReport(report: ModelProbeReport, repoRoot?: string): Promise<void> {
  const dir = path.join(getZaiLiveEvidenceDir(repoRoot), "model-probe");
  await fs.mkdir(dir, { recursive: true });
  const sanitized = sanitizeEvidenceStringLeaves(report);
  const jsonPath = path.join(dir, "latest.json");
  const mdPath = path.join(dir, "latest.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, formatZaiModelProbeMarkdown(sanitized), "utf8");
}

export function formatZaiModelProbeMarkdown(report: ModelProbeReport): string {
  const lines = [
    "# Z.ai model callability probe",
    "",
    `- Schema: \`${report.schemaVersion}\``,
    `- Generated: ${report.generatedAt}`,
    `- Host: ${report.baseUrlHost}`,
    `- Models probed: ${report.modelsProbed}`,
    `- Callable: ${report.callable}`,
    `- Estimated model calls: ${report.estimatedModelCalls}`,
    `- JSON capability probed: ${report.jsonCapabilityProbed ? "yes" : "no"}`,
    "",
    "| Model | Status | HTTP | Tokens | JSON | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const note = row.correctedModelId
      ? `${row.message} (use id: ${row.correctedModelId})`
      : row.message.slice(0, 120).replace(/\|/g, "\\|");
    lines.push(
      `| ${row.modelId} | ${row.classification} | ${row.httpStatus ?? ""} | ${row.totalTokens ?? ""} | ${row.jsonCapability ?? ""} | ${note} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function truthyEnv(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}