import { z } from "zod";

export const PUBLIC_EXTENSION_API_VERSION = "rector.extensions.v1alpha1";

export const ExtensionPointSchema = z.enum([
  "llm",
  "memory",
  "sandbox",
  "telemetry",
  "search",
  "issueTracker",
  "validator",
  "uiClient",
]);
export type ExtensionPoint = z.infer<typeof ExtensionPointSchema>;

export const ExtensionCapabilitySchema = z.object({
  point: ExtensionPointSchema,
  operations: z.array(z.string().min(1)).min(1),
});
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

export const ExtensionManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.string().min(1),
  description: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  homepage: z.string().url().optional(),
  networkAccess: z.literal(false).default(false),
  capabilities: z.array(ExtensionCapabilitySchema).min(1),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

export const ExtensionCompatibilityOptionsSchema = z.object({
  supportedApiVersion: z.string().min(1).default(PUBLIC_EXTENSION_API_VERSION),
  requiredCapabilities: z.array(ExtensionPointSchema).default([]),
});
export type ExtensionCompatibilityOptions = z.input<typeof ExtensionCompatibilityOptionsSchema>;

export const ExtensionCompatibilityResultSchema = z.object({
  compatible: z.boolean(),
  errors: z.array(z.string()),
  manifest: ExtensionManifestSchema,
});
export type ExtensionCompatibilityResult = z.infer<typeof ExtensionCompatibilityResultSchema>;

export class ExtensionCompatibilityError extends Error {
  readonly name = "ExtensionCompatibilityError";
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Extension is not compatible: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

export function checkExtensionCompatibility(
  manifestInput: unknown,
  optionsInput: ExtensionCompatibilityOptions = {}
): ExtensionCompatibilityResult {
  const manifest = ExtensionManifestSchema.parse(manifestInput);
  const options = ExtensionCompatibilityOptionsSchema.parse(optionsInput);
  const errors: string[] = [];

  if (manifest.apiVersion !== options.supportedApiVersion) {
    errors.push(`Unsupported extension apiVersion ${manifest.apiVersion}; expected ${options.supportedApiVersion}`);
  }

  const providedCapabilities = new Set(manifest.capabilities.map((capability) => capability.point));
  for (const requiredCapability of options.requiredCapabilities) {
    if (!providedCapabilities.has(requiredCapability)) {
      errors.push(`Missing required extension capability: ${requiredCapability}`);
    }
  }

  return ExtensionCompatibilityResultSchema.parse({
    compatible: errors.length === 0,
    errors,
    manifest,
  });
}

export function assertExtensionCompatibility(
  manifestInput: unknown,
  optionsInput: ExtensionCompatibilityOptions = {}
): ExtensionManifest {
  const result = checkExtensionCompatibility(manifestInput, optionsInput);
  if (!result.compatible) {
    throw new ExtensionCompatibilityError(result.errors);
  }
  return result.manifest;
}

export interface ExtensionBase<TPoint extends ExtensionPoint> {
  readonly manifest: ExtensionManifest;
  readonly point: TPoint;
}

export const ExtensionLlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});
export type ExtensionLlmMessage = z.infer<typeof ExtensionLlmMessageSchema>;

export const ExtensionLlmRequestSchema = z.object({
  messages: z.array(ExtensionLlmMessageSchema).min(1),
  /**
   * The model to invoke. If absent/undefined, the LLM extension must choose and
   * fall back to its own default model internally.
   */
  model: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ExtensionLlmRequest = z.infer<typeof ExtensionLlmRequestSchema>;

export const ExtensionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
});
export type ExtensionUsage = z.infer<typeof ExtensionUsageSchema>;

export const ExtensionLlmResponseSchema = z.object({
  content: z.string(),
  finishReason: z.enum(["stop", "length", "tool_calls", "error"]),
  usage: ExtensionUsageSchema,
  metadata: z.record(z.unknown()).optional(),
});
export type ExtensionLlmResponse = z.infer<typeof ExtensionLlmResponseSchema>;

