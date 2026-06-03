import { z } from "zod";

export const WORKFLOW_INTEGRATION_API_VERSION = "rector.workflow-integrations.v1alpha1";

export const WorkflowProviderSchema = z.enum(["linear", "make", "requestly", "browserstack"]);
export type WorkflowProvider = z.infer<typeof WorkflowProviderSchema>;

export const WorkflowIntegrationMetadataSchema = z.object({
  id: WorkflowProviderSchema,
  name: z.string().min(1),
  apiVersion: z.string().min(1),
  networkEnabledByDefault: z.literal(false),
  supportedPayloads: z.array(z.string().min(1)).min(1),
  stub: z.boolean(),
});
export type WorkflowIntegrationMetadata = z.infer<typeof WorkflowIntegrationMetadataSchema>;

export const WorkflowNotificationPayloadSchema = z.object({
  kind: z.literal("notification"),
  channel: z.enum(["operator", "chat", "email", "webhook", "linear", "make"]),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1),
  message: z.string().min(1),
  runId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type WorkflowNotificationPayload = z.infer<typeof WorkflowNotificationPayloadSchema>;

export const WorkflowReportPayloadSchema = z.object({
  kind: z.literal("report"),
  title: z.string().min(1),
  summary: z.string().min(1),
  generatedAt: z.string().datetime(),
  runIds: z.array(z.string().min(1)).default([]),
  metrics: z.record(z.number().finite()).default({}),
  links: z.array(z.object({ label: z.string().min(1), url: z.string().url() })).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type WorkflowReportPayload = z.infer<typeof WorkflowReportPayloadSchema>;

export const ApprovalWorkflowPayloadSchema = z.object({
  kind: z.literal("approval"),
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  options: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    consequences: z.string().min(1),
  })).min(1),
  requestedBy: z.string().min(1).default("rector"),
  requiredBy: z.string().datetime().optional(),
  status: z.enum(["pending", "approved", "rejected", "expired"]).default("pending"),
  metadata: z.record(z.unknown()).default({}),
});
export type ApprovalWorkflowPayload = z.infer<typeof ApprovalWorkflowPayloadSchema>;

export const EscalationTicketPayloadSchema = z.object({
  kind: z.literal("escalationTicket"),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  /**
   * For the Linear adapter, these labels map to the GraphQL variable `labelIds`
   * which are provider UUIDs/IDs rather than human-readable text display labels.
   * Passing raw string display labels (e.g., "bug", "rector") will fail unless
   * they are pre-resolved to Linear UUIDs. Display label-to-ID mapping needs
   * a future resolution mechanism/queries.
   */
  labels: z.array(z.string().min(1)).default([]),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  metadata: z.record(z.unknown()).default({}),
});
export type EscalationTicketPayload = z.infer<typeof EscalationTicketPayloadSchema>;

export const WorkflowPayloadSchema = z.discriminatedUnion("kind", [
  WorkflowNotificationPayloadSchema,
  WorkflowReportPayloadSchema,
  ApprovalWorkflowPayloadSchema,
  EscalationTicketPayloadSchema,
]);
export type WorkflowPayload = z.infer<typeof WorkflowPayloadSchema>;

export const WorkflowIssueRecordSchema = z.object({
  provider: z.literal("linear"),
  id: z.string().min(1),
  key: z.string().min(1).optional(),
  url: z.string().url().optional(),
  title: z.string().min(1),
  status: z.enum(["created", "stubbed"]),
  networkCalls: z.number().int().nonnegative(),
  raw: z.unknown().optional(),
});
export type WorkflowIssueRecord = z.infer<typeof WorkflowIssueRecordSchema>;

export const WorkflowDeliveryResultSchema = z.object({
  provider: z.enum(["make"]),
  delivered: z.boolean(),
  status: z.enum(["delivered", "stubbed"]),
  networkCalls: z.number().int().nonnegative(),
  raw: z.unknown().optional(),
});
export type WorkflowDeliveryResult = z.infer<typeof WorkflowDeliveryResultSchema>;

