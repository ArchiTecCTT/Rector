import { spawn } from "node:child_process";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";

import { evaluateSandboxRuntimeSafety, type SafetyReasonCode } from "../security/budget";
import { redactSecrets, redactString } from "../security/redaction";

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
  "COMMAND_ABORTED",
  "COMMAND_ARG_REJECTED",
  "CWD_NOT_ALLOWLISTED",
  "NETWORK_DISABLED",
  "SECRETS_DISABLED",
  "RUNTIME_BUDGET_EXCEEDED",
  "POLICY_VIOLATION",
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
  metadata: z.record(z.unknown()).default({}),
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
  existsSync?(path: string): boolean;
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

export const SandboxEnvironmentKindSchema = z.enum(["stub", "local", "e2b"]);
export type SandboxEnvironmentKind = z.infer<typeof SandboxEnvironmentKindSchema>;

export interface SandboxExecutionContext {
  runId?: string;
  nodeId?: string;
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
}

export interface SandboxEnvironment {
  readonly kind: SandboxEnvironmentKind;
  readonly supportsArbitraryShell: boolean;
  execute(command: SandboxCommandInput, ctx?: SandboxExecutionContext): Promise<SandboxExecutionResult>;
  operate(operation: SandboxOperationInput, ctx?: SandboxExecutionContext): Promise<SandboxOperationResult>;
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

// ---------------------------------------------------------------------------
// Workspace sandbox adapter (ORN-37)
// ---------------------------------------------------------------------------

/** Default command timeout (60s) applied when an operation omits `timeoutMs`. */
export const WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;

/** Hard upper bound (256 KiB) on each captured stdout/stderr stream. */
export const MAX_CAPTURED_STREAM_BYTES = 262_144;

export interface SandboxPolicy {
  /** Exact command names permitted for RUN_COMMAND. Empty means no commands. */
  allowedCommands: string[];
  /** Regex patterns denied after destructive-command detection and before execution. */
  deniedCommandPatterns: RegExp[];
  /** Absolute cwd roots allowed for command execution. Empty fails closed. */
  allowedCwdRoots: string[];
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxRuntimeMs: number;
  /** Optional runtime approval threshold; 0 disables approval gating. */
  approvalRequiredAboveRuntimeMs: number;
  /** Network access is disabled by default for all local workspace operations. */
  networkAllowed: boolean;
  /** Secret/env injection is disabled by default for all local workspace operations. */
  secretsInjectionAllowed: boolean;
  /** Shell operators in command/args are rejected unless this is explicitly true. */
  allowShellOperators: boolean;
}

export interface SandboxPolicyInput {
  allowedCommands?: string[];
  deniedCommandPatterns?: Array<string | RegExp>;
  allowedCwdRoots?: string[];
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxRuntimeMs?: number;
  approvalRequiredAboveRuntimeMs?: number;
  networkAllowed?: boolean;
  secretsInjectionAllowed?: boolean;
  allowShellOperators?: boolean;
}

export interface SafeLocalProcessRunnerOptions {
  enabled: boolean;
  /** Maps a sandbox command name to an executable path/name. Empty means no process can run. */
  commandMap: Record<string, string>;
  /** Process env variable names allowed to reach the child process. Defaults to none. */
  envAllowlist?: string[];
  /** Extra env values, still filtered through envAllowlist. */
  extraEnv?: Record<string, string>;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/** Result returned by an injected {@link CommandRunner}. */
export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the runner terminated the process because it exceeded the timeout. */
  timedOut?: boolean;
}

/**
 * Injectable command runner. Receives an already-validated (allowlisted,
 * non-shell, non-destructive, approved) command plus the contained working
 * directory and the enforced timeout, and returns the captured streams. Tests
 * inject a deterministic/counting double so no real process is ever spawned and
 * the "ran 0 times" denial invariants are observable.
 */
export type CommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) => Promise<CommandRunResult>;

