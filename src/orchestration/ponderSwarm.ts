import type { MemoryEntry } from "../store";
import type { LLMProvider } from "../providers/llm";
import type { Run } from "../store/schemas";
import { runLiveSynthesizer } from "./synthesizer";
import { createFakePlan } from "./planner";
import { CRUCIBLE_MAX_ROUNDS, type CrucibleDecision } from "./crucible";
import type { SkepticReview } from "./skeptic";
import { triageUserMessage } from "./triage";
import { redactString } from "../security/redaction";

export interface PonderSwarmDeps {
  provider: LLMProvider;
  run: Run;
}

export interface PonderLesson {
  lesson: string;
  from: number;
}

/**
 * Ponder / Dreaming Swarm (Chunk 31 / Step 6).
 * Collects recent memory, runs lightweight reflection, writes lessons to core.
 */
export async function runPonderSwarm(entries: MemoryEntry[], deps: PonderSwarmDeps): Promise<PonderLesson[]> {
  if (!entries.length) return [];

  // Simple: synthesize a lesson from recent episodic
  const recent = entries.filter(e => e.layer === "episodic").slice(0, 5);
  const prompt = "Reflect on these notes and extract 1-2 lessons: " + recent.map(e => e.content).join(" | ");

  const triage = triageUserMessage(prompt);
  const contextPack = {
    id: "ctx-ponder",
    createdAt: new Date().toISOString(),
    userIntentSummary: redactString(prompt),
    conversationRef: { id: "ponder" },
    messageRefs: [],
    relevantDocs: [],
    relevantMemory: [],
    constraints: [],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: [],
    triage,
    artifactHandles: [],
    inlineContext: [],
  };

  // Reuse synthesizer style (in real would use planner + skeptic too)
  const lesson = await runLiveSynthesizer(
    {
      traceId: "ponder",
      contextPack,
      triage,
      plannerOutput: createFakePlan({ triage, contextPack, messageContent: prompt }),
      skepticReview: { verdict: "SOUND", findings: [], createdAt: new Date().toISOString() } as SkepticReview,
      crucibleDecision: {
        verdict: "ACCEPTED",
        reason: "ponder reflection",
        createdAt: new Date().toISOString(),
        blockerFindings: [],
        round: 1,
        maxRounds: CRUCIBLE_MAX_ROUNDS,
      } as CrucibleDecision,
    },
    { provider: deps.provider, run: deps.run },
  );

  // The lesson would be written back as core memory entry by caller (with redaction)
  return [{ lesson: redactString(lesson.synthesis?.response ?? "No new lessons"), from: recent.length }];
}

/**
 * Subconscious daemon stub (contradiction detection).
 * Deterministic first, then cheap LLM if needed.
 */
export function runSubconsciousDaemon(entries: MemoryEntry[]): string[] {
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