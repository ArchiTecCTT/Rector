import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileReader, ScanError } from "./types";

export async function hashFile(path: string): Promise<string> {
  const buffer = await fs.readFile(path);
  return hashBuffer(buffer);
}

export function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function hashString(s: string): string {
  return hashBuffer(Buffer.from(s, "utf8"));
}

export async function hashViaReader(fileReader: FileReader, path: string): Promise<{ readonly hash: string } | { readonly error: ScanError }> {
  try {
    const bytes = await fileReader.readAll(path);
    return { hash: hashBuffer(Buffer.from(bytes)) };
  } catch (error) {
    return { error: { path, stage: "hash", message: hashErrorMessage(error), recoverable: true } };
  }
}

function hashErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown hash failure";
}
