import { redactSecrets, redactStringOrSuppress } from "../security/redaction";
import type {
  CreateMemoryEntryInput,
  MemoryEntry,
  MemoryLayer,
  UpdateMemoryEntryInput,
} from "../store/schemas";

const MEMORY_LAYERS = new Set<MemoryLayer>(["working", "episodic", "core"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function isMemoryLayer(value: unknown): value is MemoryLayer {
  return typeof value === "string" && MEMORY_LAYERS.has(value as MemoryLayer);
}

export function sanitizeMemoryContent(content: string): string {
  return redactStringOrSuppress(content);
}

export function sanitizeMemoryMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(metadata) as Record<string, unknown>;
}

function sanitizeMemoryFields<T extends Partial<CreateMemoryEntryInput & UpdateMemoryEntryInput>>(input: T): T {
  const sanitized = clone(input);
  if (typeof sanitized.content === "string") {
    sanitized.content = sanitizeMemoryContent(sanitized.content);
  }
  if (Array.isArray(sanitized.tags)) {
    sanitized.tags = sanitized.tags.map((tag) => sanitizeMemoryContent(tag));
  }
  if (typeof sanitized.source === "string") {
    sanitized.source = sanitizeMemoryContent(sanitized.source);
  }
  if (sanitized.metadata !== undefined) {
    sanitized.metadata = sanitizeMemoryMetadata(sanitized.metadata);
  }
  return sanitized;
}

export function sanitizeCreateMemoryEntryInput(input: CreateMemoryEntryInput): CreateMemoryEntryInput {
  return sanitizeMemoryFields(input);
}

export function sanitizeUpdateMemoryEntryInput(input: UpdateMemoryEntryInput): UpdateMemoryEntryInput {
  return sanitizeMemoryFields(input);
}

export function normalizeMemorySearchLimit(limit: number | undefined, defaultLimit = DEFAULT_SEARCH_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return defaultLimit;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

function parseIsoMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function memoryRelevanceScore(entry: MemoryEntry): number {
  return entry.accessCount * 2 + (parseIsoMs(entry.lastMentioned) ?? 0);
}

export function compareMemorySearchResults(left: MemoryEntry, right: MemoryEntry): number {
  const scoreDelta = memoryRelevanceScore(right) - memoryRelevanceScore(left);
  if (scoreDelta !== 0) return scoreDelta;
  const timestampDelta = right.timestamp.localeCompare(left.timestamp);
  if (timestampDelta !== 0) return timestampDelta;
  return left.id.localeCompare(right.id);
}

export function memoryPruneScore(entry: MemoryEntry, nowIso: string): number {
  const nowMs = parseIsoMs(nowIso) ?? 0;
  const timestampMs = parseIsoMs(entry.timestamp) ?? nowMs;
  const ageMs = Math.max(0, nowMs - timestampMs);
  const recency = Math.max(0, 100 - Math.floor(ageMs / DAY_MS));
  const accessBonus = Math.min(entry.accessCount * 3, 50);
  const noteBonus = entry.source === "user-note" || entry.tags.includes("note") ? 30 : 0;
  return recency + accessBonus + noteBonus;
}

export function compareMemoryPruneCandidates(
  left: { entry: MemoryEntry; score: number },
  right: { entry: MemoryEntry; score: number },
): number {
  if (left.score !== right.score) return left.score - right.score;
  const timestampDelta = left.entry.timestamp.localeCompare(right.entry.timestamp);
  if (timestampDelta !== 0) return timestampDelta;
  return left.entry.id.localeCompare(right.entry.id);
}
