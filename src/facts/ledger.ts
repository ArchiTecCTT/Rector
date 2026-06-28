import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { canonicalizeJson } from "./ids";
import { FactFamilyKindSchema, FactIdSchema, FactProducerSchema, FactTrustLevelSchema, RectorFactSchema } from "./schemas";
import type { FactId, FactKind, FactProducer, FactTrust, RectorFact } from "./types";

export const FACT_LEDGER_RECORD_VERSION = "rector.fact-ledger-record.v1";

const IsoDateTimeSchema = z.string().datetime();

export interface FactLedgerFactRecord {
  readonly recordVersion: typeof FACT_LEDGER_RECORD_VERSION;
  readonly recordType: "fact";
  readonly sequence: number;
  readonly appendedAt: string;
  readonly fact: RectorFact;
}

export interface FactLedgerSealRecord {
  readonly recordVersion: typeof FACT_LEDGER_RECORD_VERSION;
  readonly recordType: "seal";
  readonly sequence: number;
  readonly appendedAt: string;
  readonly runId: string;
  readonly sha256: string;
  readonly factCount: number;
}

export type FactLedgerRecord = FactLedgerFactRecord | FactLedgerSealRecord;

const FactLedgerFactRecordObject: z.ZodObject<z.ZodRawShape> = z
  .object({
    recordVersion: z.literal(FACT_LEDGER_RECORD_VERSION),
    recordType: z.literal("fact"),
    sequence: z.number().int().nonnegative(),
    appendedAt: IsoDateTimeSchema,
    fact: RectorFactSchema,
  })
  .strict();

const FactLedgerSealRecordObject: z.ZodObject<z.ZodRawShape> = z
  .object({
    recordVersion: z.literal(FACT_LEDGER_RECORD_VERSION),
    recordType: z.literal("seal"),
    sequence: z.number().int().nonnegative(),
    appendedAt: IsoDateTimeSchema,
    runId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    factCount: z.number().int().nonnegative(),
  })
  .strict();

export const FactLedgerFactRecordSchema: z.ZodTypeAny = FactLedgerFactRecordObject;
export const FactLedgerSealRecordSchema: z.ZodTypeAny = FactLedgerSealRecordObject;
export const FactLedgerRecordSchema: z.ZodTypeAny = z.union([FactLedgerFactRecordObject, FactLedgerSealRecordObject]);

export interface AppendFactResult {
  readonly fact: RectorFact;
  readonly sequence: number;
  readonly appendedAt: string;
}

export interface AppendFactsResult {
  readonly appended: readonly AppendFactResult[];
  readonly count: number;
}

export interface FactQuery {
  readonly runId?: string;
  readonly taskId?: string;
  readonly kind?: FactKind | readonly FactKind[];
  readonly producer?: FactProducer | readonly FactProducer[];
  readonly trustLevel?: FactTrust["level"] | readonly FactTrust["level"][];
  readonly factIds?: readonly FactId[];
  readonly createdAtFrom?: string;
  readonly createdAtTo?: string;
}

export interface SealedFactRun {
  readonly runId: string;
  readonly sealedAt: string;
  readonly factCount: number;
  readonly sha256: string;
  readonly facts: readonly RectorFact[];
}

export interface FactLedger {
  append(fact: RectorFact): Promise<AppendFactResult>;
  appendMany(facts: readonly RectorFact[]): Promise<AppendFactsResult>;
  get(factId: FactId | string): Promise<RectorFact | undefined>;
  query(input?: FactQuery): Promise<RectorFact[]>;
  listRun(runId: string): Promise<RectorFact[]>;
  sealRun(runId: string): Promise<SealedFactRun>;
}

interface StoredFact {
  readonly sequence: number;
  readonly appendedAt: string;
  readonly fact: RectorFact;
}

export interface InMemoryFactLedgerOptions {
  readonly now?: () => string;
}

export class InMemoryFactLedger implements FactLedger {
  private readonly now: () => string;
  private readonly facts: StoredFact[] = [];
  private readonly sealedRuns = new Map<string, SealedFactRun>();

