import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT } from "../../src/evidence";
import { runOrchestratedChatRun, type ChatRunResult } from "../../src/orchestration/chatRunner";
import {
  ProviderCapabilityMetadataSchema,
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../../src/providers/llm";
import type { RectorStore } from "../../src/store";
import type { Run } from "../../src/store/schemas";
import type { ChatRunnerDeps, ChatRunArgs } from "../../src/orchestration/chatRunner";
import type { DiscoveredLiveProvider } from "../../src/live/liveProviderDiscovery";
import {
  DEFAULT_ZAI_HARNESS_CHAT_RUNNER,
  ZAI_HARNESS_REPORT_SCHEMA_VERSION,
  ZaiHarnessReportSchema,
  runZaiHarnessSmoke,
} from "../../src/live/zaiHarnessReport";
import { zaiHarnessScenarios } from "../../src/live/harnessScenarios";
import { computeSourceWorkspaceManifest, diffWorkspaceManifests } from "../../src/live/harnessEvidence";

const GENERATED_AT = "2026-06-30T00:00:00.000Z";
const RUN_ID = "zai-harness-contract";
const SECRET = "sk-zai-contract-secret-1234567890";
const BASE_USAGE: LLMUsage = {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20,
  estimatedUsd: 0.00002,
  modelCalls: 1,
};

describe("Z.ai harness smoke runner", () => {
  it("is opt-in and skips without discovery, runner, or model calls", async () => {
    const workspace = await tempWorkspace();
    const provider = new HarnessProvider();
    let discoveryCalls = 0;
    let runnerCalls = 0;
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: { RECTOR_LIVE_PROVIDER: "zai" },
        now: fixedNow,
        providerDiscovery: async () => {
          discoveryCalls += 1;
          return { selected: discovered(provider), rejections: [] };
        },
        runner: async () => {
          runnerCalls += 1;
          throw new Error("runner should not be called");
        },
      });

      expect(report.status).toBe("skipped");
      expect(report.skippedReason).toContain("LIVE_HARNESS_EVALS");
      expect(discoveryCalls).toBe(0);
      expect(runnerCalls).toBe(0);
      expect(provider.requests).toHaveLength(0);
      expect(report.scenarios.every((scenario) => scenario.failures.length === 0)).toBe(true);
      expect(report.failures).toHaveLength(0);
      expect(await readJson(workspace, "latest.json")).toMatchObject({
        schemaVersion: ZAI_HARNESS_REPORT_SCHEMA_VERSION,
        status: "skipped",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("writes sanitized run artifacts and routes scenarios through the injected orchestration seam", async () => {
    const workspace = await tempWorkspace();
    const provider = new HarnessProvider();
    const calls: Array<{ args: ChatRunArgs; deps: ChatRunnerDeps }> = [];
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: { LIVE_HARNESS_EVALS: "1", RECTOR_LIVE_PROVIDER: "zai", OPENAI_COMPATIBLE_API_KEY: SECRET },
        now: fixedNow,
        scenarios: [zaiHarnessScenarios()[0]],
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
        runner: async (store, args, deps) => {
          calls.push({ args, deps });
          return createMinimalRunResult(store, args, deps);
        },
      });

      expect(report).toMatchObject({
        schemaVersion: ZAI_HARNESS_REPORT_SCHEMA_VERSION,
        status: "passed",
        liveEvidenceStatus: "test_only_injected",
        providerId: "zai:contract",
        host: "api.z.ai",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].args.options?.maxRuntimeMs).toBe(120_000);
      expect(calls[0].deps.sandboxConfigured).toBe(false);
      expect(calls[0].deps.router.select({ capability: "cheap" }).provider.metadata.id).toBe(provider.metadata.id);

      for (const relativePath of [
        "runs/zai-harness-contract/harness-report.json",
        "runs/zai-harness-contract/harness-report.md",
        "runs/zai-harness-contract/run-events.jsonl",
        "runs/zai-harness-contract/fact-ledger.jsonl",
        "runs/zai-harness-contract/provider-calls.json",
        "runs/zai-harness-contract/token-usage.json",
        "runs/zai-harness-contract/cost-report.json",
        "runs/zai-harness-contract/redacted-prompts.json",
        "runs/zai-harness-contract/redacted-model-outputs.json",
        "runs/zai-harness-contract/workspace-before-manifest.json",
        "runs/zai-harness-contract/workspace-after-manifest.json",
        "runs/zai-harness-contract/scorecard.json",
        "runs/zai-harness-contract/scorecard.md",
        "latest.json",
        "latest.md",
        "index.json",
      ]) {
        await expect(readJsonOrText(workspace, relativePath)).resolves.toBeDefined();
      }

      const serializedRunDir = await readRunArtifact(workspace, "harness-report.json");
      expect(serializedRunDir).not.toContain(SECRET);
      expect(serializedRunDir).not.toContain("Authorization");
      expect(serializedRunDir).not.toContain("Bearer ");
      expect(serializedRunDir).not.toContain("OPENAI_COMPATIBLE_API_KEY");
      expect(serializedRunDir).not.toContain("ZAI_API_KEY");
      const parsed = ZaiHarnessReportSchema.parse(JSON.parse(serializedRunDir));
      expect(parsed.scorecard.passed).toBe(true);
      expect(parsed.tokenUsage.total.totalTokens).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies source workspace mutation in read-only scenarios", async () => {
    const workspace = await tempWorkspace();
    const sourceFile = path.join(workspace, "src", "index.ts");
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: { LIVE_HARNESS_EVALS: "1", RECTOR_LIVE_PROVIDER: "zai" },
        now: fixedNow,
        scenarios: [zaiHarnessScenarios()[0]],
        providerDiscovery: async () => ({ selected: discovered(new HarnessProvider()), rejections: [] }),
        runner: async (store, args, deps) => {
          await writeFile(sourceFile, "export const changed = true;\n", "utf8");
          return createMinimalRunResult(store, args, deps);
        },
      });

      expect(report.status).toBe("failed");
      expect(report.scenarios[0].failures).toContainEqual(expect.objectContaining({
        kind: "unsafe_unexpected_mutation",
      }));
      expect(report.scenarios[0].workspaceMutation.mutatedPaths).toContain("src/index.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies token budget before calling the runner when estimates exceed the campaign limit", async () => {
    const workspace = await tempWorkspace();
    let runnerCalls = 0;
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: { LIVE_HARNESS_EVALS: "1", RECTOR_LIVE_PROVIDER: "zai" },
        now: fixedNow,
        scenarios: [zaiHarnessScenarios()[0]],
        campaignTokenLimit: 10,
        providerDiscovery: async () => ({
          selected: discovered(new HarnessProvider({
            inputTokens: 6,
            outputTokens: 6,
            totalTokens: 12,
            estimatedUsd: 0.000012,
            modelCalls: 1,
          })),
          rejections: [],
        }),
        runner: async () => {
          runnerCalls += 1;
          throw new Error("runner should not be called after budget denial");
        },
      });

      expect(runnerCalls).toBe(0);
      expect(report.status).toBe("failed");
      expect(report.scenarios[0].status).toBe("failed");
      expect(report.scenarios[0].failures).toContainEqual(expect.objectContaining({ kind: "token_budget" }));
      expect(report.tokenUsage.limits.maxTotalTokens).toBe(10);
      expect(report.tokenUsage.limits.maxTotalTokens).toBeLessThan(DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("excludes runtime and dependency directories from source workspace mutation manifests", async () => {
    const workspace = await tempWorkspace();
    try {
      const before = await computeSourceWorkspaceManifest(workspace, { generatedAt: GENERATED_AT });
      await writeFile(path.join(workspace, ".rector", "ignored", "runtime.json"), "changed\n", "utf8");
      await writeFile(path.join(workspace, "node_modules", "ignored", "dep.js"), "changed\n", "utf8");
      await mkdir(path.join(workspace, ".omo", "evidence"), { recursive: true });
      await writeFile(path.join(workspace, ".omo", "evidence", "legacy.json"), "changed\n", "utf8");
      await mkdir(path.join(workspace, "dist"), { recursive: true });
      await writeFile(path.join(workspace, "dist", "bundle.js"), "changed\n", "utf8");
      await mkdir(path.join(workspace, "tmp"), { recursive: true });
      await writeFile(path.join(workspace, "tmp", "scratch.txt"), "changed\n", "utf8");

      const afterIgnored = await computeSourceWorkspaceManifest(workspace, { generatedAt: GENERATED_AT });
      expect(diffWorkspaceManifests(before, afterIgnored).mutationDetected).toBe(false);

      await writeFile(path.join(workspace, "src", "index.ts"), "export const changed = true;\n", "utf8");
      const afterSourceChange = await computeSourceWorkspaceManifest(workspace, { generatedAt: GENERATED_AT });
      expect(diffWorkspaceManifests(before, afterSourceChange)).toMatchObject({
        mutationDetected: true,
        changed: ["src/index.ts"],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the default harness runner wired to runOrchestratedChatRun", () => {
    expect(DEFAULT_ZAI_HARNESS_CHAT_RUNNER).toBe(runOrchestratedChatRun);
  });

  it("applies RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS to chat run options and diagnostics", async () => {
    const workspace = await tempWorkspace();
    const calls: Array<{ args: ChatRunArgs }> = [];
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: {
          LIVE_HARNESS_EVALS: "1",
          RECTOR_LIVE_PROVIDER: "zai",
          RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS: "240000",
        },
        now: fixedNow,
        scenarios: [zaiHarnessScenarios()[0]],
        providerDiscovery: async () => ({ selected: discovered(new HarnessProvider()), rejections: [] }),
        runner: async (store, args, deps) => {
          calls.push({ args });
          return createMinimalRunResult(store, args, deps);
        },
      });
      expect(calls[0]?.args.options?.maxRuntimeMs).toBe(240_000);
      expect(report.diagnostics.harnessMaxRuntimeMs).toBe(240_000);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies provider rate limits with diagnostics taxonomy metadata", async () => {
    const workspace = await tempWorkspace();
    try {
      const report = await runZaiHarnessSmoke({
        repoRoot: workspace,
        runId: RUN_ID,
        env: { LIVE_HARNESS_EVALS: "1", RECTOR_LIVE_PROVIDER: "zai" },
        now: fixedNow,
        scenarios: [zaiHarnessScenarios()[0]],
        providerDiscovery: async () => ({ selected: discovered(new HarnessProvider()), rejections: [] }),
        runner: async () => {
          throw new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "openai-compatible",
            status: 429,
            retryable: true,
            message: "OpenAI-Compatible request failed with HTTP 429",
          });
        },
      });

      expect(report.status).toBe("failed");
      expect(report.scenarios[0].failures).toContainEqual(expect.objectContaining({
        kind: "rate_limit",
        taxonomy: "rate_limit",
        status: 429,
        retryable: true,
      }));
      expect(report.diagnostics.failureTaxonomy.rate_limit).toBeGreaterThan(0);
      expect(report.diagnostics.latencyMs.scenarios.count).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

class HarnessProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "openai-compatible",
    displayName: "OpenAI-Compatible",
    routes: ["cheap"],
    models: { cheap: "glm-4.5-air" },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 16_000,
    estimatedUsdPer1kInputTokens: 0.001,
    estimatedUsdPer1kOutputTokens: 0.001,
  });

  readonly requests: LLMRequest[] = [];

  constructor(private readonly usage: LLMUsage = BASE_USAGE) {}

  validateConfig(): void {
    return undefined;
  }

  estimateRequest(): LLMUsage {
    return this.usage;
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      provider: this.metadata.id,
      model: request.model ?? this.metadata.models.cheap,
      content: "{\"ok\":true}",
      finishReason: "stop",
      usage: this.usage,
    };
  }
}

function discovered(provider: LLMProvider): DiscoveredLiveProvider {
  return {
    requestedProvider: "zai",
    provider,
    providerId: "zai:contract",
    adapterId: "openai-compatible",
    displayName: "OpenAI-Compatible",
    modelId: "glm-4.5-air",
    route: "cheap",
    host: "api.z.ai",
    source: "env",
    liveEvidence: false,
    discoveryLabel: "contract-test",
  };
}

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rector-zai-harness-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await mkdir(path.join(root, ".rector", "ignored"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const unchanged = true;\n", "utf8");
  await writeFile(path.join(root, "node_modules", "ignored", "dep.js"), "ignored\n", "utf8");
  return root;
}

async function createMinimalRunResult(
  store: RectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps,
): Promise<ChatRunResult> {
  const run = await store.createRun({
    conversationId: args.conversationId,
    userMessageId: args.userMessageId,
    status: "completed",
    phase: "DONE",
    route: args.triage.route,
    complexity: args.triage.complexity,
    budget: {
      maxUsd: 1,
      maxInputTokens: 100_000,
      maxOutputTokens: 100_000,
      maxModelCalls: 100,
      maxRuntimeMs: 60_000,
      maxHealingAttempts: 0,
      allowedProviders: ["openai-compatible"],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0, modelCalls: 0, provider: "openai-compatible" },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId: args.observability.traceId,
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
  });
  await store.appendEvent({
    id: `${run.id}-completed`,
    runId: run.id,
    type: "RUN_COMPLETED",
    phase: "DONE",
    payload: { source: "contract-test" },
    traceId: args.observability.traceId,
    redactionState: "redacted",
    createdAt: deps.now?.() ?? GENERATED_AT,
  });
  return {
    run: run as Run,
    synthesis: {
      status: "DONE",
      route: args.triage.route,
      traceId: args.observability.traceId,
      evidence: ["contract test runner"],
      providerCalls: 0,
      observability: args.observability.getSummary(),
      response: "contract test response",
    },
    observabilitySummary: args.observability.getSummary(),
  };
}

async function readRunArtifact(workspace: string, name: string): Promise<string> {
  return readFile(path.join(workspace, ".rector", "evidence", "live", "zai", "runs", RUN_ID, name), "utf8");
}

async function readJson(workspace: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(workspace, ".rector", "evidence", "live", "zai", name), "utf8"));
}

async function readJsonOrText(workspace: string, relativePath: string): Promise<unknown> {
  const content = await readFile(path.join(workspace, ".rector", "evidence", "live", "zai", relativePath), "utf8");
  return relativePath.endsWith(".json") ? JSON.parse(content) : content;
}

function fixedNow(): Date {
  return new Date(GENERATED_AT);
}
