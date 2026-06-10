import type { MemoryProvider } from "../memory/provider";
import type { ModelRouter } from "../providers/llm";
import type { OrchestratorMode } from "../deployment";
import type { RectorStore } from "../store";
import type { Run } from "../store/schemas";
import { createDecisionRequest } from "./runStateMachine";
import { runPonderSwarm, runSubconsciousDaemon } from "./ponderSwarm";
import { redactString } from "../security/redaction";

export interface NeuroBackgroundHooks {
  onRunCompleted(run: Run): void;
  startIdleTimer(): void;
  stop(): void;
}

/**
 * Background neuro-symbolic hooks (Chunk 31 / Step 6).
 * Fire-and-forget ponder + subconscious reflection after runs complete.
 * External mode only for auto-timers; never throws past the boundary.
 */
export function createNeuroBackgroundHooks(deps: {
  getMemoryProvider: () => Promise<MemoryProvider>;
  router?: ModelRouter;
  mode: OrchestratorMode;
  store: RectorStore;
}): NeuroBackgroundHooks {
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let runningReflection = false;

  const runBackgroundReflection = async (completedRun?: Run): Promise<void> => {
    if (runningReflection) return;
    runningReflection = true;
    try {
      const memoryProvider = await deps.getMemoryProvider();
      const episodic = await memoryProvider.searchMemory(undefined, { layer: "episodic", limit: 10 });
      const allEntries = await memoryProvider.listMemoryEntries();

      if (deps.mode === "external" && deps.router && episodic.length > 0) {
        const ponderRun = completedRun ?? {
          id: "ponder-idle",
          conversationId: "ponder",
          userMessageId: "ponder",
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
          costEstimate: { usd: 0 },
          actualCost: { usd: 0 },
          tokenEstimate: { input: 0, output: 0 },
          actualTokens: { input: 0, output: 0 },
          traceId: "ponder-idle",
          attempts: 0,
          healingAttempts: 0,
          validationAttempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const selection = deps.router.select({ capability: "cheap", task: "ponder", run: ponderRun });
        const lessons = await runPonderSwarm(episodic, { provider: selection.provider, run: ponderRun });
        for (const item of lessons) {
          await memoryProvider.createMemoryEntry({
            layer: "core",
            content: redactString(item.lesson),
            timestamp: new Date().toISOString(),
            tags: ["ponder-lesson"],
            source: "ponder-swarm",
            metadata: { from: item.from },
          });
        }
      }

      const contradictions = runSubconsciousDaemon(allEntries);
      for (const contradiction of contradictions) {
        const redacted = redactString(contradiction);
        if (completedRun && completedRun.status === "running") {
          try {
            await createDecisionRequest(deps.store, completedRun.id, {
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
          timestamp: new Date().toISOString(),
          tags: ["subconscious-contradiction"],
          source: "subconscious-daemon",
          metadata: completedRun ? { runId: completedRun.id } : {},
        });
      }
    } catch {
      // Background hooks never throw past boundary.
    } finally {
      runningReflection = false;
    }
  };

  return {
    onRunCompleted(run: Run): void {
      void runBackgroundReflection(run);
    },

    startIdleTimer(): void {
      if (deps.mode !== "external") return;
      if (idleTimer) return;

      idleTimer = setInterval(() => {
        void runBackgroundReflection();
      }, 1000 * 60 * 60 * 2); // 2h
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