import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FACT_SCHEMA_VERSION,
  InMemoryFactLedger,
  JsonlFactLedger,
  appendFact,
  appendMany,
  createFactId,
  createFactScope,
  createFactTrust,
  getFact,
  listByRun,
  queryFacts,
  sealFacts,
  sealRun,
  type RectorFact,
} from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";
const APPENDED_AT = "2026-06-28T00:01:00.000Z";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

function systemProvenance() {
  return { sourceType: "system" as const, systemId: "phase-2b-ledger-test" };
}

function fact(overrides: Partial<RectorFact> & { kind?: RectorFact["kind"] } = {}): RectorFact {
  const kind = overrides.kind ?? "intent";
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind,
    runId: "run-ledger",
    createdAt: CREATED_AT,
    producer: "system",
    provenance: [systemProvenance()],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/ledger.ts"] }),
    redactionState: "none",
    intent: "Implement append-only fact ledger",
    ...overrides,
  } as Omit<RectorFact, "factId">;
  return { ...draft, factId: overrides.factId ?? createFactId(draft) } as RectorFact;
}

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rector-fact-ledger-"));
  tempDirs.push(dir);
  return join(dir, "facts.jsonl");
}

describe("InMemoryFactLedger", () => {
  it("rejects invalid facts on append", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const invalid = { ...fact(), provenance: [] } as unknown as RectorFact;

    await expect(ledger.append(invalid)).rejects.toThrow(/provenance is required/);
  });

  it("appendMany stores every fact in one batch without re-entering single-append checks", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const facts = [
      fact({ intent: "batch-a", createdAt: "2026-06-28T00:00:01.000Z" }),
      fact({ intent: "batch-b", createdAt: "2026-06-28T00:00:02.000Z" }),
      fact({ intent: "batch-c", createdAt: "2026-06-28T00:00:03.000Z" }),
    ];

    const result = await ledger.appendMany(facts);

    expect(result.count).toBe(3);
    expect(result.appended.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    await expect(ledger.listRun("run-ledger")).resolves.toEqual(facts);
  });

  it("preserves append order and supports convenience APIs", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const first = fact({ intent: "first", createdAt: "2026-06-28T00:00:02.000Z" });
    const second = fact({ intent: "second", createdAt: "2026-06-28T00:00:01.000Z" });

    await appendMany(ledger, [first, second]);

    await expect(getFact(ledger, first.factId)).resolves.toEqual(first);
    await expect(listByRun(ledger, "run-ledger")).resolves.toEqual([first, second]);
    await expect(queryFacts(ledger, { kind: "intent", trustLevel: "schema_valid" })).resolves.toEqual([first, second]);
  });

  it("keeps corrections append-only instead of mutating prior records", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const original = fact({ intent: "Original claim" });
    const correction = fact({ intent: "Corrected claim", supersedesFactId: original.factId, createdAt: "2026-06-28T00:00:10.000Z" });

    await ledger.append(original);
    await ledger.append(correction);

    await expect(ledger.get(original.factId)).resolves.toEqual(original);
    await expect(ledger.listRun("run-ledger")).resolves.toEqual([original, correction]);
  });

  it("seals a run with a content hash and rejects later appends to that run", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const original = fact({ intent: "seal me" });

    await ledger.append(original);
    const sealed = await sealRun(ledger, "run-ledger");

    expect(sealed.factCount).toBe(1);
    expect(sealed.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(appendFact(ledger, fact({ intent: "late append" }))).rejects.toThrow(/sealed/);
  });

  it("changes sealed run hash when any fact in the run changes", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const original = fact({ intent: "hash baseline" });
    const alternate = fact({ intent: "hash alternate" });

    await ledger.append(original);
    const firstSeal = await sealRun(ledger, "run-ledger");

    const otherLedger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    await otherLedger.append(alternate);
    const secondSeal = await sealRun(otherLedger, "run-ledger");

    expect(firstSeal.sha256).not.toBe(secondSeal.sha256);
    expect(sealFacts("run-ledger", [original], APPENDED_AT).sha256).toBe(firstSeal.sha256);
  });
});

describe("JsonlFactLedger", () => {
  it("writes durable individually parseable JSONL records", async () => {
    const filePath = await tempLedgerPath();
    const ledger = new JsonlFactLedger({ filePath, now: () => APPENDED_AT });
    const first = fact({ intent: "jsonl first" });
    const second = fact({ intent: "jsonl second" });

    await ledger.appendMany([first, second]);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { recordVersion: "rector.fact-ledger-record.v1", recordType: "fact", sequence: 0, fact: { factId: first.factId } },
      { recordVersion: "rector.fact-ledger-record.v1", recordType: "fact", sequence: 1, fact: { factId: second.factId } },
    ]);
    await expect(ledger.listRun("run-ledger")).resolves.toEqual([first, second]);
  });

  it("persists seal records and keeps the run immutable", async () => {
    const filePath = await tempLedgerPath();
    const ledger = new JsonlFactLedger({ filePath, now: () => APPENDED_AT });
    const original = fact({ intent: "jsonl seal" });

    await ledger.append(original);
    const sealed = await ledger.sealRun("run-ledger");
    const reopened = new JsonlFactLedger({ filePath, now: () => "2026-06-28T00:02:00.000Z" });

    await expect(reopened.sealRun("run-ledger")).resolves.toEqual(sealed);
    await expect(reopened.append(fact({ intent: "blocked after reopen" }))).rejects.toThrow(/sealed/);
  });

  it("rejects duplicate fact IDs", async () => {
    const filePath = await tempLedgerPath();
    const ledger = new JsonlFactLedger({ filePath, now: () => APPENDED_AT });
    const original = fact({ intent: "duplicate" });

    await ledger.append(original);

    await expect(ledger.append(original)).rejects.toThrow(/already contains/);
  });
});
