import type { RuntimeSettingsStore, OrchestrationProfile } from "../config/runtimeSettings";
import type { SecretStore } from "../security/secretStore";
import type { ProviderConfigStore } from "../providers/configStore";
import {
  MEMORY_ROLE_DEFINITIONS,
  MEMORY_ROLES,
  type MemoryRole,
} from "../providers/memoryAssignments";
import type { MemoryAssignmentStore } from "../providers/memoryAssignmentStore";
import type { MemoryConfigStore } from "../providers/memoryConfigStore";
import { MemoryRoleRouter } from "../providers/memoryRoleRouter";
import {
  ORCHESTRATION_ROLE_DESCRIPTORS,
  resolveEffectiveAssignment,
  type CapabilityMismatchWarning,
  type EffectiveModelRoute,
  type OrchestrationAssignmentScope,
  type OrchestrationAssignmentStore,
  type OrchestrationRole,
} from "../providers/orchestrationAssignments";
import { computeSetupStatus, type CategoryReadiness } from "../setupStatus";

/** Orchestration roles that must be assigned to configured providers before activation. */
export const REQUIRED_ORCHESTRATION_ROLES = ["triage", "planner", "synthesizer"] as const;
export type RequiredOrchestrationRole = (typeof REQUIRED_ORCHESTRATION_ROLES)[number];

export interface ProductReadiness {
  ready: boolean;
  orchestrationProfile: OrchestrationProfile;
  blockers: string[];
  onboardingStep: number;
  onboardingComplete: boolean;
  categories: CategoryReadiness[];
}

export interface OnboardingStepState {
  step: number;
  title: string;
  complete: boolean;
  blockers: string[];
}

export interface OnboardingState {
  step: number;
  steps: OnboardingStepState[];
  ready: boolean;
  onboardingComplete: boolean;
  orchestrationProfile: OrchestrationProfile;
}

export interface ProductReadinessDeps {
  env: Record<string, string | undefined>;
  secretStore: SecretStore;
  providerConfigStore: ProviderConfigStore;
  orchestrationAssignmentStore: OrchestrationAssignmentStore;
  memoryAssignmentStore: MemoryAssignmentStore;
  memoryConfigStore: MemoryConfigStore;
  runtimeSettingsStore: RuntimeSettingsStore;
  scope?: OrchestrationAssignmentScope;
}

interface ReadinessEvaluation {
  blockers: string[];
  hasProvider: boolean;
  hasTemplate: boolean;
  assignmentsReady: boolean;
  profileConfigured: boolean;
  categories: CategoryReadiness[];
  orchestrationProfile: OrchestrationProfile;
}

function roleLabel(role: OrchestrationRole): string {
  return ORCHESTRATION_ROLE_DESCRIPTORS.find((descriptor) => descriptor.id === role)?.label ?? role;
}

function memoryRoleLabel(role: MemoryRole): string {
  return MEMORY_ROLE_DEFINITIONS[role].label;
}

function isConfiguredProviderId(providerId: string | undefined): boolean {
  return providerId !== undefined && providerId !== "deterministic" && providerId !== "disabled";
}

function blockerMessagesFromWarnings(
  role: OrchestrationRole,
  warnings: CapabilityMismatchWarning[],
): string[] {
  return warnings
    .filter((warning) => warning.severity === "blocker")
    .map((warning) => `${roleLabel(role)}: ${warning.message}`);
}

function assignmentBlockers(
  role: RequiredOrchestrationRole,
  effective: EffectiveModelRoute,
  secretPresent: boolean,
): string[] {
  const blockers: string[] = [];
  if (!isConfiguredProviderId(effective.providerId)) {
    blockers.push(`${roleLabel(role)} must be assigned to a configured provider.`);
  } else if (effective.source !== "assignment" && effective.source !== "workspace-default") {
    blockers.push(`${roleLabel(role)} requires an explicit model assignment.`);
  } else if (!secretPresent) {
    blockers.push(`${roleLabel(role)} provider is missing a stored secret.`);
  }
  blockers.push(...blockerMessagesFromWarnings(role, effective.warnings));
  return blockers;
}