export interface WorkspaceSandboxOptions {
  /** Absolute workspace root; the containment boundary for every operation. */
  workspaceRoot: string;
  /** Commands permitted for `RUN_COMMAND` (exact match). Defaults to none. */
  allowlistedCommands?: string[];
  /**
   * Commands that, even when allowlisted, require a matching `COMMAND`
   * approval before they run. Read-only/idempotent commands are not risky and
   * run without an approval. Defaults to none.
   */
  riskyCommands?: string[];
  /** Explicit approvals authorizing risky writes/commands. */
  approvals?: SandboxApproval[];
  now?: () => string;
  /** Injected filesystem surface; defaults to `node:fs`. */
  fsImpl?: WorkspaceFs;
  /** Explicit deny-by-default sandbox policy. Legacy allowlist options feed this when omitted. */
  policy?: SandboxPolicyInput;
  /** Opt-in real local process runner. Omitted/disabled keeps the deterministic no-process stub. */
  safeLocalRunner?: SafeLocalProcessRunnerOptions;
  /** Injected command runner; defaults to a deterministic local stub unless safeLocalRunner is enabled. */
  commandRunner?: CommandRunner;
}

/**
 * Deterministic, network-free default command runner. Real subprocess
 * execution is wired up by the DAG-to-sandbox bridge (a later task); here a
 * command that has already cleared every policy gate reports a contained
 * success so the local default never spawns a process or touches the network.
 */
const defaultCommandRunner: CommandRunner = async ({ command, args, abortSignal }) => {
  if (abortSignal?.aborted) {
    return { exitCode: 130, stdout: "", stderr: "command aborted", timedOut: false };
  }
  return {
    exitCode: 0,
    stdout: `${[command, ...args].join(" ").trim()} completed`,
    stderr: "",
  };
};

const defaultWorkspaceFs: WorkspaceFs = {
  realpathSync: (p) => nodeFs.realpathSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p, "utf8"),
  readdirSync: (p) => nodeFs.readdirSync(p),
  writeFileSync: (p, data) => nodeFs.writeFileSync(p, data, "utf8"),
  existsSync: (p) => nodeFs.existsSync(p),
};

export function createSandboxPolicy(
  input: SandboxPolicyInput = {},
  defaults: { workspaceRoot: string; allowedCommands?: string[] },
): SandboxPolicy {
  const allowedCwdRoots = input.allowedCwdRoots?.map((root) => nodePath.resolve(root)) ?? [nodePath.resolve(defaults.workspaceRoot)];
  return {
    allowedCommands: uniqueStrings(input.allowedCommands ?? defaults.allowedCommands ?? []),
    deniedCommandPatterns: (input.deniedCommandPatterns ?? []).map((pattern) =>
      typeof pattern === "string" ? new RegExp(pattern) : pattern,
    ),
    allowedCwdRoots: uniqueStrings(allowedCwdRoots),
    maxStdoutBytes: boundedPositiveInt(input.maxStdoutBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES),
    maxStderrBytes: boundedPositiveInt(input.maxStderrBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES),
    maxRuntimeMs: boundedPositiveInt(input.maxRuntimeMs, WORKSPACE_COMMAND_TIMEOUT_MS, 3_600_000),
    approvalRequiredAboveRuntimeMs: boundedNonnegativeInt(input.approvalRequiredAboveRuntimeMs, 0, 3_600_000),
    networkAllowed: input.networkAllowed === true,
    secretsInjectionAllowed: input.secretsInjectionAllowed === true,
    allowShellOperators: input.allowShellOperators === true,
  };
}

