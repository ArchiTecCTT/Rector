import type { Budget, Run } from "../store/schemas";

export type BudgetDecisionStatus = "allowed" | "NEEDS_DECISION" | "denied";

export interface BudgetUsage {
  estimatedUsd?: number;
  actualUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  runtimeMs?: number;
  healingAttempts?: number;
  provider?: string;
}

export interface BudgetDecision {
  status: BudgetDecisionStatus;
  reasons: string[];
  usage: Required<Omit<BudgetUsage, "provider">> & { provider?: string };
}

export type SafetyReasonCode =
  | "SANDBOX_RUNTIME_BUDGET_EXCEEDED"
  | "SANDBOX_RUNTIME_APPROVAL_REQUIRED";

export interface SandboxRuntimeSafetyInput {
  runtimeMs: number;
  maxRuntimeMs: number;
  approvalRequiredAboveMs?: number;
}

export interface SandboxRuntimeSafetyDecision {
  status: BudgetDecisionStatus;
  reasonCodes: SafetyReasonCode[];
  reasons: string[];
  runtimeMs: number;
  maxRuntimeMs: number;
  approvalRequiredAboveMs: number;
}

export function evaluateBudget(run: Run, usage: BudgetUsage = {}): BudgetDecision {
  const budget = run.budget;
  const normalized = normalizeUsage(run, usage);
  const deniedReasons = hardLimitReasons(budget, normalized);

  if (deniedReasons.length > 0) {
    return { status: "denied", reasons: deniedReasons, usage: normalized };
  }

  const approvalReasons = approvalReasonsFor(budget, normalized);
  if (approvalReasons.length > 0) {
    return { status: "NEEDS_DECISION", reasons: approvalReasons, usage: normalized };
  }

  return { status: "allowed", reasons: [], usage: normalized };
}

/**
 * Pre-flight per-run ceiling input. Carries only the two fields the per-run ceiling gates on
 * (`estimatedUsd`, `modelCalls`); absent fields are treated as 0. Structurally satisfied by both
 * `RunCostAggregate` (accumulated run cost) and `LLMUsage` (next-call estimate), so callers can pass
 * either without coupling this module to the cost/observability layer (which imports `evaluateBudget`
 * from here).
 */
export interface BudgetProjectionInput {
  estimatedUsd?: number;
  modelCalls?: number;
}

/**
 * Per-run budget ceiling gate, layered on `evaluateBudget`. This is the PRE-FLIGHT check that gates
 * the NEXT provider call BEFORE it happens: it projects `accumulated + nextEstimate` and denies the
 * call when the projected total would breach the run's per-run ceiling.
 *
 * - DENY (status `"denied"`) when projected `estimatedUsd` is STRICTLY greater than `budget.maxUsd`,
 *   OR projected `modelCalls` is STRICTLY greater than `budget.maxModelCalls` (matches the strict
 *   `>` convention used by `evaluateBudget`'s hard-limit checks). Requirement 3.4.
 * - ALLOW (status `"allowed"`) when the projected total is at-or-below both ceilings (`<=`).
 *   Requirement 3.9.
 *
 * "Layers on `evaluateBudget`": the projected pre-flight totals are fed through `evaluateBudget` to
 * reuse its usage normalization and preserve existing budget semantics, while the projected usd /
 * model-call ceilings (computed from the supplied accumulated + next estimate, not the run's recorded
 * actuals) remain the authority for the allow/deny status.
 */
export function enforceMaxPerRunBudget(
  run: Run,
  accumulated: BudgetProjectionInput = {},
  nextEstimate: BudgetProjectionInput = {},
): BudgetDecision {
  const budget = run.budget;

  // Treat absent accumulated/next fields as 0.
  const projectedUsd = nonNegativeNumberFrom(accumulated.estimatedUsd, 0) + nonNegativeNumberFrom(nextEstimate.estimatedUsd, 0);
  const projectedModelCalls = nonNegativeIntFrom(accumulated.modelCalls, 0) + nonNegativeIntFrom(nextEstimate.modelCalls, 0);

  // Layer on evaluateBudget: feed the projected pre-flight totals so the returned usage is normalized
  // through the same machinery and existing budget semantics are preserved.
  const base = evaluateBudget(run, { estimatedUsd: projectedUsd, modelCalls: projectedModelCalls });

  // Per-run ceiling check on the projected totals (strict `>`, identifying the exceeded ceiling).
  const reasons: string[] = [];
  if (projectedUsd > budget.maxUsd) {
    reasons.push(`projected cost ${projectedUsd} exceeds maxUsd ${budget.maxUsd}`);
  }
  if (projectedModelCalls > budget.maxModelCalls) {
    reasons.push(`projected model calls ${projectedModelCalls} exceed maxModelCalls ${budget.maxModelCalls}`);
  }

  if (reasons.length > 0) {
    return { status: "denied", reasons, usage: base.usage };
  }

  return { status: "allowed", reasons: [], usage: base.usage };
}