async function countProvidersWithSecrets(
  providerConfigStore: ProviderConfigStore,
  secretStore: SecretStore,
): Promise<{ count: number; providerIds: string[] }> {
  const providerState = await providerConfigStore.getState();
  const providerIds: string[] = [];
  for (const record of providerState.providers) {
    if (await secretStore.hasSecret(record.secretRef)) {
      providerIds.push(record.id);
    }
  }
  return { count: providerIds.length, providerIds };
}

async function providerSecretPresent(
  providerId: string,
  providerConfigStore: ProviderConfigStore,
  secretStore: SecretStore,
): Promise<boolean> {
  const providerState = await providerConfigStore.getState();
  const record = providerState.providers.find((candidate) => candidate.id === providerId);
  if (!record) return false;
  return secretStore.hasSecret(record.secretRef);
}

async function evaluateReadiness(deps: ProductReadinessDeps): Promise<ReadinessEvaluation> {
  const scope = deps.scope ?? {};
  const [setupStatus, runtimeSettings, providerState, assignmentState] = await Promise.all([
    computeSetupStatus(deps.env, deps.secretStore, deps.memoryConfigStore),
    deps.runtimeSettingsStore.get(),
    deps.providerConfigStore.getState(),
    deps.orchestrationAssignmentStore.getState(),
  ]);

  const blockers: string[] = [];
  const { count: providerCount } = await countProvidersWithSecrets(
    deps.providerConfigStore,
    deps.secretStore,
  );
  const hasProvider = providerCount >= 1;
  if (!hasProvider) {
    blockers.push("Add at least one provider with a stored secret.");
  }

  const hasTemplate = typeof runtimeSettings.activeTemplateId === "string"
    && runtimeSettings.activeTemplateId.trim().length > 0;

  for (const role of REQUIRED_ORCHESTRATION_ROLES) {
    const effective = resolveEffectiveAssignment({
      role,
      assignments: assignmentState.assignments,
      providerState,
      scope,
      includeBuiltInDefault: false,
    });
    const secretPresent = isConfiguredProviderId(effective.providerId)
      ? await providerSecretPresent(effective.providerId, deps.providerConfigStore, deps.secretStore)
      : false;
    blockers.push(...assignmentBlockers(role, effective, secretPresent));
  }

  const orchestrationAssignments = assignmentState.assignments.filter(
    (assignment) =>
      assignment.userId === scope.userId &&
      assignment.workspaceId === scope.workspaceId,
  );
  for (const assignment of orchestrationAssignments) {
    if (!assignment.enabled || !isConfiguredProviderId(assignment.providerId)) continue;
    const effective = resolveEffectiveAssignment({
      role: assignment.role,
      assignments: assignmentState.assignments,
      providerState,
      scope,
      includeBuiltInDefault: false,
    });
    blockers.push(...blockerMessagesFromWarnings(assignment.role, effective.warnings));
  }

  const memoryRouter = new MemoryRoleRouter({
    assignmentStore: deps.memoryAssignmentStore,
    configStore: deps.memoryConfigStore,
    secrets: deps.secretStore,
    mode: "external",
  });

  for (const role of MEMORY_ROLES) {
    const definition = MEMORY_ROLE_DEFINITIONS[role];
    const effective = await memoryRouter.resolveMemoryProvider(role, {
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      mode: "external",
    });

    if (effective.status === "notReady") {
      blockers.push(
        definition.optional
          ? `${memoryRoleLabel(role)} assignment is not ready: ${effective.error ?? "provider unavailable."}`
          : `${memoryRoleLabel(role)} requires a valid memory assignment.`,
      );
      continue;
    }

    if (!definition.optional && effective.status === "disabled") {
      blockers.push(`${memoryRoleLabel(role)} cannot be disabled for the configured product.`);
    }
  }

  const profileConfigured = runtimeSettings.orchestrationProfile === "configured";
  if (!profileConfigured) {
    blockers.push("Activate Rector to unlock chat.");
  }

  const activationBlockers = blockers.filter((blocker) => blocker !== "Activate Rector to unlock chat.");
  const assignmentsReady = activationBlockers.filter((blocker) => {
    if (blocker.startsWith("Add at least one provider")) return false;
    return !(blocker.startsWith("Select a template") || blocker.includes("template"));
  }).length === 0;

  return {
    blockers,
    hasProvider,
    hasTemplate,
    assignmentsReady,
    profileConfigured,
    categories: setupStatus.categories,
    orchestrationProfile: runtimeSettings.orchestrationProfile,
  };
}

