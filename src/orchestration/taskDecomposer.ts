import type { ContextPack } from "./contextBuilder";
import type { CompiledDag } from "./dagCompiler";
import { executeDagThroughSandbox } from "./sandboxExecutor";
import { redactString } from "../security/redaction";
import type { WorkspaceSandboxAdapter } from "../sandbox";
import type { Run } from "../store/schemas";

/**
 * Task Decomposition + Concurrent + Stitching (Chunk 32 / Step 7).
 * After preprocessor, produce sub-DAG and let executor run concurrently (sandbox enforces safety).
 */
export function decomposeIntoTasks(distilled: string, context: ContextPack): { subGoals: string[]; suggestedDag: Partial<CompiledDag> } {
  // Very simple decomposition for alpha
  const subGoals = distilled.split(/\.|\n/).filter(s => s.trim().length > 10).slice(0, 4);
  return {
    subGoals,
    suggestedDag: {
      nodes: subGoals.map((g, i) => ({ id: `sub-${i}`, type: "task", description: g })),
    } as any,
  };
}

export interface DecomposedSubGoalResult {
  subGoal: string;
  artifact?: string;
  command?: string;
  summary: string;
  status: string;
}

export interface ExecuteDecomposedSubGoalsDeps {
  sandbox: WorkspaceSandboxAdapter;
  run: Run;
  now?: () => string;
}

/**
 * Executes each sub-goal concurrently through the safe workspace sandbox.
 * Each sub-goal gets a minimal single-node DAG (no-op LLM_EXECUTION) so the
 * sandbox path is exercised without real file/command I/O.
 */
export async function executeDecomposedSubGoals(
  subGoals: string[],
  deps: ExecuteDecomposedSubGoalsDeps,
): Promise<DecomposedSubGoalResult[]> {
  const nowFn = deps.now ?? (() => new Date().toISOString());

  const executeOne = async (subGoal: string, index: number): Promise<DecomposedSubGoalResult> => {
    const dag: CompiledDag = {
      id: `subdag-${deps.run.id}-${index}`,
      runId: deps.run.id,
      version: "0.1.0",
      nodes: [
        {
          id: `sub-node-${index}`,
          type: "LLM_EXECUTION",
          label: redactString(subGoal.slice(0, 120)),
          dependsOn: [],
          toolPermissions: [],
          expectedOutputs: [],
          input: { subGoal: redactString(subGoal) },
          metadata: { decomposed: true, subGoalIndex: index },
        },
      ],
      edges: [],
      createdAt: nowFn(),
    };

    const result = await executeDagThroughSandbox(dag, { sandbox: deps.sandbox, now: nowFn });
    const nodeResult = result.nodeResults[0];
    const summary =
      nodeResult?.status === "SUCCESS"
        ? `completed (${result.status})`
        : `failed: ${nodeResult?.error?.message ?? result.status}`;

    return {
      subGoal: redactString(subGoal),
      artifact: `sub-goal-${index}`,
      summary: redactString(summary),
      status: result.status,
    };
  };

  return Promise.all(subGoals.map((goal, index) => executeOne(goal, index)));
}

/**
 * Stitching helper for final synthesis (citations from artifacts, commands, tests).
 */
export function stitchResults(results: DecomposedSubGoalResult[]): string {
  return results.map(r => `• ${r.artifact || r.command || "result"}: ${r.summary || ""}`).join("\n");
}