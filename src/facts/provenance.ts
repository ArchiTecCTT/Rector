import { ArtifactRefSchema, FactProvenanceSchema, GraphRefSchema, InsufficientEvidenceSchema, ValidationRefSchema } from "./schemas";
import type { ArtifactRef, FactProvenance, GraphRef, InsufficientEvidence, ValidationRef } from "./types";

export function artifactRef(input: Omit<ArtifactRef, "refType"> & { readonly refType?: "artifact" }): ArtifactRef {
  return ArtifactRefSchema.parse({ refType: "artifact", ...input });
}

export function graphRef(input: Omit<GraphRef, "refType"> & { readonly refType?: "graph" }): GraphRef {
  return GraphRefSchema.parse({ refType: "graph", ...input });
}

export function validationRef(input: Omit<ValidationRef, "refType"> & { readonly refType?: "validation" }): ValidationRef {
  return ValidationRefSchema.parse({ refType: "validation", ...input });
}

export function insufficientEvidence(input: Omit<InsufficientEvidence, "refType"> & { readonly refType?: "insufficient_evidence" }): InsufficientEvidence {
  return InsufficientEvidenceSchema.parse({ refType: "insufficient_evidence", ...input });
}

export function userProvenance(userMessageId?: string): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "user", source: "user", userMessageId });
}

export function artifactProvenance(input: { readonly artifact: ArtifactRef; readonly span?: unknown }): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "artifact", ...input });
}

export function graphProvenance(graph: GraphRef): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "graph", graph });
}

export function validationProvenance(validation: ValidationRef): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "validation", validation });
}

export function runEventProvenance(input: { readonly runId: string; readonly eventId: string; readonly eventType?: string }): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "run_event", ...input });
}

export function toolCallProvenance(input: { readonly toolName: string; readonly callId: string; readonly artifact?: ArtifactRef }): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "tool_call", ...input });
}

export function capabilityEvalProvenance(input: { readonly capabilityId: string; readonly caseId?: string; readonly artifact?: ArtifactRef }): FactProvenance {
  return FactProvenanceSchema.parse({ sourceType: "capability_eval", ...input });
}
