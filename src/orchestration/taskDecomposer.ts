import type { ContextPack } from "./contextBuilder";
import type { CompiledDag } from "./dagCompiler";

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

/**
 * Stitching helper for final synthesis (citations from artifacts, commands, tests).
 */
export function stitchResults(results: any[]): string {
  return results.map(r => `• ${r.artifact || r.command || "result"}: ${r.summary || ""}`).join("\n");
}