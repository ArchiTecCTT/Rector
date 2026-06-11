import { describe, expect, it, vi } from "vitest";
import {
  ApprovalWorkflowPayloadSchema,
  EscalationTicketPayloadSchema,
  LinearWorkflowAdapter,
  MakeWorkflowAdapter,
  WorkflowIntegrationError,
  WorkflowNotificationPayloadSchema,
  WorkflowPayloadSchema,
  WorkflowReportPayloadSchema,
  createBrowserStackPlanStub,
  createRequestlyPlanStub,
} from "../src/workflows";

const NOW = "2026-01-01T00:00:00.000Z";

describe("external workflow payload schemas", () => {
  it("validates notification, report, approval, and escalation payloads", () => {
    const notification = WorkflowNotificationPayloadSchema.parse({
      kind: "notification",
      channel: "operator",
      severity: "warning",
      title: "Run needs attention",
      message: "Validation failed after healing attempts.",
      runId: "run-1",
    });
    expect(notification.metadata).toEqual({});

    const report = WorkflowReportPayloadSchema.parse({
      kind: "report",
      title: "Daily Rector report",
      summary: "All local checks passed.",
      generatedAt: NOW,
      runIds: ["run-1"],
      metrics: { passed: 1, failed: 0 },
      links: [{ label: "Operator", url: "https://example.test/operator" }],
    });
    expect(report.links).toHaveLength(1);

    const approval = ApprovalWorkflowPayloadSchema.parse({
      kind: "approval",
      approvalId: "approval-1",
      runId: "run-1",
      title: "Approve file write",
      summary: "A patch proposal needs review.",
      risk: "medium",
      options: [
        { id: "approve", label: "Approve", consequences: "Patch may be applied by a later executor." },
        { id: "reject", label: "Reject", consequences: "Run remains blocked." },
      ],
      requestedBy: "rector-local",
    });
    expect(approval.status).toBe("pending");

    const escalation = EscalationTicketPayloadSchema.parse({
      kind: "escalationTicket",
      title: "Investigate failed run",
      description: "The run reached NEEDS_DECISION.",
      runId: "run-1",
      labels: ["rector", "needs-decision"],
      priority: "high",
    });
    expect(escalation.labels).toEqual(["rector", "needs-decision"]);
  });

  it("rejects malformed workflow payloads", () => {
    expect(() => WorkflowNotificationPayloadSchema.parse({ kind: "notification", channel: "operator", title: "x" })).toThrow();
    expect(() => WorkflowReportPayloadSchema.parse({ kind: "report", title: "x", summary: "x", generatedAt: "not-a-date" })).toThrow();
    expect(() =>
      ApprovalWorkflowPayloadSchema.parse({
        kind: "approval",
        approvalId: "approval-1",
        runId: "run-1",
        title: "Approve",
        summary: "Missing options",
        risk: "low",
        options: [],
      })
    ).toThrow();
    expect(() => EscalationTicketPayloadSchema.parse({ kind: "escalationTicket", title: "x", priority: "urgent" })).toThrow();
  });
});

