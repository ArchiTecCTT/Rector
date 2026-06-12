import type { Application, Request, Response } from "express";
import { z } from "zod";
import { redactString } from "../../security/redaction";
import type { UserStores } from "../../security/userStores";
import {
  MEMORY_ROLES,
  MEMORY_ROLE_DEFINITIONS,
  MemoryRoleSchema,
  createMemoryRoleAssignment,
  memoryRoleResolutionToJson,
  memoryProviderCapabilitiesForKind,
  memoryCapabilityWarningsForRole,
  type EffectiveMemoryProvider,
  type MemoryRole,
  type MemoryRoleAssignment,
} from "../../providers";
import type { MemoryProvider } from "../../memory/provider";

const UpsertMemoryAssignmentRequestSchema = z
  .object({
    providerRecordId: z.string().min(1),
    enabled: z.boolean().optional(),
    workspaceId: z.string().min(1).optional(),
    readPriority: z.number().int().optional(),
    writePriority: z.number().int().optional(),
    fallbackProviderRecordId: z.string().min(1).optional(),
    retentionPolicy: z.enum(["ephemeral", "session", "durable", "longTerm"]).optional(),
    maxEntries: z.number().int().positive().optional(),
    maxUsdPerDay: z.number().nonnegative().optional(),
  })
  .strict();
type UpsertMemoryAssignmentRequest = z.infer<typeof UpsertMemoryAssignmentRequestSchema>;

const MemoryAssignmentResetRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
  })
  .strict()
  .optional();
type MemoryAssignmentResetRequest = z.infer<typeof MemoryAssignmentResetRequestSchema>;

