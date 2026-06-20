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
});
