import { z } from "zod";
import type { ScanError } from "./types";
import { ScanErrorSchema } from "./schemas";

export const SELF_SCAN_SCHEMA_VERSION = "rector.cartographer.selfScan.v1" as const;

export const ExpectedPathCheckSchema = z
  .object({ path: z.string().min(1), present: z.boolean() })
  .strict();

export const ForbiddenPathCheckSchema = z
  .object({ pathPattern: z.string().min(1), matched: z.boolean() })
  .strict();

export const GitComparisonSchema = z
  .object({
    gitTrackedCount: z.number().int().nonnegative(),
    cartographerIndexedCount: z.number().int().nonnegative(),
    ignoredTrackedCount: z.number().int().nonnegative(),
    unexplainedMissing: z.array(z.string()),
    unexpectedIndexed: z.array(z.string()),
  })
  .strict();

export const CartographerSelfScanReportSchema = z
  .object({
    schemaVersion: z.literal(SELF_SCAN_SCHEMA_VERSION),
    repoRoot: z.string().min(1),
    snapshotId: z.string().min(1),
    generatedAt: z.string().datetime(),
    indexedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    deletedFileCount: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    scanErrorCount: z.number().int().nonnegative(),
    expectedPathChecks: z.array(ExpectedPathCheckSchema),
    forbiddenPathChecks: z.array(ForbiddenPathCheckSchema),
    gitComparison: GitComparisonSchema,
    scanErrors: z.array(ScanErrorSchema),
  })
  .strict();

export type CartographerSelfScanReport = z.infer<typeof CartographerSelfScanReportSchema>;

export const CleanSelfScanReportSchema = CartographerSelfScanReportSchema.refine(
  (r) => r.scanErrorCount === 0 && r.forbiddenPathChecks.every((c) => !c.matched),
  { message: "report must be clean: zero scan errors and no forbidden path hits" }
);

export function sortExpectedPathChecks(
  checks: readonly { path: string; present: boolean }[]
): { path: string; present: boolean }[] {
  return [...checks].sort((a, b) => compareUtf16(a.path, b.path));
}

export function sortForbiddenPathChecks(
  checks: readonly { pathPattern: string; matched: boolean }[]
): { pathPattern: string; matched: boolean }[] {
  return [...checks].sort((a, b) => compareUtf16(a.pathPattern, b.pathPattern));
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stripTimestampsForComparison<T extends { generatedAt: string }>(report: T): T {
  return { ...report, generatedAt: "1970-01-01T00:00:00.000Z" };
}

export function selfScanReportsEqualAfterTimestampStrip(
  a: CartographerSelfScanReport,
  b: CartographerSelfScanReport
): boolean {
  const sa = stripTimestampsForComparison(a);
  const sb = stripTimestampsForComparison(b);
  return JSON.stringify(sa) === JSON.stringify(sb);
}

export function generateExpectedPathChecks(
  paths: readonly string[],
  presentSet: ReadonlySet<string>
): { path: string; present: boolean }[] {
  return paths.map((p) => ({ path: p, present: presentSet.has(p) }));
}

export function generateForbiddenPathChecks(
  patterns: readonly string[],
  indexedPaths: readonly string[]
): { pathPattern: string; matched: boolean }[] {
  return patterns.map((pat) => ({
    pathPattern: pat,
    matched: indexedPaths.some((p) => {
      if (p === pat) return true;
      if (p.startsWith(pat + "/")) return true;
      if (p.includes("/" + pat + "/")) return true;
      const base = p.split("/").pop() ?? p;
      if (base === pat || base.startsWith(pat)) return true;
      return false;
    }),
  }));
}

export function buildGitComparison(input: {
  gitTrackedCount: number;
  cartographerIndexedCount: number;
  ignoredTrackedCount: number;
  unexplainedMissing: readonly string[];
  unexpectedIndexed: readonly string[];
}): z.infer<typeof GitComparisonSchema> {
  return GitComparisonSchema.parse({
    gitTrackedCount: input.gitTrackedCount,
    cartographerIndexedCount: input.cartographerIndexedCount,
    ignoredTrackedCount: input.ignoredTrackedCount,
    unexplainedMissing: [...input.unexplainedMissing],
    unexpectedIndexed: [...input.unexpectedIndexed],
  });
}

export function renderSelfScanReportMarkdown(report: CartographerSelfScanReport): string {
  const lines: string[] = [];
  lines.push(`# Cartographer Self-Scan Report`);
  lines.push(``);
  lines.push(`schemaVersion: ${report.schemaVersion}`);
  lines.push(`repoRoot: ${report.repoRoot}`);
  lines.push(`snapshotId: ${report.snapshotId}`);
  lines.push(`generatedAt: ${report.generatedAt}`);
  lines.push(``);
  lines.push(`## Counts`);
  lines.push(`- indexedFileCount: ${report.indexedFileCount}`);
  lines.push(`- ignoredFileCount: ${report.ignoredFileCount}`);
  lines.push(`- deletedFileCount: ${report.deletedFileCount}`);
  lines.push(`- changedFileCount: ${report.changedFileCount}`);
  lines.push(`- scanErrorCount: ${report.scanErrorCount}`);
  lines.push(``);
  lines.push(`## Expected Path Checks`);
  for (const c of sortExpectedPathChecks(report.expectedPathChecks)) {
    lines.push(`- ${c.path}: present: ${c.present}`);
  }
  lines.push(``);
  lines.push(`## Forbidden Path Checks`);
  for (const c of sortForbiddenPathChecks(report.forbiddenPathChecks)) {
    lines.push(`- ${c.pathPattern}: matched: ${c.matched}`);
  }
  lines.push(``);
  lines.push(`## Git Comparison`);
  const g = report.gitComparison;
  lines.push(`- gitTrackedCount: ${g.gitTrackedCount}`);
  lines.push(`- cartographerIndexedCount: ${g.cartographerIndexedCount}`);
  lines.push(`- ignoredTrackedCount: ${g.ignoredTrackedCount}`);
  lines.push(`- unexplainedMissing: [${g.unexplainedMissing.join(", ")}]`);
  lines.push(`- unexpectedIndexed: [${g.unexpectedIndexed.join(", ")}]`);
  lines.push(``);
  lines.push(`## Scan Error Summary`);
  if (report.scanErrors.length === 0) {
    lines.push(`(no scan errors)`);
  } else {
    for (const e of report.scanErrors) {
      lines.push(`- [${e.stage}] ${e.path}: ${e.message} (recoverable=${e.recoverable})`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}
