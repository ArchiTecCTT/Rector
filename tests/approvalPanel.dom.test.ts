// DOM/example tests for the Approval UX panel (src/public/app.js, task 9.2).
//
// Validates (by example/DOM assertion): Requirements 9.1, 9.2, 9.6
//   - 9.1: when a run pauses for a decision (a DECISION_REQUESTED approval event arrives over the
//     existing SSE stream), the panel presents the pending operation.
//   - 9.2: the redacted diff, command, and target path are displayed BEFORE any approve/deny action
//     can be submitted — the actions are disabled until the pending operation's details render.
//   - 9.6: the panel displays the server-redacted values verbatim and never reconstructs a secret;
//     a redacted placeholder in the diff/command/target path is shown as-is.
//
// The panel is exercised through the same fake-DOM vm harness used by the other panel tests, with an
// injected `fetch` double. Zero network/provider calls: the decision endpoint is served in-test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

// Build a DECISION_REQUESTED run event carrying a redacted approval request, exactly as the server
// emits it over the SSE stream (createDecisionRequest persists the redacted decisionRequest on the
// run and on the event payload).
function approvalEvent(overrides: {
  runId?: string;
  operationId?: string;
  diff?: string;
  command?: string;
  targetPath?: string;
  riskyCommand?: boolean;
} = {}) {
  const runId = overrides.runId ?? "run-1";
  const operationId = overrides.operationId ?? "op-1";
  return {
    id: "evt-1",
    runId,
    type: "DECISION_REQUESTED",
    phase: "NEEDS_DECISION",
    payload: {
      fromPhase: "EXECUTING",
      toPhase: "NEEDS_DECISION",
      decisionRequest: {
        kind: "approval",
        operationId,
        presentedAt: "2024-01-01T00:00:00.000Z",
        riskyCommand: overrides.riskyCommand ?? false,
        view: {
          runId,
          operationId,
          diff: overrides.diff ?? "--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new",
          command: overrides.command,
          targetPath: overrides.targetPath ?? "src/file.ts",
        },
      },
    },
  };
}

