import { redactStringOrSuppress } from "../security/redaction";
import { MemoryEntrySchema, type MemoryEntry, type MemoryLayer } from "../store/schemas";
import { isMemoryLayer, sanitizeMemoryContent, sanitizeMemoryMetadata } from "./entryUtils";

/** Redact secrets from memory content before persistence or egress. */
export function redactMemoryContent(content: string): string {
  return sanitizeMemoryContent(content);
}

/** Map a provider-native record into a validated {@link MemoryEntry}. */
export function mapToMemoryEntry(
  raw: {
    id: string;
    layer?: MemoryLayer;
    content: string;
    timestamp?: string;
    lastMentioned?: string;
    accessCount?: number;
    tags?: string[];
    source?: string;
    metadata?: Record<string, unknown>;
  },
  now: () => string,
): MemoryEntry {
  const ts = raw.timestamp ?? now();
  return MemoryEntrySchema.parse({
    id: raw.id,
    layer: raw.layer ?? "episodic",
    content: redactMemoryContent(raw.content),
    timestamp: ts,
    lastMentioned: raw.lastMentioned ?? ts,
    accessCount: raw.accessCount ?? 0,
    tags: (raw.tags ?? []).map((tag) => sanitizeMemoryContent(tag)),
    source: raw.source === undefined ? undefined : sanitizeMemoryContent(raw.source),
    metadata: sanitizeMemoryMetadata(raw.metadata ?? {}),
  });
}

/** Classify and redact adapter errors — never surfaces secrets. */
export function classifyAdapterError(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${redactStringOrSuppress(message)}`);
}

/** Shared injectable-deps shape for external memory adapters. */
export interface MemoryAdapterDeps<TClient> {
  /** Injectable client factory for tests (avoids lazy require + network). */
  clientFactory?: (...args: never[]) => TClient;
}

/** Serialize memory entry fields into provider metadata (non-secret only). */
export function memoryEntryToMetadata(entry: {
  layer: MemoryLayer;
  timestamp: string;
  lastMentioned: string;
  accessCount: number;
  tags: string[];
  source?: string;
  metadata: Record<string, unknown>;
}): Record<string, string | number | boolean> {
  const flat: Record<string, string | number | boolean> = {
    layer: entry.layer,
    timestamp: entry.timestamp,
    lastMentioned: entry.lastMentioned,
    accessCount: entry.accessCount,
    tags: entry.tags.map((tag) => sanitizeMemoryContent(tag)).join(","),
  };
  if (entry.source) flat.source = sanitizeMemoryContent(entry.source);
  const redactedMetadata = sanitizeMemoryMetadata(entry.metadata);
  for (const [key, value] of Object.entries(redactedMetadata)) {
    const safeKey = sanitizeMemoryContent(key);
    if (typeof value === "string") {
      flat[`meta_${safeKey}`] = sanitizeMemoryContent(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      flat[`meta_${safeKey}`] = value;
    }
  }
  return flat;
}

/** Reconstruct memory fields from provider metadata. */
export function metadataToMemoryFields(
  metadata: Record<string, unknown> | undefined,
  fallbackNow: string,
): {
  layer: MemoryLayer;
  timestamp: string;
  lastMentioned: string;
  accessCount: number;
  tags: string[];
  source?: string;
  extraMetadata: Record<string, unknown>;
} {
  const layer = isMemoryLayer(metadata?.layer) ? metadata.layer : "episodic";
  const timestamp = typeof metadata?.timestamp === "string" ? metadata.timestamp : fallbackNow;
  const lastMentioned = typeof metadata?.lastMentioned === "string" ? metadata.lastMentioned : timestamp;
  const accessCount =
    typeof metadata?.accessCount === "number"
      ? metadata.accessCount
      : typeof metadata?.accessCount === "string" && Number.isFinite(Number(metadata.accessCount))
        ? Number(metadata.accessCount)
        : 0;
  const tags =
    typeof metadata?.tags === "string"
      ? metadata.tags.split(",").filter((t) => t.length > 0)
      : Array.isArray(metadata?.tags)
        ? (metadata.tags as string[])
        : [];
  const source = typeof metadata?.source === "string" ? metadata.source : undefined;
  const extraMetadata: Record<string, unknown> = {};
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (key.startsWith("meta_")) {
        extraMetadata[key.slice(5)] = typeof value === "string" ? sanitizeMemoryContent(value) : value;
      }
    }
  }
  return { layer, timestamp, lastMentioned, accessCount, tags, source, extraMetadata };
}