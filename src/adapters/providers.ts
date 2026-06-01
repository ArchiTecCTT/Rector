import { Subtask } from "../domain/schemas";

export interface WorkerDependencies {
  telemetry: {
    record: (e: any) => void;
    getMetrics: () => any;
  };
  eventBus: {
    publish: (topic: string, payload: Record<string, unknown>) => void;
  };
  now: () => number;
}

/** Detects if the task description should trigger a healing path */
export function isFailureTrigger(description: string): boolean {
  return /\b(fail|broken|retry|error|exception)\b/i.test(description);
}

/** Plan a task into deterministic subtasks */
export function planFlagshipTask(description: string): Array<{ title: string }> {
  const normalized = description.toLowerCase();
  if (normalized.includes("refactor")) {
    return [
      { title: "Analyze codebase structure" },
      { title: "Identify refactor targets" },
      { title: "Apply refactor patches" },
    ];
  }
  if (normalized.includes("build") || normalized.includes("create") || normalized.includes("implement")) {
    return [
      { title: "Outline architecture" },
      { title: "Implement core logic" },
      { title: "Write tests" },
    ];
  }
  return [
    { title: "Analyze request" },
    { title: "Design solution" },
    { title: "Implement solution" },
  ];
}

/** Simulate SLM execution for a subtask */
export function executeSLM(subtaskTitle: string, taskDescription: string): { result: string; success: boolean } {
  const desc = (taskDescription + " " + subtaskTitle).toLowerCase();

  if (/\b(fail|broken)\b/i.test(desc)) {
    return { result: `Execution failed for: ${subtaskTitle}`, success: false };
  }

  if (/\bretry\b/i.test(desc)) {
    return { result: `Retry-pending result for: ${subtaskTitle}`, success: true };
  }

  if (desc.includes("refactor")) {
    return { result: `Refactored ${subtaskTitle} with clean patterns`, success: true };
  }

  return { result: `Implemented ${subtaskTitle}`, success: true };
}

/** Validate subtask results and return pass/fail */
export function validateResults(subtasks: Subtask[]): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const st of subtasks) {
    if (st.status === "failed") {
      errors.push(`Subtask '${st.title}' failed: ${st.error ?? "unknown error"}`);
    }
  }
  return { passed: errors.length === 0, errors };
}

/** Apply a localized fix to subtask output */
export function applyHealing(subtasks: Subtask[]): Subtask[] {
  return subtasks.map((st) => {
    if (st.status === "failed") {
      return { ...st, status: "running" as const, error: undefined, result: `[HEALED] retrying: ${st.title}`, updatedAt: Date.now() };
    }
    return st;
  });
}

function healingRetryDescription(taskDescription: string): string {
  if (/\b(unhealable|permanent)\b/i.test(taskDescription)) {
    return taskDescription;
  }
  return taskDescription.replace(/\b(fail|broken|error|exception)\b/gi, "healed").replace(/\bretry\b/gi, "verified");
}

/** Re-run execution on healed subtasks */
export function reexecHealed(subtasks: Subtask[], taskDescription: string): Subtask[] {
  const retryDescription = healingRetryDescription(taskDescription);
  return subtasks.map((st) => {
    if (st.result?.startsWith("[HEALED]")) {
      const exec = executeSLM(st.title, retryDescription);
      return {
        ...st,
        status: exec.success ? ("completed" as const) : ("failed" as const),
        result: exec.success ? `[HEALED] ${exec.result}` : `[RETRY-FAIL] ${st.title}: ${exec.result}`,
        error: exec.success ? undefined : exec.result,
        completedAt: exec.success ? Date.now() : undefined,
        updatedAt: Date.now(),
      };
    }
    return st;
  });
}

/** Synthesize human-readable summary from subtasks */
export function synthesizeFinalOutput(subtasks: Subtask[]): string {
  const completed = subtasks.filter((s) => s.status === "completed");
  const lines = [
    `## Summary`,
    `Completed ${completed.length}/${subtasks.length} subtasks.`,
    ``,
    `### Completed Items`,
    ...completed.map((s) => `- ${s.title}: ${s.result ?? "done"}`),
  ];
  return lines.join("\n");
}

/** Telemetry event types */
export type TelemetryEventType = "model.invocation" | "cache.hit" | "validation.run" | "healing.applied" | "synthesis.run";

export interface TelemetryEvent {
  type: TelemetryEventType;
  cost: number;
  latencyMs: number;
  model?: string;
  detail?: string;
}

export class LocalTelemetry {
  private events: TelemetryEvent[] = [];
  private cacheHits = 0;
  private modelInvocations = 0;
  private validationRuns = 0;
  private healingRuns = 0;
  private synthesisRuns = 0;
  private totalCost = 0;

  record(event: Omit<TelemetryEvent, "cost" | "latencyMs"> & { cost?: number; latencyMs?: number }): void {
    const full: TelemetryEvent = {
      cost: event.cost ?? 0.01,
      latencyMs: event.latencyMs ?? Math.floor(Math.random() * 80) + 10,
      type: event.type,
      model: event.model,
      detail: event.detail,
    };
    this.events.push(full);
    this.totalCost += full.cost;
    switch (full.type) {
      case "model.invocation": this.modelInvocations++; break;
      case "cache.hit": this.cacheHits++; break;
      case "validation.run": this.validationRuns++; break;
      case "healing.applied": this.healingRuns++; break;
      case "synthesis.run": this.synthesisRuns++; break;
    }
  }

  getMetrics() {
    return {
      modelInvocations: this.modelInvocations,
      cacheHits: this.cacheHits,
      validationRuns: this.validationRuns,
      healingRuns: this.healingRuns,
      synthesisRuns: this.synthesisRuns,
      totalCost: Math.round(this.totalCost * 1000) / 1000,
      events: [...this.events],
    };
  }

  reset(): void {
    this.events = [];
    this.cacheHits = 0;
    this.modelInvocations = 0;
    this.validationRuns = 0;
    this.healingRuns = 0;
    this.synthesisRuns = 0;
    this.totalCost = 0;
  }
}
