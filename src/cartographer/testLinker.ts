import { extractImports, type ExtractImportsInput } from "./importExtractor";
import { normalizePath } from "./graphIds";

/**
 * testLinker (Todo 20)
 *
 * Links test files (*.test.*, *.spec.* for ts/tsx/js/jsx/mts/cts) to a target source file.
 *
 * Rules (strict, no invention):
 * 1. Import relation first: if a candidate test file contains a static import / dynamic import / require / export-from
 *    that resolves (via extractImports) to the target normalized path, it is a linked test with relation "import".
 * 2. Basename convention second (only if no import relation found for any candidate):
 *    - Candidate basename matches <targetBasename>.(test|spec).<ext> where ext in supported set.
 *    - If exactly one such candidate exists, link with relation "basename".
 *    - If zero or more than one, return empty linkedTests (do not fabricate certainty).
 * 3. Return empty linkedTests when no tests found; never invent paths or relationships.
 * 4. Deterministic: output is sorted by normalizedPath; no random, no wall time.
 */

export type LinkedTest = {
  readonly normalizedPath: string;
  readonly relation: "import" | "basename";
  readonly evidence: string;
};

export type FindTestsInput = {
  readonly targetNormalizedPath: string;
  readonly indexedFiles: readonly string[];
  readonly getSourceText: (normalizedPath: string) => string | undefined;
};

export type FindTestsResult = {
  readonly targetNormalizedPath: string;
  readonly linkedTests: readonly LinkedTest[];
};

const TEST_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"] as const;

function isTestFileCandidate(basename: string): boolean {
  return /\.(test|spec)\./.test(basename);
}

function basenameOf(p: string): string {
  const norm = normalizePath(p);
  const last = norm.lastIndexOf("/");
  return last >= 0 ? norm.slice(last + 1) : norm;
}

function withoutExt(b: string): string {
  // remove last extension only (e.g. .test.ts -> .test)
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

function targetBasenameNoExt(target: string): string {
  const b = basenameOf(target);
  // strip final extension
  return withoutExt(b);
}

function matchesBasenameConvention(targetNoExt: string, candidateBasename: string): boolean {
  // candidate must be <targetNoExt>.(test|spec).<ext>
  const m = candidateBasename.match(/^(.*)\.(test|spec)\.([a-z]+)$/i);
  if (!m) return false;
  const stem = m[1];
  const ext = "." + m[3].toLowerCase();
  if (!TEST_EXTS.includes(ext as (typeof TEST_EXTS)[number])) return false;
  return stem === targetNoExt;
}

function sortLinked(a: LinkedTest, b: LinkedTest): number {
  return a.normalizedPath < b.normalizedPath ? -1 : a.normalizedPath > b.normalizedPath ? 1 : 0;
}

function collectTestCandidates(indexedFiles: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const f of indexedFiles) {
    const norm = normalizePath(f);
    const base = basenameOf(norm);
    if (isTestFileCandidate(base)) {
      candidates.push(norm);
    }
  }
  return candidates;
}

function makeImportExtractionInput(
  filePath: string,
  sourceText: string,
  indexedFiles: readonly string[],
): ExtractImportsInput {
  return {
    filePath,
    sourceText,
    indexedFiles,
  };
}

function findImportEvidence(
  imports: readonly { target: { kind: string; normalizedPath?: string }; evidence: string }[],
  target: string,
): string | undefined {
  for (const rec of imports) {
    if (rec.target.kind === "file" && rec.target.normalizedPath === target) {
      return rec.evidence;
    }
  }
  return undefined;
}

function findImportLinkedTests(
  candidates: readonly string[],
  target: string,
  getSourceText: (normalizedPath: string) => string | undefined,
  indexedFiles: readonly string[],
): LinkedTest[] {
  const linked: LinkedTest[] = [];
  for (const cand of candidates) {
    const text = getSourceText(cand);
    if (text === undefined) continue;
    const ex = makeImportExtractionInput(cand, text, indexedFiles);
    const res = extractImports(ex);
    const evidence = findImportEvidence(res.imports, target);
    if (evidence !== undefined) {
      linked.push({
        normalizedPath: cand,
        relation: "import",
        evidence,
      });
    }
  }
  return linked;
}

function findBasenameFallback(
  candidates: readonly string[],
  targetBaseNoExt: string,
): LinkedTest[] {
  const basenameMatches: string[] = [];
  for (const cand of candidates) {
    const base = basenameOf(cand);
    if (matchesBasenameConvention(targetBaseNoExt, base)) {
      basenameMatches.push(cand);
    }
  }

  if (basenameMatches.length === 1) {
    return [
      {
        normalizedPath: basenameMatches[0],
        relation: "basename",
        evidence: "basename convention",
      },
    ];
  }
  // else: 0 or >1 -> empty (no invention)
  return [];
}

export function findTests(input: FindTestsInput): FindTestsResult {
  const { targetNormalizedPath, indexedFiles, getSourceText } = input;
  const target = normalizePath(targetNormalizedPath);
  const targetBaseNoExt = targetBasenameNoExt(target);

  const candidates = collectTestCandidates(indexedFiles);

  // 1) Import-relation pass
  const importLinked = findImportLinkedTests(candidates, target, getSourceText, indexedFiles);
  if (importLinked.length > 0) {
    // Import wins; return sorted, no basename fallback
    return {
      targetNormalizedPath: target,
      linkedTests: [...importLinked].sort(sortLinked),
    };
  }

  // 2) Basename convention fallback (only if no import links)
  const basenameLinked = findBasenameFallback(candidates, targetBaseNoExt);

  return {
    targetNormalizedPath: target,
    linkedTests: [...basenameLinked].sort(sortLinked),
  };
}