  constructor(options: InMemoryFactLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async append(fact: RectorFact): Promise<AppendFactResult> {
    const parsed = parseFactForLedger(fact);
    this.assertCanAppend(parsed);
    const appendedAt = this.now();
    IsoDateTimeSchema.parse(appendedAt);
    const stored = { fact: parsed, sequence: this.facts.length, appendedAt };
    this.facts.push(stored);
    return { fact: parsed, sequence: stored.sequence, appendedAt };
  }

  async appendMany(facts: readonly RectorFact[]): Promise<AppendFactsResult> {
    const parsed = facts.map(parseFactForLedger);
    const seen = new Set(this.facts.map((entry) => entry.fact.factId));
    for (const fact of parsed) {
      if (seen.has(fact.factId)) throw new Error(`Fact ledger already contains factId ${fact.factId}`);
      if (this.sealedRuns.has(fact.runId)) throw new Error(`Fact ledger run is sealed: ${fact.runId}`);
      seen.add(fact.factId);
    }
    const appendedAt = this.now();
    IsoDateTimeSchema.parse(appendedAt);
    let sequence = this.facts.length;
    const appended: AppendFactResult[] = [];
    for (const fact of parsed) {
      const stored = { fact, sequence, appendedAt };
      this.facts.push(stored);
      appended.push({ fact, sequence, appendedAt });
      sequence += 1;
    }
    return { appended, count: appended.length };
  }

  async get(factId: FactId | string): Promise<RectorFact | undefined> {
    const parsedFactId = FactIdSchema.parse(factId);
    return orderedStoredFacts(this.facts).find((entry) => entry.fact.factId === parsedFactId)?.fact;
  }

  async query(input: FactQuery = {}): Promise<RectorFact[]> {
    parseFactQuery(input);
    return orderedStoredFacts(this.facts)
      .map((entry) => entry.fact)
      .filter((fact) => matchesFactQuery(fact, input));
  }

  async listRun(runId: string): Promise<RectorFact[]> {
    if (!runId) throw new Error("runId is required");
    return this.query({ runId });
  }

  async sealRun(runId: string): Promise<SealedFactRun> {
    if (!runId) throw new Error("runId is required");
    const existing = this.sealedRuns.get(runId);
    if (existing) return existing;
    const facts = await this.listRun(runId);
    const sealedAt = this.now();
    IsoDateTimeSchema.parse(sealedAt);
    const sealed = sealFacts(runId, facts, sealedAt);
    this.sealedRuns.set(runId, sealed);
    return sealed;
  }

  private assertCanAppend(fact: RectorFact): void {
    if (this.sealedRuns.has(fact.runId)) throw new Error(`Fact ledger run is sealed: ${fact.runId}`);
    if (this.facts.some((entry) => entry.fact.factId === fact.factId)) throw new Error(`Fact ledger already contains factId ${fact.factId}`);
  }
}

export interface JsonlFactLedgerOptions {
  readonly filePath: string;
  readonly now?: () => string;
}

export class JsonlFactLedger implements FactLedger {
  private readonly filePath: string;
  private readonly now: () => string;

