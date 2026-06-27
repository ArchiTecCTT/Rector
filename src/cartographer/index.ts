export * from "./schemas";
export {
  DEFAULT_HEAD_SNIFF_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  isCurrentlyIgnored,
  type CartographerInventoryStore,
  type CartographerScanEmitter,
  type CartographerScanEvent,
  type ClassifyFileInput,
  type CreateSnapshotInput,
  type FileKind,
  type FileNode,
  type FileReader,
  type IgnoreDecision,
  type IgnoreFileInput,
  type IgnoreMatcher,
  type IgnoredFileRef,
  type IgnoreSource,
  type LanguageId,
  type LoadIgnoreMatchersResult,
  type RepoSnapshot,
  type ScanChangedFilesInput,
  type ScanError,
  type ScanRepositoryInput,
  type ScanResult,
  type ScanStage,
  type ScanSummary,
} from "./types";
export * from "./ignorePolicy";
export * from "./fileClassifier";
export * from "./fileHasher";
export { InMemoryCartographerInventoryStore, type InMemoryCartographerInventoryStoreOptions } from "./inventoryStore";
export { SqliteCartographerInventoryStore, type SqliteCartographerInventoryStoreOptions } from "./sqliteInventoryStore";
export { scanRepository } from "./repoScanner";
export { scanChangedFiles } from "./incrementalIndex";
export { buildScanSummary } from "./scanResult";
export * from "./selfScanReport";

export * from "./graphSchemas";
export * from "./graphTypes";
export {
  computeRepoRootHash,
  makeCapabilityId,
  makeDefinesEdgeId,
  makeDirectoryId,
  makeEdgeId,
  makeFileId,
  makeGraphSnapshotId,
  makeImportEdgeId,
  makePackageId,
  makeProjectId,
  makeSymbolId,
  makeToolId,
  normalizePath,
} from "./graphIds";
export type { CartographerGraphStore, PutGraphSnapshotInput } from "./graphStore";
export { InMemoryCartographerGraphStore } from "./inMemoryGraphStore";
export { SqliteCartographerGraphStore, type SqliteCartographerGraphStoreOptions } from "./sqliteGraphStore";
export type { GraphSnapshot } from "./graphSnapshot";
export { buildGraphSnapshot, type BuildGraphInput, type BuildGraphResult } from "./graphBuilder";
export { extractTsSymbols, type ExtractTsSymbolsInput, type ExtractTsSymbolsResult, type ExtractedSymbol, type ExtractionDiagnostic, type SymbolKind } from "./tsSymbolExtractor";
export {
  extractImports,
  type ExtractImportsInput,
  type ExtractImportsResult,
  type ImportRecord,
  type ImportKind,
  type ResolvedTarget,
  type FileTarget,
  type PackageTarget,
  type UnresolvedTarget,
} from "./importExtractor";
export {
  findTests,
  type FindTestsInput,
  type FindTestsResult,
  type LinkedTest,
} from "./testLinker";
export {
  CartographerQueryService,
  type QueryServiceGraph,
} from "./queryService";
export {
  buildToolGraph,
  type BuildToolGraphInput,
  type BuildToolGraphResult,
  type ToolProductionAdmission,
} from "./toolGraphAdapter";
export {
  buildCapabilityGraph,
  type BuildCapabilityGraphInput,
  type BuildCapabilityGraphResult,
} from "./capabilityGraphAdapter";
export {
  loadCapabilityGraphRecords,
} from "./capabilityGraphRecordsLoader";
export {
  CapabilityGraphRecordSchema,
  CapabilityGraphRecordsSchema,
  CapabilityRiskSchema,
  ToolProductionAdmissionSchema,
  type CapabilityGraphRecord,
  type CapabilityRisk,
} from "./capabilityGraphRecords";
export {
  buildEvalSuiteGraph,
  makeValidatedByEvalCaseEdge,
  type BuildEvalSuiteGraphInput,
  type BuildEvalSuiteGraphResult,
  type EvalSuiteCaseRef,
} from "./evalSuiteGraphAdapter";
