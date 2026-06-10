import type { MemoryEntry } from "../store";
import { runLiveSynthesizer } from "./synthesizer";
import { runLiveSkeptic } from "./skeptic";
import { createFakePlan } from "./planner";

/**
 * Ponder / Dreaming Swarm (Chunk 31 / Step 6).
 * Collects recent memory, runs lightweight reflection, writes lessons to core.
 */
export async function runPonderSwarm(entries: MemoryEntry[], deps: any) {
  if (!entries.length) return [];

  // Simple: synthesize a lesson from recent episodic
  const recent = entries.filter(e => e.layer === "episodic").slice(0, 5);
  const prompt = "Reflect on these notes and extract 1-2 lessons: " + recent.map(e => e.content).join(" | ");

  // Reuse synthesizer style (in real would use planner + skeptic too)
  const lesson = await runLiveSynthesizer({ traceId: "ponder", contextPack: { userIntentSummary: prompt } as any, triage: { route: "DIRECT_ANSWER" } as any, plannerOutput: createFakePlan({ triage: {} as any, contextPack: {} as any }), skepticReview: {} as any, crucibleDecision: {} as any }, { provider: deps.provider, run: deps.run });

  // The lesson would be written back as core memory entry by caller (with redaction)
  return [{ lesson: lesson.synthesis?.response ?? "No new lessons", from: recent.length }];
}

/**
 * Subconscious daemon stub (contradiction detection).
 * Deterministic first, then cheap LLM if needed.
 */
export function runSubconsciousDaemon(entries: MemoryEntry[]) {
  const contradictions: string[] = [];
  // Very simple deterministic check
  const notes = entries.filter(e => e.source === "user-note");
  if (notes.length > 1) {
    // toy contradiction
    if (notes.some(n => n.content.includes("never")) && notes.some(n => n.content.includes("always"))) {
      contradictions.push("Potential contradiction in user notes about 'never' vs 'always'.");
    }
  }
  return contradictions;
}