export const WorkflowPlanStubSchema = z.object({
  provider: z.enum(["requestly", "browserstack"]),
  name: z.string().min(1),
  status: z.literal("planned"),
  networkCalls: z.literal(0),
  steps: z.array(z.string().min(1)).min(1),
  docs: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.unknown()).default({}),
});
export type WorkflowPlanStub = z.infer<typeof WorkflowPlanStubSchema>;

export type WorkflowIntegrationErrorCode =
  | "CONFIG_INVALID"
  | "NETWORK_DISABLED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID";

export class WorkflowIntegrationError extends Error {
  readonly name = "WorkflowIntegrationError";
  readonly code: WorkflowIntegrationErrorCode;
  readonly provider: WorkflowProvider;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: unknown;

  constructor(input: {
    code: WorkflowIntegrationErrorCode;
    provider: WorkflowProvider;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
    this.details = input.details;
  }
}

export interface BuiltWorkflowRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}

export interface LinearWorkflowAdapterOptions {
  apiKey?: string;
  teamId?: string;
  baseUrl?: string;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export class LinearWorkflowAdapter {
  readonly metadata = WorkflowIntegrationMetadataSchema.parse({
    id: "linear",
    name: "Linear Workflow Adapter",
    apiVersion: WORKFLOW_INTEGRATION_API_VERSION,
    networkEnabledByDefault: false,
    supportedPayloads: ["escalationTicket"],
    stub: true,
  });

  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly baseUrl: string;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LinearWorkflowAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LINEAR_API_KEY ?? "";
    this.teamId = options.teamId ?? process.env.LINEAR_TEAM_ID ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.LINEAR_BASE_URL ?? "https://api.linear.app/graphql").replace(/\/+$/, "");
    this.enableNetwork = options.enableNetwork ?? envFlag("WORKFLOW_INTEGRATIONS_ENABLE_NETWORK");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  validateConfig(): void {
    if (!this.apiKey.trim()) {
      throw new WorkflowIntegrationError({
        code: "CONFIG_INVALID",
        provider: "linear",
        message: "LINEAR_API_KEY is required to use the Linear workflow adapter",
      });
    }
    if (!/^https:\/\//i.test(this.baseUrl)) {
      throw new WorkflowIntegrationError({
        code: "CONFIG_INVALID",
        provider: "linear",
        message: "LINEAR_BASE_URL must be an absolute https URL",
      });
    }
  }

