import nodeFs from "node:fs";
import { createRequire } from "node:module";

import { redactString, redactStringOrSuppress } from "../security/redaction";
import {
  MAX_CAPTURED_STREAM_BYTES,
  SANDBOX_ADAPTER_API_VERSION,
  SandboxCommandSchema,
  SandboxExecutionResultSchema,
  SandboxOperationResultSchema,
  SandboxOperationSchema,
  SandboxProviderMetadataSchema,
  WORKSPACE_COMMAND_TIMEOUT_MS,
  WorkspaceSandboxAdapter,
  type SandboxAdapter,
  type SandboxApproval,
  type SandboxArtifact,
  type SandboxCommandInput,
  type SandboxDenialReason,
  type SandboxExecutionResult,
  type SandboxExecutionStatus,
  type SandboxOperationInput,
  type SandboxOperationKind,
  type SandboxOperationResult,
  type SandboxPolicyInput,
  type SandboxProviderMetadata,
  type WorkspaceFs,
} from ".";

// ---------------------------------------------------------------------------
// E2B container client surface (Req 6.1)
// ---------------------------------------------------------------------------

/** Captured result of a command executed inside the E2B container. */
export interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A command to run inside the container (already cleared by every policy gate). */
export interface E2BRunCommandInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

/** A file write to apply inside the container (already approved + contained). */
export interface E2BWriteFileInput {
  path: string;
  content: string;
}

/**
 * Minimal container-client surface the E2B adapter depends on at runtime. It is
 * declared locally so the module type-checks and builds without the optional
 * E2B client package installed — the package is required only when a caller
 * actually constructs the real client. Tests inject a deterministic, in-memory
 * implementation so no container is ever spawned and no network call is made.
 */
export interface E2BClient {
  runCommand(input: E2BRunCommandInput): Promise<E2BCommandResult> | E2BCommandResult;
  writeFile(input: E2BWriteFileInput): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** Factory that constructs an {@link E2BClient} from a transiently-supplied API key. */
export type E2BClientFactory = (apiKey: string) => E2BClient;

export interface E2BSandboxOptions {
  /** E2B API key, read transiently from the Secret_Store at construction. */
  apiKey: string;
  /** Explicit external network mode required by the production startup readiness check. */
  networkMode?: "external";
  /** Absolute workspace root; the containment boundary for every operation. */
  workspaceRoot: string;
  /** Commands permitted for `RUN_COMMAND` (exact match). Defaults to none. */
  allowlistedCommands?: string[];
  /** Allowlisted commands that still require a matching `COMMAND` approval. */
  riskyCommands?: string[];
  /** Explicit approvals authorizing risky writes/commands. */
  approvals?: SandboxApproval[];
  /** Optional policy override shared with the workspace gateway. */
  policy?: SandboxPolicyInput;
  /** Default command timeout for container calls when an operation omits timeoutMs. */
  defaultTimeoutMs?: number;
  /** Per-stream capture caps; default to MAX_CAPTURED_STREAM_BYTES. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /**
   * Injectable client factory (Req 6.1). Tests supply a counting/in-memory
   * double; the production default lazily `require`s the optional E2B client
   * package and surfaces an actionable error when it is absent.
   */
  clientFactory?: E2BClientFactory;
  now?: () => string;
  /** Injected filesystem surface used only for containment + reads; defaults to `node:fs`. */
  fsImpl?: WorkspaceFs;
}

export type E2BReadinessReason =
  | "E2B_API_KEY_MISSING"
  | "E2B_NETWORK_MODE_NOT_EXTERNAL"
  | "E2B_TIMEOUT_MISSING";

export interface E2BReadinessCheck {
  ready: boolean;
  reasonCodes: E2BReadinessReason[];
  message: string;
}

export function checkE2BSandboxReadiness(options: Pick<E2BSandboxOptions, "apiKey" | "networkMode" | "defaultTimeoutMs">): E2BReadinessCheck {
  const reasonCodes: E2BReadinessReason[] = [];
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    reasonCodes.push("E2B_API_KEY_MISSING");
  }
  if (options.networkMode !== "external") {
    reasonCodes.push("E2B_NETWORK_MODE_NOT_EXTERNAL");
  }
  if (typeof options.defaultTimeoutMs !== "number" || !Number.isFinite(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0) {
    reasonCodes.push("E2B_TIMEOUT_MISSING");
  }
  return {
    ready: reasonCodes.length === 0,
    reasonCodes,
    message: reasonCodes.length === 0 ? "E2B sandbox ready" : redactString(reasonCodes.join(", ")),
  };
}

/**
 * The optional E2B container client. It is intentionally NOT a static import:
 * keeping it out of the module graph lets the build and the test suite (which
 * inject a client double) succeed without the package installed and without
 * opening any network connection.
 */
const OPTIONAL_E2B_CLIENT = "@e2b/code-interpreter";

function loadE2BClientFactory(): E2BClientFactory {
  const requireFromHere = createRequire(import.meta.url);
  let mod: any;
  try {
    mod = requireFromHere(OPTIONAL_E2B_CLIENT);
  } catch {
    throw new Error(
      `The E2B sandbox path requires the optional "${OPTIONAL_E2B_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_E2B_CLIENT}\` to enable the E2B sandbox, or ` +
        `use the local workspace sandbox instead (no cloud account or network required).`,
    );
  }
  const factory = (typeof mod === "function" ? mod : mod.default) as E2BClientFactory | undefined;
  if (typeof factory !== "function") {
    throw new Error(
      `The E2B sandbox path requires the optional "${OPTIONAL_E2B_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_E2B_CLIENT}\` to enable the E2B sandbox, or ` +
        `use the local workspace sandbox instead (no cloud account or network required).`,
    );
  }
  return factory;
}

function defaultClientFactory(apiKey: string): E2BClient {
  return loadE2BClientFactory()(apiKey);
}

const defaultWorkspaceFs: WorkspaceFs = {
  realpathSync: (p) => nodeFs.realpathSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p, "utf8"),
  readdirSync: (p) => nodeFs.readdirSync(p),
  writeFileSync: (p, data) => nodeFs.writeFileSync(p, data, "utf8"),
  existsSync: (p) => nodeFs.existsSync(p),
};

