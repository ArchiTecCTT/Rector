import { describe, expect, it } from "vitest";
import {
  CartographerSelfScanReportSchema,
  CleanSelfScanReportSchema,
  type CartographerSelfScanReport,
  stripTimestampsForComparison,
  selfScanReportsEqualAfterTimestampStrip,
  sortExpectedPathChecks,
  sortForbiddenPathChecks,
  generateExpectedPathChecks,
  generateForbiddenPathChecks,
  buildGitComparison,
  renderSelfScanReportMarkdown,
  SELF_SCAN_SCHEMA_VERSION,
} from "../../src/cartographer/selfScanReport";

const baseReport = {
  schemaVersion: "rector.cartographer.selfScan.v1",
  repoRoot: "/repo",
  snapshotId: "snap-1",
  generatedAt: "2026-06-26T12:00:00.000Z",
  indexedFileCount: 10,
  ignoredFileCount: 2,
  deletedFileCount: 0,
  changedFileCount: 1,
  scanErrorCount: 0,
  expectedPathChecks: [
    { path: "src/cartographer", present: true },
    { path: "src/orchestration", present: true },
  ],
  forbiddenPathChecks: [
    { pathPattern: "node_modules", matched: false },
    { pathPattern: ".env", matched: false },
  ],
  gitComparison: {
    gitTrackedCount: 12,
    cartographerIndexedCount: 10,
    ignoredTrackedCount: 2,
    unexplainedMissing: [],
    unexpectedIndexed: [],
  },
  scanErrors: [],
} satisfies CartographerSelfScanReport;

describe("Cartographer self-scan report (Todo 6)", () => {
  it("parses a valid report via schema and exposes schema version constant", () => {
    const parsed = CartographerSelfScanReportSchema.parse(baseReport);
    expect(parsed.schemaVersion).toBe(SELF_SCAN_SCHEMA_VERSION);
    expect(parsed.indexedFileCount).toBe(10);
    expect(SELF_SCAN_SCHEMA_VERSION).toBe("rector.cartographer.selfScan.v1");
  });

  it("rejects wrong schema version at parse time", () => {
    const bad = { ...baseReport, schemaVersion: "rector.cartographer.selfScan.v0" };
    const result = CartographerSelfScanReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects via Clean schema when a forbidden path check reports a hit", () => {
    const hitFixture = {
      ...baseReport,
      forbiddenPathChecks: [{ pathPattern: "node_modules", matched: true }],
      scanErrorCount: 0,
    };
    const result = CleanSelfScanReportSchema.safeParse(hitFixture);
    expect(result.success).toBe(false);
  });

  it("rejects via Clean schema when scanErrorCount is nonzero", () => {
    const errFixture = { ...baseReport, scanErrorCount: 1, scanErrors: [{ path: "x", stage: "read", message: "boom", recoverable: true }] };
    const result = CleanSelfScanReportSchema.safeParse(errFixture);
    expect(result.success).toBe(false);
  });

  it("rejects via base and Clean schemas when scanErrorCount disagrees with scanErrors list", () => {
    const mismatch: CartographerSelfScanReport = {
      ...baseReport,
      scanErrorCount: 0,
      scanErrors: [{ path: "x", stage: "read", message: "boom", recoverable: true }],
    };
    expect(CartographerSelfScanReportSchema.safeParse(mismatch).success).toBe(false);
    expect(CleanSelfScanReportSchema.safeParse(mismatch).success).toBe(false);
  });

  it("sorts expected path checks and forbidden path checks using deterministic UTF-16 order", () => {
    const unsortedExpected = [
      { path: "src/z", present: true },
      { path: "src/a", present: false },
    ];
    const sortedExpected = sortExpectedPathChecks(unsortedExpected);
    expect(sortedExpected.map((c: { path: string }) => c.path)).toEqual(["src/a", "src/z"]);

    const unsortedForbidden = [
      { pathPattern: "zzz", matched: false },
      { pathPattern: "aaa", matched: false },
    ];
    const sortedForbidden = sortForbiddenPathChecks(unsortedForbidden);
    expect(sortedForbidden.map((c: { pathPattern: string }) => c.pathPattern)).toEqual(["aaa", "zzz"]);
  });

  it("strips generatedAt for deterministic comparison and reports equality after stripping", () => {
    const a = { ...baseReport, generatedAt: "2026-06-26T12:00:00.000Z" };
    const b = { ...baseReport, generatedAt: "2026-06-26T13:00:00.000Z" };
    expect(selfScanReportsEqualAfterTimestampStrip(a, b)).toBe(true);
    const stripped = stripTimestampsForComparison(a);
    expect(stripped.generatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("generates expected path checks from a list of paths and a presence set (pure, no FS)", () => {
    const checks = generateExpectedPathChecks(["src/a", "src/b", "src/c"], new Set(["src/a", "src/c"]));
    expect(checks).toEqual([
      { path: "src/a", present: true },
      { path: "src/b", present: false },
      { path: "src/c", present: true },
    ]);
  });

  it("generates forbidden path checks from patterns and indexed paths (pure, no FS)", () => {
    const indexed = ["src/index.ts", "node_modules/pkg/index.js", ".env.local"];
    const checks = generateForbiddenPathChecks(["node_modules", ".env", ".git"], indexed);
    expect(checks.find((c: { pathPattern: string; matched: boolean }) => c.pathPattern === "node_modules")?.matched).toBe(true);
    expect(checks.find((c: { pathPattern: string; matched: boolean }) => c.pathPattern === ".env")?.matched).toBe(true);
    expect(checks.find((c: { pathPattern: string; matched: boolean }) => c.pathPattern === ".git")?.matched).toBe(false);
    const gitignoreOnly = generateForbiddenPathChecks([".git"], [".gitignore", "src/.gitignore"]);
    expect(gitignoreOnly.every((c) => !c.matched)).toBe(true);
  });

  it("builds a git comparison structure from raw counts and lists", () => {
    const comp = buildGitComparison({
      gitTrackedCount: 5,
      cartographerIndexedCount: 4,
      ignoredTrackedCount: 1,
      unexplainedMissing: ["src/missing.ts"],
      unexpectedIndexed: [],
    });
    expect(comp).toEqual({
      gitTrackedCount: 5,
      cartographerIndexedCount: 4,
      ignoredTrackedCount: 1,
      unexplainedMissing: ["src/missing.ts"],
      unexpectedIndexed: [],
    });
  });

  it("renders markdown that includes counts, expected checks, forbidden checks, git comparison, and scan error summary", () => {
    const reportWithError = {
      ...baseReport,
      scanErrorCount: 1,
      scanErrors: [{ path: "src/bad.ts", stage: "read" as const, message: "permission denied", recoverable: true }],
    };
    const md = renderSelfScanReportMarkdown(reportWithError);
    expect(md).toContain("schemaVersion: rector.cartographer.selfScan.v1");
    expect(md).toContain("indexedFileCount: 10");
    expect(md).toContain("ignoredFileCount: 2");
    expect(md).toContain("src/cartographer");
    expect(md).toContain("present: true");
    expect(md).toContain("node_modules");
    expect(md).toContain("matched: false");
    expect(md).toContain("gitTrackedCount: 12");
    expect(md).toContain("cartographerIndexedCount: 10");
    expect(md).toContain("scanErrorCount: 1");
    expect(md).toContain("src/bad.ts");
    expect(md).toContain("permission denied");
  });
});
