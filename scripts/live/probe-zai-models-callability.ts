/**
 * Minimal OpenAI-compatible chat probe per Z.ai matrix model id.
 * Opt-in: requires ZAI_API_KEY + ZAI_BASE_URL (or OPENAI_COMPATIBLE_* fallback).
 * Does not print or persist secret values.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getZaiLiveEvidenceDir } from "../../src/evidence";
import { sanitizeEvidenceStringLeaves } from "../../src/evidence/sanitize";
import { resolveZaiLiveEnvCoordinates } from "../../src/live/liveProviderDiscovery";
import { dedupeZaiModelsPreserveOrder, parseZaiModelsList } from "../../src/live/zaiModelMatrix";
import { redactString } from "../../src/security/redaction";

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

export interface ModelProbeRow {
  readonly modelId: string;
  readonly correctedModelId?: string;
  readonly classification: ModelProbeClassification;
  readonly httpStatus?: number;
  readonly latencyMs: number;
  readonly totalTokens?: number;
  readonly message: string;
}

export interface ModelProbeReport {
  readonly schemaVersion: typeof ZAI_MODEL_PROBE_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly baseUrlHost: string;
  readonly modelsProbed: number;
  readonly callable: number;
  readonly failed: number;
  readonly estimatedModelCalls: number;
  readonly rows: readonly ModelProbeRow[];
}

function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid-base-url";
  }
}

function classifyHttpFailure(status: number, bodyText: string): ModelProbeClassification {
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

async function probeOneModel(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
}): Promise<ModelProbeRow> {
  const started = Date.now();
  const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const latencyMs = Math.max(0, Date.now() - started);
    const rawText = await response.text();
    const safeMessage = redactString(rawText.slice(0, 2000));

    if (response.ok) {
      let totalTokens: number | undefined;
      try {
        const parsed = JSON.parse(rawText) as { usage?: { total_tokens?: number } };
        if (typeof parsed.usage?.total_tokens === "number") totalTokens = parsed.usage.total_tokens;
      } catch {
        // ignore parse for token rollup
      }
      return {
        modelId: input.modelId,
        classification: "callable",
        httpStatus: response.status,
        latencyMs,
        totalTokens,
        message: "chat completion succeeded",
      };
    }

    return {
      modelId: input.modelId,
      classification: classifyHttpFailure(response.status, safeMessage),
      httpStatus: response.status,
      latencyMs,
      message: safeMessage || `HTTP ${response.status}`,
    };
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - started);
    if (error instanceof Error && error.name === "AbortError") {
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
  } finally {
    clearTimeout(timer);
  }
}

export async function runZaiModelProbe(options: {
  readonly env?: Record<string, string | undefined>;
  readonly models?: readonly string[];
  readonly timeoutMs?: number;
  readonly write?: boolean;
  readonly repoRoot?: string;
} = {}): Promise<ModelProbeReport> {
  const env = options.env ?? process.env;
  const coords = resolveZaiLiveEnvCoordinates(env);
  const generatedAt = new Date().toISOString();

  if (!coords.apiKey || !coords.baseUrl) {
    const report: ModelProbeReport = {
      schemaVersion: ZAI_MODEL_PROBE_REPORT_SCHEMA,
      generatedAt,
      baseUrlHost: hostFromBaseUrl(coords.baseUrl || ""),
      modelsProbed: 0,
      callable: 0,
      failed: 0,
      estimatedModelCalls: 0,
      rows: [{
        modelId: "(none)",
        classification: "environment_missing",
        latencyMs: 0,
        message: "ZAI_API_KEY and ZAI_BASE_URL (or OPENAI_COMPATIBLE_* fallback) are required",
      }],
    };
    if (options.write !== false) await writeProbeReport(report, options.repoRoot);
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
    const row = await probeOneModel({ baseUrl: coords.baseUrl, apiKey: coords.apiKey, modelId, timeoutMs });
    estimatedModelCalls += 1;
    rows.push(row);
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
    rows,
  };

  if (options.write !== false) await writeProbeReport(report, options.repoRoot);
  return report;
}

async function writeProbeReport(report: ModelProbeReport, repoRoot?: string): Promise<void> {
  const dir = path.join(getZaiLiveEvidenceDir(repoRoot), "model-probe");
  await fs.mkdir(dir, { recursive: true });
  const sanitized = sanitizeEvidenceStringLeaves(report);
  const jsonPath = path.join(dir, "latest.json");
  const mdPath = path.join(dir, "latest.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");

  const lines = [
    "# Z.ai model callability probe",
    "",
    `- Schema: \`${report.schemaVersion}\``,
    `- Generated: ${report.generatedAt}`,
    `- Host: ${report.baseUrlHost}`,
    `- Models probed: ${report.modelsProbed}`,
    `- Callable: ${report.callable}`,
    `- Estimated model calls: ${report.estimatedModelCalls}`,
    "",
    "| Model | Status | HTTP | Tokens | Notes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const note = row.correctedModelId
      ? `${row.message} (use id: ${row.correctedModelId})`
      : row.message.slice(0, 120).replace(/\|/g, "\\|");
    lines.push(
      `| ${row.modelId} | ${row.classification} | ${row.httpStatus ?? ""} | ${row.totalTokens ?? ""} | ${note} |`,
    );
  }
  lines.push("");
  await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");
}

runZaiModelProbe()
    .then((report) => {
      const summary = {
        schemaVersion: report.schemaVersion,
        modelsProbed: report.modelsProbed,
        callable: report.callable,
        failed: report.failed,
        estimatedModelCalls: report.estimatedModelCalls,
        rows: report.rows.map((r) => ({
          modelId: r.modelId,
          correctedModelId: r.correctedModelId,
          classification: r.classification,
          httpStatus: r.httpStatus,
          totalTokens: r.totalTokens,
        })),
      };
      console.log(JSON.stringify(summary, null, 2));
      if (report.callable < report.modelsProbed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(redactString(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });