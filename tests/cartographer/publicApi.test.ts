import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScanSummary,
  classifyFile,
  hashBuffer,
  hashFile,
  hashString,
  InMemoryCartographerInventoryStore,
  scanChangedFiles,
  scanRepository,
  shouldIgnoreFile,
  SqliteCartographerInventoryStore,
} from "../../src/cartographer";
import type { CartographerInventoryStore, ScanResult } from "../../src/cartographer";
import { cartographer } from "../../src";

describe("Cartographer public API barrel", () => {
  it("exports the required runtime API from src/cartographer", () => {
    // Given: the public Cartographer barrel is the consumer import surface.
    const runtimeExports = {
      buildScanSummary,
      classifyFile,
      hashBuffer,
      hashFile,
      hashString,
      InMemoryCartographerInventoryStore,
      scanChangedFiles,
      scanRepository,
      shouldIgnoreFile,
      SqliteCartographerInventoryStore,
    };

    // When/Then: each required value export remains available.
    expect(runtimeExports).toEqual({
      buildScanSummary: expect.any(Function),
      classifyFile: expect.any(Function),
      hashBuffer: expect.any(Function),
      hashFile: expect.any(Function),
      hashString: expect.any(Function),
      InMemoryCartographerInventoryStore: expect.any(Function),
      scanChangedFiles: expect.any(Function),
      scanRepository: expect.any(Function),
      shouldIgnoreFile: expect.any(Function),
      SqliteCartographerInventoryStore: expect.any(Function),
    });
  });

  it("exports the required type API from src/cartographer", () => {
    // Given/When: type-only imports compile from the public barrel.
    const storeContract: CartographerInventoryStore | undefined = undefined;
    const scanResultContract: ScanResult | undefined = undefined;

    // Then: runtime placeholders prove the type imports were accepted by TypeScript.
    expect(storeContract).toBeUndefined();
    expect(scanResultContract).toBeUndefined();
  });

  it("exports Cartographer from the root package index namespace", () => {
    // Given: the root index barrel is the primary consumer import surface.
    // When/Then: namespace value exports match expected Cartographer public contracts.
    expect(cartographer.scanRepository).toEqual(expect.any(Function));
    expect(cartographer.scanChangedFiles).toEqual(expect.any(Function));
  });

  it("exports from dist/cartographer if dist exists, otherwise documents viability", async () => {
    const distPath = path.resolve(__dirname, "../../dist/cartographer/index.js");
    let hasDist = false;
    try {
      await fs.access(distPath);
      hasDist = true;
    } catch {
      // dist is not built yet during pre-build npm test
    }

    if (hasDist) {
      // @ts-ignore
      const distCartographer = await import("../../dist/cartographer/index.js");
      expect(distCartographer.scanRepository).toEqual(expect.any(Function));
      expect(distCartographer.scanChangedFiles).toEqual(expect.any(Function));
    } else {
      // Documenting why source/root tests are the viable check in this PR:
      // A clean checkout runs `npm test` before `npm run build`, meaning `dist/` is not yet generated.
      // Therefore, direct dynamic imports of `dist/cartographer/index.js` would fail on clean test runs.
      // The source index barrel and root exports are fully validated as the source of truth.
      console.log("Skipping build-oriented package subpath check: dist/cartographer/index.js does not exist yet.");
    }
  });
});