  constructor(options: JsonlFactLedgerOptions) {
    if (!options.filePath) throw new Error("JsonlFactLedger requires filePath");
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async append(fact: RectorFact): Promise<AppendFactResult> {
    const parsed = parseFactForLedger(fact);
    const records = await readJsonlLedgerRecords(this.filePath);
    assertJsonlCanAppend(records, parsed);
    const appendedAt = this.now();
    IsoDateTimeSchema.parse(appendedAt);
    const sequence = nextSequence(records);
    const record: FactLedgerFactRecord = { recordVersion: FACT_LEDGER_RECORD_VERSION, recordType: "fact", sequence, appendedAt, fact: parsed };
    await appendJsonlLedgerRecord(this.filePath, record);
    return { fact: parsed, sequence, appendedAt };
  }

  async appendMany(facts: readonly RectorFact[]): Promise<AppendFactsResult> {
    const parsed = facts.map(parseFactForLedger);
    const records = await readJsonlLedgerRecords(this.filePath);
    const seen = new Set(records.filter(isFactRecord).map((record) => record.fact.factId));
    const sealed = sealedRunIds(records);
    for (const fact of parsed) {
      if (sealed.has(fact.runId)) throw new Error(`Fact ledger run is sealed: ${fact.runId}`);
      if (seen.has(fact.factId)) throw new Error(`Fact ledger already contains factId ${fact.factId}`);
      seen.add(fact.factId);
    }
    const appendedAt = this.now();
    IsoDateTimeSchema.parse(appendedAt);
    let sequence = nextSequence(records);
    const appendResults: AppendFactResult[] = [];
    const newRecords: FactLedgerFactRecord[] = [];
    for (const fact of parsed) {
      const record = { recordVersion: FACT_LEDGER_RECORD_VERSION, recordType: "fact", sequence, appendedAt, fact } satisfies FactLedgerFactRecord;
      newRecords.push(record);
      appendResults.push({ fact, sequence, appendedAt });
      sequence += 1;
    }
    await appendJsonlLedgerRecords(this.filePath, newRecords);
    return { appended: appendResults, count: appendResults.length };
  }

  async get(factId: FactId | string): Promise<RectorFact | undefined> {
    const parsedFactId = FactIdSchema.parse(factId);
    const records = await readJsonlLedgerRecords(this.filePath);
    return orderedFactRecords(records.filter(isFactRecord)).find((record) => record.fact.factId === parsedFactId)?.fact;
  }

  async query(input: FactQuery = {}): Promise<RectorFact[]> {
    parseFactQuery(input);
    const records = await readJsonlLedgerRecords(this.filePath);
    return orderedFactRecords(records.filter(isFactRecord))
      .map((record) => record.fact)
      .filter((fact) => matchesFactQuery(fact, input));
  }

  async listRun(runId: string): Promise<RectorFact[]> {
    if (!runId) throw new Error("runId is required");
    return this.query({ runId });
  }

  async sealRun(runId: string): Promise<SealedFactRun> {
    if (!runId) throw new Error("runId is required");
    const records = await readJsonlLedgerRecords(this.filePath);
    const existingSeal = records.filter(isSealRecord).find((record) => record.runId === runId);
    if (existingSeal) {
      const facts = factsForRun(records, runId);
      return { runId, sealedAt: existingSeal.appendedAt, factCount: existingSeal.factCount, sha256: existingSeal.sha256, facts };
    }
    const facts = factsForRun(records, runId);
    const sealedAt = this.now();
    IsoDateTimeSchema.parse(sealedAt);
    const sealed = sealFacts(runId, facts, sealedAt);
    const record: FactLedgerSealRecord = {
      recordVersion: FACT_LEDGER_RECORD_VERSION,
      recordType: "seal",
      sequence: nextSequence(records),
      appendedAt: sealedAt,
      runId,
      sha256: sealed.sha256,
      factCount: sealed.factCount,
    };
    await appendJsonlLedgerRecord(this.filePath, record);
    return sealed;
  }
}

export async function appendFact(ledger: FactLedger, fact: RectorFact): Promise<AppendFactResult> {
  return ledger.append(fact);
}

export async function appendMany(ledger: FactLedger, facts: readonly RectorFact[]): Promise<AppendFactsResult> {
  return ledger.appendMany(facts);
}

export async function getFact(ledger: FactLedger, factId: FactId | string): Promise<RectorFact | undefined> {
  return ledger.get(factId);
}

export async function queryFacts(ledger: FactLedger, input: FactQuery = {}): Promise<RectorFact[]> {
  return ledger.query(input);
}

export async function listByRun(ledger: FactLedger, runId: string): Promise<RectorFact[]> {
  return ledger.listRun(runId);
}

export async function sealRun(ledger: FactLedger, runId: string): Promise<SealedFactRun> {
  return ledger.sealRun(runId);
}

export interface LedgerReplayDiagnostic {
  readonly line: number;
  readonly message: string;
  readonly raw: string;
}

export interface ReadJsonlLedgerRecordsOptions {
  readonly bestEffort?: boolean;
  readonly diagnostics?: LedgerReplayDiagnostic[];
}

export async function readJsonlLedgerRecords(filePath: string, options: ReadJsonlLedgerRecordsOptions = {}): Promise<FactLedgerRecord[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseJsonlLedgerRecords(content, options);
}

export function parseJsonlLedgerRecords(content: string, options: ReadJsonlLedgerRecordsOptions = {}): FactLedgerRecord[] {
  const records: FactLedgerRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    if (raw.trim().length === 0) continue;
    try {
      const parsedJson = JSON.parse(raw) as unknown;
      records.push(FactLedgerRecordSchema.parse(parsedJson) as FactLedgerRecord);
    } catch (error) {
      const message = `Invalid fact ledger JSONL record at line ${line}: ${error instanceof Error ? error.message : String(error)}`;
      if (!options.bestEffort) throw new Error(message);
      options.diagnostics?.push({ line, message, raw });
    }
  }
  return records;
}

export function sealFacts(runId: string, facts: readonly RectorFact[], sealedAt: string): SealedFactRun {
  const ordered = [...facts].sort(compareFactsDeterministically);
  const sha256 = createHash("sha256").update(canonicalizeJson({ runId, facts: ordered }), "utf8").digest("hex");
  return { runId, sealedAt, factCount: ordered.length, sha256, facts: ordered };
}

export function compareFactsDeterministically(left: RectorFact, right: RectorFact): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.factId.localeCompare(right.factId);
}