describe("Approval UX panel", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores non-approval decision requests (extractApprovalRequest is null) (Req 9.1)", () => {
    const extract = harness.sandbox.extractApprovalRequest;
    expect(extract(undefined)).toBeNull();
    expect(extract({ kind: "other", operationId: "op" })).toBeNull();
    expect(extract({ kind: "approval" })).toBeNull(); // missing operationId
    const ok = extract({ kind: "approval", operationId: "op-9", view: { diff: "d", targetPath: "p" } });
    expect(ok).not.toBeNull();
    expect(ok.operationId).toBe("op-9");
    expect(ok.view.targetPath).toBe("p");
  });

  it("presents the pending operation with redacted details and enables the actions only then (Req 9.1, 9.2)", () => {
    // Before any presentation the approve/deny actions are disabled (bindApproval ran during init).
    expect(harness.getEl("approval-approve").disabled).toBe(true);
    expect(harness.getEl("approval-deny").disabled).toBe(true);

    // A DECISION_REQUESTED approval event arrives over the live stream.
    harness.sandbox.maybePresentApprovalFromEvent(
      approvalEvent({ command: "rm -rf build", riskyCommand: true }),
    );

    // Req 9.2: the redacted diff, command, and target path are displayed.
    expect(harness.getEl("approval-detail").hidden).toBe(false);
    expect(harness.getEl("approval-run-id").textContent).toBe("run-1");
    expect(harness.getEl("approval-operation-id").textContent).toBe("op-1");
    expect(harness.getEl("approval-target-path").textContent).toBe("src/file.ts");
    expect(harness.getEl("approval-command-block").hidden).toBe(false);
    expect(harness.getEl("approval-command").textContent).toBe("rm -rf build");
    expect(harness.getEl("approval-risky").hidden).toBe(false);
    expect(harness.getEl("approval-diff").textContent).toContain("+new");

    // Req 9.1: the panel auto-opens, and the badge reflects the pending operation.
    expect(harness.getEl("approval-modal").hidden).toBe(false);
    expect(harness.getEl("approval-badge").hidden).toBe(false);

    // Only now (details rendered) are the actions enabled.
    expect(harness.getEl("approval-approve").disabled).toBe(false);
    expect(harness.getEl("approval-deny").disabled).toBe(false);
  });

  it("hides the command block when the operation carries no command (Req 9.2)", () => {
    harness.sandbox.maybePresentApprovalFromEvent(approvalEvent({})); // no command
    expect(harness.getEl("approval-command-block").hidden).toBe(true);
    expect(harness.getEl("approval-risky").hidden).toBe(true);
    expect(harness.getEl("approval-target-path").textContent).toBe("src/file.ts");
  });

  it("displays server-redacted values verbatim and never reconstructs a secret (Req 9.6)", () => {
    harness.sandbox.maybePresentApprovalFromEvent(
      approvalEvent({
        command: "deploy --token [REDACTED]",
        diff: "+const apiKey = \"[REDACTED]\";",
        targetPath: "src/secrets/[REDACTED].ts",
        riskyCommand: true,
      }),
    );
    const command = harness.getEl("approval-command").textContent;
    const diff = harness.getEl("approval-diff").textContent;
    const target = harness.getEl("approval-target-path").textContent;
    // The redacted placeholder is shown as-is; no live key material is present.
    expect(command).toContain("[REDACTED]");
    expect(diff).toContain("[REDACTED]");
    expect(target).toContain("[REDACTED]");
    for (const value of [command, diff, target]) {
      expect(value).not.toMatch(/sk-[A-Za-z0-9]/);
    }
  });

  it("submits an approval to the decision endpoint and records a success indication (Req 9.1)", async () => {
    harness.sandbox.maybePresentApprovalFromEvent(approvalEvent({ command: "npm run build", riskyCommand: true }));
    harness.getEl("approval-decided-by").value = "alice";

    let requestedUrl: string | undefined;
    let requestBody: any;
    harness.setFetchHandler(async (url, options) => {
      requestedUrl = url;
      requestBody = JSON.parse(options.body);
      return jsonResponse({ decisionProcessed: true, record: { decision: "approve" } });
    });

    await harness.sandbox.submitApprovalDecision("approve");

    expect(requestedUrl).toBe("/api/runs/run-1/decision");
    expect(requestBody).toEqual({ operationId: "op-1", decision: "approve", decidedBy: "alice" });

    const result = harness.getEl("approval-result");
    expect(result.hidden).toBe(false);
    expect(result.className).toContain("approval-result--ok");
    expect(result.textContent).toContain("approved");
    // Decided: actions stay disabled (cannot submit twice) and the badge clears.
    expect(harness.getEl("approval-approve").disabled).toBe(true);
    expect(harness.getEl("approval-deny").disabled).toBe(true);
    expect(harness.getEl("approval-badge").hidden).toBe(true);
  });

  it("submits a denial with the default identity when none is entered", async () => {
    harness.sandbox.maybePresentApprovalFromEvent(approvalEvent({}));

    let requestBody: any;
    harness.setFetchHandler(async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ decisionProcessed: true, record: { decision: "deny" } });
    });

    await harness.sandbox.submitApprovalDecision("deny");

    expect(requestBody.decision).toBe("deny");
    expect(requestBody.decidedBy).toBe("browser-user");
    expect(harness.getEl("approval-result").textContent).toContain("denied");
  });

  it("keeps the operation pending and re-enables the actions when the decision cannot be processed (Req 9.7)", async () => {
    harness.sandbox.maybePresentApprovalFromEvent(approvalEvent({}));

    harness.setFetchHandler(async () =>
      jsonResponse(
        { decisionProcessed: false, code: "NOT_AWAITING_DECISION", error: "not awaiting a decision" },
        { ok: false, status: 409 },
      ),
    );

    await harness.sandbox.submitApprovalDecision("approve");

    const result = harness.getEl("approval-result");
    expect(result.hidden).toBe(false);
    expect(result.className).toContain("approval-result--err");
    // Still pending: actions re-enabled so the user can retry, badge still shown.
    expect(harness.getEl("approval-approve").disabled).toBe(false);
    expect(harness.getEl("approval-deny").disabled).toBe(false);
    expect(harness.getEl("approval-badge").hidden).toBe(false);
  });

  it("opening the panel with nothing pending shows the empty state and no actions", () => {
    harness.sandbox.openApprovalPanel();
    expect(harness.getEl("approval-modal").hidden).toBe(false);
    expect(harness.getEl("approval-empty").hidden).toBe(false);
    expect(harness.getEl("approval-detail").hidden).toBe(true);
    expect(harness.getEl("approval-foot").hidden).toBe(true);
  });
});
