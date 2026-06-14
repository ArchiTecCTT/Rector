import { WorkspaceSandboxAdapter, SandboxOperationSchema, type SandboxOperationInput } from "../sandbox";
import { redactSecrets } from "../security/redaction";
import { ToolRegistry } from "./registry";
import { toolSuccess, type ToolHandlerContext, type ToolRegistryEntry } from "./types";

const SANDBOX_OPERATION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "object" },
  },
  additionalProperties: true,
};

export function loadBuiltinTools(registry: ToolRegistry): void {
  for (const entry of builtinToolEntries()) {
    registry.register(entry);
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  loadBuiltinTools(registry);
  return registry;
}

export function builtinToolEntries(): ToolRegistryEntry[] {
  return [
    {
      definition: {
        name: "sandbox.execute",
        description: "Execute an allowlisted sandbox command through the selected sandbox environment.",
        inputSchema: SANDBOX_OPERATION_INPUT_SCHEMA,
        risk: "high",
        requiresApproval: false,
        requiresSandbox: true,
      },
      source: "builtin",
      handler: (args, ctx) => runSandboxOperation("sandbox.execute", args, ctx, "RUN_COMMAND"),
    },
    {
      definition: {
        name: "workspace.read_file",
        description: "Read a contained workspace file through the sandbox filesystem boundary.",
        inputSchema: SANDBOX_OPERATION_INPUT_SCHEMA,
        risk: "low",
        requiresApproval: false,
        requiresSandbox: true,
      },
      source: "builtin",
      handler: (args, ctx) => runSandboxOperation("workspace.read_file", args, ctx, "READ_FILE"),
    },
    {
      definition: {
        name: "workspace.list_dir",
        description: "List a contained workspace directory through the sandbox filesystem boundary.",
        inputSchema: SANDBOX_OPERATION_INPUT_SCHEMA,
        risk: "low",
        requiresApproval: false,
        requiresSandbox: true,
      },
      source: "builtin",
      handler: (args, ctx) => runSandboxOperation("workspace.list_dir", args, ctx, "LIST_DIR"),
    },
    {
      definition: {
        name: "workspace.write_file",
        description: "Write a contained workspace file after explicit file-write approval.",
        inputSchema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        risk: "destructive",
        requiresApproval: true,
        requiresSandbox: true,
      },
      source: "builtin",
      handler: (args, ctx) => runSandboxOperation("workspace.write_file", writeOperationFromArgs(args), ctx, "PROPOSE_PATCH"),
    },
    {
      definition: {
        name: "workspace.apply_patch",
        description: "Apply or propose a contained workspace patch through the sandbox approval boundary.",
        inputSchema: SANDBOX_OPERATION_INPUT_SCHEMA,
        risk: "high",
        requiresApproval: true,
        requiresSandbox: true,
      },
      source: "builtin",
      handler: (args, ctx) => runSandboxOperation("workspace.apply_patch", args, ctx, "PROPOSE_PATCH"),
    },
    {
      definition: {
        name: "workspace.validate",
        description: "Run a validation command or report validation metadata for a DAG validation node.",
        inputSchema: SANDBOX_OPERATION_INPUT_SCHEMA,
        risk: "low",
        requiresApproval: false,
        requiresSandbox: false,
      },
      source: "builtin",
      handler: async (args, ctx) => {
        if (hasOperationLikeInput(args)) {
          return runSandboxOperation("workspace.validate", args, ctx, "RUN_COMMAND");
        }
        return toolSuccess("workspace.validate", {
          validation: {
            passed: true,
            nodeId: ctx.nodeId,
          },
        });
      },
    },
    {
      definition: {
        name: "simulator.echo",
        description: "Deterministic simulator-only echo tool used by CI and executor simulation.",
        inputSchema: { type: "object", additionalProperties: true },
        risk: "low",
        requiresApproval: false,
        requiresSandbox: false,
      },
      source: "builtin",
      handler: async (args) => toolSuccess("simulator.echo", { echo: redactSecrets(args) }),
    },
  ];
}

async function runSandboxOperation(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
  fallbackKind: SandboxOperationInput["kind"],
) {
  const operation = operationFromArgs(args, fallbackKind);
  const sandbox = ctx.sandbox ?? new WorkspaceSandboxAdapter({
    workspaceRoot: ctx.workspaceRoot ?? process.cwd(),
    fsImpl: ctx.fsImpl,
    commandRunner: ctx.commandRunner,
    approvals: ctx.approvals ?? [],
    now: undefined,
  });
  const result = await sandbox.operate(operation, {
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    workspaceRoot: ctx.workspaceRoot,
    abortSignal: ctx.abortSignal,
  });
  return toolSuccess(
    toolName,
    {
      sandboxResult: result,
      operationResult: result,
      ...(ctx.steerHint ? { steerGuidance: ctx.steerHint } : {}),
    },
    {
      sandboxStatus: result.status,
      denialReason: result.denialReason,
      approvalGateId: result.approvalGates.find((gate) => gate.required)?.id,
      ...(ctx.steerHint ? { steerGuidance: ctx.steerHint } : {}),
    },
  );
}

function operationFromArgs(
  args: Record<string, unknown>,
  fallbackKind: SandboxOperationInput["kind"],
): SandboxOperationInput {
  const nested = args.operation;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return SandboxOperationSchema.parse(nested);
  }
  return SandboxOperationSchema.parse({
    kind: args.kind ?? fallbackKind,
    path: args.path,
    operation: args.patchOperation ?? args.operationKind,
    content: args.content,
    command: args.command,
    args: Array.isArray(args.args) ? args.args : [],
    timeoutMs: args.timeoutMs,
    approvalId: args.approvalId,
    metadata: args.metadata ?? {},
  });
}

function writeOperationFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  return {
    operation: {
      kind: "PROPOSE_PATCH",
      path: args.path,
      operation: "update",
      content: args.content,
      approvalId: args.approvalId,
      metadata: args.metadata ?? {},
    },
  };
}

function hasOperationLikeInput(args: Record<string, unknown>): boolean {
  return Boolean(args.operation ?? args.command ?? args.kind);
}
