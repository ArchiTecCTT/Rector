import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FACT_LEDGER_RECORD_VERSION,
  FACT_SCHEMA_VERSION,
  InMemoryFactLedger,
  JsonlFactLedger,
  createFactId,
  createFactScope,
  createFactTrust,
  replayJsonlFactLedger,
  replayJsonlFactLedgerContent,
  replayRun,
  type RectorFact,
} from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";
const APPENDED_AT = "2026-06-28T00:01:00.000Z";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

function fact(intent: string, overrides: Partial<RectorFact> = {}): RectorFact {
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "intent",
    runId: "run-replay",
    createdAt: CREATED_AT,
    producer: "system",
    provenance: [{ sourceType: "system" as const, systemId: "phase-2b-replay-test" }],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/replay.ts"] }),
    redactionState: "none",
    intent,
    ...overrides,
  } as Omit<RectorFact, "factId">;
  return { ...draft, factId: overrides.factId ?? createFactId(draft) } as RectorFact;
}

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rector-fact-replay-"));
  tempDirs.push(dir);
  return join(dir, "facts.jsonl");
}

describe("fact replay", () => {
  it("reconstructs the same fact list from JSONL", async () => {
    const filePath = await tempLedgerPath();
    const ledger = new JsonlFactLedger({ filePath, now: () => APPENDED_AT });
    const first = fact("first replay fact");
    const second = fact("second replay fact", { createdAt: "2026-06-28T00:00:05.000Z" });

    await ledger.appendMany([first, second]);

    await expect(replayJsonlFactLedger(filePath, { runId: "run-replay" })).resolves.toEqual({ facts: [first, second], diagnostics: [] });
    await expect(replayRun(filePath, { runId: "run-replay" })).resolves.toEqual({ facts: [first, second], diagnostics: [] });
  });

  it("fails loudly for corrupted JSONL by default", () => {
    const valid = JSON.stringify({ recordVersion: FACT_LEDGER_RECORD_VERSION, recordType: "fact", sequence: 0, appendedAt: APPENDED_AT, fact: fact("valid before corrupt") });
    const content = `${valid}\n{not-json}\n`;

    expect(() => replayJsonlFactLedgerContent(content)).toThrow(/Invalid fact ledger JSONL record at line 2/);
  });

  it("returns best-effort diagnostics when explicitly requested", () => {
    const validFact = fact("valid with diagnostics");
    const valid = JSON.stringify({ recordVersion: FACT_LEDGER_RECORD_VERSION, recordType: "fact", sequence: 0, appendedAt: APPENDED_AT, fact: validFact });
    const result = replayJsonlFactLedgerContent(`${valid}\n{not-json}\n`, { bestEffort: true });

    expect(result.facts).toEqual([validFact]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(/line 2/);
  });

  it("fails replay of a durable record whose fact no longer parses", async () => {
    const filePath = await tempLedgerPath();
    const invalidFact = { ...fact("invalid durable fact"), provenance: [] };
    await writeFile(filePath, `${JSON.stringify({ recordVersion: FACT_LEDGER_RECORD_VERSION, recordType: "fact", sequence: 0, appendedAt: APPENDED_AT, fact: invalidFact })}\n`, "utf8");

    await expect(replayJsonlFactLedger(filePath)).rejects.toThrow(/Invalid fact ledger JSONL record at line 1/);
  });

  it("replays from a FactLedger in append sequence order", async () => {
    const ledger = new InMemoryFactLedger({ now: () => APPENDED_AT });
    const first = fact("append-first", { createdAt: "2026-06-28T00:00:02.000Z" });
    const second = fact("append-second", { createdAt: "2026-06-28T00:00:01.000Z" });

    await ledger.appendMany([first, second]);

    await expect(replayRun(ledger, { runId: "run-replay" })).resolves.toEqual({ facts: [first, second], diagnostics: [] });
  });

  it("can replay from an in-memory fact list deterministically by timestamp", async () => {
    const later = fact("later", { createdAt: "2026-06-28T00:00:02.000Z" });
    const earlier = fact("earlier", { createdAt: "2026-06-28T00:00:01.000Z" });

    await expect(replayRun([later, earlier], { runId: "run-replay" })).resolves.toEqual({ facts: [earlier, later], diagnostics: [] });
  });
});
