import { z } from "zod";
import { RunPhaseSchema } from "./phases";

export const ProtocolEnvelopeMetadataSchema = z
  .object({
    timestamp: z.string().datetime().optional(),
    trace: z
      .object({
        traceId: z.string().min(1).optional(),
        spanId: z.string().min(1).optional(),
        parentSpanId: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    budget: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ProtocolEnvelopeSchema = z.object({
  version: z.string().min(1),
  messageId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  sender: z.string().min(1),
  receiver: z.string().min(1),
  phase: RunPhaseSchema,
  content: z.unknown(),
  metadata: ProtocolEnvelopeMetadataSchema.optional(),
});

export type ProtocolEnvelopeMetadata = z.infer<typeof ProtocolEnvelopeMetadataSchema>;
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;
