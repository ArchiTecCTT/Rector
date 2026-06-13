import { z } from "zod";

import type { RunPhase } from "../protocol/phases";
import type {
  CommandRunner,
  SandboxApproval,
  SandboxOperationInput,
  SandboxOperationResult,
  SandboxExecutionContext,
  WorkspaceFs,
} from "../sandbox";
import type { Budget } from "../store/schemas";
import type { IterationBudget } from "../orchestration/turnBudget";

export const ToolRiskSchema = z.enum(["low", "medium", "high", "destructive"]);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolSchemaDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  risk: ToolRiskSchema.default("low"),
  requiresApproval: z.boolean().default(false),
  requiresSandbox: z.boolean().default(false),
});
export type ToolSchemaDefinition = z.infer<typeof ToolSchemaDefinitionSchema>;

export const ToolErrorCodeSchema = z.enum([
  "TOOL_NOT_FOUND",
  "TOOL_UNAVAILABLE",
  "TOOL_HANDLER_FAILED",
  "BUDGET_EXCEEDED",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "POLICY_DENIED",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  toolName: z.string().min(1).optional(),
  output: z.record(z.unknown()).default({}),
  error: ToolErrorSchema.optional(),
  halt: z.boolean().default(false),
  approvalGateId: z.string().min(1).optional(),
  middlewareHalt: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({}),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface SandboxOperationExecutor {
  operate(operation: SandboxOperationInput, ctx?: SandboxExecutionContext): Promise<SandboxOperationResult>;
}

export interface ToolEventSinkInput {
  type: "TOOL_INVOKED" | "TOOL_COMPLETED" | "RUN_BUDGET_EXHAUSTED";
  phase: RunPhase;
  payload: Record<string, unknown>;
}

export interface ToolAvailabilityModuleRegistry {
  isEnabled(id: string): boolean;
}

export type ToolHandlerContext = {
  runId: string;
  nodeId: string;
  conversationId: string;
  phase?: RunPhase;
  workspaceRoot?: string;
  fsImpl?: WorkspaceFs;
  commandRunner?: CommandRunner;
  approvals?: SandboxApproval[];
  budget?: Budget;
  turnBudget?: IterationBudget;
  abortSignal?: AbortSignal;
  steerHint?: string;
  sandbox?: SandboxOperationExecutor;
  moduleRegistry?: ToolAvailabilityModuleRegistry;
  toolPermissions?: string[];
  toolPolicy?: Record<string, unknown>;
  appendRunEvent?: (event: ToolEventSinkInput) => Promise<void> | void;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolResult>;

export type ToolCheckFn = (
  ctx: ToolHandlerContext,
) => boolean | Promise<boolean>;

export type ToolRegistryEntry = {
  definition: ToolSchemaDefinition;
  handler: ToolHandler;
  checkFn?: ToolCheckFn;
  source: "builtin" | "module";
  moduleId?: string;
};

export function toolSuccess(
  toolName: string,
  output: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): ToolResult {
  return ToolResultSchema.parse({
    ok: true,
    toolName,
    output,
    metadata,
  });
}

export function toolError(
  toolName: string,
  code: ToolErrorCode,
  message: string,
  options: {
    details?: Record<string, unknown>;
    halt?: boolean;
    approvalGateId?: string;
    metadata?: Record<string, unknown>;
    middlewareHalt?: boolean;
  } = {},
): ToolResult {
  return ToolResultSchema.parse({
    ok: false,
    toolName,
    output: {},
    error: {
      code,
      message,
      ...(options.details ? { details: options.details } : {}),
    },
    halt: options.halt ?? true,
    approvalGateId: options.approvalGateId,
    middlewareHalt: options.middlewareHalt ?? options.halt ?? true,
    metadata: options.metadata ?? {},
  });
}
