import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { getSetupChecklist } from "../src/setupChecklist";

describe("release packaging", () => {
  it("exports a side-effect-free root module and public submodules", () => {
    expect(packageJson.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./extensions": { types: "./dist/extensions/index.d.ts", import: "./dist/extensions/index.js" },
      "./sandbox": { types: "./dist/sandbox/index.d.ts", import: "./dist/sandbox/index.js" },
      "./workflows": { types: "./dist/workflows/index.d.ts", import: "./dist/workflows/index.js" },
      "./deployment": { types: "./dist/deployment/index.d.ts", import: "./dist/deployment/index.js" },
    });
  });

  it("uses the executable server entrypoint for dev and exposes check command", () => {
    expect(packageJson.scripts.dev).toContain("src/bin/server.ts");
    expect(packageJson.scripts.dev).toContain("--env-file=.env");
    expect(packageJson.scripts.check).toBe("tsc --noEmit");
  });

  it("includes Make webhook secret in setup checklist", () => {
    const item = getSetupChecklist().find((entry) => entry.key === "MAKE_WEBHOOK_SECRET");

    expect(item).toMatchObject({
      key: "MAKE_WEBHOOK_SECRET",
      category: "integrations",
      isSensitive: true,
    });
  });
});
