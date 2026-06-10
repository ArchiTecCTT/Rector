// DOM tests for the Trace_Drawer Phase_Cards (src/public/app.js, task 12).
//
// Validates (by example/DOM assertion): Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
//   - 7.1: the drawer renders one Phase_Card per pipeline phase (triage → synthesis), in order.
//   - 7.2: each card's status is derived from the actual persisted run events, distinguishing
//     pending / active / done / failed / decision.
//   - 7.3: each card expands/collapses with accessible button semantics (aria-expanded, aria-controls).
//   - 7.4: the observability summary, decision section, and raw run-events view are preserved.
//   - 7.5 / Property 9 (Trace fidelity): every rendered value derives from a real event — pending
//     phases show no duration and no fabricated events; durations appear only when derivable from
//     real event timestamps.
//   - 7.6: a non-success terminal phase (failed / needs-decision) is styled distinctly from a clean
//     completion.
//
// Reuses the same fake-DOM vm harness as the Provider_Test_Panel / Setup_Wizard DOM tests; the
// Phase_Cards are built with createElement/appendChild so the resulting tree is fully navigable.
// Zero network/provider calls.
import { beforeEach, describe, expect, it } from "vitest";

import { createProviderPanelHarness, type ProviderPanelHarness } from "./support/providerPanelHarness";

// The canonical phase cards, in the order Req 7.1 mandates (includes preprocessing, Chunk 36).
const EXPECTED_CARDS = [
  { id: "triage", label: "Triage" },
  { id: "context", label: "Context building" },
  { id: "preprocessing", label: "Preprocessing" },
  { id: "planning", label: "Planning" },
  { id: "skeptic", label: "Skeptic review" },
  { id: "crucible", label: "Crucible arbitration" },
  { id: "dag", label: "DAG compilation" },
  { id: "execution", label: "Execution" },
  { id: "validation", label: "Validation & healing" },
  { id: "synthesis", label: "Synthesis" },
];

let seq = 0;
// Build a real-shaped persisted RunEvent. createdAt drives the (real) duration derivation.
function event(phase: string, type: string, offsetMs: number, payload: Record<string, unknown> = {}) {
  return {
    id: `evt-${seq++}`,
    runId: "run-1",
    type,
    phase,
    payload,
    createdAt: new Date(1_700_000_000_000 + offsetMs).toISOString(),
  };
}

// Find the rendered card elements (in DOM order) from the #phase-cards container.
function cards(harness: ProviderPanelHarness) {
  return harness.getEl("phase-cards").children.filter((c) => c.classList.contains("phase-card"));
}
function cardById(harness: ProviderPanelHarness, id: string) {
  return cards(harness).find((c) => c.dataset.phase === id);
}
function header(card: any) {
  return card.children.find((c: any) => c.classList.contains("phase-card__header"));
}
function body(card: any) {
  return card.children.find((c: any) => c.classList.contains("phase-card__body"));
}
function statusText(card: any): string {
  const h = header(card);
  const s = h.children.find((c: any) => c.classList.contains("phase-card__status"));
  return s ? s.textContent : "";
}
function durationText(card: any): string {
  const h = header(card);
  const d = h.children.find((c: any) => c.classList.contains("phase-card__duration"));
  return d ? d.textContent : "";
}

