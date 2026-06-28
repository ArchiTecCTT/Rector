import { createHash } from "node:crypto";

import { FactIdSchema, JsonValueSchema } from "./schemas";
import type { FactId, RectorFact } from "./types";

const FACT_ID_PREFIX = "fact_";
const OMIT_FROM_FACT_ID = new Set(["factId", "runId", "createdAt"]);
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function createFactId(input: unknown): FactId {
  const canonical = canonicalizeJson(semanticFactIdInput(input));
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return FactIdSchema.parse(`${FACT_ID_PREFIX}${digest.slice(0, 40)}`);
}

export function factIdForFact(fact: Omit<RectorFact, "factId"> | RectorFact): FactId {
  return createFactId(fact);
}

export function canonicalizeJson(input: unknown): string {
  const json = normalizeJsonValue(input);
  JsonValueSchema.parse(json);
  return JSON.stringify(json);
}

function semanticFactIdInput(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(semanticFactIdInput);
  if (!isPlainRecord(input)) return input;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) throw new Error(`Fact IDs reject prototype pollution key: ${key}`);
    if (OMIT_FROM_FACT_ID.has(key)) continue;
    const value = input[key];
    if (value !== undefined) sorted[key] = semanticFactIdInput(value);
  }
  return sorted;
}

function normalizeJsonValue(input: unknown): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Fact IDs require finite JSON numbers");
    return input;
  }
  if (Array.isArray(input)) return input.map(normalizeJsonValue);
  if (isPlainRecord(input)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) throw new Error(`Fact IDs reject prototype pollution key: ${key}`);
      const value = input[key];
      if (value !== undefined) sorted[key] = normalizeJsonValue(value);
    }
    return sorted;
  }
  throw new Error(`Fact IDs require JSON-compatible values, received ${typeof input}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Object]";
}
