import { canonicalizeJson } from "./ids";
import { RectorFactSchema } from "./schemas";
import type { FactId, RectorFact } from "./types";

export interface ChangedFact {
  readonly factId: FactId;
  readonly before: RectorFact;
  readonly after: RectorFact;
}

export interface FactDiff {
  readonly added: readonly RectorFact[];
  readonly removed: readonly RectorFact[];
  readonly changed: readonly ChangedFact[];
  readonly unchanged: readonly RectorFact[];
}

export function diffFacts(before: readonly RectorFact[], after: readonly RectorFact[]): FactDiff {
  const beforeById = toFactMap(before, "before");
  const afterById = toFactMap(after, "after");
  const added: RectorFact[] = [];
  const removed: RectorFact[] = [];
  const changed: ChangedFact[] = [];
  const unchanged: RectorFact[] = [];

  for (const [factId, beforeFact] of sortedEntries(beforeById)) {
    const afterFact = afterById.get(factId);
    if (!afterFact) {
      removed.push(beforeFact);
      continue;
    }
    if (canonicalizeJson(beforeFact) === canonicalizeJson(afterFact)) {
      unchanged.push(beforeFact);
    } else {
      changed.push({ factId, before: beforeFact, after: afterFact });
    }
  }

  for (const [factId, afterFact] of sortedEntries(afterById)) {
    if (!beforeById.has(factId)) added.push(afterFact);
  }

  return { added, removed, changed, unchanged };
}

export function factsEqual(left: readonly RectorFact[], right: readonly RectorFact[]): boolean {
  const diff = diffFacts(left, right);
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

function toFactMap(facts: readonly RectorFact[], side: string): Map<FactId, RectorFact> {
  const byId = new Map<FactId, RectorFact>();
  for (const fact of facts) {
    const parsed = RectorFactSchema.parse(fact);
    if (byId.has(parsed.factId)) throw new Error(`Duplicate factId in ${side} fact set: ${parsed.factId}`);
    byId.set(parsed.factId, parsed);
  }
  return byId;
}

function sortedEntries(map: Map<FactId, RectorFact>): [FactId, RectorFact][] {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}
