import { describe, expect, it } from "vitest";
import packageJson from "../package.json";

describe("dependency security overrides", () => {
  it("defines an npm overrides section", () => {
    expect(packageJson.overrides).toBeDefined();
  });

  it("forces esbuild to a non-vulnerable range via npm overrides", () => {
    expect(packageJson.overrides.esbuild).toBe(">=0.28.1");
  });
});
