import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CartographerQueryService,
  buildGraphSnapshot,
  type CartographerGraphNode,
  type CartographerGraphEdge,
} from "../../src/cartographer";
import {
  makeStructuralMiniFixture,
  scanStructuralMiniFixture,
} from "./repoScannerTestHarness";

async function buildStructuralGraphWithSources() {
  const repoRoot = await makeStructuralMiniFixture();
  const scan = await scanStructuralMiniFixture();
  const invId = scan.snapshot.id;

  const getSourceText = (normalizedPath: string): string | undefined => {
    try {
      const abs = path.join(repoRoot, normalizedPath);
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  };

  const built = await buildGraphSnapshot({
    repoRoot,
    inventorySnapshotId: invId,
    createdAt: "2026-06-20T00:00:00.000Z",
    files: scan.files,
    getSourceText,
  });

  return {
    repoRoot,
    nodes: built.nodes,
    edges: built.edges,
    snapshotId: built.snapshot.id,
    inventoryFiles: scan.files,
  };
}

function makeMinimalGraphWithDuplicates(): { nodes: CartographerGraphNode[]; edges: CartographerGraphEdge[] } {
  const nodes: CartographerGraphNode[] = [
    {
      id: "file:abc:src/a.ts",
      snapshotId: "snap:1",
      kind: "File",
      label: "a.ts",
      path: "src/a.ts",
      normalizedPath: "src/a.ts",
      properties: {},
    },
    {
      id: "file:abc:src/b.ts",
      snapshotId: "snap:1",
      kind: "File",
      label: "b.ts",
      path: "src/b.ts",
      normalizedPath: "src/b.ts",
      properties: {},
    },
    {
      id: "symbol:abc:src/a.ts:export:Helper:1",
      snapshotId: "snap:1",
      kind: "Function",
      label: "Helper",
      path: "src/a.ts",
      normalizedPath: "src/a.ts",
      symbolName: "Helper",
      symbolKind: "function",
      startLine: 1,
      properties: { isExported: true },
    },
    {
      id: "symbol:abc:src/b.ts:export:Helper:5",
      snapshotId: "snap:1",
      kind: "Function",
      label: "Helper",
      path: "src/b.ts",
      normalizedPath: "src/b.ts",
      symbolName: "Helper",
      symbolKind: "function",
      startLine: 5,
      properties: { isExported: true },
    },
  ];
  const edges: CartographerGraphEdge[] = [];
  return { nodes, edges };
}

function makeGraphWithDeps(): { nodes: CartographerGraphNode[]; edges: CartographerGraphEdge[] } {
  const f1 = {
    id: "file:abc:src/app.ts",
    snapshotId: "s1",
    kind: "File" as const,
    label: "app.ts",
    path: "src/app.ts",
    normalizedPath: "src/app.ts",
    properties: {},
  };
  const f2 = {
    id: "file:abc:src/lib.ts",
    snapshotId: "s1",
    kind: "File" as const,
    label: "lib.ts",
    path: "src/lib.ts",
    normalizedPath: "src/lib.ts",
    properties: {},
  };
  const eImp = {
    id: "edge:IMPORTS:file:abc:src/app.ts:./lib",
    snapshotId: "s1",
    kind: "IMPORTS" as const,
    fromNodeId: f1.id,
    toNodeId: f2.id,
    properties: { specifier: "./lib" },
  };
  const eDep = {
    id: "edge:DEPENDS_ON:file:abc:src/app.ts:file:abc:src/lib.ts",
    snapshotId: "s1",
    kind: "DEPENDS_ON" as const,
    fromNodeId: f1.id,
    toNodeId: f2.id,
    properties: {},
  };
  return { nodes: [f1, f2], edges: [eImp, eDep] };
}

function makeGraphWithTests(): { nodes: CartographerGraphNode[]; edges: CartographerGraphEdge[] } {
  const src = {
    id: "file:abc:src/app.ts",
    snapshotId: "s1",
    kind: "File" as const,
    label: "app.ts",
    path: "src/app.ts",
    normalizedPath: "src/app.ts",
    properties: {},
  };
  const tst = {
    id: "file:abc:src/app.test.ts",
    snapshotId: "s1",
    kind: "Test" as const,
    label: "app.test.ts",
    path: "src/app.test.ts",
    normalizedPath: "src/app.test.ts",
    properties: {},
  };
  const eTest = {
    id: "edge:TESTS:file:abc:src/app.test.ts:file:abc:src/app.ts",
    snapshotId: "s1",
    kind: "TESTS" as const,
    fromNodeId: tst.id,
    toNodeId: src.id,
    properties: { relation: "import" },
    evidence: { path: "src/app.test.ts", text: "import" },
  };
  return { nodes: [src, tst], edges: [eTest] };
}

function makeGraphWithRule(): { nodes: CartographerGraphNode[]; edges: CartographerGraphEdge[] } {
  const rule = {
    id: "rule:abc:arch:1",
    snapshotId: "s1",
    kind: "Rule" as const,
    label: "no-direct-db",
    path: "docs/architecture.md",
    normalizedPath: "docs/architecture.md",
    properties: {},
  };
  return { nodes: [rule], edges: [] };
}

describe("CartographerQueryService (Todo 22)", () => {
  it("rejects absolute paths with invalid_input", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r = await svc.getFile({ normalizedPath: "/etc/passwd" });
    expect(r.status).toBe("invalid_input");
    if (r.status === "invalid_input") {
      expect(r.reason).toMatch(/absolute/);
    }
  });

  it("rejects path traversal with invalid_input", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r1 = await svc.getFile({ normalizedPath: "../package.json" });
    expect(r1.status).toBe("invalid_input");
    const r2 = await svc.getFile({ normalizedPath: "src/../../secret.ts" });
    expect(r2.status).toBe("invalid_input");
  });

  it("getFile falls back when inventoryFileNode JSON is malformed", async () => {
    const fileNode: CartographerGraphNode = {
      id: "file:abc:src/broken.ts",
      snapshotId: "s1",
      kind: "File",
      label: "broken.ts",
      path: "src/broken.ts",
      normalizedPath: "src/broken.ts",
      fileHash: "deadbeef",
      language: "typescript",
      properties: { kind: "source", inventoryFileNode: "{not-json" },
    };
    const svc = CartographerQueryService.fromGraph({ nodes: [fileNode], edges: [] });
    const res = await svc.getFile({ normalizedPath: "src/broken.ts" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.fileNode.normalizedPath).toBe("src/broken.ts");
      expect(res.fileNode.hash).toBe("deadbeef");
      expect(res.fileNode.sizeBytes).toBe(0);
    }
  });

  it("getFile returns not_found for missing path", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r = await svc.getFile({ normalizedPath: "src/missing.ts" });
    expect(r.status).toBe("not_found");
  });

  it("getSymbol(name) returns all matches sorted; not_found when none", async () => {
    const { nodes, edges } = makeMinimalGraphWithDuplicates();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const res = await svc.getSymbol({ name: "Helper" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.symbols.length).toBe(2);
      expect(res.symbols[0].normalizedPath).toBe("src/a.ts");
      expect(res.symbols[1].normalizedPath).toBe("src/b.ts");
      // sorted by id
      const ids = res.symbols.map((s) => s.id);
      expect(ids).toEqual([...ids].sort());
    }

    const none = await svc.getSymbol({ name: "NoSuch" });
    expect(none.status).toBe("not_found");
  });

  it("getDependencies and getDependents are deterministic and graph-backed", async () => {
    const { nodes, edges } = makeGraphWithDeps();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const deps = await svc.getDependencies({ target: { kind: "file", normalizedPath: "src/app.ts" } });
    expect(deps.status).toBe("ok");
    if (deps.status === "ok") {
      expect(deps.edges.length).toBeGreaterThan(0);
      const kinds = new Set(deps.edges.map((e) => e.kind));
      expect(kinds.has("IMPORTS") || kinds.has("DEPENDS_ON")).toBe(true);
    }

    const rev = await svc.getDependents({ target: { kind: "file", normalizedPath: "src/lib.ts" } });
    expect(rev.status).toBe("ok");
    if (rev.status === "ok") {
      expect(rev.edges.length).toBeGreaterThan(0);
    }
  });

  it("getDependencies rejects invalid file path with invalid_input (not not_found)", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r = await svc.getDependencies({ target: { kind: "file", normalizedPath: "../package.json" } });
    expect(r.status).toBe("invalid_input");
    if (r.status === "invalid_input") {
      expect(r.reason).toMatch(/traversal|absolute/);
    }
  });

  it("getDependents rejects absolute file path with invalid_input (not not_found)", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r = await svc.getDependents({ target: { kind: "file", normalizedPath: "/etc/passwd" } });
    expect(r.status).toBe("invalid_input");
    if (r.status === "invalid_input") {
      expect(r.reason).toMatch(/absolute/);
    }
  });

  it("getDependencies returns not_found for valid but missing file target", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r = await svc.getDependencies({ target: { kind: "file", normalizedPath: "src/missing.ts" } });
    expect(r.status).toBe("not_found");
  });

  it("getImpact returns structural confidence and deterministic lists", async () => {
    const { nodes, edges } = makeGraphWithDeps();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const imp = await svc.getImpact({ changedNormalizedPaths: ["src/app.ts"] });
    expect(imp.status).toBe("ok");
    if (imp.status === "ok") {
      expect(imp.confidence).toBe("structural");
      expect(Array.isArray(imp.impactedFiles)).toBe(true);
      expect(Array.isArray(imp.probableTests)).toBe(true);
      // sorted
      expect(imp.impactedFiles).toEqual([...imp.impactedFiles].sort());
    }
  });

  it("findTests returns empty linkedTests (ok) when no tests; uses graph TESTS when present", async () => {
    // no tests graph
    const svcEmpty = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r1 = await svcEmpty.findTests({ targetNormalizedPath: "src/app.ts" });
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") {
      expect(r1.linkedTests).toEqual([]);
    }

    // with TESTS edge
    const { nodes, edges } = makeGraphWithTests();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const r2 = await svc.findTests({ targetNormalizedPath: "src/app.ts" });
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.linkedTests.length).toBe(1);
      expect(r2.linkedTests[0].normalizedPath).toBe("src/app.test.ts");
    }
  });

  it("checkArchitecture returns not_configured when no rules; ok with findings when Rule nodes exist", async () => {
    const svcNo = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const r1 = await svcNo.checkArchitecture({});
    expect(r1.status).toBe("not_configured");

    const { nodes, edges } = makeGraphWithRule();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const r2 = await svc.checkArchitecture({});
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.findings).toContain("no-direct-db");
    }
  });

  it("listCapabilities and getCapability return not_configured", async () => {
    const svc = CartographerQueryService.fromGraph({ nodes: [], edges: [] });
    const list = await svc.listCapabilities();
    expect(list.status).toBe("not_configured");

    const get = await svc.getCapability({ id: "cap:foo" });
    expect(get.status).toBe("not_configured");
  });

  it("getRelevantContext is path/symbol-hint only and deterministic", async () => {
    const { nodes, edges } = makeGraphWithDeps();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const ctx = await svc.getRelevantContext({
      hints: { paths: ["src/app.ts"], symbolNames: [] },
    });
    expect(ctx.status).toBe("ok");
    if (ctx.status === "ok") {
      expect(Array.isArray(ctx.nodes)).toBe(true);
      expect(Array.isArray(ctx.edges)).toBe(true);
    }
  });

  it("getFile on structural fixture returns file + symbols + imports when sources provided", async () => {
    const { nodes, edges, inventoryFiles } = await buildStructuralGraphWithSources();
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const expected = inventoryFiles.find((f) => f.normalizedPath === "src/app.ts");
    expect(expected).toBeDefined();
    const res = await svc.getFile({ normalizedPath: "src/app.ts" });
    expect(res.status).toBe("ok");
    if (res.status === "ok" && expected) {
      expect(res.file.normalizedPath).toBe("src/app.ts");
      expect(res.fileNode).toEqual(expected);
      expect(Array.isArray(res.symbols)).toBe(true);
      expect(Array.isArray(res.imports)).toBe(true);
    }
  });

  it("S1 regression: resolveTargetToNodes symbol branch validates isSymbolKind (symbol query by id/name must not return file nodes)", async () => {
    const fileNode: CartographerGraphNode = {
      id: "file:src/app.ts",
      snapshotId: "s1",
      kind: "File",
      label: "app.ts",
      path: "src/app.ts",
      normalizedPath: "src/app.ts",
      symbolName: "fake",
      properties: {},
    };
    const svc = CartographerQueryService.fromGraph({ nodes: [fileNode], edges: [] });

    const byId = await svc.getDependencies({ target: { kind: "symbol", id: fileNode.id } });
    expect(byId.status).toBe("not_found");

    const byName = await svc.getDependencies({ target: { kind: "symbol", name: "fake" } });
    expect(byName.status).toBe("not_found");
  });

  it("C6 regression: getDependents for symbol target includes containing-file reverse edges (mirrors getDependencies fallback)", async () => {
    const libFile = {
      id: "file:abc:src/lib.ts",
      snapshotId: "s1",
      kind: "File" as const,
      label: "lib.ts",
      path: "src/lib.ts",
      normalizedPath: "src/lib.ts",
      properties: {},
    };
    const libSym = {
      id: "symbol:abc:src/lib.ts:libFn:1",
      snapshotId: "s1",
      kind: "Function" as const,
      label: "libFn",
      path: "src/lib.ts",
      normalizedPath: "src/lib.ts",
      symbolName: "libFn",
      symbolKind: "function" as const,
      startLine: 10,
      properties: {},
    };
    const appFile = {
      id: "file:abc:src/app.ts",
      snapshotId: "s1",
      kind: "File" as const,
      label: "app.ts",
      path: "src/app.ts",
      normalizedPath: "src/app.ts",
      properties: {},
    };
    const eImp = {
      id: "edge:IMPORTS:file:abc:src/app.ts:./lib",
      snapshotId: "s1",
      kind: "IMPORTS" as const,
      fromNodeId: appFile.id,
      toNodeId: libFile.id,
      properties: { specifier: "./lib" },
    };
    const svc = CartographerQueryService.fromGraph({ nodes: [libFile, libSym, appFile], edges: [eImp] });

    const res = await svc.getDependents({ target: { kind: "symbol", name: "libFn" } });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      // must include the file->file edge (IMPORTS are file-to-file)
      const hasFileEdge = res.edges.some(
        (e) => e.fromNodeId === appFile.id && e.toNodeId === libFile.id && e.kind === "IMPORTS"
      );
      expect(hasFileEdge).toBe(true);
      // targetNodes includes the symbol
      expect(res.targetNodes.some((n) => n.symbolName === "libFn")).toBe(true);
    }
  });

  it("C5 regression: getImpact collects probableTests for impacted dependents (lib.ts -> app.ts -> app.test.ts)", async () => {
    const libFile = {
      id: "file:abc:src/lib.ts",
      snapshotId: "s1",
      kind: "File" as const,
      label: "lib.ts",
      path: "src/lib.ts",
      normalizedPath: "src/lib.ts",
      properties: {},
    };
    const appFile = {
      id: "file:abc:src/app.ts",
      snapshotId: "s1",
      kind: "File" as const,
      label: "app.ts",
      path: "src/app.ts",
      normalizedPath: "src/app.ts",
      properties: {},
    };
    const testFile = {
      id: "file:abc:src/app.test.ts",
      snapshotId: "s1",
      kind: "Test" as const,
      label: "app.test.ts",
      path: "src/app.test.ts",
      normalizedPath: "src/app.test.ts",
      properties: {},
    };
    const eImp = {
      id: "edge:IMPORTS:file:abc:src/app.ts:./lib",
      snapshotId: "s1",
      kind: "IMPORTS" as const,
      fromNodeId: appFile.id,
      toNodeId: libFile.id,
      properties: { specifier: "./lib" },
    };
    const eTest = {
      id: "edge:TESTS:file:abc:src/app.test.ts:file:abc:src/app.ts",
      snapshotId: "s1",
      kind: "TESTS" as const,
      fromNodeId: testFile.id,
      toNodeId: appFile.id,
      properties: { relation: "import" },
      evidence: { path: "src/app.test.ts", text: "import" },
    };
    const svc = CartographerQueryService.fromGraph({ nodes: [libFile, appFile, testFile], edges: [eImp, eTest] });

    const res = await svc.getImpact({ changedNormalizedPaths: ["src/lib.ts"] });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.impactedFiles).toContain("src/lib.ts");
      expect(res.impactedFiles).toContain("src/app.ts");
      expect(res.probableTests).toContain("src/app.test.ts");
      // deterministic sorted
      expect(res.impactedFiles).toEqual([...res.impactedFiles].sort());
      expect(res.probableTests).toEqual([...res.probableTests].sort());
    }
  });
});
