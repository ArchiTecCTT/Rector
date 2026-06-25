#!/usr/bin/env tsx
/**
 * Local/provider-free performance baseline for Rector.
 *
 * Usage:
 *   npm run benchmark:performance
 *   npm run benchmark:performance -- --enforce
 *
 * Exits 0 by default even when advisory thresholds are exceeded.
 * Pass --enforce to fail on acceptable-threshold exceedance.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import request from "supertest";
import type express from "express";
import type { ChatRunArgs } from "../src/orchestration/chatRunner";
import type { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const COLD_START_PROBE = join(SCRIPT_DIR, "performance-baseline-cold-start.ts");
const COLD_START_COMPILED_PROBE = join(SCRIPT_DIR, "performance-baseline-cold-start-compiled.mjs");
const COMPILED_SERVER_ENTRY = join(REPO_ROOT, "dist/api/server.js");
const requireFromScript = createRequire(import.meta.url);
const TSX_CLI = join(dirname(requireFromScript.resolve("tsx/package.json")), "dist/cli.mjs");

export const PERFORMANCE_BASELINE_SECTIONS = [
  "startup_import",
  "startup_cold_subprocess",
  "startup_cold_compiled_subprocess",
  "local_direct_answer",
  "configured_spy_pipeline",
  "pipeline_triage",
  "pipeline_context_building",
  "pipeline_planning",
  "pipeline_executing",
  "pipeline_synthesizing",
  "orchestration_assignment_resolution",
  "memory_role_resolution",
  "template_preview",
  "context_builder_1k",
  "api_setup_status",
  "api_orchestration_models_effective",
  "api_memory_assignments_effective",
  "api_templates",
] as const;

type SectionId = (typeof PERFORMANCE_BASELINE_SECTIONS)[number];

interface Threshold {
  preferredMs: number;
  acceptableMs: number;
}

interface BenchmarkResult {
  id: SectionId;
  label: string;
  ms: number;
  threshold: Threshold;
  status: "ok" | "warn" | "fail" | "skip";
  skipReason?: string;
}

const THRESHOLDS: Record<SectionId, Threshold> = {
  startup_import: { preferredMs: 1_000, acceptableMs: 2_000 },
  startup_cold_subprocess: { preferredMs: 1_000, acceptableMs: 2_000 },
  startup_cold_compiled_subprocess: { preferredMs: 1_000, acceptableMs: 2_000 },
  local_direct_answer: { preferredMs: 100, acceptableMs: 250 },
  configured_spy_pipeline: { preferredMs: 500, acceptableMs: 1_000 },
  pipeline_triage: { preferredMs: 10, acceptableMs: 25 },
  pipeline_context_building: { preferredMs: 50, acceptableMs: 100 },
  pipeline_planning: { preferredMs: 50, acceptableMs: 150 },
  pipeline_executing: { preferredMs: 50, acceptableMs: 150 },
  pipeline_synthesizing: { preferredMs: 50, acceptableMs: 150 },
  orchestration_assignment_resolution: { preferredMs: 10, acceptableMs: 25 },
  memory_role_resolution: { preferredMs: 10, acceptableMs: 25 },
  template_preview: { preferredMs: 50, acceptableMs: 100 },
  context_builder_1k: { preferredMs: 100, acceptableMs: 250 },
  api_setup_status: { preferredMs: 100, acceptableMs: 250 },
  api_orchestration_models_effective: { preferredMs: 100, acceptableMs: 250 },
  api_memory_assignments_effective: { preferredMs: 100, acceptableMs: 250 },
  api_templates: { preferredMs: 100, acceptableMs: 250 },
};

const LABELS: Record<SectionId, string> = {
  startup_import: "Server startup / import (warm, in-process)",
  startup_cold_subprocess: "Server startup / import (cold subprocess, tsx)",
  startup_cold_compiled_subprocess: "Server startup / import (cold subprocess, compiled)",
  local_direct_answer: "Local direct answer",
  configured_spy_pipeline: "Configured spy pipeline (total)",
  pipeline_triage: "Pipeline phase: TRIAGE",
  pipeline_context_building: "Pipeline phase: CONTEXT_BUILDING",
  pipeline_planning: "Pipeline phase: PLANNING",
  pipeline_executing: "Pipeline phase: EXECUTING",
  pipeline_synthesizing: "Pipeline phase: SYNTHESIZING",
  orchestration_assignment_resolution: "Orchestration assignment resolution",
  memory_role_resolution: "Memory role resolution",
  template_preview: "Template preview (__test_profile__)",
  context_builder_1k: "Context builder (1K memories)",
  api_setup_status: "API GET /api/setup/status",
  api_orchestration_models_effective: "API GET /api/orchestration-models/effective",
  api_memory_assignments_effective: "API GET /api/memory-assignments/effective",
  api_templates: "API GET /api/templates",
};

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "GOOGLE_API_KEY",
  "MEM0_API_KEY",
  "CHROMA_URL",
  "CHROMA_API_KEY",
  "E2B_API_KEY",
] as const;

const BENCHMARK_PROMPT = "What is Rector?";
const FIXED_NOW = "2026-06-12T12:00:00.000Z";

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function measureMedian(iterations: number, fn: () => void | Promise<void>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function classify(ms: number, threshold: Threshold): BenchmarkResult["status"] {
  if (ms <= threshold.preferredMs) return "ok";
  if (ms <= threshold.acceptableMs) return "warn";
  return "fail";
}

function buildMemoryEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `mem-perf-${index}`,
    layer: "episodic" as const,
    content: `Benchmark memory note ${index} about Rector orchestration and context retrieval.`,
    timestamp: FIXED_NOW,
    lastMentioned: FIXED_NOW,
    accessCount: index % 10,
    tags: ["benchmark", `tag-${index % 20}`],
    metadata: {},
  }));
}

function emptySecretStore() {
  return {
    async setSecret() {
      return { ok: true as const, value: undefined };
    },
    async getSecret() {
      return { ok: false as const, error: "missing" };
    },
    async hasSecret() {
      return false;
    },
    async deleteSecret() {
      return { ok: true as const, value: undefined };
    },
  };
}

function providerFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function parseColdStartProbeMs(output: string): number {
  const match = output.match(/^RECTOR_PERF_MS=([0-9.]+)/m);
  if (!match) {
    throw new Error(`cold-start probe missing RECTOR_PERF_MS line: ${output.trim()}`);
  }
  return Number(match[1]);
}

async function measureStartupImport(): Promise<number> {
  return measureMedian(1, async () => {
    const serverMod = await import("../src/api/server");
    const { TaskManager } = await import("../src/thalamus/router");
    serverMod.createApp(new TaskManager());
  });
}

function runColdStartProbe(command: string, args: string[]): string {
  const output = execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: providerFreeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const probeMs = parseColdStartProbeMs(output);
  if (!Number.isFinite(probeMs) || probeMs <= 0) {
    throw new Error(`cold-start probe returned invalid ms: ${probeMs}`);
  }
  return output;
}

async function measureStartupColdSubprocess(): Promise<number> {
  return measureMedian(3, () => {
    runColdStartProbe(process.execPath, [TSX_CLI, COLD_START_PROBE]);
  });
}

async function measureStartupColdCompiledSubprocess(): Promise<BenchmarkResult> {
  if (!existsSync(COMPILED_SERVER_ENTRY)) {
    return {
      id: "startup_cold_compiled_subprocess",
      label: LABELS.startup_cold_compiled_subprocess,
      ms: 0,
      threshold: THRESHOLDS.startup_cold_compiled_subprocess,
      status: "skip",
      skipReason: "dist/api/server.js missing — run npm run build first",
    };
  }

  const ms = await measureMedian(3, () => {
    runColdStartProbe(process.execPath, [COLD_START_COMPILED_PROBE]);
  });

  const threshold = THRESHOLDS.startup_cold_compiled_subprocess;
  return {
    id: "startup_cold_compiled_subprocess",
    label: LABELS.startup_cold_compiled_subprocess,
    ms,
    threshold,
    status: classify(ms, threshold),
  };
}

interface FakePipelineRun {
  store: InMemoryRectorStore;
  args: ChatRunArgs;
  triageMs: number;
  contextMs: number;
}

async function buildFakePipelineRun(): Promise<FakePipelineRun> {
  const { InMemoryRectorStore } = await import("../src/store/inMemoryRectorStore");
  const { triageUserMessage } = await import("../src/orchestration/triage");
  const { buildContextPack } = await import("../src/orchestration/contextBuilder");
  const { createInMemoryObservabilityTrace } = await import("../src/observability");

  const store = new InMemoryRectorStore({ now: () => FIXED_NOW });
  const conversation = await store.createConversation({
    title: "perf pipeline",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: BENCHMARK_PROMPT,
    status: "created",
    redactionState: "none",
  });

  const triageStart = performance.now();
  const triage = triageUserMessage(BENCHMARK_PROMPT);
  const triageMs = performance.now() - triageStart;

  const contextStart = performance.now();
  const contextPack = await buildContextPack(store, {
    conversation,
    messages: [userMessage],
    userMessage,
    triage,
    now: () => FIXED_NOW,
  });
  const contextMs = performance.now() - contextStart;

  return {
    store,
    args: {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      prompt: BENCHMARK_PROMPT,
      triage,
      contextPack,
      observability: createInMemoryObservabilityTrace({ provider: "local" }),
    },
    triageMs,
    contextMs,
  };
}

function spanDurationMs(spans: Array<{ phase: string; durationMs: number }>, phase: string): number {
  const span = [...spans].reverse().find((candidate) => candidate.phase === phase);
  if (!span) {
    throw new Error(`missing observability span for phase ${phase}`);
  }
  return span.durationMs;
}

async function measurePipelinePhaseBreakdown(): Promise<
  Array<{ id: SectionId; ms: number }>
> {
  const { runFakeChatRun } = await import("../tests/support/fakeChatRun");
  const phaseIds = [
    "pipeline_triage",
    "pipeline_context_building",
    "pipeline_planning",
    "pipeline_executing",
    "pipeline_synthesizing",
  ] as const;
  const samples: Record<(typeof phaseIds)[number], number[]> = {
    pipeline_triage: [],
    pipeline_context_building: [],
    pipeline_planning: [],
    pipeline_executing: [],
    pipeline_synthesizing: [],
  };

  for (let i = 0; i < 3; i += 1) {
    const { store, args, triageMs, contextMs } = await buildFakePipelineRun();
    samples.pipeline_triage.push(triageMs);
    samples.pipeline_context_building.push(contextMs);
    await runFakeChatRun(store, args);
    const spans = args.observability.getSummary().spans;
    samples.pipeline_planning.push(spanDurationMs(spans, "PLANNING"));
    samples.pipeline_executing.push(spanDurationMs(spans, "EXECUTING"));
    samples.pipeline_synthesizing.push(spanDurationMs(spans, "SYNTHESIZING"));
  }

  return phaseIds.map((id) => ({ id, ms: median(samples[id]) }));
}

async function measureLocalDirectAnswer(): Promise<number> {
  const { triageUserMessage } = await import("../src/orchestration/triage");
  const { createFakePlan } = await import("../src/orchestration/planner");
  const { reviewPlanWithSkeptic } = await import("../src/orchestration/skeptic");
  const { arbitratePlanWithCrucible } = await import("../src/orchestration/crucible");
  const { synthesizeChatBrainstemResponse } = await import("../src/orchestration/synthesizer");
  const { ContextPackSchema } = await import("../src/orchestration/contextBuilder");

  return measureMedian(3, () => {
    const triage = triageUserMessage(BENCHMARK_PROMPT);
    const contextPack = ContextPackSchema.parse({
      id: "ctx-perf-direct",
      createdAt: FIXED_NOW,
      userIntentSummary: "What is Rector?",
      conversationRef: { id: "conv-perf", title: "perf", workspaceId: "local" },
      messageRefs: [{ id: "msg-perf", role: "user", status: "created", createdAt: FIXED_NOW }],
      relevantDocs: [],
      relevantMemory: [],
      constraints: [],
      availableProviders: { configured: [], unavailable: [], notes: [] },
      availableTools: { names: [], notes: [] },
      riskFlags: triage.riskFlags,
      triage,
      artifactHandles: [],
      inlineContext: [],
    });
    const plannerOutput = createFakePlan({ triage, contextPack, messageContent: BENCHMARK_PROMPT });
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({ plannerOutput, skepticReview });
    synthesizeChatBrainstemResponse({
      traceId: "perf-direct-answer",
      triage,
      contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    });
  });
}

async function measureConfiguredSpyPipeline(): Promise<number> {
  const { runFakeChatRun } = await import("../tests/support/fakeChatRun");
  return measureMedian(3, async () => {
    const { store, args } = await buildFakePipelineRun();
    await runFakeChatRun(store, args);
  });
}

async function measureOrchestrationAssignmentResolution(): Promise<number> {
  const { ORCHESTRATION_ROLES, resolveEffectiveAssignment } = await import("../src/providers/orchestrationAssignments");
  const start = performance.now();
  for (const role of ORCHESTRATION_ROLES) {
    resolveEffectiveAssignment({ role, assignments: [] });
  }
  return performance.now() - start;
}

async function measureMemoryRoleResolution(): Promise<number> {
  const { MEMORY_ROLES } = await import("../src/providers/memoryAssignments");
  const { MemoryRoleRouter } = await import("../src/providers/memoryRoleRouter");
  const { createInMemoryMemoryRoleAssignmentStore } = await import("../src/providers/memoryAssignmentStore");
  const { createInMemoryMemoryConfigStore } = await import("../src/providers/memoryConfigStore");

  const router = new MemoryRoleRouter({
    assignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    configStore: createInMemoryMemoryConfigStore(),
    secrets: emptySecretStore(),
    now: () => FIXED_NOW,
  });
  const start = performance.now();
  for (const role of MEMORY_ROLES) {
    await router.resolveMemoryProvider(role);
  }
  return performance.now() - start;
}

async function measureTemplatePreview(): Promise<number> {
  const { TemplateService } = await import("../src/templates/templateService");
  const { createInMemoryOrchestrationAssignmentStore } = await import("../src/providers/orchestrationAssignments");
  const { createInMemoryMemoryRoleAssignmentStore } = await import("../src/providers/memoryAssignmentStore");
  const { createInMemoryProviderConfigStore } = await import("../src/providers/configStore");
  const { createInMemoryMemoryConfigStore } = await import("../src/providers/memoryConfigStore");
  const { createInMemoryModuleConfigStore } = await import("../src/modules/moduleConfigStore");
  const { createInMemoryUserTemplateStore } = await import("../src/templates/templateService");

  const service = new TemplateService({
    orchestrationAssignmentStore: createInMemoryOrchestrationAssignmentStore(),
    memoryAssignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    providerConfigStore: createInMemoryProviderConfigStore(),
    memoryConfigStore: createInMemoryMemoryConfigStore(),
    secretStore: emptySecretStore(),
    moduleConfigStore: createInMemoryModuleConfigStore(),
    userTemplateStore: createInMemoryUserTemplateStore(),
    now: () => FIXED_NOW,
  });

  return measureMedian(3, async () => {
    await service.preview("__test_profile__");
  });
}

async function measureContextBuilder1k(): Promise<number> {
  const { InMemoryRectorStore } = await import("../src/store/inMemoryRectorStore");
  const { buildContextPack } = await import("../src/orchestration/contextBuilder");
  const { triageUserMessage } = await import("../src/orchestration/triage");

  const store = new InMemoryRectorStore({ now: () => FIXED_NOW });
  const conversation = await store.createConversation({
    title: "perf context",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: BENCHMARK_PROMPT,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(BENCHMARK_PROMPT);
  const memoryEntries = buildMemoryEntries(1_000);

  return measureMedian(3, async () => {
    await buildContextPack(store, {
      conversation,
      messages: [userMessage],
      userMessage,
      triage,
      memoryEntries,
      truthQuery: BENCHMARK_PROMPT,
      now: () => FIXED_NOW,
    });
  });
}

async function createBenchmarkApp(): Promise<express.Application> {
  const { createApp } = await import("../src/api/server");
  const { TaskManager } = await import("../src/thalamus/router");
  const { createInMemoryOrchestrationAssignmentStore } = await import("../src/providers/orchestrationAssignments");
  const { createInMemoryMemoryRoleAssignmentStore } = await import("../src/providers/memoryAssignmentStore");
  const { createInMemoryProviderConfigStore } = await import("../src/providers/configStore");
  const { createInMemoryMemoryConfigStore } = await import("../src/providers/memoryConfigStore");
  const { createInMemoryModuleConfigStore } = await import("../src/modules/moduleConfigStore");
  const { createInMemoryUserTemplateStore } = await import("../src/templates/templateService");

  return createApp(new TaskManager(), {
    secretStore: emptySecretStore(),
    providerConfigStore: createInMemoryProviderConfigStore(),
    memoryConfigStore: createInMemoryMemoryConfigStore(),
    moduleConfigStore: createInMemoryModuleConfigStore(),
    orchestrationAssignmentStore: createInMemoryOrchestrationAssignmentStore(),
    memoryRoleAssignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    userTemplateStore: createInMemoryUserTemplateStore(),
  });
}

async function measureApiRoute(app: express.Application, path: string): Promise<number> {
  return measureMedian(3, async () => {
    await request(app).get(path).expect(200);
  });
}

function formatMs(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms).toString();
}

function printReport(results: BenchmarkResult[], enforce: boolean): void {
  const exceeded = results.filter((result) => result.status === "warn" || result.status === "fail");

  console.log("# Rector performance baseline (local/provider-free)\n");
  console.log("| Section | ms | preferred | acceptable | status |");
  console.log("|---|---:|---:|---:|---|");
  for (const result of results) {
    const msCell = result.status === "skip" ? "skipped" : formatMs(result.ms);
    console.log(
      `| ${result.label} (\`${result.id}\`) | ${msCell} | <${result.threshold.preferredMs}ms | <${result.threshold.acceptableMs}ms | ${result.status} |`,
    );
  }

  console.log("");
  const skipped = results.filter((result) => result.status === "skip");
  if (skipped.length > 0) {
    for (const result of skipped) {
      console.log(`Skipped \`${result.id}\`: ${result.skipReason ?? "not available"}`);
    }
    console.log("");
  }
  if (exceeded.length === 0) {
    console.log("All measured benchmarks within preferred thresholds.");
  } else {
    const warns = exceeded.filter((result) => result.status === "warn").length;
    const fails = exceeded.filter((result) => result.status === "fail").length;
    console.log(`Advisory threshold notes: ${warns} warn, ${fails} fail (enforce=${enforce}).`);
  }
  console.log(`Sections: ${PERFORMANCE_BASELINE_SECTIONS.join(", ")}`);
}

function toBenchmarkResult(id: SectionId, ms: number): BenchmarkResult {
  const threshold = THRESHOLDS[id];
  return {
    id,
    label: LABELS[id],
    ms,
    threshold,
    status: classify(ms, threshold),
  };
}

async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const app = await createBenchmarkApp();
  const compiledColdStart = await measureStartupColdCompiledSubprocess();
  const pipelinePhases = await measurePipelinePhaseBreakdown();

  const measurements: Array<{ id: SectionId; ms: number } | BenchmarkResult> = [
    { id: "startup_import", ms: await measureStartupImport() },
    { id: "startup_cold_subprocess", ms: await measureStartupColdSubprocess() },
    compiledColdStart,
    { id: "local_direct_answer", ms: await measureLocalDirectAnswer() },
    { id: "configured_spy_pipeline", ms: await measureConfiguredSpyPipeline() },
    ...pipelinePhases,
    { id: "orchestration_assignment_resolution", ms: await measureOrchestrationAssignmentResolution() },
    { id: "memory_role_resolution", ms: await measureMemoryRoleResolution() },
    { id: "template_preview", ms: await measureTemplatePreview() },
    { id: "context_builder_1k", ms: await measureContextBuilder1k() },
    { id: "api_setup_status", ms: await measureApiRoute(app, "/api/setup/status") },
    { id: "api_orchestration_models_effective", ms: await measureApiRoute(app, "/api/orchestration-models/effective") },
    { id: "api_memory_assignments_effective", ms: await measureApiRoute(app, "/api/memory-assignments/effective") },
    { id: "api_templates", ms: await measureApiRoute(app, "/api/templates") },
  ];

  return measurements.map((entry) => {
    if ("status" in entry) return entry;
    return toBenchmarkResult(entry.id, entry.ms);
  });
}

async function main(): Promise<void> {
  const enforce = process.argv.includes("--enforce");
  clearProviderEnv();

  const results = await runBenchmarks();
  printReport(results, enforce);

  if (enforce && results.some((result) => result.status === "fail")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`performance baseline failed: ${message}`);
  process.exitCode = 1;
});