import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuffer, hashFile, hashString, hashViaReader, type FileReader } from "../../src/cartographer";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-file-hasher-"));
  tempRoots.push(root);
  return root;
}

function unusedReader(): FileReader {
  return {
    async lstat(_path: string): Promise<Stats> {
      throw new Error("unused lstat");
    },
    async readdir(_path: string): Promise<readonly Dirent[]> {
      throw new Error("unused readdir");
    },
    async readHead(_path: string, _maxBytes: number): Promise<Uint8Array> {
      throw new Error("unused readHead");
    },
    async readAll(_path: string): Promise<Uint8Array> {
      throw new Error("permission denied");
    },
  };
}

describe("Cartographer T4 file hasher", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("hashes identical temp-file bytes identically and detects a one-byte change", async () => {
    // Given: three temp files where two share bytes and the third differs by one byte.
    const root = await makeTempRoot();
    const firstPath = path.join(root, "first.txt");
    const secondPath = path.join(root, "second.txt");
    const changedPath = path.join(root, "changed.txt");
    await fs.writeFile(firstPath, Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(secondPath, Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(changedPath, Buffer.from([0, 1, 2, 4]));

    // When: each file is hashed through the fs-backed convenience wrapper.
    const firstHash = await hashFile(firstPath);
    const secondHash = await hashFile(secondPath);
    const changedHash = await hashFile(changedPath);

    // Then: raw-byte identity and sensitivity are visible as lowercase SHA-256 hex.
    expect(firstHash).toBe(secondHash);
    expect(firstHash).not.toBe(changedHash);
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
    expect(changedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches node crypto for a fixed Buffer and keeps string hashing UTF-8 based", () => {
    // Given: a fixed string represented as explicit UTF-8 bytes.
    const buffer = Buffer.from("Rector cartographer\n", "utf8");
    const expected = createHash("sha256").update(buffer).digest("hex");

    // When: the lower-level helpers hash the raw buffer and a string.
    const bufferHash = hashBuffer(buffer);
    const stringHash = hashString("x");

    // Then: the buffer helper matches Node crypto and hashString delegates to UTF-8 bytes.
    expect(bufferHash).toBe(expected);
    expect(bufferHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stringHash).toBe(hashBuffer(Buffer.from("x", "utf8")));
  });

  it("returns a recoverable hash ScanError when the injected reader rejects", async () => {
    // Given: a scanner-injected reader whose readAll method fails.
    const reader = unusedReader();

    // When: scanner-facing hashing is requested.
    const result = await hashViaReader(reader, "src/unreadable.ts");

    // Then: the error is structured and the promise itself resolves.
    expect(result).toEqual({
      error: {
        path: "src/unreadable.ts",
        stage: "hash",
        message: "permission denied",
        recoverable: true,
      },
    });
  });

  it("rejects from hashFile for missing paths and directories", async () => {
    // Given: a repo-local missing path and a directory path.
    const root = await makeTempRoot();

    // When/Then: convenience hashing preserves fs rejection semantics.
    await expect(hashFile(path.join(root, "definitely-missing.txt"))).rejects.toBeInstanceOf(Error);
    await expect(hashFile(root)).rejects.toBeInstanceOf(Error);
  });
});
