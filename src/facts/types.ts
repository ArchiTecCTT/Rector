import type { z } from "zod";

import type {
  ArtifactHashFactSchema,
  ArtifactRedactionFactSchema,
  ArtifactRefSchema,
  CapabilityCallFactSchema,
  CapabilityCoverageFactSchema,
  CapabilityEvidenceFactSchema,
  CapabilityFailureFactSchema,
  CapabilityGraphContextFactSchema,
  CapabilityRequestFactSchema,
  CapabilityWarningFactSchema,
  CartographerSnapshotFactSchema,
  ContextSliceFactSchema,
  CritiqueFactSchema,
  EvidenceRefSchema,
  FactEnvelopeSchema,
  FactFamilyKindSchema,
  FactIdSchema,
  FactProducerSchema,
  FactProvenanceSchema,
  FactScopeSchema,
  FactSchemaValidationFactSchema,
  FactTrustSchema,
  FactValidationErrorSchema,
  FileContextFactSchema,
  GraphEdgeFactRefSchema,
  GraphNodeFactRefSchema,
  GraphRefSchema,
  ImpactContextFactSchema,
  InsufficientEvidenceSchema,
  IntentFactSchema,
  JsonValueSchema,
  MemoryPatchCandidateFactSchema,
  PlanCandidateFactSchema,
  RawArtifactChunkFactSchema,
  RawArtifactFactSchema,
  RectorFactSchema,
  RedactionStateSchema,
  RepairCandidateFactSchema,
  RiskToleranceFactSchema,
  SourceSpanSchema,
  SuccessCriteriaFactSchema,
  SymbolContextFactSchema,
  TaskConstraintFactSchema,
  TestLinkContextFactSchema,
  ToolCallFactSchema,
  ToolDefinitionFactSchema,
  ToolFailureFactSchema,
  ToolResultFactSchema,
  UnknownOrAmbiguityFactSchema,
  ValidationObligationFactSchema,
  ValidationRefSchema,
  FactGroundingValidationFactSchema,
  FactScopeValidationFactSchema,
  FactProvenanceValidationFactSchema,
  FactReplayValidationFactSchema,
} from "./schemas";

export type JsonValue = z.infer<typeof JsonValueSchema>;
export type FactId = z.infer<typeof FactIdSchema>;
export type FactKind = z.infer<typeof FactFamilyKindSchema>;
export type FactProducer = z.infer<typeof FactProducerSchema>;
export type FactTrust = Readonly<z.infer<typeof FactTrustSchema>>;
export type RedactionState = z.infer<typeof RedactionStateSchema>;
export type FactScope = Readonly<z.infer<typeof FactScopeSchema>>;
export type FactProvenance = Readonly<z.infer<typeof FactProvenanceSchema>>;
export type ArtifactRef = Readonly<z.infer<typeof ArtifactRefSchema>>;
export type GraphRef = Readonly<z.infer<typeof GraphRefSchema>>;
export type SourceSpan = Readonly<z.infer<typeof SourceSpanSchema>>;
export type EvidenceRef = Readonly<z.infer<typeof EvidenceRefSchema>>;
export type ValidationRef = Readonly<z.infer<typeof ValidationRefSchema>>;
export type FactValidationError = Readonly<z.infer<typeof FactValidationErrorSchema>>;
export type InsufficientEvidence = Readonly<z.infer<typeof InsufficientEvidenceSchema>>;
export type FactEnvelope = Readonly<z.infer<typeof FactEnvelopeSchema>>;
export type RectorFact = Readonly<z.infer<typeof RectorFactSchema>>;

export type IntentFact = Readonly<z.infer<typeof IntentFactSchema>>;
export type TaskConstraintFact = Readonly<z.infer<typeof TaskConstraintFactSchema>>;
export type SuccessCriteriaFact = Readonly<z.infer<typeof SuccessCriteriaFactSchema>>;
export type RiskToleranceFact = Readonly<z.infer<typeof RiskToleranceFactSchema>>;
export type UnknownOrAmbiguityFact = Readonly<z.infer<typeof UnknownOrAmbiguityFactSchema>>;

export type CartographerSnapshotFact = Readonly<z.infer<typeof CartographerSnapshotFactSchema>>;
export type GraphNodeFactRef = Readonly<z.infer<typeof GraphNodeFactRefSchema>>;
export type GraphEdgeFactRef = Readonly<z.infer<typeof GraphEdgeFactRefSchema>>;
export type ContextSliceFact = Readonly<z.infer<typeof ContextSliceFactSchema>>;
export type FileContextFact = Readonly<z.infer<typeof FileContextFactSchema>>;
export type SymbolContextFact = Readonly<z.infer<typeof SymbolContextFactSchema>>;
export type ImpactContextFact = Readonly<z.infer<typeof ImpactContextFactSchema>>;
export type TestLinkContextFact = Readonly<z.infer<typeof TestLinkContextFactSchema>>;
export type CapabilityGraphContextFact = Readonly<z.infer<typeof CapabilityGraphContextFactSchema>>;

export type ToolDefinitionFact = Readonly<z.infer<typeof ToolDefinitionFactSchema>>;
export type ToolCallFact = Readonly<z.infer<typeof ToolCallFactSchema>>;
export type ToolResultFact = Readonly<z.infer<typeof ToolResultFactSchema>>;
export type ToolFailureFact = Readonly<z.infer<typeof ToolFailureFactSchema>>;
export type CapabilityRequestFact = Readonly<z.infer<typeof CapabilityRequestFactSchema>>;
export type CapabilityCallFact = Readonly<z.infer<typeof CapabilityCallFactSchema>>;
export type CapabilityEvidenceFact = Readonly<z.infer<typeof CapabilityEvidenceFactSchema>>;
export type CapabilityCoverageFact = Readonly<z.infer<typeof CapabilityCoverageFactSchema>>;
export type CapabilityWarningFact = Readonly<z.infer<typeof CapabilityWarningFactSchema>>;
export type CapabilityFailureFact = Readonly<z.infer<typeof CapabilityFailureFactSchema>>;

export type RawArtifactFact = Readonly<z.infer<typeof RawArtifactFactSchema>>;
export type RawArtifactChunkFact = Readonly<z.infer<typeof RawArtifactChunkFactSchema>>;
export type ArtifactHashFact = Readonly<z.infer<typeof ArtifactHashFactSchema>>;
export type ArtifactRedactionFact = Readonly<z.infer<typeof ArtifactRedactionFactSchema>>;

export type PlanCandidateFact = Readonly<z.infer<typeof PlanCandidateFactSchema>>;
export type CritiqueFact = Readonly<z.infer<typeof CritiqueFactSchema>>;
export type ValidationObligationFact = Readonly<z.infer<typeof ValidationObligationFactSchema>>;
export type RepairCandidateFact = Readonly<z.infer<typeof RepairCandidateFactSchema>>;
export type MemoryPatchCandidateFact = Readonly<z.infer<typeof MemoryPatchCandidateFactSchema>>;

export type FactSchemaValidationFact = Readonly<z.infer<typeof FactSchemaValidationFactSchema>>;
export type FactGroundingValidationFact = Readonly<z.infer<typeof FactGroundingValidationFactSchema>>;
export type FactScopeValidationFact = Readonly<z.infer<typeof FactScopeValidationFactSchema>>;
export type FactProvenanceValidationFact = Readonly<z.infer<typeof FactProvenanceValidationFactSchema>>;
export type FactReplayValidationFact = Readonly<z.infer<typeof FactReplayValidationFactSchema>>;