describe("Linear workflow adapter", () => {
  it("validates required config without making network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new LinearWorkflowAdapter({ apiKey: "", teamId: "" });

    expect(() => adapter.validateConfig()).toThrow(WorkflowIntegrationError);
    expect(() => adapter.validateConfig()).toThrow(/LINEAR_API_KEY is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("builds a GraphQL issue request without network access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new LinearWorkflowAdapter({
      apiKey: "linear-test-key",
      teamId: "team-123",
      baseUrl: "https://linear.unit.test/graphql",
    });

    const built = adapter.buildCreateIssueRequest({
      kind: "escalationTicket",
      title: "Investigate Rector run",
      description: "No network in unit tests.",
      runId: "run-123",
      labels: ["rector", "alpha"],
      priority: "medium",
      metadata: { source: "unit-test" },
    });

    expect(built.url).toBe("https://linear.unit.test/graphql");
    expect(built.init.method).toBe("POST");
    expect(built.init.headers).toMatchObject({
      Authorization: "linear-test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(built.init.body);
    expect(body.query).toContain("issueCreate");
    expect(body.variables.input).toMatchObject({
      teamId: "team-123",
      title: "Investigate Rector run",
      description: expect.stringContaining("No network in unit tests."),
      labelIds: ["rector", "alpha"],
    });
    expect(body.variables.input.description).toContain("run-123");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps live Linear issue creation disabled by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new LinearWorkflowAdapter({ apiKey: "linear-test-key", teamId: "team-123" });

    await expect(
      adapter.createIssue({ kind: "escalationTicket", title: "Blocked run", description: "Needs approval" })
    ).rejects.toMatchObject({ code: "NETWORK_DISABLED", provider: "linear" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Make workflow adapter", () => {
  it("validates webhook config without making network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new MakeWorkflowAdapter({ webhookUrl: "" });

    expect(() => adapter.validateConfig()).toThrow(WorkflowIntegrationError);
    expect(() => adapter.validateConfig()).toThrow(/MAKE_WEBHOOK_URL is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("builds a webhook request for approval workflows without network access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new MakeWorkflowAdapter({ webhookUrl: "https://hook.make.unit.test/abc", webhookSecret: "secret" });

    const payload = ApprovalWorkflowPayloadSchema.parse({
      kind: "approval",
      approvalId: "approval-1",
      runId: "run-1",
      title: "Approve external side effect",
      summary: "Make should receive a pending approval payload.",
      risk: "high",
      options: [{ id: "approve", label: "Approve", consequences: "Continue workflow." }],
    });
    const built = adapter.buildWebhookRequest(payload);

    expect(built.url).toBe("https://hook.make.unit.test/abc");
    expect(built.init.method).toBe("POST");
    expect(built.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Rector-Workflow-Version": "rector.workflow-integrations.v1alpha1",
      "X-Rector-Webhook-Secret": "secret",
    });
    expect(JSON.parse(built.init.body)).toMatchObject({
      source: "rector",
      payload,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps live Make webhook delivery disabled by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new MakeWorkflowAdapter({ webhookUrl: "https://hook.make.unit.test/abc" });

    await expect(
      adapter.sendWorkflow({
        kind: "notification",
        channel: "make",
        severity: "info",
        title: "Done",
        message: "Workflow completed locally.",
      })
    ).rejects.toMatchObject({ code: "NETWORK_DISABLED", provider: "make" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Requestly and BrowserStack plan stubs", () => {
  it("returns docs-only Requestly plan stubs with zero network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const plan = createRequestlyPlanStub({
      name: "Mock flaky API",
      targetUrlPattern: "https://api.example.test/*",
      behavior: "mock-response",
      notes: "Use after API surface stabilizes.",
    });

    expect(plan.provider).toBe("requestly");
    expect(plan.status).toBe("planned");
    expect(plan.networkCalls).toBe(0);
    expect(plan.steps.join("\n")).toContain("Document Requestly rule");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns docs-only BrowserStack plan stubs with zero network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const plan = createBrowserStackPlanStub({
      name: "Chat smoke test",
      target: "local chat UI",
      browsers: ["chrome", "edge"],
      devices: ["Windows desktop"],
      notes: "Run manually once UI selectors are stable.",
    });

    expect(plan.provider).toBe("browserstack");
    expect(plan.status).toBe("planned");
    expect(plan.networkCalls).toBe(0);
    expect(plan.steps.join("\n")).toContain("Document BrowserStack coverage");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("WorkflowPayloadSchema discriminated union dispatch", () => {
  it("successfully dispatches and parses each payload kind via the union schema", () => {
    // 1. notification
    const notificationInput = {
      kind: "notification" as const,
      channel: "chat" as const,
      severity: "info" as const,
      title: "Test notification",
      message: "Notification message",
    };
    const parsedNotification = WorkflowPayloadSchema.parse(notificationInput);
    expect(parsedNotification.kind).toBe("notification");
    expect(parsedNotification).toMatchObject(notificationInput);

    // 2. report
    const reportInput = {
      kind: "report" as const,
      title: "Test report",
      summary: "Report summary",
      generatedAt: NOW,
    };
    const parsedReport = WorkflowPayloadSchema.parse(reportInput);
    expect(parsedReport.kind).toBe("report");
    expect(parsedReport).toMatchObject(reportInput);

    // 3. approval
    const approvalInput = {
      kind: "approval" as const,
      approvalId: "app-123",
      runId: "run-123",
      title: "Test approval",
      summary: "Approval summary",
      risk: "low" as const,
      options: [{ id: "ok", label: "OK", consequences: "Does OK" }],
    };
    const parsedApproval = WorkflowPayloadSchema.parse(approvalInput);
    expect(parsedApproval.kind).toBe("approval");
    expect(parsedApproval).toMatchObject(approvalInput);

    // 4. escalationTicket
    const escalationInput = {
      kind: "escalationTicket" as const,
      title: "Test escalation",
      description: "Escalation description",
    };
    const parsedEscalation = WorkflowPayloadSchema.parse(escalationInput);
    expect(parsedEscalation.kind).toBe("escalationTicket");
    expect(parsedEscalation).toMatchObject(escalationInput);
  });

  it("rejects unknown kinds or malformed inputs in the union schema", () => {
    expect(() => WorkflowPayloadSchema.parse({ kind: "unknownKind" })).toThrow();
    expect(() =>
      WorkflowPayloadSchema.parse({
        kind: "notification",
        channel: "operator",
        severity: "info",
        title: "",
        message: "hello",
      })
    ).toThrow();
  });
});

describe("LinearWorkflowAdapter live/mocked network handling", () => {
  it("handles a successful issue creation with mocked fetch", async () => {
    const mockIssue = {
      id: "issue-999",
      identifier: "LIN-123",
      title: "Investigate Rector run",
      url: "https://linear.app/issue/LIN-123",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          issueCreate: {
            success: true,
            issue: mockIssue,
          },
        },
      }),
    } as Response);

    const adapter = new LinearWorkflowAdapter({
      apiKey: "linear-test-key",
      teamId: "team-123",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.createIssue({
      kind: "escalationTicket",
      title: "Investigate Rector run",
      description: "Mocked network test",
    });

    expect(result).toMatchObject({
      provider: "linear",
      id: "issue-999",
      key: "LIN-123",
      url: "https://linear.app/issue/LIN-123",
      title: "Investigate Rector run",
      status: "created",
      networkCalls: 1,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws WorkflowIntegrationError on non-OK response from Linear", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    } as Response);

    const adapter = new LinearWorkflowAdapter({
      apiKey: "linear-test-key",
      teamId: "team-123",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(
      adapter.createIssue({
        kind: "escalationTicket",
        title: "Investigate Rector run",
      })
    ).rejects.toThrowError(
      new WorkflowIntegrationError({
        code: "PROVIDER_HTTP_ERROR",
        provider: "linear",
        message: "Linear request failed with HTTP 503",
        status: 503,
        retryable: true,
      })
    );
  });

  it("throws WorkflowIntegrationError with retryable=false for non-retryable status (e.g. 400)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    } as Response);

    const adapter = new LinearWorkflowAdapter({
      apiKey: "linear-test-key",
      teamId: "team-123",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    try {
      await adapter.createIssue({
        kind: "escalationTicket",
        title: "Investigate Rector run",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkflowIntegrationError);
      expect(err.code).toBe("PROVIDER_HTTP_ERROR");
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
    }
  });

  it("throws WorkflowIntegrationError on invalid Linear response schema (e.g. missing issueCreate)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          // missing issueCreate
        },
      }),
    } as Response);

    const adapter = new LinearWorkflowAdapter({
      apiKey: "linear-test-key",
      teamId: "team-123",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    try {
      await adapter.createIssue({
        kind: "escalationTicket",
        title: "Investigate Rector run",
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkflowIntegrationError);
      expect(err.code).toBe("PROVIDER_RESPONSE_INVALID");
      expect(err.provider).toBe("linear");
      expect(err.retryable).toBe(false);
      expect(err.details).toBeDefined();
    }
  });
});

describe("MakeWorkflowAdapter live/mocked network handling", () => {
  it("handles a successful webhook delivery with mocked fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "accepted",
      }),
    } as Response);

    const adapter = new MakeWorkflowAdapter({
      webhookUrl: "https://hook.make.unit.test/abc",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const result = await adapter.sendWorkflow({
      kind: "notification",
      channel: "make",
      severity: "info",
      title: "Rector notification",
      message: "Webhook body message",
    });

    expect(result).toMatchObject({
      provider: "make",
      delivered: true,
      status: "delivered",
      networkCalls: 1,
      raw: { status: "accepted" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws WorkflowIntegrationError on non-OK response from Make webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    } as Response);

    const adapter = new MakeWorkflowAdapter({
      webhookUrl: "https://hook.make.unit.test/abc",
      enableNetwork: true,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(
      adapter.sendWorkflow({
        kind: "notification",
        channel: "make",
        severity: "info",
        title: "Rector notification",
        message: "Webhook body message",
      })
    ).rejects.toThrowError(
      new WorkflowIntegrationError({
        code: "PROVIDER_HTTP_ERROR",
        provider: "make",
        message: "Make webhook failed with HTTP 502",
        status: 502,
        retryable: true,
      })
    );
  });
});
