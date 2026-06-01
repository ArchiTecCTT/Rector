import { describe, it, expect } from "vitest";
import {
  isFailureTrigger,
  planFlagshipTask,
  executeSLM,
  validateResults,
  applyHealing,
  reexecHealed,
  synthesizeFinalOutput,
  LocalTelemetry,
} from "../src/adapters/providers";
import { SubtaskSchema } from "../src/domain/schemas";

describe("adapters/providers", () => {
  describe("isFailureTrigger", () => {
    it("detects fail keyword", () => {
      expect(isFailureTrigger("fix the broken fail logic")).toBe(true);
    });
    it("detects retry keyword", () => {
      expect(isFailureTrigger("please retry this task")).toBe(true);
    });
    it("detects broken keyword", () => {
      expect(isFailureTrigger("the broken build process")).toBe(true);
    });
    it("safe task returns false", () => {
      expect(isFailureTrigger("build a new REST API")).toBe(false);
    });
  });

  describe("planFlagshipTask", () => {
    it("plans refactor task", () => {
      const plan = planFlagshipTask("Refactor the auth module");
      expect(plan.length).toBe(3);
      expect(plan[0].title).toContain("Analyze");
    });

    it("plans build task", () => {
      const plan = planFlagshipTask("Build a CLI tool");
      expect(plan.length).toBe(3);
      expect(plan[0].title).toContain("Outline");
    });

    it("plans generic task", () => {
      const plan = planFlagshipTask("Review documentation");
      expect(plan.length).toBe(3);
    });
  });

  describe("executeSLM", () => {
    it("succeeds for normal task", () => {
      const r = executeSLM("Implement API", "Build a REST API");
      expect(r.success).toBe(true);
      expect(r.result).toContain("Implemented");
    });

    it("fails when description contains 'fail'", () => {
      const r = executeSLM("fix broken", "fix the broken fail logic");
      expect(r.success).toBe(false);
    });
  });

  describe("validateResults", () => {
    it("passes with all completed subtasks", () => {
      const tasks = [
        SubtaskSchema.parse({ id: "s1", title: "a", status: "completed", createdAt: 1, updatedAt: 1 }),
      ];
      const result = validateResults(tasks);
      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fails with a failed subtask", () => {
      const tasks = [
        SubtaskSchema.parse({ id: "s1", title: "a", status: "failed", error: "boom", createdAt: 1, updatedAt: 1 }),
      ];
      const result = validateResults(tasks);
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("healing workflow", () => {
    it("applyHealing resets failed subtasks to running", () => {
      const subs = [
        SubtaskSchema.parse({ id: "s1", title: "fix", status: "failed", error: "err", createdAt: 1, updatedAt: 1 }),
        SubtaskSchema.parse({ id: "s2", title: "skip", status: "completed", result: "done", createdAt: 1, updatedAt: 1 }),
      ];
      const healed = applyHealing(subs);
      expect(healed[0].status).toBe("running");
      expect(healed[0].error).toBeUndefined();
      expect(healed[1].status).toBe("completed");
    });

    it("reexecHealed re-runs repaired subtasks", () => {
      let healed = [
        SubtaskSchema.parse({ id: "s1", title: "build API", status: "running", result: "[HEALED] retrying: build API", createdAt: 1, updatedAt: 2 }),
      ];
      let rerun = reexecHealed(healed, "Build a broken retry API");
      expect(rerun[0].status).toBe("completed");
      expect(rerun[0].result).toContain("[HEALED]");
      expect(rerun[0].result).toContain("Implemented");
    });

    it("reexecHealed preserves failure for explicitly unhealable tasks", () => {
      const healed = [
        SubtaskSchema.parse({ id: "s1", title: "build API", status: "running", result: "[HEALED] retrying: build API", createdAt: 1, updatedAt: 2 }),
      ];
      const rerun = reexecHealed(healed, "Build an unhealable broken API");
      expect(rerun[0].status).toBe("failed");
      expect(rerun[0].result).toContain("[RETRY-FAIL]");
      expect(rerun[0].error).toBeDefined();
    });
  });

  describe("synthesizeFinalOutput", () => {
    it("produces markdown summary from completed subtasks", () => {
      const subs = [
        SubtaskSchema.parse({ id: "s1", title: "impl", status: "completed", result: "done", createdAt: 1, updatedAt: 1 }),
      ];
      const output = synthesizeFinalOutput(subs);
      expect(output).toContain("Summary");
      expect(output).toContain("1/1");
    });
  });

  describe("LocalTelemetry", () => {
    it("records events and computes totals", () => {
      const tel = new LocalTelemetry();
      tel.record({ type: "model.invocation", cost: 0.05, latencyMs: 10 });
      tel.record({ type: "validation.run", cost: 0.01, latencyMs: 20 });
      const metrics = tel.getMetrics();
      expect(metrics.modelInvocations).toBe(1);
      expect(metrics.validationRuns).toBe(1);
      expect(metrics.totalCost).toBeCloseTo(0.06, 2);
    });

    it("reset clears all counters", () => {
      const tel = new LocalTelemetry();
      tel.record({ type: "model.invocation", cost: 0.1 });
      tel.reset();
      const metrics = tel.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.modelInvocations).toBe(0);
    });
  });
});