export function createSafeLocalProcessRunner(options: SafeLocalProcessRunnerOptions): CommandRunner {
  const commandMap = { ...options.commandMap };
  const envAllowlist = new Set(options.envAllowlist ?? []);
  const maxStdoutBytes = boundedPositiveInt(options.maxStdoutBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES);
  const maxStderrBytes = boundedPositiveInt(options.maxStderrBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES);

  return async ({ command, args, cwd, timeoutMs, abortSignal }) => {
    if (!options.enabled) {
      return { exitCode: 126, stdout: "", stderr: "safe local process runner is disabled" };
    }

    const executable = commandMap[command];
    if (!executable) {
      return { exitCode: 126, stdout: "", stderr: `command ${command} is not configured for the safe local runner` };
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { exitCode: 126, stdout: "", stderr: "safe local process runner requires a positive timeout", timedOut: true };
    }

    if (abortSignal?.aborted) {
      return { exitCode: 130, stdout: "", stderr: "command aborted" };
    }

    const env: NodeJS.ProcessEnv = {};
    for (const name of envAllowlist) {
      const value = options.extraEnv?.[name] ?? process.env[name];
      if (value !== undefined) env[name] = value;
    }

    return new Promise<CommandRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const finish = (result: CommandRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
        resolve(result);
      };

      const child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      abortHandler = () => {
        child.kill();
        finish({ exitCode: 130, stdout, stderr: appendBounded(stderr, "command aborted", maxStderrBytes) });
      };
      abortSignal?.addEventListener("abort", abortHandler, { once: true });

      child.stdout?.on("data", (chunk) => {
        stdout = appendBounded(stdout, String(chunk), maxStdoutBytes);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = appendBounded(stderr, String(chunk), maxStderrBytes);
      });
      child.on("error", (error) => {
        finish({ exitCode: 1, stdout, stderr: appendBounded(stderr, error.message, maxStderrBytes), timedOut });
      });
      child.on("close", (code) => {
        finish({ exitCode: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
      });
    });
  };
}

/**
 * Workspace-anchored sandbox adapter (ORN-37). Funnels every file and command
 * operation through `resolveWithinWorkspace` and a command allowlist /
 * destructive-denylist / approval gate before any I/O, captures and redacts
 * stdout/stderr/file content, and never performs network access.
 */
export class WorkspaceSandboxAdapter implements SandboxAdapter {
  readonly metadata: SandboxProviderMetadata;
  private readonly workspaceRoot: string;
  private readonly allowlistedCommands: string[];
  private readonly riskyCommands: string[];
  private readonly approvals: SandboxApproval[];
  private readonly now: () => string;
  private readonly fsImpl: WorkspaceFs;
  private readonly commandRunner: CommandRunner;
  private readonly policy: SandboxPolicy;

  constructor(options: WorkspaceSandboxOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.policy = createSandboxPolicy(options.policy, {
      workspaceRoot: options.workspaceRoot,
      allowedCommands: options.allowlistedCommands ?? [],
    });
    this.allowlistedCommands = this.policy.allowedCommands;
    this.riskyCommands = options.riskyCommands ?? [];
    this.approvals = options.approvals ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
    this.fsImpl = options.fsImpl ?? defaultWorkspaceFs;
    this.commandRunner =
      options.commandRunner ??
      (options.safeLocalRunner?.enabled === true
        ? createSafeLocalProcessRunner({
            ...options.safeLocalRunner,
            maxStdoutBytes: options.safeLocalRunner.maxStdoutBytes ?? this.policy.maxStdoutBytes,
            maxStderrBytes: options.safeLocalRunner.maxStderrBytes ?? this.policy.maxStderrBytes,
          })
        : defaultCommandRunner);
    this.metadata = SandboxProviderMetadataSchema.parse({
      id: "workspace",
      name: "Workspace Sandbox",
      apiVersion: SANDBOX_ADAPTER_API_VERSION,
      localOnly: true,
      networkAccess: false,
      arbitraryShell: false,
      supportedCommands: [...this.allowlistedCommands],
      stub: false,
    });
  }

  /**
   * Bridges the legacy `SandboxAdapter.execute` contract onto `operate`: a
   * command invocation maps to a `RUN_COMMAND` operation. The richer entry
   * point is `operate`.
   */
  async execute(commandInput: SandboxCommandInput): Promise<SandboxExecutionResult> {
    const command = SandboxCommandSchema.parse(commandInput);
    const startedAt = this.safeNow();
    const result = await this.operate({
      kind: "RUN_COMMAND",
      command: command.command,
      args: command.args,
      timeoutMs: command.timeoutMs,
      metadata: {
        ...(command.kind === "shell" ? { kind: "shell" } : {}),
        ...(Object.keys(command.env).length > 0 ? { env: command.env } : {}),
      },
    });
    const completedAt = this.safeNow();
    return SandboxExecutionResultSchema.parse({
      adapter: this.metadata,
      status: result.status,
      exitCode: result.status === "SUCCEEDED" ? 0 : 126,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      networkCalls: 0,
      artifacts: result.artifacts,
      approvalGates: result.approvalGates,
      metadata: result.denialReason ? { ...result.metadata, deniedReason: result.denialReason } : result.metadata,
    });
  }

