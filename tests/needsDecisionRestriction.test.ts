import { describe, expect, it } from "vitest";
import {
  ALLOWED_RUN_PHASE_TRANSITIONS,
  isAllowedRunPhaseTransition,
} from "../src/orchestration/runStateMachine.js";

describe("M20 — NEEDS_DECISION transition restrictions", () => {
  const needsDecisionTransitions = ALLOWED_RUN_PHASE_TRANSITIONS.NEEDS_DECISION;

  it("allows EXECUTING (approve operation)", () => {
    expect(needsDecisionTransitions).toContain("EXECUTING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "EXECUTING")).toBe(true);
  });

  it("allows SYNTHESIZING (deny operation, produce final answer)", () => {
    expect(needsDecisionTransitions).toContain("SYNTHESIZING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "SYNTHESIZING")).toBe(true);
  });

  it("allows PLANNING (re-plan after decision)", () => {
    expect(needsDecisionTransitions).toContain("PLANNING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "PLANNING")).toBe(true);
  });

  it("allows FAILED (timeout/abort)", () => {
    expect(needsDecisionTransitions).toContain("FAILED");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "FAILED")).toBe(true);
  });

  it("allows ABORTED (user abort)", () => {
    expect(needsDecisionTransitions).toContain("ABORTED");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "ABORTED")).toBe(true);
  });

  it("rejects TRIAGE", () => {
    expect(needsDecisionTransitions).not.toContain("TRIAGE");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "TRIAGE")).toBe(false);
  });

  it("rejects CONTEXT_BUILDING", () => {
    expect(needsDecisionTransitions).not.toContain("CONTEXT_BUILDING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "CONTEXT_BUILDING")).toBe(false);
  });

  it("rejects SKEPTIC_REVIEW", () => {
    expect(needsDecisionTransitions).not.toContain("SKEPTIC_REVIEW");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "SKEPTIC_REVIEW")).toBe(false);
  });

  it("rejects CRUCIBLE", () => {
    expect(needsDecisionTransitions).not.toContain("CRUCIBLE");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "CRUCIBLE")).toBe(false);
  });

  it("rejects DAG_COMPILATION", () => {
    expect(needsDecisionTransitions).not.toContain("DAG_COMPILATION");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "DAG_COMPILATION")).toBe(false);
  });

  it("rejects VALIDATING", () => {
    expect(needsDecisionTransitions).not.toContain("VALIDATING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "VALIDATING")).toBe(false);
  });

  it("rejects HEALING", () => {
    expect(needsDecisionTransitions).not.toContain("HEALING");
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "HEALING")).toBe(false);
  });

  it("has exactly 5 allowed transitions", () => {
    expect(needsDecisionTransitions).toHaveLength(5);
  });

  it("rejects CHAT_RECEIVED", () => {
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "CHAT_RECEIVED")).toBe(false);
  });

  it("rejects DONE", () => {
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "DONE")).toBe(false);
  });

  it("rejects recursion into NEEDS_DECISION", () => {
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "NEEDS_DECISION")).toBe(false);
  });
});
