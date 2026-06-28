#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";

import { replayJsonlFactLedger } from "../../src/facts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function usage(): string {
  return [
    "Usage: npm run facts:replay -- <ledger.jsonl> [--run-id <runId>] [--best-effort]",
    "",
    "Replays a JSONL fact ledger and prints counts plus diagnostics; raw fact payloads are not dumped.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): { ledgerPath?: string; runId?: string; bestEffort: boolean; help: boolean } {
  let ledgerPath: string | undefined;
  let runId: string | undefined;
  let bestEffort = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--best-effort") {
      bestEffort = true;
    } else if (arg === "--run-id") {
      runId = argv[index + 1];
      index += 1;
    } else if (!ledgerPath) {
      ledgerPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { ledgerPath, runId, bestEffort, help };
}

export async function replayFactsCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.ledgerPath) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }
  const ledgerPath = path.resolve(REPO_ROOT, args.ledgerPath);
  const result = await replayJsonlFactLedger(ledgerPath, { runId: args.runId, bestEffort: args.bestEffort });
  const byKind = new Map<string, number>();
  for (const fact of result.facts) byKind.set(fact.kind, (byKind.get(fact.kind) ?? 0) + 1);
  process.stdout.write([
    "[facts:replay] replay complete.",
    `  ledger: ${path.relative(REPO_ROOT, ledgerPath)}`,
    args.runId ? `  runId: ${args.runId}` : "",
    `  facts: ${result.facts.length}`,
    `  diagnostics: ${result.diagnostics.length}`,
    `  kinds: ${[...byKind.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([kind, count]) => `${kind}=${count}`).join(" ") || "none"}`,
  ].filter(Boolean).join("\n") + "\n");
  if (result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics.slice(0, 20)) {
      process.stdout.write(`  diagnostic: line=${diagnostic.line} ${diagnostic.message}\n`);
    }
  }
  return result.diagnostics.length > 0 && !args.bestEffort ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  replayFactsCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`[facts:replay] FAILED: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