  async operate(operationInput: SandboxOperationInput, ctx: SandboxExecutionContext = {}): Promise<SandboxOperationResult> {
    const operation = SandboxOperationSchema.parse(operationInput);
    const startedAt = this.safeNow();

    if (ctx.abortSignal?.aborted) {
      return this.denied(operation.kind, operation.kind === "RUN_COMMAND" ? "COMMAND_ABORTED" : "POLICY_VIOLATION", startedAt, {
        aborted: true,
      });
    }

    if (operation.kind === "RUN_COMMAND") {
      return this.runCommand(operation, startedAt, ctx);
    }

    // READ_FILE / LIST_DIR / PROPOSE_PATCH share the containment gate.
    const candidatePath = operation.path ?? "";
    const resolved = resolveWithinWorkspace(this.workspaceRoot, candidatePath, this.fsImpl);
    if (!resolved.ok) {
      return this.denied(operation.kind, resolved.reason, startedAt);
    }

    if (operation.kind === "READ_FILE") {
      const content = redactString(this.fsImpl.readFileSync(resolved.absolutePath));
      return this.result({
        kind: operation.kind,
        status: "SUCCEEDED",
        startedAt,
        resolvedPath: resolved.absolutePath,
        fileContent: content,
      });
    }

    if (operation.kind === "LIST_DIR") {
      const entries = this.fsImpl.readdirSync(resolved.absolutePath);
      return this.result({
        kind: operation.kind,
        status: "SUCCEEDED",
        startedAt,
        resolvedPath: resolved.absolutePath,
        entries,
      });
    }

    // PROPOSE_PATCH — never writes without a matching FILE_WRITE approval.
    return this.proposePatch(operation, resolved.absolutePath, startedAt);
  }

  private proposePatch(operation: SandboxOperation, absolutePath: string, startedAt: string): SandboxOperationResult {
    const targetPath = operation.path as string;
    const operationKind = operation.operation ?? "update";
    const content = operation.content ?? "";
    const approved = this.hasApproval("FILE_WRITE", targetPath, absolutePath);

    const gate = ApprovalGateSchema.parse({
      id: `approval:file-write:${targetPath}`,
      type: "FILE_WRITE",
      required: true,
      approved,
      reason: FILE_WRITE_APPROVAL_REASON,
      metadata: { path: targetPath, operation: operationKind },
    });
    const artifact = redactSecrets(
      PatchArtifactSchema.parse({
        kind: "PATCH",
        id: `patch:${stableId(targetPath)}`,
        path: targetPath,
        operation: operationKind,
        unifiedDiff: unifiedDiffFor(targetPath, content, operationKind),
        createdAt: startedAt,
        approval: { required: true, approved },
        metadata: { applied: approved, workspaceSandbox: true },
      }),
    );

    if (!approved) {
      return this.result({
        kind: "PROPOSE_PATCH",
        status: "NEEDS_APPROVAL",
        denialReason: "NEEDS_APPROVAL",
        startedAt,
        resolvedPath: absolutePath,
        artifacts: [artifact],
        approvalGates: [gate],
      });
    }

    this.fsImpl.writeFileSync(absolutePath, content);
    return this.result({
      kind: "PROPOSE_PATCH",
      status: "SUCCEEDED",
      startedAt,
      resolvedPath: absolutePath,
      artifacts: [artifact],
      approvalGates: [gate],
    });
  }