/**
 * Sandbox runtime safety gate used before local/E2B command execution.
 * It turns runtime-budget violations into structured decisions/reason codes so
 * callers can fail closed or request approval instead of throwing from the
 * command path.
 */
export function evaluateSandboxRuntimeSafety(
  input: SandboxRuntimeSafetyInput,
): SandboxRuntimeSafetyDecision {
  const runtimeMs = nonNegativeIntFrom(input.runtimeMs, 0);
  const maxRuntimeMs = nonNegativeIntFrom(input.maxRuntimeMs, 0);
  const approvalRequiredAboveMs = nonNegativeIntFrom(input.approvalRequiredAboveMs, 0);
  const invalidNegativeRuntime = isNegativeFinite(input.runtimeMs) || isNegativeFinite(input.maxRuntimeMs);

  if (invalidNegativeRuntime || maxRuntimeMs <= 0 || runtimeMs > maxRuntimeMs) {
    return {
      status: "denied",
      reasonCodes: ["SANDBOX_RUNTIME_BUDGET_EXCEEDED"],
      reasons: [
        invalidNegativeRuntime
          ? "sandbox runtime inputs must be non-negative"
          : `sandbox runtime ${runtimeMs}ms exceeds maxRuntimeMs ${maxRuntimeMs}ms`,
      ],
      runtimeMs,
      maxRuntimeMs,
      approvalRequiredAboveMs,
    };
  }

  if (approvalRequiredAboveMs > 0 && runtimeMs > approvalRequiredAboveMs) {
    return {
      status: "NEEDS_DECISION",
      reasonCodes: ["SANDBOX_RUNTIME_APPROVAL_REQUIRED"],
      reasons: [`sandbox runtime ${runtimeMs}ms requires approval above ${approvalRequiredAboveMs}ms`],
      runtimeMs,
      maxRuntimeMs,
      approvalRequiredAboveMs,
    };
  }

  return {
    status: "allowed",
    reasonCodes: [],
    reasons: [],
    runtimeMs,
    maxRuntimeMs,
    approvalRequiredAboveMs,
  };
}

function normalizeUsage(run: Run, usage: BudgetUsage): BudgetDecision["usage"] {
  return {
    estimatedUsd: nonNegativeNumberFrom(usage.estimatedUsd, run.costEstimate.usd, 0),
    actualUsd: nonNegativeNumberFrom(usage.actualUsd, run.actualCost?.usd, 0),
    inputTokens: nonNegativeIntFrom(usage.inputTokens, run.actualTokens?.input, run.tokenEstimate.input, 0),
    outputTokens: nonNegativeIntFrom(usage.outputTokens, run.actualTokens?.output, run.tokenEstimate.output, 0),
    modelCalls: nonNegativeIntFrom(usage.modelCalls, run.actualCost?.modelCalls, run.costEstimate.modelCalls, 0),
    runtimeMs: nonNegativeIntFrom(usage.runtimeMs, run.actualCost?.runtimeMs, run.costEstimate.runtimeMs, 0),
    healingAttempts: nonNegativeIntFrom(usage.healingAttempts, run.healingAttempts, 0),
    provider: usage.provider ?? stringFrom(run.actualCost?.provider, run.costEstimate.provider),
  };
}

function hardLimitReasons(budget: Budget, usage: BudgetDecision["usage"]): string[] {
  const reasons: string[] = [];
  const cost = usage.actualUsd > 0 ? usage.actualUsd : usage.estimatedUsd;

  if (cost > budget.maxUsd) reasons.push(`estimated cost ${cost} exceeds maxUsd ${budget.maxUsd}`);
  if (usage.inputTokens > budget.maxInputTokens) {
    reasons.push(`input tokens ${usage.inputTokens} exceed maxInputTokens ${budget.maxInputTokens}`);
  }
  if (usage.outputTokens > budget.maxOutputTokens) {
    reasons.push(`output tokens ${usage.outputTokens} exceed maxOutputTokens ${budget.maxOutputTokens}`);
  }
  if (usage.modelCalls > budget.maxModelCalls) {
    reasons.push(`model calls ${usage.modelCalls} exceed maxModelCalls ${budget.maxModelCalls}`);
  }
  if (usage.runtimeMs > budget.maxRuntimeMs) {
    reasons.push(`runtime ${usage.runtimeMs}ms exceeds maxRuntimeMs ${budget.maxRuntimeMs}ms`);
  }
  if (usage.healingAttempts > budget.maxHealingAttempts) {
    reasons.push(`healing attempts ${usage.healingAttempts} exceed maxHealingAttempts ${budget.maxHealingAttempts}`);
  }
  if (usage.provider && budget.allowedProviders.length > 0 && !budget.allowedProviders.includes(usage.provider)) {
    reasons.push(`provider ${usage.provider} is not allowed`);
  }

  return reasons;
}

