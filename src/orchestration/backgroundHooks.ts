import type { MemoryProvider } from "../memory/provider";
import type { ModelRouter } from "../providers/llm";
import type { OrchestratorMode } from "../deployment";
import type { RectorStore } from "../store";
import type { Run } from "../store/schemas";
import { createDecisionRequest } from "./runStateMachine";
import {
  detectContradictions,
  PonderTriggerPolicy,
  ponderLessonInputHash,
  runPonderSwarm,
  type ContradictionSignal,
  type PonderTrigger,
} from "./ponderSwarm";
import { redactString } from "../security/redaction";

export interface NeuroBackgroundHooks {
  onRunCompleted(run: Run): void;
  startIdleTimer(): void;
  stop(): void;
}

/**
 * Background neuro-symbolic hooks (Chunk 042c).
 * External-mode only, bounded by {@link PonderTriggerPolicy}, and never throws
 * past the boundary. Local/provider-free mode remains inert.
 */
export function createNeuroBackgroundHooks(deps: {
  getMemoryProvider: () => Promise<MemoryProvider>;
  router?: ModelRouter;
  mode: OrchestratorMode;
  store: RectorStore;
  ponderPolicy?: PonderTriggerPolicy;
  ponderRunFactory?: (completedRun?: Run) => Run;
  now?: () => string;
}): NeuroBackgroundHooks {
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let runningReflection = false;
  const policy = deps.ponderPolicy ?? new PonderTriggerPolicy();
  const now = deps.now ?? (() => new Date().toISOString());

  const runBackgroundReflection = async (trigger: PonderTrigger, completedRun?: Run): Promise<void> => {
    if (deps.mode !== "external") return;
    if (runningReflection) return;
    runningReflection = true;
    try {
      const memoryProvider = await deps.getMemoryProvider();
      const episodic = await memoryProvider.searchMemory(undefined, { layer: "episodic", limit: 10 });
      const allEntries = await memoryProvider.listMemoryEntries();
      const contradictions = detectContradictions(allEntries);

      const decision = policy.shouldRun({
        trigger,
        episodicEntries: episodic,
        contradictionSignals: contradictions,
        completedRun,
      });

      if (decision.shouldRun && deps.router) {
        const ponderRun = deps.ponderRunFactory?.(completedRun) ?? createPonderRun(completedRun, now);
        const selection = deps.router.select({ capability: "cheap", task: "ponder", run: ponderRun });
        const existingLessons = allEntries.filter(
          (entry) => entry.layer === "core" && entry.tags.includes("ponder-lesson"),
        );
        const lessons = await runPonderSwarm(episodic, { provider: selection.provider, run: ponderRun }, {
          existingLessons,
          trigger,
          now,
        });
        policy.recordRun();

        for (const item of lessons) {
          await memoryProvider.createMemoryEntry({
            layer: "core",
            content: redactString(item.lesson),
            timestamp: now(),
            tags: ["ponder-lesson"],
            source: "ponder-swarm",
            metadata: {
              from: item.from,
              confidence: item.confidence,
              sourceMemoryIds: item.sourceMemoryIds,
              contentHash: item.contentHash,
              trigger,
              triggerReasons: decision.reasons,
            },
          });
        }
      }

      await writeContradictionSignals(memoryProvider, contradictions, allEntries, completedRun, deps.store, now);
    } catch {
      // Background hooks never throw past boundary.
    } finally {
      runningReflection = false;
    }
  };

  return {
    onRunCompleted(run: Run): void {
      void runBackgroundReflection("run-completed", run);
    },

    startIdleTimer(): void {
      if (deps.mode !== "external") return;
      if (idleTimer) return;

      idleTimer = setInterval(() => {
        void runBackgroundReflection("idle");
      }, policy.idleIntervalMs);
      idleTimer.unref?.();
    },

    stop(): void {
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = undefined;
      }
    },
  };
}

async function writeContradictionSignals(
  memoryProvider: MemoryProvider,
  contradictions: ContradictionSignal[],
  allEntries: Awaited<ReturnType<MemoryProvider["listMemoryEntries"]>>,
  completedRun: Run | undefined,
  store: RectorStore,
  now: () => string,
): Promise<void> {
  const existingContradictionHashes = new Set(
    allEntries
      .filter((entry) => entry.layer === "core" && entry.tags.includes("subconscious-contradiction"))
      .map((entry) => (typeof entry.metadata.contentHash === "string" ? entry.metadata.contentHash : ponderLessonInputHash(entry.content))),
  );

  for (const signal of contradictions) {
    if (signal.confidence < 0.7) continue;
    if (existingContradictionHashes.has(signal.contentHash)) continue;
    existingContradictionHashes.add(signal.contentHash);

    const redacted = redactString(signal.message);
    if (completedRun && completedRun.status === "running") {
      try {
        await createDecisionRequest(store, completedRun.id, {
          kind: "subconscious-contradiction",
          message: redacted,
          source: "subconscious-daemon",
        });
        continue;
      } catch {
        // Fall through to core memory note when decision request is not possible.
      }
    }

    await memoryProvider.createMemoryEntry({
      layer: "core",
      content: redacted,
      timestamp: now(),
      tags: ["subconscious-contradiction"],
      source: "subconscious-daemon",
      metadata: {
        runId: completedRun?.id,
        confidence: signal.confidence,
        sourceMemoryIds: signal.sourceMemoryIds,
        contentHash: signal.contentHash,
        kind: signal.kind,
      },
    });
  }
}

function createPonderRun(completedRun: Run | undefined, now: () => string): Run {
  const timestamp = now();
  return {
    id: completedRun ? `ponder-${completedRun.id}` : "ponder-idle",
    conversationId: completedRun?.conversationId ?? "ponder",
    userMessageId: completedRun?.userMessageId ?? "ponder",
    status: "completed",
    phase: "DONE",
    route: "ponder",
    complexity: "low",
    budget: {
      maxUsd: 0.1,
      maxInputTokens: 4000,
      maxOutputTokens: 1000,
      maxModelCalls: 1,
      maxRuntimeMs: 30_000,
      maxHealingAttempts: 0,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0, modelCalls: 0, runtimeMs: 0 },
    actualCost: { usd: 0, modelCalls: 0, runtimeMs: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId: completedRun ? `ponder-${completedRun.traceId}` : "ponder-idle",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
