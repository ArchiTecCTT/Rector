import nodeFs from "node:fs";
import nodePath from "node:path";
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

// ---------------------------------------------------------------------------
// Workspace sandbox operations (ORN-37)
// ---------------------------------------------------------------------------

export const SandboxOperationKindSchema = z.enum([
  "READ_FILE",
  "LIST_DIR",
  "PROPOSE_PATCH",
  "RUN_COMMAND",
]);
export type SandboxOperationKind = z.infer<typeof SandboxOperationKindSchema>;

export const SandboxDenialReasonSchema = z.enum([
  "INVALID_PATH", // empty, null, or whitespace-only candidate path
  "ABSOLUTE_PATH", // candidate path is absolute
  "PATH_ESCAPE", // candidate path contains a ".." segment
  "SYMLINK_ESCAPE", // realpath resolves outside the workspace root
  "ARBITRARY_SHELL_DISABLED",
  "COMMAND_NOT_ALLOWLISTED",
  "DESTRUCTIVE_COMMAND_BLOCKED",
  "COMMAND_TIMEOUT",
  "NEEDS_APPROVAL",
]);
export type SandboxDenialReason = z.infer<typeof SandboxDenialReasonSchema>;

export const SandboxOperationSchema = z.object({
  kind: SandboxOperationKindSchema,
  path: z.string().min(1).optional(), // required for READ_FILE / LIST_DIR / PROPOSE_PATCH
  operation: PatchOperationSchema.optional(), // required for PROPOSE_PATCH
  content: z.string().optional(), // patch content for PROPOSE_PATCH
  command: z.string().min(1).optional(), // required for RUN_COMMAND (allowlisted)
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  approvalId: z.string().min(1).optional(), // references an explicit SandboxApproval
  metadata: z.record(z.unknown()).default({}),
});
export type SandboxOperationInput = z.input<typeof SandboxOperationSchema>;
export type SandboxOperation = z.infer<typeof SandboxOperationSchema>;

export const SandboxOperationResultSchema = z.object({
  kind: SandboxOperationKindSchema,
  status: SandboxExecutionStatusSchema, // SUCCEEDED | FAILED | DENIED | NEEDS_APPROVAL
  denialReason: SandboxDenialReasonSchema.optional(),
  resolvedPath: z.string().min(1).optional(), // absolute, contained path (never returned on denial)
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  entries: z.array(z.string()).optional(), // for LIST_DIR
  fileContent: z.string().optional(), // for READ_FILE (redacted)
  artifacts: z.array(SandboxArtifactSchema).default([]), // PatchArtifact + captured stdio
  approvalGates: z.array(ApprovalGateSchema).default([]),
  networkCalls: z.literal(0),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});
export type SandboxOperationResult = z.infer<typeof SandboxOperationResultSchema>;

export const SandboxApprovalSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["FILE_WRITE", "COMMAND"]),
  target: z.string().min(1), // path or command the approval authorizes
  approvedBy: z.string().min(1),
});
export type SandboxApproval = z.infer<typeof SandboxApprovalSchema>;

/**
 * Injectable filesystem surface used by the workspace sandbox. Tests supply an
 * in-memory implementation so no real disk is required; production code falls
 * back to `node:fs`. `resolveWithinWorkspace` only needs `realpathSync`.
 */
export interface WorkspaceFs {
  realpathSync(path: string): string;
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
  writeFileSync(path: string, data: string): void;
  existsSync(path: string): boolean;
}

export type ResolveWithinWorkspaceResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: SandboxDenialReason };

/**
 * Pure, side-effect-free containment gate. Resolves `candidatePath` against
 * `workspaceRoot`, applying validation checks in the fixed order:
 *   1. empty / whitespace-only path  -> INVALID_PATH
 *   2. absolute path                 -> ABSOLUTE_PATH
 *   3. ".." (parent-traversal) segment -> PATH_ESCAPE
 *   4. symlink realpath escape       -> SYMLINK_ESCAPE
 *
 * `isSafeRelativePath` is reused as the first cheap gate for the happy path. On
 * success the returned `absolutePath` is equal to, or a descendant of, the
 * (realpath-resolved) workspace root. No I/O is performed on a denied path: the
 * only filesystem access is the `realpathSync` lookup used by the symlink check,
 * which runs strictly after the cheap denial checks have passed.
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  candidatePath: string,
  fsImpl?: Pick<WorkspaceFs, "realpathSync">,
): ResolveWithinWorkspaceResult {
  // 1. empty-path check (INVALID_PATH) — before any other inspection or I/O.
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    return { ok: false, reason: "INVALID_PATH" };
  }

  // Cheap happy-path gate: a clean safe relative path skips the per-reason
  // string checks below and proceeds straight to the symlink containment check.
  if (!isSafeRelativePath(candidatePath)) {
    // 2. absolute-path check (ABSOLUTE_PATH).
    if (isAbsolutePath(candidatePath)) {
      return { ok: false, reason: "ABSOLUTE_PATH" };
    }
    // 3. parent-traversal check (PATH_ESCAPE).
    if (hasParentTraversalSegment(candidatePath)) {
      return { ok: false, reason: "PATH_ESCAPE" };
    }
    // Any remaining reason `isSafeRelativePath` rejected (e.g. a "." segment) is
    // harmless: it cannot escape the root, so normalization below handles it.
  }

  // 4. symlink realpath escape check (SYMLINK_ESCAPE). This is the only step
  // that touches the filesystem, and only for paths that passed the checks above.
  const realpathSync = fsImpl?.realpathSync ?? ((p: string) => nodeFs.realpathSync(p));
  const realRoot = safeRealpath(nodePath.resolve(workspaceRoot), realpathSync);
  const absoluteCandidate = nodePath.resolve(realRoot, candidatePath);
  const realCandidate = realpathOrNearestExisting(absoluteCandidate, realpathSync);

  if (!isContainedWithin(realRoot, realCandidate)) {
    return { ok: false, reason: "SYMLINK_ESCAPE" };
  }

  return { ok: true, absolutePath: realCandidate };
}

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

/**
 * Detects absolute paths in either POSIX or Windows form, independent of the
 * host platform, so adversarial inputs in tests are classified correctly:
 *   - POSIX root: "/foo"
 *   - backslash / UNC root: "\\foo", "\\\\server\\share"
 *   - Windows drive: "C:\\foo", "c:/foo"
 */
function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return false;
}

function hasParentTraversalSegment(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => segment === "..");
}

function safeRealpath(path: string, realpathSync: (p: string) => string): string {
  try {
    return realpathSync(path);
  } catch {
    return nodePath.resolve(path);
  }
}

/**
 * Resolves the realpath of `target`. When `target` does not exist (e.g. a new
 * file proposed by PROPOSE_PATCH), it resolves the realpath of the nearest
 * existing ancestor and re-appends the non-existent tail, so a symlinked
 * ancestor still triggers a SYMLINK_ESCAPE while a brand-new contained file
 * resolves successfully.
 */
function realpathOrNearestExisting(target: string, realpathSync: (p: string) => string): string {
  let current = nodePath.resolve(target);
  const tail: string[] = [];

  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? nodePath.resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without an existing ancestor; fall back
        // to the normalized absolute target.
        return nodePath.resolve(target);
      }
      tail.push(nodePath.basename(current));
      current = parent;
    }
  }
}

function isContainedWithin(root: string, target: string): boolean {
  const relative = nodePath.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
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