  private async runCommand(
    operation: SandboxOperation,
    startedAt: string,
    ctx: SandboxExecutionContext = {},
  ): Promise<SandboxOperationResult> {
    const command = operation.command ?? "";
    const args = operation.args;

    // Destructive denylist has the highest precedence — it beats the allowlist
    // AND the arbitrary-shell gate so a known-destructive signature is always
    // reported as such.
    if (matchesDestructiveDenylist(command, args)) {
      return this.denied("RUN_COMMAND", "DESTRUCTIVE_COMMAND_BLOCKED", startedAt);
    }

    if (operation.metadata.network === true && !this.policy.networkAllowed) {
      return this.denied("RUN_COMMAND", "NETWORK_DISABLED", startedAt);
    }

    if (operationRequestsSecretInjection(operation) && !this.policy.secretsInjectionAllowed) {
      return this.denied("RUN_COMMAND", "SECRETS_DISABLED", startedAt);
    }

    // Arbitrary shell (an explicit shell kind, or metacharacters in the program
    // string/args) is denied by default.
    if (isShellInvocation(operation, this.policy.allowShellOperators)) {
      return this.denied("RUN_COMMAND", "ARBITRARY_SHELL_DISABLED", startedAt);
    }

    if (matchesDeniedCommandPattern(command, args, this.policy.deniedCommandPatterns)) {
      return this.denied("RUN_COMMAND", "COMMAND_ARG_REJECTED", startedAt);
    }

    if (!this.allowlistedCommands.includes(command)) {
      return this.denied("RUN_COMMAND", "COMMAND_NOT_ALLOWLISTED", startedAt);
    }

    if (!this.isCwdAllowed(this.workspaceRoot)) {
      return this.denied("RUN_COMMAND", "CWD_NOT_ALLOWLISTED", startedAt);
    }

    if (this.isRisky(operation) && !this.hasApproval("COMMAND", command)) {
      return this.result({
        kind: "RUN_COMMAND",
        status: "NEEDS_APPROVAL",
        denialReason: "NEEDS_APPROVAL",
        startedAt,
        approvalGates: [
          ApprovalGateSchema.parse({
            id: `approval:command:${stableId(command)}`,
            // ApprovalGateTypeSchema only models FILE_WRITE today; the command
            // approval is surfaced through status + denialReason instead.
            type: "FILE_WRITE",
            required: true,
            approved: false,
            reason: "Risky command execution requires an explicit approval.",
            metadata: { command },
          }),
        ],
        metadata: { safetyReasonCode: "NEEDS_APPROVAL" },
      });
    }

    const timeoutMs = operation.timeoutMs ?? WORKSPACE_COMMAND_TIMEOUT_MS;
    const runtimeGate = evaluateSandboxRuntimeSafety({
      runtimeMs: timeoutMs,
      maxRuntimeMs: this.policy.maxRuntimeMs,
      approvalRequiredAboveMs: this.policy.approvalRequiredAboveRuntimeMs,
    });
    if (runtimeGate.status === "denied") {
      return this.denied("RUN_COMMAND", "RUNTIME_BUDGET_EXCEEDED", startedAt, {
        safetyReasonCode: runtimeGate.reasonCodes[0],
        safetyReasons: runtimeGate.reasons,
        requestedRuntimeMs: timeoutMs,
        maxRuntimeMs: this.policy.maxRuntimeMs,
      });
    }
    if (runtimeGate.status === "NEEDS_DECISION") {
      return this.result({
        kind: "RUN_COMMAND",
        status: "NEEDS_APPROVAL",
        denialReason: "NEEDS_APPROVAL",
        startedAt,
        metadata: {
          safetyReasonCode: runtimeGate.reasonCodes[0],
          safetyReasons: runtimeGate.reasons,
          requestedRuntimeMs: timeoutMs,
          maxRuntimeMs: this.policy.maxRuntimeMs,
        },
      });
    }

    const run = await this.commandRunner({ command, args, cwd: this.workspaceRoot, timeoutMs, abortSignal: ctx.abortSignal });
    const stdoutCapture = captureStream(run.stdout, this.policy.maxStdoutBytes);
    const stderrCapture = captureStream(run.stderr, this.policy.maxStderrBytes);
    const stdout = redactString(stdoutCapture.value);
    const stderr = redactString(stderrCapture.value);
    const streamMetadata = {
      stdoutTruncated: stdoutCapture.truncated,
      stderrTruncated: stderrCapture.truncated,
      requestedRuntimeMs: timeoutMs,
      maxRuntimeMs: this.policy.maxRuntimeMs,
    };

    if (run.timedOut) {
      // Partial output produced before termination is preserved.
      return this.result({
        kind: "RUN_COMMAND",
        status: "DENIED",
        denialReason: "COMMAND_TIMEOUT",
        startedAt,
        stdout,
        stderr,
        metadata: { ...streamMetadata, safetyReasonCode: "COMMAND_TIMEOUT" },
      });
    }

    if (ctx.abortSignal?.aborted || run.exitCode === 130) {
      return this.result({
        kind: "RUN_COMMAND",
        status: "DENIED",
        denialReason: "COMMAND_ABORTED",
        startedAt,
        stdout,
        stderr,
        metadata: { ...streamMetadata, safetyReasonCode: "COMMAND_ABORTED", aborted: true },
      });
    }

    return this.result({
      kind: "RUN_COMMAND",
      status: run.exitCode === 0 ? "SUCCEEDED" : "FAILED",
      startedAt,
      stdout,
      stderr,
      metadata: streamMetadata,
    });
  }

