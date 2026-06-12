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

import { performance } from "node:perf_hooks";
import request from "supertest";
import type express from "express";

export const PERFORMANCE_BASELINE_SECTIONS = [
  "startup_import",
  "local_direct_answer",
  "local_fake_pipeline",
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
  status: "ok" | "warn" | "fail";
}

const THRESHOLDS: Record<SectionId, Threshold> = {
  startup_import: { preferredMs: 1_000, acceptableMs: 2_000 },
  local_direct_answer: { preferredMs: 100, acceptableMs: 250 },
  local_fake_pipeline: { preferredMs: 500, acceptableMs: 1_000 },
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
  startup_import: "Server startup / import",
  local_direct_answer: "Local direct answer",
  local_fake_pipeline: "Local full fake pipeline",
  orchestration_assignment_resolution: "Orchestration assignment resolution",
  memory_role_resolution: "Memory role resolution",
  template_preview: "Template preview (local-free)",
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

async function measureStartupImport(): Promise<number> {
  return measureMedian(1, async () => {
    const serverMod = await import("../src/api/server");
    const { TaskManager } = await import("../src/thalamus/router");
    serverMod.createApp(new TaskManager());
  });
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

async function measureLocalFakePipeline(): Promise<number> {
  const { InMemoryRectorStore } = await import("../src/store/inMemoryRectorStore");
  const { runFakeChatRun } = await import("../src/orchestration/chatRunner");
  const { triageUserMessage } = await import("../src/orchestration/triage");
  const { createInMemoryObservabilityTrace } = await import("../src/observability");
  const { ContextPackSchema } = await import("../src/orchestration/contextBuilder");

  return measureMedian(3, async () => {
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
    const triage = triageUserMessage(BENCHMARK_PROMPT);
    const contextPack = ContextPackSchema.parse({
      id: "ctx-perf-pipeline",
      createdAt: FIXED_NOW,
      userIntentSummary: "What is Rector?",
      conversationRef: { id: conversation.id, title: conversation.title, workspaceId: conversation.workspaceId },
      messageRefs: [{ id: userMessage.id, role: "user", status: "created", createdAt: userMessage.createdAt }],
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
    await runFakeChatRun(store, {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      prompt: BENCHMARK_PROMPT,
      triage,
      contextPack,
      observability: createInMemoryObservabilityTrace({ provider: "local" }),
    });
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
  const { createInMemoryProviderConfigStore } = await import("../src/providers/configStore");
  const { createInMemoryMemoryConfigStore } = await import("../src/providers/memoryConfigStore");

  const router = new MemoryRoleRouter({
    assignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    configStore: createInMemoryMemoryConfigStore(),
    secrets: emptySecretStore(),
    mode: "local",
    now: () => FIXED_NOW,
  });
  const start = performance.now();
  for (const role of MEMORY_ROLES) {
    await router.resolveMemoryProvider(role, { mode: "local" });
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
    await service.preview("local-free");
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
  const exceeded = results.filter((result) => result.status !== "ok");

  console.log("# Rector performance baseline (local/provider-free)\n");
  console.log("| Section | ms | preferred | acceptable | status |");
  console.log("|---|---:|---:|---:|---|");
  for (const result of results) {
    console.log(
      `| ${result.label} (\`${result.id}\`) | ${formatMs(result.ms)} | <${result.threshold.preferredMs}ms | <${result.threshold.acceptableMs}ms | ${result.status} |`,
    );
  }

  console.log("");
  if (exceeded.length === 0) {
    console.log("All benchmarks within preferred thresholds.");
  } else {
    const warns = exceeded.filter((result) => result.status === "warn").length;
    const fails = exceeded.filter((result) => result.status === "fail").length;
    console.log(`Advisory threshold notes: ${warns} warn, ${fails} fail (enforce=${enforce}).`);
  }
  console.log(`Sections: ${PERFORMANCE_BASELINE_SECTIONS.join(", ")}`);
}

async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const app = await createBenchmarkApp();

  const measurements: Array<{ id: SectionId; ms: number }> = [
    { id: "startup_import", ms: await measureStartupImport() },
    { id: "local_direct_answer", ms: await measureLocalDirectAnswer() },
    { id: "local_fake_pipeline", ms: await measureLocalFakePipeline() },
    { id: "orchestration_assignment_resolution", ms: await measureOrchestrationAssignmentResolution() },
    { id: "memory_role_resolution", ms: await measureMemoryRoleResolution() },
    { id: "template_preview", ms: await measureTemplatePreview() },
    { id: "context_builder_1k", ms: await measureContextBuilder1k() },
    { id: "api_setup_status", ms: await measureApiRoute(app, "/api/setup/status") },
    { id: "api_orchestration_models_effective", ms: await measureApiRoute(app, "/api/orchestration-models/effective") },
    { id: "api_memory_assignments_effective", ms: await measureApiRoute(app, "/api/memory-assignments/effective") },
    { id: "api_templates", ms: await measureApiRoute(app, "/api/templates") },
  ];

  return measurements.map(({ id, ms }) => {
    const threshold = THRESHOLDS[id];
    return {
      id,
      label: LABELS[id],
      ms,
      threshold,
      status: classify(ms, threshold),
    };
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