/**
 * Real E2B Sandbox_Adapter (Req 6). It reuses the {@link WorkspaceSandboxAdapter}
 * policy gates (path containment, command allowlist, destructive denylist, and
 * approval gates) as a side-effect-free decision oracle: an internal gateway is
 * wired with inert recorder seams (a no-op command runner and a deferred file
 * write) so it authorizes or rejects an operation WITHOUT performing any real
 * work. Only after every gate passes does this adapter contact the container.
 *
 * Pipeline (Req 6.2–6.6, 6.8–6.10):
 *   policy gates first  → lazy client init from the Secret_Store key
 *   → run command / apply patch in the container
 *   → capture exit code, stdout, stderr
 *   → truncate each stream to MAX_CAPTURED_STREAM_BYTES with a truncation indicator
 *   → redact streams and artifacts.
 *
 * A denied/needs-approval operation never reaches the container (Req 6.6). A
 * client-init failure returns a redacted failure result and spawns no process
 * (Req 6.9). A patch-apply failure returns a redacted failure result and leaves
 * the target file unchanged (Req 6.10).
 */
class E2BSandboxAdapter implements SandboxAdapter {
  readonly metadata: SandboxProviderMetadata;
  private readonly apiKey: string;
  private readonly workspaceRoot: string;
  private readonly clientFactory: E2BClientFactory;
  private readonly now: () => string;
  private readonly gateway: WorkspaceSandboxAdapter;
  private readonly defaultTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private client: E2BClient | undefined;