describe("Trace_Drawer Phase_Cards", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    seq = 0;
    harness = createProviderPanelHarness();
    harness.sandbox.resetPhaseCards();
  });

  it("renders one card per pipeline phase, in order (Req 7.1)", () => {
    harness.sandbox.renderPhaseCards({ phase: "TRIAGE" }, [event("TRIAGE", "PHASE_STARTED", 0)]);

    const rendered = cards(harness);
    expect(rendered).toHaveLength(EXPECTED_CARDS.length);
    expect(rendered.map((c) => c.dataset.phase)).toEqual(EXPECTED_CARDS.map((c) => c.id));
    const labels = rendered.map((c) => {
      const name = header(c).children.find((x: any) => x.classList.contains("phase-card__name"));
      return name.textContent;
    });
    expect(labels).toEqual(EXPECTED_CARDS.map((c) => c.label));
  });

  it("maps card status from real events: done/active/pending (Req 7.2)", () => {
    // A run that has progressed through PLANNING but not beyond.
    const events = [
      event("CHAT_RECEIVED", "RUN_CREATED", 0),
      event("TRIAGE", "PHASE_STARTED", 10, { triage: { route: "code", complexity: "medium" } }),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 20),
      event("PLANNING", "PHASE_STARTED", 30, { plannerOutput: { tasks: [1, 2] } }),
    ];
    harness.sandbox.renderPhaseCards({ phase: "PLANNING" }, events);

    expect(cardById(harness, "triage").dataset.status).toBe("done");
    expect(cardById(harness, "context").dataset.status).toBe("done");
    expect(cardById(harness, "planning").dataset.status).toBe("active");
    expect(cardById(harness, "skeptic").dataset.status).toBe("pending");
    expect(cardById(harness, "synthesis").dataset.status).toBe("pending");

    // Status is always conveyed as text, not color alone (Req 9.4 reinforcement).
    expect(statusText(cardById(harness, "planning"))).toBe("Active");
    expect(statusText(cardById(harness, "triage"))).toBe("Done");
    expect(statusText(cardById(harness, "skeptic"))).toBe("Pending");
  });

  it("marks every reached card done for a completed run (Req 7.2)", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 10),
      event("PLANNING", "PHASE_STARTED", 20),
      event("SKEPTIC_REVIEW", "PHASE_STARTED", 30),
      event("CRUCIBLE", "PHASE_STARTED", 40),
      event("DAG_COMPILATION", "PHASE_STARTED", 50),
      event("EXECUTING", "PHASE_STARTED", 60),
      event("VALIDATING", "PHASE_STARTED", 70),
      event("SYNTHESIZING", "PHASE_STARTED", 80),
      event("DONE", "RUN_COMPLETED", 90),
    ];
    harness.sandbox.renderPhaseCards({ phase: "DONE", status: "completed" }, events);

    for (const { id } of EXPECTED_CARDS) {
      // Preprocessing is external-only; without a preprocessor payload it stays honestly pending.
      if (id === "preprocessing") {
        expect(cardById(harness, id).dataset.status).toBe("pending");
        continue;
      }
      expect(cardById(harness, id).dataset.status).toBe("done");
    }
  });

  it("styles a failed terminal phase distinctly (Req 7.6)", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 10),
      event("PLANNING", "PHASE_STARTED", 20),
      event("SKEPTIC_REVIEW", "PHASE_STARTED", 30),
      event("CRUCIBLE", "PHASE_STARTED", 40),
      event("DAG_COMPILATION", "PHASE_STARTED", 50),
      event("EXECUTING", "PHASE_STARTED", 60),
    ];
    harness.sandbox.renderPhaseCards({ phase: "FAILED", status: "failed" }, events);

    const execution = cardById(harness, "execution");
    expect(execution.dataset.status).toBe("failed");
    expect(execution.classList.contains("phase-card--failed")).toBe(true);
    // Distinct from a clean completion: a done card never carries the failed modifier.
    expect(cardById(harness, "triage").classList.contains("phase-card--failed")).toBe(false);
    expect(cardById(harness, "triage").dataset.status).toBe("done");
    // Phases after the failure stay pending (never fabricated as reached).
    expect(cardById(harness, "validation").dataset.status).toBe("pending");
    expect(statusText(execution)).toBe("Failed");
  });

  it("styles a needs-decision terminal phase distinctly (Req 7.6)", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 10),
      event("PLANNING", "PHASE_STARTED", 20),
      event("SKEPTIC_REVIEW", "PHASE_STARTED", 30),
    ];
    harness.sandbox.renderPhaseCards({ phase: "NEEDS_DECISION", status: "needs_decision" }, events);

    const skeptic = cardById(harness, "skeptic");
    expect(skeptic.dataset.status).toBe("decision");
    expect(skeptic.classList.contains("phase-card--decision")).toBe(true);
    expect(statusText(skeptic)).toBe("Needs decision");
  });

  it("expands and collapses a card with accessible button semantics (Req 7.3)", () => {
    harness.sandbox.renderPhaseCards({ phase: "TRIAGE" }, [event("TRIAGE", "PHASE_STARTED", 0)]);

    const triage = cardById(harness, "triage");
    const h = header(triage);
    const b = body(triage);

    // Header is a real button wired to its body via aria-controls.
    expect(h.tagName).toBe("BUTTON");
    expect(h.getAttribute("aria-controls")).toBe(b.id);

    // The triage card auto-expands as the active phase; collapse then re-expand it.
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(b.hidden).toBe(false);

    h.dispatch("click");
    expect(h.getAttribute("aria-expanded")).toBe("false");
    expect(b.hidden).toBe(true);

    h.dispatch("click");
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(b.hidden).toBe(false);
  });

  it("fabricates no values: pending phases show no duration and no events (Req 7.5 / Property 9)", () => {
    // A run with no events: every card is pending, with no durations and an explicit empty state.
    harness.sandbox.renderPhaseCards({ phase: undefined }, []);

    for (const { id } of EXPECTED_CARDS) {
      const card = cardById(harness, id);
      expect(card.dataset.status).toBe("pending");
      // No fabricated duration.
      expect(durationText(card)).toBe("");
      // No fabricated events; an honest empty-state line instead.
      const b = body(card);
      expect(b.querySelectorAll(".phase-card__event")).toHaveLength(0);
      const empty = b.children.find((c: any) => c.classList.contains("phase-card__empty"));
      expect(empty).toBeDefined();
    }
  });

  it("derives durations and evidence only from real event data (Req 7.5 / Property 9)", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0, { triage: { route: "code", complexity: "high" } }),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 50),
      event("PLANNING", "PHASE_STARTED", 200),
    ];
    harness.sandbox.renderPhaseCards({ phase: "PLANNING" }, events);

    // Triage duration = time to the next phase's first event = 50ms (real-derived).
    expect(durationText(cardById(harness, "triage"))).toBe("50ms");
    // Context duration = 200 - 50 = 150ms.
    expect(durationText(cardById(harness, "context"))).toBe("150ms");
    // The active last phase has no later event, so no duration is invented.
    expect(durationText(cardById(harness, "planning"))).toBe("");

    // Evidence comes straight from the real payload.
    const triageBody = body(cardById(harness, "triage"));
    const evidence = triageBody.children.find((c: any) => c.classList.contains("phase-card__evidence"));
    expect(evidence.textContent).toContain("code/high");

    // The real event type is listed for the reached phase.
    const eventItems = triageBody.querySelectorAll(".phase-card__event");
    expect(eventItems.map((e: any) => e.textContent)).toContain("PHASE_STARTED");
  });

  it("preserves the observability summary, decision section, and raw run-events view (Req 7.4)", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0),
      event("SKEPTIC_REVIEW", "PHASE_STARTED", 10),
      event("NEEDS_DECISION", "DECISION_REQUESTED", 20, { reason: "needs human input" }),
    ];
    const result = {
      run: { phase: "NEEDS_DECISION", status: "needs_decision", traceId: "trace-1" },
      events,
      observability: { spanCount: 5, durationMs: 42, modelCallCount: 0, estimatedCostUsd: 0 },
    };
    harness.sandbox.renderTrace(result);

    // Observability summary still populated from the run data.
    expect(harness.getEl("obs-spans").textContent).toBe("5");
    expect(harness.getEl("obs-duration").textContent).toBe("42ms");

    // Decision section revealed for a needs-decision run.
    expect(harness.getEl("decision-section").hidden).toBe(false);

    // Raw run-events view still rendered (one row per event).
    expect(harness.getEl("events").children.length).toBe(events.length);

    // Phase cards rendered alongside the preserved sections.
    expect(cards(harness)).toHaveLength(EXPECTED_CARDS.length);
  });
});
