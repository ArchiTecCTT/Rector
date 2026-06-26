import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

export function makeTempLifecycle() {
  const tempRoots: string[] = [];

  const cleanup = async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  };

  const tempOutputDir = async (prefix: string) => {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  };

  return { tempRoots, cleanup, tempOutputDir };
}