  private isRisky(operation: SandboxOperation): boolean {
    if (operation.metadata.requiresApproval === true) return true;
    return this.riskyCommands.includes(operation.command ?? "");
  }

  private hasApproval(scope: "FILE_WRITE" | "COMMAND", target: string, alternateTarget?: string): boolean {
    return this.approvals.some(
      (approval) =>
        approval.scope === scope &&
        (approval.target === target || (alternateTarget !== undefined && approval.target === alternateTarget)),
    );
  }

  private isCwdAllowed(cwd: string): boolean {
    const resolved = nodePath.resolve(cwd);
    return this.policy.allowedCwdRoots.some((root) => isContainedWithin(root, resolved));
  }

  private denied(
    kind: SandboxOperationKind,
    reason: SandboxDenialReason,
    startedAt: string,
    metadata: Record<string, unknown> = {},
  ): SandboxOperationResult {
    // resolvedPath is withheld on denial.
    return this.result({
      kind,
      status: "DENIED",
      denialReason: reason,
      startedAt,
      metadata: { safetyReasonCode: safetyReasonCodeForDenial(reason), ...metadata },
    });
  }

  private result(input: {
    kind: SandboxOperationKind;
    status: SandboxExecutionStatus;
    startedAt: string;
    denialReason?: SandboxDenialReason;
    resolvedPath?: string;
    stdout?: string;
    stderr?: string;
    entries?: string[];
    fileContent?: string;
    artifacts?: SandboxArtifact[];
    approvalGates?: ApprovalGate[];
    metadata?: Record<string, unknown>;
  }): SandboxOperationResult {
    const completedAt = this.safeNow();
    return SandboxOperationResultSchema.parse({
      kind: input.kind,
      status: input.status,
      denialReason: input.denialReason,
      resolvedPath: input.status === "DENIED" ? undefined : input.resolvedPath,
      stdout: input.stdout ?? "",
      stderr: input.stderr ?? "",
      entries: input.entries,
      fileContent: input.fileContent,
      artifacts: input.artifacts ?? [],
      approvalGates: input.approvalGates ?? [],
      networkCalls: 0,
      startedAt: input.startedAt,
      completedAt,
      metadata: input.metadata ?? {},
    });
  }

  private safeNow(): string {
    const value = this.now();
    return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  }
}

export interface SandboxEnvironmentOptions extends WorkspaceSandboxOptions {
  adapter?: SandboxAdapter & { operate?: (operation: SandboxOperationInput) => Promise<SandboxOperationResult> };
}

export class StubSandboxEnvironment implements SandboxEnvironment {
  readonly kind = "stub" as const;
  readonly supportsArbitraryShell = false;
  private readonly adapter: SandboxAdapter;

  constructor(options: SandboxStubOptions = {}) {
    this.adapter = createE2BSandboxAdapterStub(options);
  }

