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
  if (repoRoot.includes("\\") || absolutePath.includes("\\") || /^[A-Za-z]:/.test(repoRoot)) {
    return path.win32.relative(repoRoot, absolutePath).split(path.win32.sep).join("/");
  }
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.split(path.sep).join("/").replace(/\\/g, "/");
}
