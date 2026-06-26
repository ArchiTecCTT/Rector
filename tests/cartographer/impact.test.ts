import { describe, expect, it } from "vitest";

import { CartographerQueryService } from "../../src/cartographer";

describe("impact (Todo 22 query-service facing)", () => {
  it("returns structural confidence and deterministic sorted lists", async () => {
    const nodes = [
      {
        id: "file:abc:src/app.ts",
        snapshotId: "s1",
        kind: "File" as const,
        label: "app.ts",
        path: "src/app.ts",
        normalizedPath: "src/app.ts",
        properties: {},
      },
      {
        id: "file:abc:src/lib.ts",
        snapshotId: "s1",
        kind: "File" as const,
        label: "lib.ts",
        path: "src/lib.ts",
        normalizedPath: "src/lib.ts",
        properties: {},
      },
    ];
    const edges = [
      {
        id: "edge:DEPENDS_ON:file:abc:src/app.ts:file:abc:src/lib.ts",
        snapshotId: "s1",
        kind: "DEPENDS_ON" as const,
        fromNodeId: "file:abc:src/app.ts",
        toNodeId: "file:abc:src/lib.ts",
        properties: {},
      },
    ];
    const svc = CartographerQueryService.fromGraph({ nodes, edges });
    const r = await svc.getImpact({ changedNormalizedPaths: ["src/app.ts"] });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.confidence).toBe("structural");
      expect(r.impactedFiles).toEqual([...r.impactedFiles].sort());
      expect(r.probableTests).toEqual([...r.probableTests].sort());
    }
  });
});