  async execute(command: SandboxCommandInput): Promise<SandboxExecutionResult> {
    return this.adapter.execute(command);
  }

  async operate(operation: SandboxOperationInput): Promise<SandboxOperationResult> {
    const parsed = SandboxOperationSchema.parse(operation);
    const startedAt = new Date().toISOString();
    return SandboxOperationResultSchema.parse({
      kind: parsed.kind,
      status: "DENIED",
      denialReason: "POLICY_VIOLATION",
      stdout: "",
      stderr: "Stub sandbox environment does not execute workspace operations.",
      networkCalls: 0,
      startedAt,
      completedAt: startedAt,
      metadata: { sandboxEnvironment: this.kind, stub: true },
    });
  }
}

export class LocalSandboxEnvironment implements SandboxEnvironment {
  readonly kind = "local" as const;
  readonly supportsArbitraryShell = false;
  private readonly adapter: WorkspaceSandboxAdapter;

  constructor(options: WorkspaceSandboxOptions) {
    this.adapter = new WorkspaceSandboxAdapter(options);
  }

  async execute(command: SandboxCommandInput): Promise<SandboxExecutionResult> {
    return this.adapter.execute(command);
  }

  async operate(operation: SandboxOperationInput): Promise<SandboxOperationResult> {
    return this.adapter.operate(operation);
  }
}

export class AdapterSandboxEnvironment implements SandboxEnvironment {
  readonly supportsArbitraryShell = false;

  constructor(
    readonly kind: SandboxEnvironmentKind,
    private readonly adapter: SandboxAdapter & { operate?: (operation: SandboxOperationInput) => Promise<SandboxOperationResult> },
  ) {}

  async execute(command: SandboxCommandInput): Promise<SandboxExecutionResult> {
    return this.adapter.execute(command);
  }

  async operate(operation: SandboxOperationInput): Promise<SandboxOperationResult> {
    if (this.adapter.operate) return this.adapter.operate(operation);
    const parsed = SandboxOperationSchema.parse(operation);
    if (parsed.kind !== "RUN_COMMAND") {
      const startedAt = new Date().toISOString();
      return SandboxOperationResultSchema.parse({
        kind: parsed.kind,
        status: "DENIED",
        denialReason: "POLICY_VIOLATION",
        stdout: "",
        stderr: "Selected sandbox adapter does not support workspace operations.",
        networkCalls: 0,
        startedAt,
        completedAt: startedAt,
        metadata: { sandboxEnvironment: this.kind },
      });
    }
    const execution = await this.adapter.execute({
      kind: parsed.metadata.kind === "shell" ? "shell" : "local",
      command: parsed.command ?? "",
      args: parsed.args,
      timeoutMs: parsed.timeoutMs ?? WORKSPACE_COMMAND_TIMEOUT_MS,
    });
    return SandboxOperationResultSchema.parse({
      kind: "RUN_COMMAND",
      status: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
      artifacts: execution.artifacts,
      approvalGates: execution.approvalGates,
      networkCalls: 0,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      metadata: execution.metadata,
    });
  }
}

export function createSandboxEnvironment(
  kind: SandboxEnvironmentKind,
  options: SandboxEnvironmentOptions,
): SandboxEnvironment {
  if (kind === "stub") return new StubSandboxEnvironment({ now: options.now });
  if (kind === "e2b" && options.adapter) return new AdapterSandboxEnvironment("e2b", options.adapter);
  return new LocalSandboxEnvironment(options);
}

