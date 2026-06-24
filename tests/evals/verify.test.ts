import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function run(cmd: string, env?: NodeJS.ProcessEnv): { code: number } {
  try {
    execSync(cmd, { encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } });
    return { code: 0 };
  } catch (e: any) {
    return { code: e.status ?? 1 };
  }
}

describe("completion verifiers", () => {
  it("verify:phase0 exits 1 on <10 corpus cases", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "v0-"));
    const manifest = { schemaVersion: "phase0.eval-corpus.v1", description: "x", cases: [] };
    writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));
    const r = run("npm run verify:phase0", { VERIFY_CORPUS_ROOT: tmp });
    expect(r.code).not.toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("verify:phase0.5 exits 1 on <20 scenarios", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "v05-"));
    mkdirSync(path.join(tmp, "scenarios"), { recursive: true });
    const r = run("npm run verify:phase0.5", { VERIFY_SCENARIOS_DIR: path.join(tmp, "scenarios") });
    expect(r.code).not.toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("verify:phase0 exits 0 on real tree", () => {
    const r = run("npm run verify:phase0");
    expect(r.code).toBe(0);
  });

  it("verify:phase0.5 exits 0 on real tree", () => {
    const r = run("npm run verify:phase0.5");
    expect(r.code).toBe(0);
  }, 120000);
});
