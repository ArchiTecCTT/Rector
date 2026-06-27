import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRepoRootHash,
  makeProjectId,
  makePackageId,
  makeDirectoryId,
  makeFileId,
  makeSymbolId,
  makeToolId,
  makeCapabilityId,
  makeGraphSnapshotId,
  makeEdgeId,
  makeImportEdgeId,
  makeDefinesEdgeId,
  normalizePath,
} from "../../src/cartographer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const graphIdsSourcePath = path.resolve(__dirname, "../../src/cartographer/graphIds.ts");

describe("deterministic graph ID policy (Todo 12)", () => {
  it("exports normalizePath and computeRepoRootHash helpers", () => {
    expect(typeof normalizePath).toBe("function");
    expect(typeof computeRepoRootHash).toBe("function");
  });

  it("produces stable project IDs for equivalent repo roots (win/posix)", () => {
    const idPosix = makeProjectId("/repo/root");
    const idWin = makeProjectId("C:\\repo\\root");
    const idMixed = makeProjectId("C:/repo/root");
    expect(idPosix).toMatch(/^project:[0-9a-f]{64}$/);
    // Different roots produce different hashes (expected)
    expect(idPosix).not.toBe(idWin);
    // Same logical root string after sep norm must match
    const idWinNorm = makeProjectId("C:\\repo\\root");
    const idPosixSame = makeProjectId("C:/repo/root");
    expect(idWinNorm).toBe(idPosixSame);
  });

  it("produces identical IDs on repeated calls", () => {
    const r = "/repo";
    const p = "src/index.ts";
    expect(makeFileId(r, p)).toBe(makeFileId(r, p));
    expect(makeSymbolId(r, p, true, "foo", 42)).toBe(makeSymbolId(r, p, true, "foo", 42));
    expect(makeEdgeId("CONTAINS", "a", "b")).toBe(makeEdgeId("CONTAINS", "a", "b"));
  });

  it("normalizes POSIX and Windows-style paths to same file/dir IDs for equivalent paths", () => {
    const r = "/repo";
    const id1 = makeFileId(r, "src/foo/bar.ts");
    const id2 = makeFileId(r, "src\\foo\\bar.ts");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^file:[0-9a-f]{64}:src\/foo\/bar\.ts$/);

    const d1 = makeDirectoryId(r, "src/utils");
    const d2 = makeDirectoryId(r, "src\\utils");
    expect(d1).toBe(d2);

    const rootFile1 = makeFileId(r, "package.json");
    const rootFile2 = makeFileId(r, ".\\package.json");
    expect(rootFile1).toBe(rootFile2);
  });

  it("repo root normalization affects hash consistently across separator styles", () => {
    const h1 = computeRepoRootHash("/repo/root");
    const h2 = computeRepoRootHash("C:\\repo\\root");
    const h3 = computeRepoRootHash("C:/repo/root");
    expect(h1).not.toBe(h2); // different roots
    expect(h2).toBe(h3);
  });

  it("changed symbol start line produces different symbol ID", () => {
    const r = "/repo";
    const p = "src/lib.ts";
    const s1 = makeSymbolId(r, p, true, "handler", 10);
    const s2 = makeSymbolId(r, p, true, "handler", 11);
    const s3 = makeSymbolId(r, p, false, "handler", 10);
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(s3);
    expect(s1).toMatch(/^symbol:[0-9a-f]{64}:src\/lib\.ts:export:handler:10$/);
    expect(s3).toMatch(/^symbol:[0-9a-f]{64}:src\/lib\.ts:local:handler:10$/);
  });

  it("produces package, tool, and capability IDs with stable prefixes", () => {
    const r = "/repo";
    const pkg1 = makePackageId(r, ".");
    const pkg2 = makePackageId(r, "packages/core");
    expect(pkg1).toMatch(/^package:[0-9a-f]{64}:\.$/);
    expect(pkg2).toMatch(/^package:[0-9a-f]{64}:packages\/core$/);
    expect(pkg1).toBe(makePackageId(r, "."));

    const t1 = makeToolId("git-commit");
    const t2 = makeToolId("git-commit");
    expect(t1).toBe("tool:git-commit");
    expect(t1).toBe(t2);

    const c1 = makeCapabilityId("code-edit");
    expect(c1).toBe("capability:code-edit");
  });

  it("graph snapshot ID is deterministic and does not embed wall time", () => {
    const r = "/repo";
    const inv = "snap:deadbeef:abc123";
    const s1 = makeGraphSnapshotId(r, inv);
    const s2 = makeGraphSnapshotId(r, inv);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^snapshot:[0-9a-f]{64}:snap:deadbeef:abc123$/);
    // different inventory id -> different snapshot id
    expect(makeGraphSnapshotId(r, "snap:other")).not.toBe(s1);
  });

  it("edge IDs change when kind/from/to change and are deterministic", () => {
    const e1 = makeEdgeId("CONTAINS", "file:dead:src/a.ts", "dir:dead:src");
    const e2 = makeEdgeId("CONTAINS", "file:dead:src/a.ts", "dir:dead:src");
    const e3 = makeEdgeId("DEFINES", "file:dead:src/a.ts", "dir:dead:src");
    const e4 = makeEdgeId("CONTAINS", "file:dead:src/b.ts", "dir:dead:src");
    expect(e1).toBe(e2);
    expect(e1).not.toBe(e3);
    expect(e1).not.toBe(e4);
    expect(e1).toMatch(/^edge:CONTAINS:file:dead:src\/a\.ts:dir:dead:src$/);

    const imp = makeImportEdgeId("file:dead:src/a.ts", "@foo/bar");
    expect(imp).toBe("edge:IMPORTS:file:dead:src/a.ts:@foo/bar");

    const def = makeDefinesEdgeId("file:dead:src/a.ts", "symbol:dead:src/a.ts:export:foo:5");
    expect(def).toMatch(/^edge:DEFINES:file:dead:src\/a\.ts:symbol:dead:src\/a\.ts:export:foo:5$/);
  });

  it("source file contains no random UUID or timestamp ID sources", () => {
    const source = fs.readFileSync(graphIdsSourcePath, "utf8");
    expect(source).not.toMatch(/randomUUID|crypto\.randomUUID/);
    expect(source.includes("Math.random(")).toBe(false);
    // time may exist for other things (e.g. now in other modules), but must not be used as ID source
    // we assert the ID factories do not reference Date.now or new Date in their construction
    // by scanning for direct use in id expressions is hard; instead ensure no obvious non-deterministic in this file
    expect(source).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    // also no uuid import patterns
    expect(source).not.toMatch(/from ["']uuid["']|require\(["']uuid["']\)/);
  });

  it("normalizePath handles mixed separators and redundant slashes", () => {
    expect(normalizePath("src\\foo//bar.ts")).toBe("src/foo/bar.ts");
    expect(normalizePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath("/")).toBe(".");
    expect(normalizePath("C:\\\\repo\\\\")).toBe("C:/repo");
  });
});