// Characters/operators that imply shell interpretation when present in command/argv tokens.
const SHELL_METACHARACTER_PATTERN = /[;&|`$<>(){}*?!\n\r]/;

/**
 * True when an operation requests arbitrary shell execution: an explicit
 * `kind: "shell"` (carried on operation metadata) or shell metacharacters in
 * the program string/args. The safe local process runner uses argv arrays and
 * `shell:false`, but policy still fails closed on shell-looking tokens unless
 * the caller explicitly opts in via SandboxPolicy.allowShellOperators.
 */
function isShellInvocation(operation: SandboxOperation, allowShellOperators: boolean): boolean {
  if (allowShellOperators) return false;
  if (operation.metadata.kind === "shell" || operation.metadata.shell === true) return true;
  return [operation.command ?? "", ...operation.args].some((token) => SHELL_METACHARACTER_PATTERN.test(token));
}

function operationRequestsSecretInjection(operation: SandboxOperation): boolean {
  if (operation.metadata.secrets === true || operation.metadata.injectSecrets === true) return true;
  const env = operation.metadata.env;
  return env !== null && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length > 0;
}

function matchesDeniedCommandPattern(command: string, args: string[], patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const rendered = [command, ...args].join(" ");
  return patterns.some((pattern) => pattern.test(rendered));
}

function safetyReasonCodeForDenial(reason: SandboxDenialReason): SafetyReasonCode | SandboxDenialReason {
  if (reason === "RUNTIME_BUDGET_EXCEEDED") return "SANDBOX_RUNTIME_BUDGET_EXCEEDED";
  return reason;
}


/** Returns the final path segment of a token, independent of separator style. */
function commandBaseName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? token;
}

/**
 * Matches a structured command invocation against the destructive denylist. The
 * full argv (`command` + `args`) is inspected as discrete tokens so a
 * destructive signature is detected whether it appears as the program or among
 * its arguments (e.g. an allowlisted program followed by `&& rm -rf .`).
 */
function matchesDestructiveDenylist(command: string, args: string[]): boolean {
  const tokens = [command, ...args].map((token) => token.trim()).filter((token) => token.length > 0);
  const joined = tokens.join(" ").toLowerCase();

  // Fork-bomb signature.
  if (joined.includes(":(){") || joined.replace(/\s+/g, "").includes(":|:&")) return true;

  for (let i = 0; i < tokens.length; i += 1) {
    const base = commandBaseName(tokens[i]).toLowerCase();
    const rest = tokens.slice(i + 1).map((token) => token.toLowerCase());

    if (base === "rm") {
      let recursive = false;
      let force = false;
      for (const arg of rest) {
        const normalized = arg.toLowerCase();
        if (normalized === "--recursive" || normalized === "--dir") recursive = true;
        if (normalized === "--force") force = true;
        if (/^-[a-z]+$/.test(normalized)) {
          recursive = recursive || /[rR]/.test(arg);
          force = force || normalized.includes("f");
        }
      }
      if (recursive && force) return true;
    }
    if (base === "del" || base === "erase") {
      if (rest.some((arg) => arg === "/f" || arg === "/s" || arg === "/q")) return true;
    }
    if (base === "rmdir" && rest.some((arg) => arg === "/s")) return true;
    if (base === "format") return true;
    if (base === "mkfs" || base.startsWith("mkfs.")) return true;
    if (base === "dd") return true;
    if (base === "shutdown" || base === "reboot" || base === "halt" || base === "poweroff") return true;
    if (base === "git" && rest[0] === "clean" && rest.some((arg) => arg.startsWith("-") && arg.includes("f") && arg.includes("d"))) {
      return true;
    }
  }

  return false;
}

function captureStream(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bounded = truncateToBytes(value, maxBytes);
  return { value: bounded, truncated: bounded !== value };
}

/** Truncates `value` so its UTF-8 byte length does not exceed `maxBytes`. */
function truncateToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;

  // Trim by characters until the byte budget is satisfied (handles multi-byte
  // characters without splitting a code point).
  let result = value;
  while (encoder.encode(result).length > maxBytes && result.length > 0) {
    const overflowBytes = encoder.encode(result).length - maxBytes;
    const dropChars = Math.max(1, Math.ceil(overflowBytes / 4));
    result = result.slice(0, Math.max(0, result.length - dropChars));
  }
  return result;
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  return truncateToBytes(`${current}${chunk}`, maxBytes);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return Math.trunc(fallback);
  return Math.min(Math.trunc(value), max);
}

function boundedNonnegativeInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return Math.trunc(fallback);
  return Math.min(Math.trunc(value), max);
}