  buildCreateIssueRequest(payloadInput: EscalationTicketPayload): BuiltWorkflowRequest {
    this.validateConfig();
    const payload = EscalationTicketPayloadSchema.parse(payloadInput);
    const teamId = getString(payload.metadata.teamId) ?? this.teamId;
    if (!teamId.trim()) {
      throw new WorkflowIntegrationError({
        code: "CONFIG_INVALID",
        provider: "linear",
        message: "LINEAR_TEAM_ID or payload.metadata.teamId is required to build a Linear issue request",
      });
    }

    return {
      url: this.baseUrl,
      init: {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: LINEAR_ISSUE_CREATE_MUTATION,
          variables: {
            input: {
              teamId,
              title: payload.title,
              description: linearIssueDescription(payload),
              // Note: Linear API expects UUIDs for `labelIds`. If the caller provides
              // raw display name strings (like "bug"), the request will fail on the provider.
              // Resolving human-readable names to Linear UUIDs is deferred for future implementation.
              labelIds: payload.labels,
              priority: linearPriority(payload.priority),
            },
          },
        }),
      },
    };
  }

  async createIssue(payloadInput: EscalationTicketPayload): Promise<WorkflowIssueRecord> {
    const built = this.buildCreateIssueRequest(payloadInput);
    if (!this.enableNetwork) {
      throw new WorkflowIntegrationError({
        code: "NETWORK_DISABLED",
        provider: "linear",
        message: "Linear network access is disabled by default; pass enableNetwork: true only after explicit approval",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) {
      throw new WorkflowIntegrationError({
        code: "PROVIDER_HTTP_ERROR",
        provider: "linear",
        message: `Linear request failed with HTTP ${response.status}`,
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    const raw = await response.json() as unknown;
    const issue = parseLinearIssue(raw);
    return WorkflowIssueRecordSchema.parse({
      provider: "linear",
      id: issue.id,
      key: issue.identifier,
      url: issue.url,
      title: issue.title,
      status: "created",
      networkCalls: 1,
      raw,
    });
  }
}

export interface MakeWorkflowAdapterOptions {
  webhookUrl?: string;
  webhookSecret?: string;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export class MakeWorkflowAdapter {
  readonly metadata = WorkflowIntegrationMetadataSchema.parse({
    id: "make",
    name: "Make Workflow Adapter",
    apiVersion: WORKFLOW_INTEGRATION_API_VERSION,
    networkEnabledByDefault: false,
    supportedPayloads: ["notification", "report", "approval"],
    stub: true,
  });

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MakeWorkflowAdapterOptions = {}) {
    this.webhookUrl = options.webhookUrl ?? process.env.MAKE_WEBHOOK_URL ?? "";
    this.webhookSecret = options.webhookSecret ?? process.env.MAKE_WEBHOOK_SECRET ?? "";
    this.enableNetwork = options.enableNetwork ?? envFlag("WORKFLOW_INTEGRATIONS_ENABLE_NETWORK");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  validateConfig(): void {
    if (!this.webhookUrl.trim()) {
      throw new WorkflowIntegrationError({
        code: "CONFIG_INVALID",
        provider: "make",
        message: "MAKE_WEBHOOK_URL is required to use the Make workflow adapter",
      });
    }
    if (!/^https:\/\//i.test(this.webhookUrl)) {
      throw new WorkflowIntegrationError({
        code: "CONFIG_INVALID",
        provider: "make",
        message: "MAKE_WEBHOOK_URL must be an absolute https URL",
      });
    }
  }

  buildWebhookRequest(payloadInput: WorkflowNotificationPayload | WorkflowReportPayload | ApprovalWorkflowPayload): BuiltWorkflowRequest {
    this.validateConfig();
    const payload = parseMakePayload(payloadInput);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Rector-Workflow-Version": WORKFLOW_INTEGRATION_API_VERSION,
    };
    if (this.webhookSecret.trim()) {
      headers["X-Rector-Webhook-Secret"] = this.webhookSecret;
    }

    return {
      url: this.webhookUrl,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "rector",
          apiVersion: WORKFLOW_INTEGRATION_API_VERSION,
          payload,
        }),
      },
    };
  }

  async sendWorkflow(payloadInput: WorkflowNotificationPayload | WorkflowReportPayload | ApprovalWorkflowPayload): Promise<WorkflowDeliveryResult> {
    const built = this.buildWebhookRequest(payloadInput);
    if (!this.enableNetwork) {
      throw new WorkflowIntegrationError({
        code: "NETWORK_DISABLED",
        provider: "make",
        message: "Make webhook network access is disabled by default; pass enableNetwork: true only after explicit approval",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) {
      throw new WorkflowIntegrationError({
        code: "PROVIDER_HTTP_ERROR",
        provider: "make",
        message: `Make webhook failed with HTTP ${response.status}`,
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }

    return WorkflowDeliveryResultSchema.parse({
      provider: "make",
      delivered: true,
      status: "delivered",
      networkCalls: 1,
      raw,
    });
  }
}

export const RequestlyPlanInputSchema = z.object({
  name: z.string().min(1),
  targetUrlPattern: z.string().min(1),
  behavior: z.enum(["mock-response", "rewrite-url", "inject-header", "delay-response"]),
  notes: z.string().min(1).optional(),
});
export type RequestlyPlanInput = z.infer<typeof RequestlyPlanInputSchema>;

export function createRequestlyPlanStub(input: RequestlyPlanInput): WorkflowPlanStub {
  const parsed = RequestlyPlanInputSchema.parse(input);
  return WorkflowPlanStubSchema.parse({
    provider: "requestly",
    name: parsed.name,
    status: "planned",
    networkCalls: 0,
    steps: [
      `Document Requestly rule for ${parsed.targetUrlPattern}.`,
      `Plan behavior: ${parsed.behavior}.`,
      "Wait for Rector API/UI behavior and selectors to stabilize before enabling Requestly automation.",
      "Keep future Requestly API calls behind explicit env, budget, and network approval gates.",
    ],
    docs: ["docs/plans/chunks/023-external-workflow-integrations.md"],
    metadata: {
      targetUrlPattern: parsed.targetUrlPattern,
      behavior: parsed.behavior,
      notes: parsed.notes ?? "",
      stubOnly: true,
    },
  });
}

export const BrowserStackPlanInputSchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1),
  browsers: z.array(z.string().min(1)).min(1),
  devices: z.array(z.string().min(1)).default([]),
  notes: z.string().min(1).optional(),
});
export type BrowserStackPlanInput = z.infer<typeof BrowserStackPlanInputSchema>;

export function createBrowserStackPlanStub(input: BrowserStackPlanInput): WorkflowPlanStub {
  const parsed = BrowserStackPlanInputSchema.parse(input);
  return WorkflowPlanStubSchema.parse({
    provider: "browserstack",
    name: parsed.name,
    status: "planned",
    networkCalls: 0,
    steps: [
      `Document BrowserStack coverage for ${parsed.target}.`,
      `Target browsers: ${parsed.browsers.join(", ")}.`,
      parsed.devices.length > 0 ? `Target devices: ${parsed.devices.join(", ")}.` : "Use default desktop coverage until device matrix is approved.",
      "Wait for stable UI selectors and release smoke scripts before enabling BrowserStack automation.",
      "Keep future BrowserStack API calls behind explicit env, budget, and network approval gates.",
    ],
    docs: ["docs/plans/chunks/023-external-workflow-integrations.md"],
    metadata: {
      target: parsed.target,
      browsers: parsed.browsers,
      devices: parsed.devices,
      notes: parsed.notes ?? "",
      stubOnly: true,
    },
  });
}

const LINEAR_ISSUE_CREATE_MUTATION = `mutation RectorIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}`;

function parseMakePayload(input: WorkflowNotificationPayload | WorkflowReportPayload | ApprovalWorkflowPayload): WorkflowNotificationPayload | WorkflowReportPayload | ApprovalWorkflowPayload {
  if (input.kind === "notification") return WorkflowNotificationPayloadSchema.parse(input);
  if (input.kind === "report") return WorkflowReportPayloadSchema.parse(input);
  return ApprovalWorkflowPayloadSchema.parse(input);
}

function linearIssueDescription(payload: EscalationTicketPayload): string {
  const lines = [payload.description ?? "Rector escalation ticket."];
  if (payload.runId) lines.push(`Run: ${payload.runId}`);
  if (payload.traceId) lines.push(`Trace: ${payload.traceId}`);
  lines.push(`Priority: ${payload.priority}`);
  return lines.join("\n\n");
}

function linearPriority(priority: EscalationTicketPayload["priority"]): number {
  switch (priority) {
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function envFlag(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

function parseLinearIssue(raw: unknown): { id: string; identifier?: string; title: string; url?: string } {
  const result = LinearIssueCreateResponseSchema.safeParse(raw);
  if (!result.success || !result.data.data.issueCreate.success || !result.data.data.issueCreate.issue) {
    throw new WorkflowIntegrationError({
      code: "PROVIDER_RESPONSE_INVALID",
      provider: "linear",
      message: "Linear issueCreate response did not include a created issue",
      details: result.success ? raw : result.error.flatten(),
    });
  }
  return result.data.data.issueCreate.issue;
}

const LinearIssueCreateResponseSchema = z.object({
  data: z.object({
    issueCreate: z.object({
      success: z.boolean(),
      issue: z.object({
        id: z.string().min(1),
        identifier: z.string().min(1).optional(),
        title: z.string().min(1),
        url: z.string().url().optional(),
      }).nullable(),
    }),
  }),
});
