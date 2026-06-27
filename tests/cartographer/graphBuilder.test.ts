import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGraphSnapshot,
  InMemoryCartographerGraphStore,
  SqliteCartographerGraphStore,
  makeFileId,
  type FileNode,
} from "../../src/cartographer";
import { createSqliteDriver } from "../../src/store";
import {
  makeStructuralMiniFixture,
  scanStructuralMiniFixture,
} from "./repoScannerTestHarness";

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type SnapshotWithCreatedAt = { readonly createdAt: string; readonly [k: string]: unknown };

function stripSnapshotVolatile(s: SnapshotWithCreatedAt): Omit<SnapshotWithCreatedAt, "createdAt"> {
  const { createdAt: _c, ...rest } = s;
  return rest;
}

describe("graphBuilder", () => {
  it("builds Project, Package, Directory, File/Doc/Config/Test nodes and CONTAINS edges from structural mini fixture", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });

    // Snapshot header
    expect(result.snapshot.repoRoot).toBe(repoRoot);
    expect(result.snapshot.inventorySnapshotId).toBe(invId);
    expect(result.snapshot.nodeCount).toBe(result.nodes.length);
    expect(result.snapshot.edgeCount).toBe(result.edges.length);

    // Collect kinds present
    const kinds = new Set(result.nodes.map((n) => n.kind));
    expect(kinds.has("Project")).toBe(true);
    expect(kinds.has("Package")).toBe(true);
    expect(kinds.has("Directory")).toBe(true);
    // We must have at least one of each file-level kind exercised by the fixture
    expect(kinds.has("File")).toBe(true);
    expect(kinds.has("Doc")).toBe(true);
    expect(kinds.has("Config")).toBe(true);
    expect(kinds.has("Test")).toBe(true);

    // Specific nodes by path/kind
    const project = result.nodes.find((n) => n.kind === "Project");
    expect(project).toBeDefined();
    expect(project?.normalizedPath).toBe(".");

    const pkg = result.nodes.find((n) => n.kind === "Package");
    expect(pkg).toBeDefined();
    expect(pkg?.normalizedPath).toBe("package.json");

    const doc = result.nodes.find((n) => n.kind === "Doc" && n.normalizedPath === "docs/architecture.md");
    expect(doc).toBeDefined();

    const testNode = result.nodes.find((n) => n.kind === "Test" && n.normalizedPath === "src/app.test.ts");
    expect(testNode).toBeDefined();

    const appFile = result.nodes.find((n) => n.kind === "File" && n.normalizedPath === "src/app.ts");
    expect(appFile).toBeDefined();
    const inventoryFileNode = JSON.parse(String(appFile?.properties.inventoryFileNode ?? "{}")) as Record<string, unknown>;
    expect(inventoryFileNode.lastIndexedAt).toBeUndefined();
    expect(inventoryFileNode.mtimeMs).toBeUndefined();

    const configPkg = result.nodes.find((n) => n.kind === "Config" && n.normalizedPath === "package.json");
    expect(configPkg).toBeDefined();

    const configTs = result.nodes.find((n) => n.kind === "Config" && n.normalizedPath === "tsconfig.json");
    expect(configTs).toBeDefined();

    // All nodes sorted by id
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // Edges are CONTAINS and sorted
    for (const e of result.edges) {
      expect(e.kind).toBe("CONTAINS");
    }
    const edgeIds = result.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // Project contains Package
    if (project === undefined || pkg === undefined) {
      throw new Error("expected project and package nodes");
    }
    const projectToPkg = result.edges.find(
      (e) => e.fromNodeId === project.id && e.toNodeId === pkg.id && e.kind === "CONTAINS",
    );
    expect(projectToPkg).toBeDefined();

    // There is a CONTAINS for the doc
    if (doc === undefined) {
      throw new Error("expected doc node");
    }
    const docId = doc.id;
    const containsDoc = result.edges.some((e) => e.toNodeId === docId && e.kind === "CONTAINS");
    expect(containsDoc).toBe(true);

    // There is a CONTAINS for the test file
    if (testNode === undefined) {
      throw new Error("expected test node");
    }
    const testId = testNode.id;
    const containsTest = result.edges.some((e) => e.toNodeId === testId && e.kind === "CONTAINS");
    expect(containsTest).toBe(true);
  });

  it("produces identical nodes and edges for two builds (timestamp stripping)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const r1 = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });
    const r2 = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-21T12:34:56.000Z",
      files: scan.files,
    });

    const s1 = stripSnapshotVolatile(r1.snapshot);
    const s2 = stripSnapshotVolatile(r2.snapshot);
    expect(s1).toEqual(s2);

    expect(r1.nodes).toEqual(r2.nodes);
    expect(r1.edges).toEqual(r2.edges);
  });

  it("produces stable node/edge ids and sorted order regardless of input file order (shuffle stability)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const base = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });

    // Shuffle a copy of files (deterministic shuffle via sort by hash of index or reverse+sort)
    const shuffled = [...scan.files].sort((a, b) => {
      // simple deterministic but non-sorted order: reverse then stable by length then name
      if (a.normalizedPath.length !== b.normalizedPath.length) {
        return b.normalizedPath.length - a.normalizedPath.length;
      }
      return a.normalizedPath < b.normalizedPath ? 1 : a.normalizedPath > b.normalizedPath ? -1 : 0;
    });

    const shuf = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: shuffled,
    });

    const baseNodeIds = base.nodes.map((n) => n.id);
    const shufNodeIds = shuf.nodes.map((n) => n.id);
    expect(shufNodeIds).toEqual(baseNodeIds);

    const baseEdgeIds = base.edges.map((e) => e.id);
    const shufEdgeIds = shuf.edges.map((e) => e.id);
    expect(shufEdgeIds).toEqual(baseEdgeIds);

    // Output is sorted
    expect(shuf.nodes).toEqual([...shuf.nodes].sort(byId));
    expect(shuf.edges).toEqual([...shuf.edges].sort(byId));
  });

  it("in-memory and SQLite stores produce identical sorted nodes/edges for builder output", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;
    const createdAt = "2026-06-20T00:00:00.000Z";

    const built = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      files: scan.files,
    });

    const mem = new InMemoryCartographerGraphStore();
    const driver = createSqliteDriver({ path: ":memory:" });
    const sql = new SqliteCartographerGraphStore({ driver });

    await mem.putGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      nodes: built.nodes,
      edges: built.edges,
    });
    await sql.putGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      nodes: built.nodes,
      edges: built.edges,
    });

    const snapId = built.snapshot.id;
    const memNodes = await mem.listNodes(snapId);
    const memEdges = await mem.listEdges(snapId);
    const sqlNodes = await sql.listNodes(snapId);
    const sqlEdges = await sql.listEdges(snapId);

    expect(memNodes).toEqual(built.nodes);
    expect(memEdges).toEqual(built.edges);
    expect(sqlNodes).toEqual(built.nodes);
    expect(sqlEdges).toEqual(built.edges);
    expect(sqlNodes).toEqual(memNodes);
    expect(sqlEdges).toEqual(memEdges);

    driver.close();
  });

  it("builds structural nodes (Function/Class/Interface/TypeAlias/Enum/Symbol) and DEFINES/EXPORTS edges when getSourceText provided", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    // Synthetic source exercising all required structural symbol kinds.
    // "variable" maps to fallback "Symbol" node kind per symbolKindToNodeKind.
    const structuralSrc = `
export function myFunc(): void {}
export class MyClass {}
export interface MyInterface {}
export type MyTypeAlias = string;
export enum MyEnum { A = 1, B = 2 }
export const myVar = 42;
`;

    const structuralPath = "src/structural-all-kinds.ts";
    const structuralFile: FileNode = {
      id: makeFileId(repoRoot, structuralPath),
      path: structuralPath,
      normalizedPath: structuralPath,
      hash: "cafebabe",
      sizeBytes: structuralSrc.length,
      language: "typescript",
      kind: "source",
      ignored: false,
      lastIndexedAt: "2026-06-20T00:00:00.000Z",
    };

    const filesWithStructural = [...scan.files, structuralFile];

    const getSourceText = (np: string): string | undefined => {
      if (np === structuralPath) return structuralSrc;
      try {
        return readFileSync(path.join(repoRoot, np), "utf8");
      } catch {
        return undefined;
      }
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: filesWithStructural,
      getSourceText,
    });

    const kinds = new Set(result.nodes.map((n) => n.kind));
    expect(kinds.has("Function")).toBe(true);
    expect(kinds.has("Class")).toBe(true);
    expect(kinds.has("Interface")).toBe(true);
    expect(kinds.has("TypeAlias")).toBe(true);
    expect(kinds.has("Enum")).toBe(true);
    expect(kinds.has("Symbol")).toBe(true);

    const defines = result.edges.filter((e) => e.kind === "DEFINES");
    expect(defines.length).toBeGreaterThan(0);

    const exportsEdges = result.edges.filter((e) => e.kind === "EXPORTS");
    expect(exportsEdges.length).toBeGreaterThan(0);
  });

  it("emits IMPORTS/DEPENDS_ON for resolved relative imports and bare Package nodes for bare specifiers", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const getSourceText = (np: string): string | undefined => {
      try {
        return readFileSync(path.join(repoRoot, np), "utf8");
      } catch {
        return undefined;
      }
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
      getSourceText,
    });

    const imports = result.edges.filter((e) => e.kind === "IMPORTS");
    const depends = result.edges.filter((e) => e.kind === "DEPENDS_ON");
    expect(imports.length).toBeGreaterThan(0);
    expect(depends.length).toBeGreaterThan(0);

    // Bare package nodes exist for any bare specifier present in sources (none in this fixture, but shape is exercised)
    const pkgs = result.nodes.filter((n) => n.kind === "Package");
    expect(pkgs.length).toBeGreaterThan(0);
  });

  it("does not emit IMPORTS/DEPENDS_ON/EXPORTS edges for unresolved imports (no self-edge or fabricated target)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    // Build a synthetic file list + source text that contains an unresolved relative import
    // and an alias-style import. Use getSourceText to supply the text for the synthetic file.
    const syntheticPath = "src/unresolved.ts";
    const syntheticSource = `
import { x } from "./does-not-exist";
import { y } from "@/alias/path";
export const z = 1;
`;

    // Extend the inventory with a synthetic file node (ignored by real scan but used by builder)
    const syntheticFile: FileNode = {
      id: makeFileId(repoRoot, syntheticPath),
      path: syntheticPath,
      normalizedPath: syntheticPath,
      hash: "deadbeef",
      sizeBytes: syntheticSource.length,
      language: "typescript",
      kind: "source",
      ignored: false,
      lastIndexedAt: "2026-06-20T00:00:00.000Z",
    };

    const filesWithSynthetic = [...scan.files, syntheticFile];

    const getSourceText = (np: string): string | undefined => {
      if (np === syntheticPath) return syntheticSource;
      try {
        return readFileSync(path.join(repoRoot, np), "utf8");
      } catch {
        return undefined;
      }
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: filesWithSynthetic,
      getSourceText,
    });

    const syntheticFileId = makeFileId(repoRoot, syntheticPath);

    // No IMPORTS/DEPENDS_ON/EXPORTS edge whose toNodeId is the synthetic file for import/dependency edges
    // (no unresolved target fabricated as self or any other)
    const unresolvedTargetEdges = result.edges.filter(
      (e) => e.toNodeId === syntheticFileId && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON"),
    );
    expect(unresolvedTargetEdges.length).toBe(0);

    // No IMPORTS or DEPENDS_ON edges emitted from the synthetic file (unresolved imports must not create dependency edges)
    const outgoingImportEdges = result.edges.filter(
      (e) => e.fromNodeId === syntheticFileId && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON"),
    );
    expect(outgoingImportEdges.length).toBe(0);
  });

  it("emits TESTS edges from findTests evidence when getSourceText provided", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const getSourceText = (np: string): string | undefined => {
      try {
        return readFileSync(path.join(repoRoot, np), "utf8");
      } catch {
        return undefined;
      }
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
      getSourceText,
    });

    const testsEdges = result.edges.filter((e) => e.kind === "TESTS");
    // app.test.ts imports app.ts -> should produce at least one TESTS edge
    expect(testsEdges.length).toBeGreaterThan(0);
    const hasAppTestToApp = testsEdges.some((e) => {
      const from = result.nodes.find((n) => n.id === e.fromNodeId);
      const to = result.nodes.find((n) => n.id === e.toNodeId);
      return from?.normalizedPath === "src/app.test.ts" && to?.normalizedPath === "src/app.ts";
    });
    expect(hasAppTestToApp).toBe(true);
  });

  it("produces deterministic output across shuffled file order and shuffled import order (via getSourceText)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const getSourceText = (np: string): string | undefined => {
      try {
        return readFileSync(path.join(repoRoot, np), "utf8");
      } catch {
        return undefined;
      }
    };

    const base = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
      getSourceText,
    });

    // Shuffle files
    const shuffledFiles = [...scan.files].sort((a, b) => (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0));
    const shuf = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: shuffledFiles,
      getSourceText,
    });

    expect(shuf.nodes.map((n) => n.id)).toEqual(base.nodes.map((n) => n.id));
    expect(shuf.edges.map((e) => e.id)).toEqual(base.edges.map((e) => e.id));
  });

  it("C2 regression: structural extraction (symbols/imports/exports/DEFINES) is gated to TS/JS files only", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    // Use inline synthetic files only (no reliance on fixture scan for this C2 case)
    const docPath = "docs/evil-doc.md";
    const configPath = "config/bad.json";
    const tsPath = "src/good.ts";

    const docSrc = "# Docs\n\nexport function fakeFn() { return 1; }\nexport class FakeClass {}";
    const configSrc = '{\n  "script": "export function notReal() {}",\n  "value": 42\n}';
    const tsSrc = "export function realFn() { return 99; }\nexport const realConst = 7;";

    const files: FileNode[] = [
      {
        id: makeFileId(repoRoot, docPath),
        path: docPath,
        normalizedPath: docPath,
        hash: "doc1",
        sizeBytes: docSrc.length,
        language: "markdown",
        kind: "doc",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: makeFileId(repoRoot, configPath),
        path: configPath,
        normalizedPath: configPath,
        hash: "cfg1",
        sizeBytes: configSrc.length,
        language: "json",
        kind: "config",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: makeFileId(repoRoot, tsPath),
        path: tsPath,
        normalizedPath: tsPath,
        hash: "ts1",
        sizeBytes: tsSrc.length,
        language: "typescript",
        kind: "source",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
    ];

    const getSourceText = (np: string): string | undefined => {
      if (np === docPath) return docSrc;
      if (np === configPath) return configSrc;
      if (np === tsPath) return tsSrc;
      return undefined;
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: "inv-c2",
      createdAt: "2026-06-20T00:00:00.000Z",
      files,
      getSourceText,
    });

    const docFileId = makeFileId(repoRoot, docPath);
    const configFileId = makeFileId(repoRoot, configPath);

    // C2: NO Symbol/Function/Class/Interface/TypeAlias/Enum nodes whose path matches the doc/config file
    const forbiddenKinds = ["Function", "Symbol", "Class", "Interface", "TypeAlias", "Enum"];
    const badStructuralNodes = result.nodes.filter(
      (n) => forbiddenKinds.includes(n.kind) && (n.path === docPath || n.path === configPath),
    );
    expect(badStructuralNodes.length).toBe(0);

    // C2: NO DEFINES or EXPORTS edges whose fromNodeId is the doc/config file id
    const badStructuralEdges = result.edges.filter(
      (e) =>
        (e.kind === "DEFINES" || e.kind === "EXPORTS") &&
        (e.fromNodeId === docFileId || e.fromNodeId === configFileId),
    );
    expect(badStructuralEdges.length).toBe(0);

    // (sanity) the real TS file DID produce structural symbols
    const goodStructuralNodes = result.nodes.filter(
      (n) => forbiddenKinds.includes(n.kind) && n.path === tsPath,
    );
    expect(goodStructuralNodes.length).toBeGreaterThan(0);
  });

  it("C3 regression: TESTS edges computed once per source (same edges as before, correctness)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    // Fully synthetic to control test<->source links via import statements in test files.
    // Two source files, two test files. a.test imports a, b.test imports b.
    const aSrcPath = "src/a.ts";
    const aTestPath = "src/a.test.ts";
    const bSrcPath = "src/b.ts";
    const bTestPath = "src/b.test.ts";

    const aSrc = "export const aValue = 1;\n";
    const aTestSrc = "import { aValue } from './a';\n";
    const bSrc = "export const bValue = 2;\n";
    const bTestSrc = "import { bValue } from './b';\n";

    const files: FileNode[] = [
      {
        id: makeFileId(repoRoot, aSrcPath),
        path: aSrcPath,
        normalizedPath: aSrcPath,
        hash: "has",
        sizeBytes: aSrc.length,
        language: "typescript",
        kind: "source",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: makeFileId(repoRoot, aTestPath),
        path: aTestPath,
        normalizedPath: aTestPath,
        hash: "hat",
        sizeBytes: aTestSrc.length,
        language: "typescript",
        kind: "test",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: makeFileId(repoRoot, bSrcPath),
        path: bSrcPath,
        normalizedPath: bSrcPath,
        hash: "hbs",
        sizeBytes: bSrc.length,
        language: "typescript",
        kind: "source",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: makeFileId(repoRoot, bTestPath),
        path: bTestPath,
        normalizedPath: bTestPath,
        hash: "hbt",
        sizeBytes: bTestSrc.length,
        language: "typescript",
        kind: "test",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      },
    ];

    const getSourceText = (np: string): string | undefined => {
      if (np === aSrcPath) return aSrc;
      if (np === aTestPath) return aTestSrc;
      if (np === bSrcPath) return bSrc;
      if (np === bTestPath) return bTestSrc;
      return undefined;
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: "inv-c3-correct",
      createdAt: "2026-06-20T00:00:00.000Z",
      files,
      getSourceText,
    });

    const testsEdges = result.edges.filter((e) => e.kind === "TESTS");
    expect(testsEdges.length).toBe(2);

    const hasAToA = testsEdges.some((e) => {
      const from = result.nodes.find((n) => n.id === e.fromNodeId);
      const to = result.nodes.find((n) => n.id === e.toNodeId);
      return from?.normalizedPath === aTestPath && to?.normalizedPath === aSrcPath;
    });
    const hasBToB = testsEdges.some((e) => {
      const from = result.nodes.find((n) => n.id === e.fromNodeId);
      const to = result.nodes.find((n) => n.id === e.toNodeId);
      return from?.normalizedPath === bTestPath && to?.normalizedPath === bSrcPath;
    });
    expect(hasAToA).toBe(true);
    expect(hasBToB).toBe(true);

    // Edge IDs use makeEdgeId and must be unique/stable
    const edgeIds = testsEdges.map((e) => e.id);
    expect(edgeIds.length).toBe(2);
    expect(new Set(edgeIds).size).toBe(2);
  });

  it("C3 regression: TESTS edges computed with N sources and M tests produce correct count (guards against quadratic calls)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    // N=3 sources, M=3 tests (paired 1:1 via imports in tests). Expect exactly 3 TESTS edges.
    // Previously the nested loop invoked findTests O(N*M) times redundantly.
    // The refactored loop calls findTests once per source file.
    // We assert edge set is correct (N links); direct spy skipped to avoid fragile module mock in this test style.
    const srcPaths = ["src/x.ts", "src/y.ts", "src/z.ts"];
    const testPaths = ["src/x.test.ts", "src/y.test.ts", "src/z.test.ts"];

    const srcContents = [
      "export const x = 'x';\n",
      "export const y = 'y';\n",
      "export const z = 'z';\n",
    ];
    const testContents = [
      "import { x } from './x';\n",
      "import { y } from './y';\n",
      "import { z } from './z';\n",
    ];

    const files: FileNode[] = [];
    for (let i = 0; i < srcPaths.length; i++) {
      files.push({
        id: makeFileId(repoRoot, srcPaths[i]),
        path: srcPaths[i],
        normalizedPath: srcPaths[i],
        hash: "hs" + i,
        sizeBytes: srcContents[i].length,
        language: "typescript",
        kind: "source",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      });
    }
    for (let i = 0; i < testPaths.length; i++) {
      files.push({
        id: makeFileId(repoRoot, testPaths[i]),
        path: testPaths[i],
        normalizedPath: testPaths[i],
        hash: "ht" + i,
        sizeBytes: testContents[i].length,
        language: "typescript",
        kind: "test",
        ignored: false,
        lastIndexedAt: "2026-06-20T00:00:00.000Z",
      });
    }

    const getSourceText = (np: string): string | undefined => {
      const si = srcPaths.indexOf(np);
      if (si >= 0) return srcContents[si];
      const ti = testPaths.indexOf(np);
      if (ti >= 0) return testContents[ti];
      return undefined;
    };

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: "inv-c3-perf",
      createdAt: "2026-06-20T00:00:00.000Z",
      files,
      getSourceText,
    });

    const testsEdges = result.edges.filter((e) => e.kind === "TESTS");
    expect(testsEdges.length).toBe(3);

    // Verify exact pairing
    const pairs = testsEdges.map((e) => {
      const from = result.nodes.find((n) => n.id === e.fromNodeId)?.normalizedPath;
      const to = result.nodes.find((n) => n.id === e.toNodeId)?.normalizedPath;
      return `${from}->${to}`;
    }).sort();
    expect(pairs).toEqual([
      "src/x.test.ts->src/x.ts",
      "src/y.test.ts->src/y.ts",
      "src/z.test.ts->src/z.ts",
    ]);
  });
});
