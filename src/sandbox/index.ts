import { z } from "zod";

export const SANDBOX_ADAPTER_API_VERSION = "rector.sandbox.v1alpha1";

export const SandboxCommandKindSchema = z.enum(["fake", "local", "shell"]);
export type SandboxCommandKind = z.infer<typeof SandboxCommandKindSchema>;

export const SandboxCommandSchema = z.object({
  kind: SandboxCommandKindSchema.default("fake"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().min(1, "timeoutMs must be at least 1").max(3_600_000),
  metadata: z.record(z.unknown()).default({}),
});
export type SandboxCommandInput = z.input<typeof SandboxCommandSchema>;
export type SandboxCommand = z.infer<typeof SandboxCommandSchema>;

export const SandboxProviderMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  apiVersion: z.string().min(1),
  localOnly: z.boolean(),
  networkAccess: z.literal(false),
  arbitraryShell: z.literal(false),
  supportedCommands: z.array(z.string().min(1)),
  stub: z.boolean().default(false),
});
export type SandboxProviderMetadata = z.infer<typeof SandboxProviderMetadataSchema>;

export const ApprovalGateTypeSchema = z.enum(["FILE_WRITE"]);
export type ApprovalGateType = z.infer<typeof ApprovalGateTypeSchema>;

export const ApprovalGateSchema = z.object({
  id: z.string().min(1),
  type: ApprovalGateTypeSchema,
  required: z.boolean(),
  approved: z.boolean(),
  reason: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;

export const PatchOperationSchema = z.enum(["add", "update", "delete"]);
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const PatchArtifactSchema = z.object({
  kind: z.literal("PATCH"),
  id: z.string().min(1),
  path: z.string().min(1).refine(isSafeRelativePath, "path must be a safe relative file path"),
  operation: PatchOperationSchema,
  unifiedDiff: z.string().min(1),
  createdAt: z.string().datetime(),
  approval: z.object({
    required: z.literal(true),
    approved: z.boolean(),
    approvedBy: z.string().min(1).optional(),
  }),
  metadata: z.record(z.unknown()).default({}),
});
export type PatchArtifact = z.infer<typeof PatchArtifactSchema>;

export const SandboxArtifactSchema = PatchArtifactSchema;
export type SandboxArtifact = PatchArtifact;

export const SandboxExecutionStatusSchema = z.enum(["SUCCEEDED", "FAILED", "DENIED", "NEEDS_APPROVAL"]);
export type SandboxExecutionStatus = z.infer<typeof SandboxExecutionStatusSchema>;

export const SandboxExecutionResultSchema = z.object({
  adapter: SandboxProviderMetadataSchema,
  status: SandboxExecutionStatusSchema,
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  networkCalls: z.literal(0),
  artifacts: z.array(SandboxArtifactSchema).default([]),
  approvalGates: z.array(ApprovalGateSchema).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type SandboxExecutionResult = z.infer<typeof SandboxExecutionResultSchema>;

export interface SandboxAdapter {
  readonly metadata: SandboxProviderMetadata;
  execute(command: SandboxCommandInput): Promise<SandboxExecutionResult>;
}

export interface SafeLocalSandboxAdapterOptions {
  now?: () => string;
}

const SAFE_LOCAL_COMMANDS = ["fake:echo", "fake:test-pass", "local:propose-patch"] as const;
const FILE_WRITE_APPROVAL_REASON = "File write proposals require explicit approval metadata before execution.";

export class SafeLocalSandboxAdapter implements SandboxAdapter {
  readonly metadata: SandboxProviderMetadata;
  private readonly now: () => string;

  constructor(options: SafeLocalSandboxAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.metadata = SandboxProviderMetadataSchema.parse({
      id: "safe-local",
      name: "Safe Local Sandbox",
      apiVersion: SANDBOX_ADAPTER_API_VERSION,
      localOnly: true,
      networkAccess: false,
      arbitraryShell: false,
      supportedCommands: [...SAFE_LOCAL_COMMANDS],
      stub: false,
    });
  }

  async execute(commandInput: SandboxCommandInput): Promise<SandboxExecutionResult> {
    const command = SandboxCommandSchema.parse(commandInput);
    const startedAt = this.safeNow();

    if (command.kind === "shell") {
      return this.denied(command, startedAt, "ARBITRARY_SHELL_DISABLED", "Arbitrary shell execution is denied by default.");
    }

    if (!isAllowlistedCommand(command.command)) {
      return this.denied(command, startedAt, "COMMAND_NOT_ALLOWLISTED", `Command ${command.command} is not in the safe local allowlist.`);
    }

    if (command.command === "fake:echo") {
      return this.result({
        command,
        startedAt,
        status: "SUCCEEDED",
        exitCode: 0,
        stdout: command.args.join(" "),
        stderr: "",
        metadata: { command: command.command },
      });
    }

    if (command.command === "fake:test-pass") {
      return this.result({
        command,
        startedAt,
        status: "SUCCEEDED",
        exitCode: 0,
        stdout: "fake tests passed",
        stderr: "",
        metadata: { command: command.command, tests: { passed: 1, failed: 0 } },
      });
    }

    return this.proposePatch(command, startedAt);
  }

  private proposePatch(command: SandboxCommand, startedAt: string): SandboxExecutionResult {
    const targetPath = command.args[0];
    const content = command.args[1] ?? "";
    const operation = parsePatchOperation(command.metadata.operation);

    if (!isSafeRelativePath(targetPath)) {
      return this.denied(command, startedAt, "UNSAFE_PATH", "Patch proposals require a safe relative file path.");
    }

    const approvalMetadata = recordFrom(command.metadata.approval);
    const approved = approvalMetadata?.fileWriteApproved === true;
    const approvedBy = typeof approvalMetadata?.approvedBy === "string" && approvalMetadata.approvedBy.length > 0
      ? approvalMetadata.approvedBy
      : undefined;
    const gate = ApprovalGateSchema.parse({
      id: `approval:file-write:${targetPath}`,
      type: "FILE_WRITE",
      required: true,
      approved,
      reason: FILE_WRITE_APPROVAL_REASON,
      metadata: { path: targetPath, operation },
    });
    const artifact = PatchArtifactSchema.parse({
      kind: "PATCH",
      id: `patch:${stableId(targetPath)}`,
      path: targetPath,
      operation,
      unifiedDiff: unifiedDiffFor(targetPath, content, operation),
      createdAt: startedAt,
      approval: {
        required: true,
        approved,
        approvedBy,
      },
      metadata: {
        applied: false,
        command: command.command,
        safeLocalOnly: true,
      },
    });

    return this.result({
      command,
      startedAt,
      status: approved ? "SUCCEEDED" : "NEEDS_APPROVAL",
      exitCode: 0,
      stdout: approved ? `approved patch proposal for ${targetPath}` : `approval required for patch proposal ${targetPath}`,
      stderr: "",
      artifacts: [artifact],
      approvalGates: [gate],
      metadata: {
        command: command.command,
        fileWriteApproved: approved,
        applied: false,
      },
    });
  }

  private denied(
    command: SandboxCommand,
    startedAt: string,
    deniedReason: string,
    message: string,
  ): SandboxExecutionResult {
    return this.result({
      command,
      startedAt,
      status: "DENIED",
      exitCode: 126,
      stdout: "",
      stderr: `denied: ${message}`,
      metadata: { command: command.command, deniedReason },
    });
  }

  private result(input: {
    command: SandboxCommand;
    startedAt: string;
    status: SandboxExecutionStatus;
    exitCode: number;
    stdout: string;
    stderr: string;
    artifacts?: SandboxArtifact[];
    approvalGates?: ApprovalGate[];
    metadata?: Record<string, unknown>;
  }): SandboxExecutionResult {
    const completedAt = this.safeNow();
    return SandboxExecutionResultSchema.parse({
      adapter: this.metadata,
      status: input.status,
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
      startedAt: input.startedAt,
      completedAt,
      durationMs: durationMs(input.startedAt, completedAt),
      networkCalls: 0,
      artifacts: input.artifacts ?? [],
      approvalGates: input.approvalGates ?? [],
      metadata: input.metadata ?? {},
    });
  }

  private safeNow(): string {
    const value = this.now();
    return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  }
}

export interface SandboxStubOptions {
  now?: () => string;
}

export function createE2BSandboxAdapterStub(options: SandboxStubOptions = {}): SandboxAdapter {
  return new NoNetworkSandboxStub("e2b", "E2B Sandbox Stub", options.now);
}

export function createDepotSandboxAdapterStub(options: SandboxStubOptions = {}): SandboxAdapter {
  return new NoNetworkSandboxStub("depot", "Depot Sandbox Stub", options.now);
}

class NoNetworkSandboxStub implements SandboxAdapter {
  readonly metadata: SandboxProviderMetadata;
  private readonly now: () => string;

  constructor(id: "e2b" | "depot", name: string, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    this.metadata = SandboxProviderMetadataSchema.parse({
      id,
      name,
      apiVersion: SANDBOX_ADAPTER_API_VERSION,
      localOnly: false,
      networkAccess: false,
      arbitraryShell: false,
      supportedCommands: [],
      stub: true,
    });
  }

  async execute(commandInput: SandboxCommandInput): Promise<SandboxExecutionResult> {
    const command = SandboxCommandSchema.parse(commandInput);
    const startedAt = this.safeNow();
    const completedAt = this.safeNow();
    return SandboxExecutionResultSchema.parse({
      adapter: this.metadata,
      status: "DENIED",
      exitCode: 126,
      stdout: "",
      stderr: `${this.metadata.name} is a no-network stub in local alpha mode.`,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      networkCalls: 0,
      artifacts: [],
      approvalGates: [],
      metadata: {
        provider: this.metadata.id,
        stub: true,
        command: command.command,
        deniedReason: "SANDBOX_PROVIDER_STUB_NO_NETWORK",
      },
    });
  }

  private safeNow(): string {
    const value = this.now();
    return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  }
}

function isAllowlistedCommand(command: string): boolean {
  return (SAFE_LOCAL_COMMANDS as readonly string[]).includes(command);
}

function isSafeRelativePath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parsePatchOperation(value: unknown): PatchOperation {
  const parsed = PatchOperationSchema.safeParse(value);
  return parsed.success ? parsed.data : "update";
}

function unifiedDiffFor(path: string, content: string, operation: PatchOperation): string {
  if (operation === "delete") {
    return `--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${content}`;
  }

  const oldPath = operation === "add" ? "/dev/null" : `a/${path}`;
  return `--- ${oldPath}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${content}`;
}

function stableId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function durationMs(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