function approvalReasonsFor(budget: Budget, usage: BudgetDecision["usage"]): string[] {
  const cost = usage.actualUsd > 0 ? usage.actualUsd : usage.estimatedUsd;
  if (budget.approvalRequiredAboveUsd > 0 && cost > budget.approvalRequiredAboveUsd) {
    return [`estimated cost ${cost} requires approval above ${budget.approvalRequiredAboveUsd}`];
  }
  return [];
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function intFrom(...values: unknown[]): number {
  return Math.trunc(numberFrom(...values));
}

function nonNegativeNumberFrom(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function nonNegativeIntFrom(...values: unknown[]): number {
  return Math.trunc(nonNegativeNumberFrom(...values));
}

function isNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value < 0;
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// --- Budget Approval Flow (Task 4.4) ---

/** A pending or resolved budget approval request. */
export interface BudgetApprovalRequest {
  id: string;
  runId: string;
  reasons: string[];
  /** The budget usage snapshot at the time the approval was requested. */
  usage: BudgetDecision["usage"];
  status: "pending" | "approved" | "denied";
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

/** In-memory budget approval registry. Shared across the process for route + chatRunner access. */
class BudgetApprovalRegistry {
  private approvals = new Map<string, BudgetApprovalRequest>();
  private resolvers = new Map<string, Set<(decision: "approved" | "denied" | "timeout") => void>>();

  /** Create a new approval request and return its ID. */
  createApproval(runId: string, reasons: string[], usage: BudgetDecision["usage"]): string {
    const id = `budget-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: BudgetApprovalRequest = {
      id,
      runId,
      reasons,
      usage,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.approvals.set(id, request);
    return id;
  }

  /** Record a decision on a pending approval. Returns the updated request or undefined if not found. */
  recordDecision(approvalId: string, decision: "approved" | "denied", decidedBy?: string): BudgetApprovalRequest | undefined {
    const request = this.approvals.get(approvalId);
    if (!request) return undefined;
    if (request.status !== "pending") return request;
    request.status = decision;
    request.decidedBy = decidedBy ?? "unknown";
    request.decidedAt = new Date().toISOString();
    // Resolve any waiting pollers
    const list = this.resolvers.get(approvalId);
    if (list) {
      for (const resolver of list) {
        resolver(decision);
      }
      this.resolvers.delete(approvalId);
    }
    return request;
  }

  /** Get a specific approval request. */
  getApproval(approvalId: string): BudgetApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }

  /** List all pending approval requests. */
  listPendingApprovals(): BudgetApprovalRequest[] {
    return [...this.approvals.values()].filter((a) => a.status === "pending");
  }

  /**
   * Wait for a decision on a pending approval with a timeout.
   * Resolves with "approved", "denied", or "timeout".
   */
  waitForDecision(approvalId: string, timeoutMs: number): Promise<"approved" | "denied" | "timeout"> {
    const request = this.approvals.get(approvalId);
    if (!request) return Promise.resolve("timeout");
    if (request.status !== "pending") return Promise.resolve(request.status as "approved" | "denied");

    return new Promise<"approved" | "denied" | "timeout">((resolve) => {
      let timer: NodeJS.Timeout;
      const resolver = (decision: "approved" | "denied" | "timeout") => {
        clearTimeout(timer);
        resolve(decision);
      };

      let list = this.resolvers.get(approvalId);
      if (!list) {
        list = new Set();
        this.resolvers.set(approvalId, list);
      }
      list.add(resolver);

      timer = setTimeout(() => {
        const currentList = this.resolvers.get(approvalId);
        if (currentList) {
          currentList.delete(resolver);
          if (currentList.size === 0) {
            this.resolvers.delete(approvalId);
          }
        }
        if (request.status === "pending") {
          request.status = "denied";
          request.decidedBy = "timeout";
          request.decidedAt = new Date().toISOString();
        }
        resolve("timeout");
      }, timeoutMs);
    });
  }
}

/** Global budget approval registry singleton. */
export const budgetApprovalRegistry = new BudgetApprovalRegistry();

/** Default timeout for budget approval polling (5 minutes). */
export const BUDGET_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Record an approval decision on the global registry.
 * Convenience wrapper for use from API routes.
 */
export function recordBudgetApprovalDecision(
  approvalId: string,
  decision: "approved" | "denied",
  decidedBy?: string,
): BudgetApprovalRequest | undefined {
  return budgetApprovalRegistry.recordDecision(approvalId, decision, decidedBy);
}

/**
 * Wait for a budget approval decision with a timeout.
 * Returns "approved", "denied", or "timeout".
 * Used by chatRunner to poll for budget decisions.
 */
export function waitForBudgetApproval(
  approvalId: string,
  timeoutMs: number = BUDGET_APPROVAL_TIMEOUT_MS,
): Promise<"approved" | "denied" | "timeout"> {
  return budgetApprovalRegistry.waitForDecision(approvalId, timeoutMs);
}
