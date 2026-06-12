import type { ContextPack } from "../../orchestration/contextBuilder";
import { runDeepPlanner } from "../../orchestration/deepPlanner";
import { runLivePlanner, type LivePlannerResult } from "../../orchestration/planner";
import { decomposeIntoTasks, type SubGoalGraph } from "../../orchestration/taskDecomposer";
import type { TriageResult } from "../../orchestration/triage";
import type { ModelRouter, ModelSelection } from "../../providers/llm";
import type { Run } from "../../store/schemas";
import { PUBLIC_MODULE_API_VERSION, type ModuleManifest } from "../manifest";
import type { RectorModule } from "../registry";
import type { NeuroFeatureFlags } from "../featureFlags";

export const NEURO_PLANNING_MODULE_ID = "@rector/builtin/neuro-planning";

export const neuroPlanningManifest: ModuleManifest = {
  id: NEURO_PLANNING_MODULE_ID,
  name: "Neuro Planning",
  version: "0.2.0",
  apiVersion: PUBLIC_MODULE_API_VERSION,
  description: "Bounded multi-candidate planning and dependency-aware task decomposition (Chunks 30, 32, 042c).",
  tier: "builtin",
  hooks: ["onExternalRunPhase"],
  capabilities: [],
  defaultEnabled: true,
  externalModeOnly: true,
};

export interface PlanningPhaseInput {
  triage: TriageResult;
  contextPack: ContextPack;
  effectiveMessageContent: string;
  deepPlanning: boolean;
  router: ModelRouter;
  budgetRun: Run;
  flags: NeuroFeatureFlags;
  recordSpan: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface PlanningPhasePrep {
  subGoals: string[];
  subGoalGraph?: SubGoalGraph;
  plannerContextPack: ContextPack;
}

export function preparePlanningPhase(input: PlanningPhaseInput): PlanningPhasePrep {
  let subGoals: string[] = [];
  let subGoalGraph: SubGoalGraph | undefined;
  let plannerContextPack = input.contextPack;

  if (
    input.flags.decomposition &&
    input.triage.complexity === "high"
  ) {
    const decomposition = decomposeIntoTasks(
      input.effectiveMessageContent,
      input.contextPack,
    );
    subGoals = decomposition.subGoals;
    subGoalGraph = decomposition.subGoalGraph;
    if (subGoals.length > 0) {
      plannerContextPack = { ...input.contextPack, subGoals };
    }
  }

  return { subGoals, subGoalGraph, plannerContextPack };
}

export async function executePlanningPhase(
  input: PlanningPhaseInput,
  prep: PlanningPhasePrep,
): Promise<LivePlannerResult> {
  const selection: ModelSelection = input.router.select({
    capability: "flagship",
    task: "planner",
    run: input.budgetRun,
  });

  const useDeepPlanning = input.flags.deepPlanning && input.deepPlanning;

  return input.recordSpan("PLANNING", () =>
    useDeepPlanning
      ? runDeepPlanner(
          {
            triage: input.triage,
            contextPack: prep.plannerContextPack,
            messageContent: input.effectiveMessageContent,
            deepPlanning: true,
          },
          { provider: selection.provider, run: input.budgetRun },
        )
      : runLivePlanner(
          {
            triage: input.triage,
            contextPack: prep.plannerContextPack,
            messageContent: input.effectiveMessageContent,
          },
          { provider: selection.provider, run: input.budgetRun },
        ),
  );
}

export function createNeuroPlanningModule(): RectorModule {
  return { manifest: neuroPlanningManifest };
}