import type { Application, Request, Response } from "express";
import { z } from "zod";
import { redactString } from "../../security/redaction";
import type { UserStores } from "../../security/userStores";
import { resolveTestProvider } from "../../providers/configBridge";
import {
  ORCHESTRATION_ROLE_DESCRIPTORS,
  OrchestrationAssignmentUpsertSchema,
  OrchestrationModelAssignmentSchema,
  OrchestrationRoleSchema,
  orchestrationAssignmentId,
  resolveEffectiveAssignment,
  type EffectiveModelRoute,
  type OrchestrationAssignmentScope,
  type OrchestrationModelAssignment,
  type OrchestrationRole,
  type providerOptionsFromConfigState,
} from "../../providers/orchestrationAssignments";

const TestOrchestrationAssignmentRequestSchema = OrchestrationAssignmentUpsertSchema.partial().strict();
type TestOrchestrationAssignmentRequest = z.infer<typeof TestOrchestrationAssignmentRequestSchema>;

type OrchestrationModelsPayload = {
  roles: typeof ORCHESTRATION_ROLE_DESCRIPTORS;
  assignments: OrchestrationModelAssignment[];
  effective: EffectiveModelRoute[];
  providers: ReturnType<typeof providerOptionsFromConfigState>;
};

export interface OrchestrationModelRoutesDeps {
  storesFor(req: Request): UserStores;
  assignmentScopeFor(req: Request, workspaceId?: string): OrchestrationAssignmentScope;
  workspaceIdFromQuery(req: Request): string | undefined;
  buildOrchestrationModelsPayload(req: Request, workspaceId?: string): Promise<OrchestrationModelsPayload>;
  sendRedacted(res: Response, status: number, payload: unknown): void;
  requestValidationMessage(error: unknown): string;
  runConnectionTest(input: {
    providerId: string;
    provider?: unknown;
    model?: string;
    deployment?: string;
    fetchImpl: typeof fetch;
  }): Promise<unknown>;
}

const errorMessageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function registerOrchestrationModelRoutes(app: Application, deps: OrchestrationModelRoutesDeps): void {
  const {
    storesFor,
    assignmentScopeFor,
    workspaceIdFromQuery,
    buildOrchestrationModelsPayload,
    sendRedacted,
    requestValidationMessage,
    runConnectionTest,
  } = deps;

  app.get("/api/orchestration-models/roles", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, {
        roles: payload.roles,
        providers: payload.providers,
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/orchestration-models/assignments", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/orchestration-models/effective", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.put("/api/orchestration-models/assignments/:role", async (req, res) => {
    let role: OrchestrationRole;
    let body: z.infer<typeof OrchestrationAssignmentUpsertSchema>;
    try {
      role = OrchestrationRoleSchema.parse(req.params.role);
      body = OrchestrationAssignmentUpsertSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return sendRedacted(res, 400, { error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const scope = assignmentScopeFor(req, body.workspaceId);
      const [existing, existingAssignments, providerState] = await Promise.all([
        userStores.orchestrationAssignmentStore.getAssignment(role, scope),
        userStores.orchestrationAssignmentStore.listAssignments(scope),
        userStores.providerConfigStore.getState(),
      ]);
      const now = new Date().toISOString();
      const candidate = OrchestrationModelAssignmentSchema.parse({
        id: existing?.id ?? orchestrationAssignmentId(role, scope),
        ...(scope.userId ? { userId: scope.userId } : {}),
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        role,
        providerId: body.providerId,
        ...(body.modelId ? { modelId: body.modelId } : {}),
        ...(body.fallbackProviderId ? { fallbackProviderId: body.fallbackProviderId } : {}),
        ...(body.fallbackModelId ? { fallbackModelId: body.fallbackModelId } : {}),
        enabled: body.enabled ?? existing?.enabled ?? true,
        ...(body.maxUsdPerCall !== undefined ? { maxUsdPerCall: body.maxUsdPerCall } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.requiresJsonMode !== undefined ? { requiresJsonMode: body.requiresJsonMode } : {}),
        ...(body.requiresToolCalling !== undefined ? { requiresToolCalling: body.requiresToolCalling } : {}),
        ...(body.requiresStreaming !== undefined ? { requiresStreaming: body.requiresStreaming } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const withoutCandidate = existingAssignments.filter((assignment) => assignment.role !== role);
      const effective = resolveEffectiveAssignment({
        role,
        assignments: [...withoutCandidate, candidate],
        providerState,
        scope,
      });
      const blockers = effective.warnings.filter((warning) => warning.severity === "blocker");
      if (blockers.length > 0) {
        return sendRedacted(res, 400, {
          error: "Assignment does not satisfy required role capabilities.",
          warnings: effective.warnings,
        });
      }

      const result = await userStores.orchestrationAssignmentStore.upsertAssignment(role, body, scope);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      const payload = await buildOrchestrationModelsPayload(req, scope.workspaceId);
      sendRedacted(res, 200, { assignment: result.value, effective, assignments: payload.assignments });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/orchestration-models/assignments/:role/test", async (req, res) => {
    let role: OrchestrationRole;
    let body: TestOrchestrationAssignmentRequest;
    try {
      role = OrchestrationRoleSchema.parse(req.params.role);
      body = TestOrchestrationAssignmentRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return sendRedacted(res, 400, { error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const scope = assignmentScopeFor(req, body.workspaceId);
      const providerState = await userStores.providerConfigStore.getState();
      const saved = await userStores.orchestrationAssignmentStore.getAssignment(role, scope);
      const draft = body.providerId
        ? OrchestrationModelAssignmentSchema.parse({
            id: saved?.id ?? orchestrationAssignmentId(role, scope),
            ...(scope.userId ? { userId: scope.userId } : {}),
            ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            role,
            providerId: body.providerId,
            ...(body.modelId ? { modelId: body.modelId } : {}),
            ...(body.fallbackProviderId ? { fallbackProviderId: body.fallbackProviderId } : {}),
            ...(body.fallbackModelId ? { fallbackModelId: body.fallbackModelId } : {}),
            enabled: body.enabled ?? saved?.enabled ?? true,
            ...(body.maxUsdPerCall !== undefined ? { maxUsdPerCall: body.maxUsdPerCall } : {}),
            ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
            ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
            ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            ...(body.requiresJsonMode !== undefined ? { requiresJsonMode: body.requiresJsonMode } : {}),
            ...(body.requiresToolCalling !== undefined ? { requiresToolCalling: body.requiresToolCalling } : {}),
            ...(body.requiresStreaming !== undefined ? { requiresStreaming: body.requiresStreaming } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            createdAt: saved?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
        : saved;
      const effective = draft
        ? resolveEffectiveAssignment({ role, assignments: [draft], providerState, scope })
        : resolveEffectiveAssignment({ role, assignments: [], providerState, scope });

      if (!effective.enabled || effective.providerId === "disabled") {
        return sendRedacted(res, 200, {
          ok: true,
          role,
          providerId: effective.providerId,
          model: effective.modelId,
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }
      if (effective.providerId === "deterministic") {
        return sendRedacted(res, 200, {
          ok: true,
          role,
          providerId: "deterministic",
          model: effective.modelId ?? "deterministic-local",
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }

      const provider = await resolveTestProvider(
        effective.providerId,
        userStores.providerConfigStore,
        userStores.secretStore,
        { enableNetwork: true, fetchImpl: fetch },
        effective.modelId ? { model: effective.modelId, deployment: effective.modelId } : {},
      );
      if (!provider) {
        return sendRedacted(res, 400, {
          ok: false,
          role,
          providerId: effective.providerId,
          code: "CONFIG_INVALID",
          error: redactString(`Provider ${effective.providerId} is not configured.`),
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }

      const result = await runConnectionTest({
        providerId: effective.providerId,
        provider,
        model: effective.modelId,
        deployment: effective.modelId,
        fetchImpl: fetch,
      });
      sendRedacted(res, (result as { ok?: boolean }).ok ? 200 : 400, { ...(result as object), role, warnings: effective.warnings });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/orchestration-models/assignments/reset", async (req, res) => {
    try {
      const workspaceId = typeof (req.body ?? {}).workspaceId === "string" ? String((req.body ?? {}).workspaceId).trim() : undefined;
      const userStores = storesFor(req);
      const result = await userStores.orchestrationAssignmentStore.resetAssignments(assignmentScopeFor(req, workspaceId));
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      const payload = await buildOrchestrationModelsPayload(req, workspaceId);
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });
}
