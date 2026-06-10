import { z } from "zod";
import { RunEventSchema, type RunEvent } from "../protocol/events";
import { RunPhaseSchema } from "../protocol/phases";

const NonEmptyStringSchema = z.string().min(1);
const MetadataSchema = z.record(z.unknown());
const EstimateSchema = z.record(z.unknown());

export const ConversationSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  workspaceId: NonEmptyStringSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  retentionPolicy: NonEmptyStringSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z.object({
  id: NonEmptyStringSchema,
  conversationId: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  content: z.string(),
  status: NonEmptyStringSchema,
  runId: NonEmptyStringSchema.optional(),
  redactionState: NonEmptyStringSchema,
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const BudgetSchema = z.object({
  maxUsd: z.number().nonnegative(),
  maxInputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  maxModelCalls: z.number().int().nonnegative(),
  maxRuntimeMs: z.number().int().nonnegative(),
  maxHealingAttempts: z.number().int().nonnegative(),
  allowedProviders: z.array(NonEmptyStringSchema),
  approvalRequiredAboveUsd: z.number().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const RunSchema = z.object({
  id: NonEmptyStringSchema,
  conversationId: NonEmptyStringSchema,
  userMessageId: NonEmptyStringSchema,
  status: NonEmptyStringSchema,
  phase: RunPhaseSchema,
  route: NonEmptyStringSchema,
  complexity: NonEmptyStringSchema,
  budget: BudgetSchema,
  costEstimate: EstimateSchema,
  actualCost: EstimateSchema.optional(),
  tokenEstimate: EstimateSchema,
  actualTokens: EstimateSchema.optional(),
  traceId: NonEmptyStringSchema,
  dagId: NonEmptyStringSchema.optional(),
  attempts: z.number().int().nonnegative(),
  healingAttempts: z.number().int().nonnegative(),
  validationAttempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  decisionRequest: MetadataSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const ArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  kind: NonEmptyStringSchema,
  uri: NonEmptyStringSchema,
  summary: z.string(),
  hash: NonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  piiState: NonEmptyStringSchema,
  retentionPolicy: NonEmptyStringSchema,
  metadata: MetadataSchema,
  createdAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const MemoryLayerSchema = z.enum(["working", "episodic", "core"]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const MemoryEntrySchema = z.object({
  id: NonEmptyStringSchema,
  layer: MemoryLayerSchema,
  content: z.string(),
  timestamp: z.string().datetime(),
  lastMentioned: z.string().datetime(),
  accessCount: z.number().int().nonnegative(),
  tags: z.array(NonEmptyStringSchema).default([]),
  source: z.string().optional(),
  metadata: MetadataSchema,
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export { RunEventSchema, type RunEvent };
export type StoreEvent = RunEvent;

export type CreateConversationInput = Omit<Conversation, "id" | "createdAt" | "updatedAt">;
export type UpdateConversationInput = Partial<Omit<Conversation, "id" | "createdAt" | "updatedAt">>;

export type CreateMessageInput = Omit<Message, "id" | "createdAt">;
export type UpdateMessageInput = Partial<Omit<Message, "id" | "createdAt">>;

export type CreateRunInput = Omit<Run, "id" | "createdAt" | "updatedAt">;
export type UpdateRunInput = Partial<Omit<Run, "id" | "createdAt" | "updatedAt">>;

export type CreateArtifactInput = Omit<Artifact, "id" | "createdAt">;
export type UpdateArtifactInput = Partial<Omit<Artifact, "id" | "createdAt">>;

export type CreateMemoryEntryInput = Omit<MemoryEntry, "id" | "accessCount" | "lastMentioned"> & {
  accessCount?: number;
  lastMentioned?: string;
};
export type UpdateMemoryEntryInput = Partial<Omit<MemoryEntry, "id">>;
