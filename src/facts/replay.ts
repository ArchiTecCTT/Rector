import {
  type FactLedger,
  type FactLedgerFactRecord,
  type LedgerReplayDiagnostic,
  compareFactsDeterministically,
  isFactRecord,
  parseJsonlLedgerRecords,
  readJsonlLedgerRecords,
} from "./ledger";
import { RectorFactSchema } from "./schemas";
import type { RectorFact } from "./types";

export interface ReplayRunOptions {
  readonly runId?: string;
  readonly bestEffort?: boolean;
}

export interface FactReplayResult {
  readonly facts: readonly RectorFact[];
  readonly diagnostics: readonly LedgerReplayDiagnostic[];
}

export async function replayRun(source: FactLedger | string | readonly RectorFact[], options: ReplayRunOptions = {}): Promise<FactReplayResult> {
  if (typeof source === "string") return replayJsonlFactLedger(source, options);
  if (isReadonlyFactArray(source)) return replayFactList(source, options);
  const facts = options.runId ? await source.listRun(options.runId) : await source.query();
  return { facts, diagnostics: [] };
}

export async function replayJsonlFactLedger(filePath: string, options: ReplayRunOptions = {}): Promise<FactReplayResult> {
  const diagnostics: LedgerReplayDiagnostic[] = [];
  const records = await readJsonlLedgerRecords(filePath, { bestEffort: options.bestEffort, diagnostics });
  return replayFactRecords(records.filter(isFactRecord), options, diagnostics);
}

export function replayJsonlFactLedgerContent(content: string, options: ReplayRunOptions = {}): FactReplayResult {
  const diagnostics: LedgerReplayDiagnostic[] = [];
  const records = parseJsonlLedgerRecords(content, { bestEffort: options.bestEffort, diagnostics });
  return replayFactRecords(records.filter(isFactRecord), options, diagnostics);
}

export function replayFactRecords(records: readonly FactLedgerFactRecord[], options: ReplayRunOptions = {}, diagnostics: readonly LedgerReplayDiagnostic[] = []): FactReplayResult {
  const facts = records
    .filter((record) => options.runId === undefined || record.fact.runId === options.runId)
    .sort((left, right) => {
      const sequence = left.sequence - right.sequence;
      if (sequence !== 0) return sequence;
      const appended = left.appendedAt.localeCompare(right.appendedAt);
      if (appended !== 0) return appended;
      return compareFactsDeterministically(left.fact, right.fact);
    })
    .map((record) => RectorFactSchema.parse(record.fact));
  return { facts, diagnostics };
}

function isReadonlyFactArray(source: FactLedger | string | readonly RectorFact[]): source is readonly RectorFact[] {
  return Array.isArray(source);
}

function replayFactList(facts: readonly RectorFact[], options: ReplayRunOptions): FactReplayResult {
  const parsed = facts
    .filter((fact) => options.runId === undefined || fact.runId === options.runId)
    .map((fact) => RectorFactSchema.parse(fact))
    .sort(compareFactsDeterministically);
  return { facts: parsed, diagnostics: [] };
}