export function deriveOnboardingStep(evaluation: Pick<
  ReadinessEvaluation,
  "hasProvider" | "hasTemplate" | "assignmentsReady" | "profileConfigured"
>): number {
  if (!evaluation.hasProvider) return 1;
  if (!evaluation.hasTemplate && !evaluation.assignmentsReady) return 2;
  if (!evaluation.assignmentsReady) return 3;
  return 4;
}

function deriveStepBlockers(
  evaluation: ReadinessEvaluation,
): OnboardingStepState[] {
  const providerBlockers = evaluation.hasProvider
    ? []
    : ["Add at least one provider with a stored secret."];
  const templateBlockers = evaluation.hasTemplate
    ? []
    : ["Pick a starter template or continue with manual configuration."];
  const assignmentBlockers = evaluation.assignmentsReady
    ? []
    : evaluation.blockers.filter((blocker) => {
        if (blocker === "Activate Rector to unlock chat.") return false;
        return !providerBlockers.includes(blocker);
      });
  const activationBlockers = evaluation.profileConfigured
    ? []
    : ["Review the checklist and activate Rector when ready."];

  return [
    { step: 1, title: "Add provider", complete: evaluation.hasProvider, blockers: providerBlockers },
    {
      step: 2,
      title: "Pick template",
      complete: evaluation.hasTemplate || evaluation.assignmentsReady,
      blockers: evaluation.hasTemplate || evaluation.assignmentsReady ? [] : templateBlockers,
    },
    { step: 3, title: "Review assignments", complete: evaluation.assignmentsReady, blockers: assignmentBlockers },
    { step: 4, title: "Activate", complete: evaluation.profileConfigured, blockers: activationBlockers },
  ];
}

/**
 * Returns true when every activation prerequisite passes except setting
 * `orchestrationProfile` to `configured`.
 */
export async function computeActivationReadiness(deps: ProductReadinessDeps): Promise<{
  ready: boolean;
  blockers: string[];
}> {
  const evaluation = await evaluateReadiness(deps);
  const blockers = evaluation.blockers.filter((blocker) => blocker !== "Activate Rector to unlock chat.");
  return { ready: blockers.length === 0, blockers };
}

/** Single readiness composer used by API, chat gate, and onboarding UI. */
export async function computeProductReadiness(deps: ProductReadinessDeps): Promise<ProductReadiness> {
  const evaluation = await evaluateReadiness(deps);
  const onboardingStep = deriveOnboardingStep(evaluation);
  const ready = evaluation.blockers.length === 0;

  return {
    ready,
    orchestrationProfile: evaluation.orchestrationProfile,
    blockers: evaluation.blockers,
    onboardingStep,
    onboardingComplete: ready,
    categories: evaluation.categories,
  };
}

export async function computeOnboardingState(deps: ProductReadinessDeps): Promise<OnboardingState> {
  const evaluation = await evaluateReadiness(deps);
  const readiness = await computeProductReadiness(deps);
  return {
    step: deriveOnboardingStep(evaluation),
    steps: deriveStepBlockers(evaluation),
    ready: readiness.ready,
    onboardingComplete: readiness.onboardingComplete,
    orchestrationProfile: evaluation.orchestrationProfile,
  };
}
