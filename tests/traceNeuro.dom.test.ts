// DOM tests for neuro-symbolic trace drawer extensions (src/public/app.js, Chunk 36 Wave 2C).
//
// Validates:
//   - PREPROCESSING phase card renders before Planning.
//   - Preprocessor payload (intent, constraints, proposedToolCalls) is collapsed and escaped.
//   - PLANNING events surface pathsExplored when present.
//   - SYNTHESIZING events surface a decomposedResults snippet when present.
//   - Assistant messages with source === "proactive" show a Proactive badge.
//
// Reuses the provider panel vm harness; zero network/provider calls.
import { beforeEach, describe, expect, it } from "vitest";

import { createProviderPanelHarness, type ProviderPanelHarness } from "./support/providerPanelHarness";

let seq = 0;

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

function cards(harness: ProviderPanelHarness) {
  return harness.getEl("phase-cards").children.filter((c) => c.classList.contains("phase-card"));
}

function cardById(harness: ProviderPanelHarness, id: string) {
  return cards(harness).find((c) => c.dataset.phase === id);
}

function body(card: any) {
  return card.children.find((c: any) => c.classList.contains("phase-card__body"));
}

function detailBlocks(cardBody: any) {
  return cardBody.children.filter((c: any) => c.classList.contains("phase-card__details"));
}

function detailPre(cardBody: any, label: string): string {
  const block = detailBlocks(cardBody).find((d: any) => {
    const summary = d.children.find((c: any) => c.classList.contains("phase-card__details-summary"));
    return summary?.textContent === label;
  });
  const pre = block?.children.find((c: any) => c.classList.contains("phase-card__details-pre"));
  return pre?.textContent ?? "";
}

describe("Trace drawer neuro-symbolic phases (Chunk 36 Wave 2C)", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    seq = 0;
    harness = createProviderPanelHarness();
    harness.sandbox.resetPhaseCards();
  });

  it("renders the Preprocessing card before Planning", () => {
    const events = [
      event("TRIAGE", "PHASE_STARTED", 0),
      event("CONTEXT_BUILDING", "PHASE_STARTED", 10),
      event("PLANNING", "PHASE_STARTED", 20, {
        preprocessor: {
          intent: "Refactor pagination",
          constraints: ["keep tests green"],
          proposedToolCalls: [{ tool: "read_file", args: { path: "src/page.ts" } }],
        },
      }),
    ];
    harness.sandbox.renderPhaseCards({ phase: "PLANNING" }, events);

    const ids = cards(harness).map((c) => c.dataset.phase);
    expect(ids.indexOf("preprocessing")).toBeGreaterThan(ids.indexOf("context"));
    expect(ids.indexOf("planning")).toBeGreaterThan(ids.indexOf("preprocessing"));
    expect(cardById(harness, "preprocessing")?.dataset.status).toBe("done");
  });

  it("renders collapsed, escaped preprocessor payload from events", () => {
    const malicious = '<script>alert("xss")</script>';
    const events = [
      event("PLANNING", "PHASE_STARTED", 0, {
        preprocessor: {
          intent: malicious,
          constraints: ["no <b>html</b>"],
          proposedToolCalls: [{ tool: "grep", args: { pattern: "<img>" } }],
        },
      }),
    ];
    harness.sandbox.renderPhaseCards({ phase: "PLANNING" }, events);

    const preBody = body(cardById(harness, "preprocessing"));
    expect(detailBlocks(preBody)).toHaveLength(3);
    expect(detailPre(preBody, "Intent")).toBe(malicious);
    expect(detailPre(preBody, "Constraints")).toContain("no <b>html</b>");
    expect(detailPre(preBody, "Proposed tool calls")).toContain('"tool": "grep"');

    const intentPre = preBody.querySelector(".phase-card__details-pre");
    expect(intentPre?.children).toHaveLength(0);
  });

  it("shows pathsExplored on the Planning card when present", () => {
    const paths = ["Plan for: refactor auth", "Plan for: refactor auth (alternative path: minimize risk)"];
    const events = [
      event("PLANNING", "PHASE_STARTED", 0, {
        plannerOutput: { tasks: [{ title: "Step 1" }] },
        pathsExplored: paths,
      }),
    ];
    harness.sandbox.renderPhaseCards({ phase: "PLANNING" }, events);

    const planningBody = body(cardById(harness, "planning"));
    const text = detailPre(planningBody, "Paths explored");
    expect(text).toContain(paths[0]);
    expect(text).toContain(paths[1]);
  });

  it("shows a decomposedResults snippet on the Synthesis card when present", () => {
    const long = "sub-goal-a: ok\n".repeat(80);
    const events = [
      event("SYNTHESIZING", "PHASE_STARTED", 0, {
        decomposedResults: long,
        synthesis: { response: "Done.", status: "VALIDATED" },
      }),
    ];
    harness.sandbox.renderPhaseCards({ phase: "SYNTHESIZING" }, events);

    const synthBody = body(cardById(harness, "synthesis"));
    const snippet = detailPre(synthBody, "Decomposed results");
    expect(snippet.length).toBeLessThanOrEqual(501);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.startsWith("sub-goal-a: ok")).toBe(true);
  });

  it("adds a Proactive badge to assistant messages with source proactive", () => {
    harness.sandbox.renderMessage("assistant", "Hey — want me to finish pagination?", {
      source: "proactive",
    });

    const messages = harness.getEl("messages");
    const msg = messages.children.find((c) => c.classList.contains("msg--assistant"));
    const badge = msg?.querySelector(".msg__badge--proactive");
    expect(badge).toBeDefined();
    expect(badge?.textContent).toBe("Proactive");
  });

  it("does not add a Proactive badge to normal assistant messages", () => {
    harness.sandbox.renderMessage("assistant", "Here is the plan.", {});

    const messages = harness.getEl("messages");
    const msg = messages.children.find((c) => c.classList.contains("msg--assistant"));
    expect(msg?.querySelector(".msg__badge--proactive")).toBeNull();
  });
});