import { FactTrustLevelSchema, FactTrustSchema } from "./schemas";
import type { FactTrust } from "./types";

export const FACT_TRUST_ORDER = [
  "raw",
  "schema_valid",
  "provenance_attached",
  "graph_grounded",
  "scope_checked",
  "validation_linked",
] as const;

export type ProgressiveFactTrustLevel = (typeof FACT_TRUST_ORDER)[number];

const TERMINAL_TRUST_LEVELS = new Set(["rejected", "insufficient_evidence"]);

export function createFactTrust(level: FactTrust["level"], reason?: string): FactTrust {
  return FactTrustSchema.parse({ level, reason, validationRefs: [] });
}

export function compareFactTrust(left: FactTrust["level"], right: FactTrust["level"]): number {
  const leftIndex = FACT_TRUST_ORDER.indexOf(left as ProgressiveFactTrustLevel);
  const rightIndex = FACT_TRUST_ORDER.indexOf(right as ProgressiveFactTrustLevel);
  if (leftIndex === -1 || rightIndex === -1) {
    if (left === right) return 0;
    if (TERMINAL_TRUST_LEVELS.has(left) && !TERMINAL_TRUST_LEVELS.has(right)) return -1;
    if (!TERMINAL_TRUST_LEVELS.has(left) && TERMINAL_TRUST_LEVELS.has(right)) return 1;
    return left < right ? -1 : 1;
  }
  return leftIndex - rightIndex;
}

export function canTransitionFactTrust(from: FactTrust["level"], to: FactTrust["level"]): boolean {
  FactTrustLevelSchema.parse(from);
  FactTrustLevelSchema.parse(to);
  if (from === to) return true;
  if (from === "rejected" || from === "insufficient_evidence") return false;
  if (to === "rejected" || to === "insufficient_evidence") return true;
  const fromIndex = FACT_TRUST_ORDER.indexOf(from as ProgressiveFactTrustLevel);
  const toIndex = FACT_TRUST_ORDER.indexOf(to as ProgressiveFactTrustLevel);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex === fromIndex + 1;
}

export function assertFactTrustTransition(from: FactTrust["level"], to: FactTrust["level"]): void {
  if (!canTransitionFactTrust(from, to)) {
    throw new Error(`Invalid fact trust transition: ${from} -> ${to}`);
  }
}

export function isTerminalFactTrust(level: FactTrust["level"]): boolean {
  FactTrustLevelSchema.parse(level);
  return TERMINAL_TRUST_LEVELS.has(level);
}