const MemoryAssignmentMigrationPlanRequestSchema = z
  .object({
    targetProviderRecordId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict()
  .optional();
type MemoryAssignmentMigrationPlanRequest = z.infer<typeof MemoryAssignmentMigrationPlanRequestSchema>;

const TestMemoryAssignmentRequestSchema = z
  .object({
    providerRecordId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict()
  .optional();
type TestMemoryAssignmentRequest = z.infer<typeof TestMemoryAssignmentRequestSchema>;

export interface MemoryAssignmentRoutesDeps {
  storesFor(req: Request): UserStores;
  requestUserId(req: Request): string | undefined;
  sendRedacted(res: Response, status: number, payload: unknown): void;
  requestValidationMessage(error: unknown): string;
  clearMemoryRoutingCaches(): void;
  resolveEffectiveMemoryProviderFor(
    req: Request | undefined,
    role: MemoryRole,
    workspaceId?: string,
  ): Promise<EffectiveMemoryProvider>;
  resolveSelectedMemoryProviderFor(
    req: Request,
    role: MemoryRole,
    providerRecordId: string | undefined,
    workspaceId?: string,
  ): Promise<EffectiveMemoryProvider>;
  runMemoryProviderConnectionTest(input: {
    providerId: string;
    provider: MemoryProvider;
    kind: string;
  }): unknown;
}

const errorMessageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function parseMemoryRoleParam(raw: string): MemoryRole | undefined {
  const parsed = MemoryRoleSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function exactAssignmentFor(
  assignments: MemoryRoleAssignment[],
  input: { role: MemoryRole; userId?: string; workspaceId?: string },
): MemoryRoleAssignment | undefined {
  return assignments.find(
    (assignment) =>
      assignment.role === input.role &&
      assignment.userId === input.userId &&
      assignment.workspaceId === input.workspaceId,
  );
}

async function ensureMemoryProviderRefExists(
  stores: UserStores,
  providerRecordId: string | undefined,
): Promise<string | undefined> {
  if (providerRecordId === undefined || providerRecordId === "local" || providerRecordId === "disabled") {
    return undefined;
  }
  const state = await stores.memoryConfigStore.getState();
  return state.providers.some((provider) => provider.id === providerRecordId)
    ? undefined
    : `Memory provider "${providerRecordId}" is not configured.`;
}

async function providerOptionsForAssignments(stores: UserStores): Promise<Array<Record<string, unknown>>> {
  const state = await stores.memoryConfigStore.getState();
  return [
    {
      id: "local",
      kind: "local-inmemory",
      label: "Local default",
      capabilities: memoryProviderCapabilitiesForKind("local-inmemory"),
      builtIn: true,
    },
    {
      id: "disabled",
      kind: "disabled",
      label: "Disabled",
      capabilities: memoryProviderCapabilitiesForKind("disabled"),
      builtIn: true,
    },
    ...state.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      label: provider.label,
      config: provider.config,
      capabilities: memoryProviderCapabilitiesForKind(provider.kind),
      builtIn: false,
    })),
  ];
}

export function registerMemoryAssignmentRoutes(app: Application, deps: MemoryAssignmentRoutesDeps): void {
  const {
    storesFor,
    requestUserId,
    sendRedacted,
    requestValidationMessage,
    clearMemoryRoutingCaches,
    resolveEffectiveMemoryProviderFor,
    resolveSelectedMemoryProviderFor,
    runMemoryProviderConnectionTest,
  } = deps;

  const memoryAssignmentsPayload = async (req: Request) => {
    const userStores = storesFor(req);
    const assignments = await userStores.memoryAssignmentStore.listAssignments();
    return {
      roles: Object.values(MEMORY_ROLE_DEFINITIONS),
      assignments,
      providers: await providerOptionsForAssignments(userStores),
    };
  };

  const effectiveMemoryAssignmentsPayload = async (req: Request, workspaceId?: string) => ({
    roles: Object.values(MEMORY_ROLE_DEFINITIONS),
    effective: await Promise.all(
      MEMORY_ROLES.map(async (role) =>
        memoryRoleResolutionToJson(await resolveEffectiveMemoryProviderFor(req, role, workspaceId)),
      ),
    ),
  });

  app.get("/api/memory-roles", (_req, res) => {
    sendRedacted(res, 200, { roles: Object.values(MEMORY_ROLE_DEFINITIONS) });
  });

  app.get("/api/memory-assignments", async (req, res) => {
    try {
      sendRedacted(res, 200, await memoryAssignmentsPayload(req));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/memory-assignments/effective", async (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
      sendRedacted(res, 200, await effectiveMemoryAssignmentsPayload(req, workspaceId));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.put("/api/memory-assignments/:role", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    let body: UpsertMemoryAssignmentRequest;
    try {
      body = UpsertMemoryAssignmentRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const providerError = await ensureMemoryProviderRefExists(userStores, body.providerRecordId);
      if (providerError) return sendRedacted(res, 400, { error: providerError });
      const fallbackError = await ensureMemoryProviderRefExists(userStores, body.fallbackProviderRecordId);
      if (fallbackError) return sendRedacted(res, 400, { error: fallbackError });

      const userId = requestUserId(req);
      const assignments = await userStores.memoryAssignmentStore.listAssignments();
      const existing = exactAssignmentFor(assignments, { role, userId, workspaceId: body.workspaceId });
      const now = new Date().toISOString();
      const assignment = createMemoryRoleAssignment({
        role,
        providerRecordId: body.providerRecordId,
        userId,
        workspaceId: body.workspaceId,
        enabled: body.enabled,
        readPriority: body.readPriority,
        writePriority: body.writePriority,
        fallbackProviderRecordId: body.fallbackProviderRecordId,
        retentionPolicy: body.retentionPolicy,
        maxEntries: body.maxEntries,
        maxUsdPerDay: body.maxUsdPerDay,
        existing,
        now,
      });

      const result = await userStores.memoryAssignmentStore.upsertAssignment(assignment);
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      clearMemoryRoutingCaches();

      sendRedacted(res, 200, {
        assignment: result.value,
        effective: memoryRoleResolutionToJson(await resolveEffectiveMemoryProviderFor(req, role, body.workspaceId)),
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/:role/test", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    let body: TestMemoryAssignmentRequest;
    try {
      body = TestMemoryAssignmentRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const workspaceId = body?.workspaceId;
      const providerRecordId = body?.providerRecordId;
      const providerError = await ensureMemoryProviderRefExists(storesFor(req), providerRecordId);
      if (providerError) return sendRedacted(res, 400, { error: providerError });
      const effective = await resolveSelectedMemoryProviderFor(req, role, providerRecordId, workspaceId);
      if (effective.status === "disabled" || !effective.provider) {
        return sendRedacted(res, 200, {
          ok: effective.status === "disabled",
          role,
          providerId: effective.providerRecordId,
          code: effective.status === "disabled" ? undefined : "CONFIG_INVALID",
          error: effective.error,
          networkAttempted: false,
          effective: memoryRoleResolutionToJson(effective),
        });
      }

      const result = runMemoryProviderConnectionTest({
        providerId: effective.provider.id,
        provider: effective.provider,
        kind: effective.provider.kind,
      });
      sendRedacted(res, 200, { role, ...(result as object), effective: memoryRoleResolutionToJson(effective) });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/reset", async (req, res) => {
    let body: MemoryAssignmentResetRequest;
    try {
      body = MemoryAssignmentResetRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const result = await userStores.memoryAssignmentStore.resetAssignments(
        body?.workspaceId ? { workspaceId: body.workspaceId } : undefined,
      );
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      clearMemoryRoutingCaches();
      sendRedacted(res, 200, await memoryAssignmentsPayload(req));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/:role/migrate/plan", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    let body: MemoryAssignmentMigrationPlanRequest;
    try {
      body = MemoryAssignmentMigrationPlanRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const targetProviderRecordId = body?.targetProviderRecordId;
      const providerError = await ensureMemoryProviderRefExists(userStores, targetProviderRecordId);
      if (providerError) return sendRedacted(res, 400, { error: providerError });

      const workspaceId = body?.workspaceId;
      const effective = await resolveEffectiveMemoryProviderFor(req, role, workspaceId);
      const target = targetProviderRecordId ?? effective.providerRecordId;
      const targetCapabilities = target === "local" || target === "disabled"
        ? memoryProviderCapabilitiesForKind(target)
        : memoryProviderCapabilitiesForKind(
            (await userStores.memoryConfigStore.getState()).providers.find((provider) => provider.id === target)?.kind,
          );
      sendRedacted(res, 200, {
        role,
        destructive: false,
        sourceProviderRecordId: effective.providerRecordId,
        targetProviderRecordId: target,
        estimatedEntries: "unknown",
        steps: [
          "Read current role assignment and provider readiness.",
          "Estimate entries for this role when a store exposes counts.",
          "Copy to the target provider in a later migration chunk.",
          "Verify copied entries before any future cutover.",
        ],
        warnings: [
          ...effective.warnings,
          ...memoryCapabilityWarningsForRole({ role, capabilities: targetCapabilities, providerRecordId: target }),
        ],
        automaticExecution: false,
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });
}