export function isFactRecord(record: FactLedgerRecord): record is FactLedgerFactRecord {
  return record.recordType === "fact";
}

export function isSealRecord(record: FactLedgerRecord): record is FactLedgerSealRecord {
  return record.recordType === "seal";
}

function parseFactForLedger(fact: RectorFact): RectorFact {
  return RectorFactSchema.parse(fact);
}

function parseFactQuery(query: FactQuery): void {
  if (query.kind !== undefined) parseOneOrMany(query.kind, FactFamilyKindSchema.parse);
  if (query.producer !== undefined) parseOneOrMany(query.producer, FactProducerSchema.parse);
  if (query.trustLevel !== undefined) parseOneOrMany(query.trustLevel, FactTrustLevelSchema.parse);
  if (query.factIds !== undefined) query.factIds.forEach((factId) => FactIdSchema.parse(factId));
  if (query.createdAtFrom !== undefined) IsoDateTimeSchema.parse(query.createdAtFrom);
  if (query.createdAtTo !== undefined) IsoDateTimeSchema.parse(query.createdAtTo);
}

function parseOneOrMany(value: unknown, parse: (item: unknown) => unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) parse(item);
  } else {
    parse(value);
  }
}

function matchesFactQuery(fact: RectorFact, query: FactQuery): boolean {
  return (
    (query.runId === undefined || fact.runId === query.runId) &&
    (query.taskId === undefined || fact.taskId === query.taskId) &&
    (query.kind === undefined || matchesOneOrMany(fact.kind, query.kind)) &&
    (query.producer === undefined || matchesOneOrMany(fact.producer, query.producer)) &&
    (query.trustLevel === undefined || matchesOneOrMany(fact.trust.level, query.trustLevel)) &&
    (query.factIds === undefined || query.factIds.includes(fact.factId)) &&
    (query.createdAtFrom === undefined || fact.createdAt >= query.createdAtFrom) &&
    (query.createdAtTo === undefined || fact.createdAt <= query.createdAtTo)
  );
}

function matchesOneOrMany<T>(value: T, candidate: T | readonly T[]): boolean {
  return Array.isArray(candidate) ? candidate.includes(value) : value === candidate;
}

function orderedStoredFacts(facts: readonly StoredFact[]): StoredFact[] {
  return [...facts].sort(compareStoredFacts);
}

function orderedFactRecords(records: readonly FactLedgerFactRecord[]): FactLedgerFactRecord[] {
  return [...records].sort(compareFactRecords);
}

function compareStoredFacts(left: StoredFact, right: StoredFact): number {
  const sequence = left.sequence - right.sequence;
  if (sequence !== 0) return sequence;
  const appended = left.appendedAt.localeCompare(right.appendedAt);
  if (appended !== 0) return appended;
  return compareFactsDeterministically(left.fact, right.fact);
}

function compareFactRecords(left: FactLedgerFactRecord, right: FactLedgerFactRecord): number {
  const sequence = left.sequence - right.sequence;
  if (sequence !== 0) return sequence;
  const appended = left.appendedAt.localeCompare(right.appendedAt);
  if (appended !== 0) return appended;
  return compareFactsDeterministically(left.fact, right.fact);
}

function assertJsonlCanAppend(records: readonly FactLedgerRecord[], fact: RectorFact): void {
  if (sealedRunIds(records).has(fact.runId)) throw new Error(`Fact ledger run is sealed: ${fact.runId}`);
  if (records.filter(isFactRecord).some((record) => record.fact.factId === fact.factId)) throw new Error(`Fact ledger already contains factId ${fact.factId}`);
}

function nextSequence(records: readonly FactLedgerRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.sequence), -1) + 1;
}

function sealedRunIds(records: readonly FactLedgerRecord[]): Set<string> {
  return new Set(records.filter(isSealRecord).map((record) => record.runId));
}

function factsForRun(records: readonly FactLedgerRecord[], runId: string): RectorFact[] {
  return orderedFactRecords(records.filter(isFactRecord).filter((record) => record.fact.runId === runId)).map((record) => record.fact);
}

async function appendJsonlLedgerRecord(filePath: string, record: FactLedgerRecord): Promise<void> {
  await appendJsonlLedgerRecords(filePath, [record]);
}

async function appendJsonlLedgerRecords(filePath: string, records: readonly FactLedgerRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(filePath), { recursive: true });
  let previous = "";
  try {
    previous = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";
  const next = `${separator}${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await appendFile(filePath, next, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
