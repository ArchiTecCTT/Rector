import type { OrchestratorMode } from "../deployment";
import type { ContextPack } from "../orchestration/contextBuilder";
import type { TriageResult } from "../orchestration/triage";
import type { MemoryProvider } from "../memory/provider";
import type { ModelRouter } from "../providers/llm";
import type { RectorStore } from "../store";
import type { Run } from "../store/schemas";
import type { ToolRegistry } from "../tools";

/** Dependencies available to modules at boot. */
export interface ModuleBootContext {
  mode: OrchestratorMode;
  store: RectorStore;
  router?: ModelRouter;
  getMemoryProvider?: () => Promise<MemoryProvider>;
  toolRegistry?: ToolRegistry;
}

/** Context passed before external-run neuro phases (preprocessor, etc.). */
export interface ExternalRunStartContext {
  store: RectorStore;
  run: Run;
  prompt: string;
  triage: TriageResult;
  contextPack: ContextPack;
  router: ModelRouter;
}

/** Optional overrides modules may return without bypassing core phase graph. */
export interface ExternalRunStartResult {
  /** Replace effective user message content after preprocessing hooks. */
  effectiveMessageContent?: string;
  contextPack?: ContextPack;
}

export interface RunCompletedContext {
  store: RectorStore;
  run: Run;
  mode: OrchestratorMode;
  router?: ModelRouter;
  getMemoryProvider?: () => Promise<MemoryProvider>;
}

export interface EnrichContextInput {
  contextPack: ContextPack;
  triage: TriageResult;
  prompt: string;
}

export interface EnrichContextResult {
  contextPack: ContextPack;
}

export type ExternalRunPhase =
  | "PREPROCESSING"
  | "PLANNING"
  | "SKEPTIC_REVIEW"
  | "CRUCIBLE"
  | "DAG_COMPILATION"
  | "EXECUTING"
  | "VALIDATING"
  | "HEALING"
  | "SYNTHESIZING";

export interface ExternalRunPhaseContext {
  phase: ExternalRunPhase;
  store: RectorStore;
  run: Run;
  triage: TriageResult;
  contextPack: ContextPack;
  router: ModelRouter;
}
