import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileReader } from "./types";

export const defaultFileReader: FileReader = {
  lstat: (filePath) => fs.lstat(filePath),
  readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
  async readHead(filePath: string, maxBytes: number): Promise<Uint8Array> {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const result = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  },
  readAll: (filePath) => fs.readFile(filePath),
};

export function normalizeRepositoryPath(repoRoot: string, absolutePath: string): string {
  const platformPath = isWindowsStylePath(repoRoot, absolutePath) ? path.win32 : path;
  const normalizedRoot = platformPath.resolve(repoRoot);
  const normalizedAbsolute = platformPath.resolve(absolutePath);
  if (!isSameOrChildPath(normalizedRoot, normalizedAbsolute, platformPath.sep)) {
    throw new Error(`Path escapes repository root: ${absolutePath}`);
  }
  return platformPath.relative(normalizedRoot, normalizedAbsolute).replace(/\\/g, "/");
}

function isWindowsStylePath(repoRoot: string, absolutePath: string): boolean {
  return repoRoot.includes("\\") || absolutePath.includes("\\") || /^[A-Za-z]:/.test(repoRoot);
}

function isSameOrChildPath(root: string, candidate: string, separator: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${separator}`);
}