  constructor(options: E2BSandboxOptions) {
    this.apiKey = options.apiKey;
    this.workspaceRoot = options.workspaceRoot;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultTimeoutMs = positiveInt(options.defaultTimeoutMs, WORKSPACE_COMMAND_TIMEOUT_MS, 3_600_000);
    this.maxStdoutBytes = positiveInt(options.maxStdoutBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES);
    this.maxStderrBytes = positiveInt(options.maxStderrBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES);

    const baseFs = options.fsImpl ?? defaultWorkspaceFs;
    // The gateway runs the identical policy gates as the workspace sandbox, but
    // its execution seams are inert recorders: the command runner performs no
    // work and the file write is deferred to the container. The gateway thus
    // only ever reports whether an operation cleared every gate; the real
    // command/patch is executed by this adapter after that decision.
    this.gateway = new WorkspaceSandboxAdapter({
      workspaceRoot: options.workspaceRoot,
      allowlistedCommands: options.allowlistedCommands,
      riskyCommands: options.riskyCommands,
      approvals: options.approvals,
      policy: options.policy,
      now: this.now,
      fsImpl: {
        realpathSync: baseFs.realpathSync,
        readFileSync: baseFs.readFileSync,
        readdirSync: baseFs.readdirSync,
        // Deferred to the container; the gateway must not write locally.
        writeFileSync: () => {},
        existsSync: baseFs.existsSync,
      },
      // No-op recorder: a command that clears the gates reports a contained
      // success here so the gateway authorizes it without spawning a process.
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    this.metadata = SandboxProviderMetadataSchema.parse({
      id: "e2b",
      name: "E2B Sandbox",
      apiVersion: SANDBOX_ADAPTER_API_VERSION,
      localOnly: false,
      networkAccess: false,
      arbitraryShell: false,
      supportedCommands: [...(options.allowlistedCommands ?? [])],
      stub: false,
    });
  }

  /**
   * Legacy `SandboxAdapter.execute` contract: a command invocation maps to a
   * `RUN_COMMAND` operation. The truncation indicator for each captured stream
   * is surfaced in the execution-result metadata (Req 6.5).
   */
  async execute(commandInput: SandboxCommandInput): Promise<SandboxExecutionResult> {
    const command = SandboxCommandSchema.parse(commandInput);
    const startedAt = this.safeNow();

    const decision = await this.gateway.operate({
      kind: "RUN_COMMAND",
      command: command.command,
      args: command.args,
      timeoutMs: command.timeoutMs,
      metadata: command.kind === "shell" ? { kind: "shell" } : {},
    });

    if (decision.status === "DENIED" || decision.status === "NEEDS_APPROVAL") {
      return this.executionResult({
        status: decision.status,
        exitCode: 126,
        stdout: decision.stdout,
        stderr: decision.stderr,
        startedAt,
        metadata: decision.denialReason ? { deniedReason: decision.denialReason } : {},
      });
    }

    const run = await this.runCommandInContainer(
      { command: command.command ?? "", args: command.args, timeoutMs: command.timeoutMs },
      decision.startedAt,
    );
    return this.executionResult({
      status: run.result.status,
      exitCode: run.exitCode,
      stdout: run.result.stdout,
      stderr: run.result.stderr,
      startedAt,
      metadata: { stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated },
    });
  }

  /**
   * Richer operation entry point covering RUN_COMMAND, PROPOSE_PATCH, READ_FILE,
   * and LIST_DIR. The gateway decides first; the container is only contacted for
   * an authorized RUN_COMMAND or PROPOSE_PATCH.
   */
  async operate(operationInput: SandboxOperationInput): Promise<SandboxOperationResult> {
    const decision = await this.gateway.operate(operationInput);

    // Gates rejected the operation — never contact the container (Req 6.6).
    if (decision.status === "DENIED" || decision.status === "NEEDS_APPROVAL") {
      return decision;
    }

    if (decision.kind === "RUN_COMMAND") {
      const operation = SandboxOperationSchema.parse(operationInput);
      const run = await this.runCommandInContainer(
        { command: operation.command ?? "", args: operation.args, timeoutMs: operation.timeoutMs },
        decision.startedAt,
      );
      return run.result;
    }

    if (decision.kind === "PROPOSE_PATCH") {
      return this.applyPatchInContainer(operationInput, decision);
    }

    // READ_FILE / LIST_DIR were satisfied by the gateway's containment-checked,
    // redacted filesystem read; no container call is required.
    return decision;
  }

  private async runCommandInContainer(
    input: { command: string; args: string[]; timeoutMs?: number },
    startedAt: string,
  ): Promise<{ result: SandboxOperationResult; exitCode: number; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    const client = this.tryGetClient();
    if (!client.ok) {
      // Req 6.9: client init failed — no process spawned, redacted failure.
      return {
        result: this.operationResult({ kind: "RUN_COMMAND", status: "FAILED", startedAt, stderr: client.error }),
        exitCode: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    let raw: E2BCommandResult;
    try {
      raw = await client.value.runCommand({
        command: input.command,
        args: input.args,
        cwd: this.workspaceRoot,
        timeoutMs,
      });
    } catch (error) {
      return {
        result: this.operationResult({ kind: "RUN_COMMAND", status: "FAILED", startedAt, stderr: this.redactError(error) }),
        exitCode: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    // Capture (Req 6.4) → truncate (Req 6.5) → redact (Req 6.8).
    const stdoutCapture = truncateStream(raw.stdout ?? "", this.maxStdoutBytes);
    const stderrCapture = truncateStream(raw.stderr ?? "", this.maxStderrBytes);
    const exitCode = Number.isFinite(raw.exitCode) ? raw.exitCode : 1;

    return {
      result: this.operationResult({
        kind: "RUN_COMMAND",
        status: exitCode === 0 ? "SUCCEEDED" : "FAILED",
        startedAt,
        stdout: redactString(stdoutCapture.value),
        stderr: redactString(stderrCapture.value),
      }),
      exitCode,
      stdoutTruncated: stdoutCapture.truncated,
      stderrTruncated: stderrCapture.truncated,
    };
  }

  private async applyPatchInContainer(
    operationInput: SandboxOperationInput,
    decision: SandboxOperationResult,
  ): Promise<SandboxOperationResult> {
    const operation = SandboxOperationSchema.parse(operationInput);
    const startedAt = decision.startedAt;
    const targetPath = decision.resolvedPath ?? operation.path ?? "";

    const client = this.tryGetClient();
    if (!client.ok) {
      // Req 6.9 + 6.10: no write occurs, target file is left unchanged.
      return this.operationResult({
        kind: "PROPOSE_PATCH",
        status: "FAILED",
        startedAt,
        stderr: client.error,
        resolvedPath: decision.resolvedPath,
        approvalGates: decision.approvalGates,
      });
    }

    try {
      await client.value.writeFile({ path: targetPath, content: operation.content ?? "" });
    } catch (error) {
      // Req 6.10: apply failed — redacted failure, target file unchanged.
      return this.operationResult({
        kind: "PROPOSE_PATCH",
        status: "FAILED",
        startedAt,
        stderr: this.redactError(error),
        resolvedPath: decision.resolvedPath,
        approvalGates: decision.approvalGates,
      });
    }

    // Success — reuse the gateway's already-redacted patch artifact + gate.
    return this.operationResult({
      kind: "PROPOSE_PATCH",
      status: "SUCCEEDED",
      startedAt,
      resolvedPath: decision.resolvedPath,
      artifacts: decision.artifacts,
      approvalGates: decision.approvalGates,
    });
  }

  private tryGetClient(): { ok: true; value: E2BClient } | { ok: false; error: string } {
    if (this.client) return { ok: true, value: this.client };
    try {
      const client = this.clientFactory(this.apiKey);
      this.client = client;
      return { ok: true, value: client };
    } catch (error) {
      return { ok: false, error: this.redactError(error) };
    }
  }

  private redactError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactStringOrSuppress(message);
  }

  private operationResult(input: {
    kind: SandboxOperationKind;
    status: SandboxExecutionStatus;
    startedAt: string;
    denialReason?: SandboxDenialReason;
    resolvedPath?: string;
    stdout?: string;
    stderr?: string;
    artifacts?: SandboxArtifact[];
    approvalGates?: SandboxOperationResult["approvalGates"];
  }): SandboxOperationResult {
    return SandboxOperationResultSchema.parse({
      kind: input.kind,
      status: input.status,
      denialReason: input.denialReason,
      resolvedPath: input.status === "DENIED" ? undefined : input.resolvedPath,
      stdout: input.stdout ?? "",
      stderr: input.stderr ?? "",
      artifacts: input.artifacts ?? [],
      approvalGates: input.approvalGates ?? [],
      networkCalls: 0,
      startedAt: input.startedAt,
      completedAt: this.safeNow(),
    });
  }

  private executionResult(input: {
    status: SandboxExecutionStatus;
    exitCode: number;
    stdout: string;
    stderr: string;
    startedAt: string;
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
      artifacts: [],
      approvalGates: [],
      metadata: input.metadata ?? {},
    });
  }

  private safeNow(): string {
    const value = this.now();
    return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  }
}

/**
 * Construct the real E2B Sandbox_Adapter (Req 6). Reuses the workspace policy
 * gates before any container call, lazily initializes the container client from
 * the supplied Secret_Store API key, and captures + truncates + redacts every
 * stream and artifact.
 */
export function createE2BSandboxAdapter(options: E2BSandboxOptions): SandboxAdapter {
  return new E2BSandboxAdapter(options);
}

/**
 * Truncates `value` so its UTF-8 byte length does not exceed
 * MAX_CAPTURED_STREAM_BYTES, reporting whether truncation occurred so the
 * caller can set the truncation indicator (Req 6.5).
 */
function truncateStream(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const cap = positiveInt(maxBytes, MAX_CAPTURED_STREAM_BYTES, MAX_CAPTURED_STREAM_BYTES);
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= cap) {
    return { value, truncated: false };
  }

  let result = value;
  while (encoder.encode(result).length > cap && result.length > 0) {
    const overflowBytes = encoder.encode(result).length - cap;
    const dropChars = Math.max(1, Math.ceil(overflowBytes / 4));
    result = result.slice(0, Math.max(0, result.length - dropChars));
  }
  return { value: result, truncated: true };
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), max)
    : fallback;
}

function durationMs(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
