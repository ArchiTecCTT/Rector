import { runSLMPreprocessor, type PreprocessorOutput } from "../../orchestration/preprocessor";
import type { ContextPack } from "../../orchestration/contextBuilder";
import type { TriageResult } from "../../orchestration/triage";
import type { ModelRouter, ModelSelection } from "../../providers/llm";
import type { RectorStore } from "../../store";
import type { Run } from "../../store/schemas";
import type { LLMUsage } from "../../providers/llm";
import { PUBLIC_MODULE_API_VERSION, type ModuleManifest } from "../manifest";
import type { RectorModule } from "../registry";

export const NEURO_PREPROCESS_MODULE_ID = "@rector/builtin/neuro-preprocess";

export const neuroPreprocessManifest: ModuleManifest = {
  id: NEURO_PREPROCESS_MODULE_ID,
  name: "Neuro Preprocessor",
  version: "0.2.0",
  apiVersion: PUBLIC_MODULE_API_VERSION,
  description: "SLM preprocessor and structured tool-call validation (Chunk 26).",
  tier: "builtin",
  hooks: ["onExternalRunStart"],
  capabilities: [],
  defaultEnabled: true,
  externalModeOnly: true,
};

export interface PreprocessorPhaseInput {
  store: RectorStore;
  run: Run;
  prompt: string;
  contextPack: ContextPack;
  triage: TriageResult;
  router: ModelRouter;
  recordSpan: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  addProviderUsage: (run: Run, usage: LLMUsage, providerId: string) => Promise<Run>;
}

export interface PreprocessorPhaseResult {
  budgetRun: Run;
  preprocessorOutput: PreprocessorOutput;
  effectiveMessageContent: string;
}

export async function executePreprocessorPhase(
  input: PreprocessorPhaseInput,
): Promise<PreprocessorPhaseResult> {
  const selection: ModelSelection = input.router.select({
    capability: "cheap",
    task: "preprocessor",
    run: input.run,
  });

  const preprocessorResult = await input.recordSpan("PREPROCESSING", () =>
    runSLMPreprocessor(
      { rawPrompt: input.prompt, contextPack: input.contextPack, triage: input.triage },
      { slmProvider: selection.provider, run: input.run, model: selection.model },
    ),
  );

  let budgetRun = input.run;
  if (preprocessorResult.usage.modelCalls > 0) {
    budgetRun = await input.addProviderUsage(
      input.run,
      preprocessorResult.usage,
      selection.provider.metadata.id,
    );
  }

  const effectiveMessageContent =
    (preprocessorResult.output.distilledContext || "").trim() || input.prompt;

  return {
    budgetRun,
    preprocessorOutput: preprocessorResult.output,
    effectiveMessageContent,
  };
}

/** Passthrough when preprocessor module is disabled. */
export function executePreprocessorPassthrough(
  run: Run,
  prompt: string,
): PreprocessorPhaseResult {
  return {
    budgetRun: run,
    preprocessorOutput: {
      distilledContext: prompt,
      proposedToolCalls: [],
      entities: ["user"],
      intent: "passthrough",
      constraints: [],
    },
    effectiveMessageContent: prompt,
  };
}

export function createNeuroPreprocessModule(): RectorModule {
  return { manifest: neuroPreprocessManifest };
}