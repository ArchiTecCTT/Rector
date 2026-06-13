import { redactSecrets, redactString } from "../security/redaction";
import type { SandboxApproval } from "../sandbox";
import type { ToolRegistry } from "./registry";
import {
  ToolResultSchema,
  toolError,
  type ToolHandlerContext,
  type ToolRegistryEntry,
  type ToolResult,
} from "./types";

export interface MiddlewareContext {
  registry: ToolRegistry;
  toolName: string;
  args: Record<string, unknown>;
  handlerContext: ToolHandlerContext;
  entry?: ToolRegistryEntry;
  redactedArgs?: Record<string, unknown>;
  trace: string[];
}

export type ToolMiddleware = (
  ctx: MiddlewareContext,
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

export const DEFAULT_TOOL_MIDDLEWARE_ORDER = [
  "budget",
  "redactionInput",
  "approval",
  "policy",
  "handler",
  "redactionOutput",
  "trace",
] as const;

export const budgetMiddleware: ToolMiddleware = async (ctx, next) => {
  ctx.trace.push("budget");
  const budget = ctx.handlerContext.budget;
  if (budget && budget.maxModelCalls <= 0) {
    return toolError(ctx.toolName, "BUDGET_EXCEEDED", "Tool execution denied because the run budget is exhausted", {
      halt: true,
      middlewareHalt: true,
      details: { maxModelCalls: budget.maxModelCalls },
      metadata: { middleware: "budget" },
    });
  }
  return next();
};

export const redactionInputMiddleware: ToolMiddleware = async (ctx, next) => {
  ctx.trace.push("redactionInput");
  ctx.redactedArgs = redactRecord(ctx.args);
  return next();
};

export const approvalMiddleware: ToolMiddleware = async (ctx, next) => {
  ctx.trace.push("approval");
  const definition = ctx.entry?.definition;
  const target = approvalTargetFor(ctx.args);
  const requiresPreApproval =
    ctx.toolName === "workspace.write_file" ||
    ctx.args.destructive === true ||
    definition?.risk === "destructive";

  if (requiresPreApproval && !hasApproval(ctx.handlerContext.approvals, "FILE_WRITE", target)) {
    return toolError(ctx.toolName, "PERMISSION_DENIED", "Tool execution requires explicit approval", {
      halt: true,
      middlewareHalt: true,
      approvalGateId: target ? `approval:file-write:${target}` : undefined,
      details: { target: target ? redactString(target) : undefined, risk: definition?.risk },
      metadata: { middleware: "approval" },
    });
  }

  return next();
};

export const policyMiddleware: ToolMiddleware = async (ctx, next) => {
  ctx.trace.push("policy");
  const policy = ctx.handlerContext.toolPolicy;
  const allowed = stringArray(policy?.allowed);
  const denied = stringArray(policy?.denied);
  if (allowed.length > 0 && !allowed.includes(ctx.toolName) && !allowed.some((permission) => permissionMatchesTool(permission, ctx.toolName))) {
    return policyDenied(ctx, "Tool is not present in the node allowlist", { allowed });
  }
  if (denied.includes(ctx.toolName)) {
    return policyDenied(ctx, "Tool is explicitly denied by node policy", { denied });
  }
  return next();
};

export const redactionOutputMiddleware: ToolMiddleware = async (ctx, next) => {
  const result = await next();
  ctx.trace.push("redactionOutput");
  return ToolResultSchema.parse(redactSecrets(result));
};

export const traceMiddleware: ToolMiddleware = async (ctx, next) => {
  const phase = ctx.handlerContext.phase ?? "EXECUTING";
  await ctx.handlerContext.appendRunEvent?.({
    type: "TOOL_INVOKED",
    phase,
    payload: {
      source: "tool-registry",
      toolName: redactString(ctx.toolName),
      nodeId: ctx.handlerContext.nodeId,
      input: ctx.redactedArgs ?? redactRecord(ctx.args),
      middlewareOrder: DEFAULT_TOOL_MIDDLEWARE_ORDER,
    },
  });

  const result = await next();
  ctx.trace.push("trace");
  const completed = ToolResultSchema.parse({
    ...result,
    metadata: {
      ...result.metadata,
      middlewareTrace: ctx.trace,
      middlewareOrder: DEFAULT_TOOL_MIDDLEWARE_ORDER,
    },
  });
  await ctx.handlerContext.appendRunEvent?.({
    type: "TOOL_COMPLETED",
    phase,
    payload: {
      source: "tool-registry",
      toolName: redactString(ctx.toolName),
      nodeId: ctx.handlerContext.nodeId,
      ok: completed.ok,
      halt: shouldHalt(completed),
      middlewareHalt: completed.middlewareHalt,
      approvalGateId: completed.approvalGateId,
      error: completed.error,
      output: redactRecord(completed.output),
      middlewareTrace: completed.metadata.middlewareTrace,
    },
  });
  return completed;
};

export const DEFAULT_TOOL_MIDDLEWARE: ToolMiddleware[] = [
  traceMiddleware,
  budgetMiddleware,
  redactionInputMiddleware,
  approvalMiddleware,
  policyMiddleware,
  redactionOutputMiddleware,
];

export async function runToolWithMiddleware(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  handlerContext: ToolHandlerContext,
  middleware: ToolMiddleware[] = DEFAULT_TOOL_MIDDLEWARE,
): Promise<ToolResult> {
  const ctx: MiddlewareContext = {
    registry,
    toolName: name,
    args,
    handlerContext,
    entry: registry.get(name),
    trace: [],
  };

  let index = -1;
  const dispatch = async (nextIndex: number): Promise<ToolResult> => {
    if (nextIndex <= index) {
      return toolError(name, "TOOL_HANDLER_FAILED", "Tool middleware called next more than once", { halt: true });
    }
    index = nextIndex;
    const current = middleware[nextIndex];
    if (!current) {
      ctx.trace.push("handler");
      return registry.dispatch(name, ctx.args, handlerContext);
    }
    return current(ctx, () => dispatch(nextIndex + 1));
  };

  return dispatch(0);
}

export function shouldHalt(result: ToolResult): boolean {
  return result.halt === true || result.middlewareHalt === true || result.ok === false;
}

function policyDenied(
  ctx: MiddlewareContext,
  message: string,
  details: Record<string, unknown>,
): ToolResult {
  return toolError(ctx.toolName, "POLICY_DENIED", message, {
    halt: true,
    middlewareHalt: true,
    details,
    metadata: { middleware: "policy" },
  });
}

function redactRecord(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : [];
}

function approvalTargetFor(args: Record<string, unknown>): string | undefined {
  const path = args.path;
  if (typeof path === "string" && path.length > 0) return path;
  const operation = args.operation;
  if (operation && typeof operation === "object" && !Array.isArray(operation)) {
    const operationPath = (operation as Record<string, unknown>).path;
    if (typeof operationPath === "string" && operationPath.length > 0) return operationPath;
  }
  return undefined;
}

function hasApproval(
  approvals: SandboxApproval[] | undefined,
  scope: SandboxApproval["scope"],
  target: string | undefined,
): boolean {
  if (!target) return false;
  return (approvals ?? []).some((approval) => approval.scope === scope && approval.target === target);
}

function permissionMatchesTool(permission: string, toolName: string): boolean {
  const normalized = permission.toLowerCase();
  const tool = toolName.toLowerCase();
  if (normalized === tool) return true;
  if (tool === "sandbox.execute") return normalized.includes("command") || normalized.includes("validation");
  if (tool === "workspace.read_file") return normalized.includes("read");
  if (tool === "workspace.write_file" || tool === "workspace.apply_patch") {
    return normalized.includes("write") || normalized.includes("patch") || normalized.includes("file");
  }
  return false;
}