export interface LlmExtension extends ExtensionBase<"llm"> {
  /**
   * Estimate token usage and cost for the request.
   * If request.model is absent, the extension must choose its own default model to calculate the estimate.
   */
  estimate(request: ExtensionLlmRequest): Promise<ExtensionUsage> | ExtensionUsage;
  /**
   * Invoke the LLM to generate a response.
   * If request.model is absent, the extension must choose its own default model to execute the request.
   */
  invoke(request: ExtensionLlmRequest): Promise<ExtensionLlmResponse>;
}

export const ExtensionDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type ExtensionDocument = z.infer<typeof ExtensionDocumentSchema>;

export const ExtensionSearchQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
  filters: z.record(z.unknown()).optional(),
});
export type ExtensionSearchQuery = z.input<typeof ExtensionSearchQuerySchema>;

export const ExtensionSearchResultSchema = ExtensionDocumentSchema.extend({
  score: z.number().nonnegative(),
});
export type ExtensionSearchResult = z.infer<typeof ExtensionSearchResultSchema>;

export const ExtensionUpsertResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ExtensionUpsertResult = z.infer<typeof ExtensionUpsertResultSchema>;

export interface MemoryExtension extends ExtensionBase<"memory"> {
  upsert(items: ExtensionDocument[]): Promise<ExtensionUpsertResult>;
  search(query: ExtensionSearchQuery): Promise<ExtensionSearchResult[]>;
}

export interface SearchExtension extends ExtensionBase<"search"> {
  index(documents: ExtensionDocument[]): Promise<ExtensionUpsertResult>;
  search(query: ExtensionSearchQuery): Promise<ExtensionSearchResult[]>;
}

export const SandboxCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().min(1, "timeoutMs must be at least 1").max(3_600_000),
});
export type SandboxCommand = z.input<typeof SandboxCommandSchema>;

export const SandboxExecutionResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  networkCalls: z.literal(0),
  artifacts: z.array(ExtensionDocumentSchema).default([]),
});
export type SandboxExecutionResult = z.infer<typeof SandboxExecutionResultSchema>;

export interface SandboxExtension extends ExtensionBase<"sandbox"> {
  execute(command: SandboxCommand): Promise<SandboxExecutionResult>;
}

export const TelemetryEventSchema = z.object({
  name: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]),
  timestamp: z.string().datetime(),
  traceId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export interface TelemetryExtension extends ExtensionBase<"telemetry"> {
  capture(event: TelemetryEvent): Promise<void>;
}

export const IssueInputSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).optional(),
});
export type IssueInput = z.input<typeof IssueInputSchema>;

export const IssueRecordSchema = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  title: z.string().min(1),
  status: z.enum(["open", "closed"]),
});
export type IssueRecord = z.infer<typeof IssueRecordSchema>;

export interface IssueTrackerExtension extends ExtensionBase<"issueTracker"> {
  create(issue: IssueInput): Promise<IssueRecord>;
  list(filter?: Record<string, unknown>): Promise<IssueRecord[]>;
}

export const ValidatorInputSchema = z.object({
  subject: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});
export type ValidatorInput = z.infer<typeof ValidatorInputSchema>;

export const ValidatorFindingSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  path: z.string().min(1).optional(),
});
export type ValidatorFinding = z.infer<typeof ValidatorFindingSchema>;

export const ValidatorResultSchema = z.object({
  status: z.enum(["passed", "failed", "skipped"]),
  findings: z.array(ValidatorFindingSchema),
});
export type ValidatorResult = z.infer<typeof ValidatorResultSchema>;

export interface ValidatorExtension extends ExtensionBase<"validator"> {
  validate(input: ValidatorInput): Promise<ValidatorResult>;
}

export const UiClientMessageSchema = z.object({
  type: z.enum(["toast", "progress", "result"]),
  message: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type UiClientMessage = z.infer<typeof UiClientMessageSchema>;

export const UiClientDeliveryResultSchema = z.object({
  delivered: z.boolean(),
});
export type UiClientDeliveryResult = z.infer<typeof UiClientDeliveryResultSchema>;

export interface UiClientExtension extends ExtensionBase<"uiClient"> {
  notify(message: UiClientMessage): Promise<UiClientDeliveryResult>;
}
