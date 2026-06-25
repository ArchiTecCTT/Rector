import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFsRawArtifactStore, RawArtifactRecordSchema, type RawArtifactRecord } from "../../src/capabilities/eval/artifactStore";

const fixedCreatedAt = "2026-06-23T01:02:03.000Z";
const tempRoots: string[] = [];

describe("LocalFsRawArtifactStore", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("writes redacted raw artifacts and parseable metadata when content contains secrets", async () => {
    // Given: a local raw-artifact store rooted in a real temp directory and raw tool exhaust containing an authorization secret.
    const rootDir = await makeTempRoot();
    const store = new LocalFsRawArtifactStore({ rootDir, now: () => new Date(fixedCreatedAt) });

    // When: a raw artifact is written with both text and metadata that require redaction.
    const record = await store.writeRawArtifact({
      callId: "call-rg-1",
      artifactName: "rg-search.txt",
      content: "Authorization: Bearer sk-live-secret\napi_key=abc123\nmatch: src/index.ts:1",
      contentType: "text/plain",
      metadata: { apiKey: "sk-metadata-secret", query: "memory" },
    });
    const stored = await store.readRawArtifact(record.uri);

    // Then: persisted content is redacted, metadata is schema-parseable, and no original secret substring remains.
    expect(record).toMatchObject({
      schemaVersion: "rector.capability.rawArtifact.v1",
      callId: "call-rg-1",
      artifactName: "rg-search.txt",
      contentType: "text/plain",
      redactionState: "redacted",
      createdAt: fixedCreatedAt,
    } satisfies Partial<RawArtifactRecord>);
    expect(record.uri).toBe("artifact://call-rg-1/rg-search.txt");
    expect(record.sizeBytes).toBe(Buffer.byteLength(stored.content, "utf8"));
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.content).toContain("Bearer [REDACTED]");
    expect(stored.content).toContain("api_key=[REDACTED]");
    expect(stored.content).not.toContain("sk-live-secret");
    expect(stored.content).not.toContain("abc123");
    expect(stored.record.metadata).toEqual({ apiKey: "[REDACTED]", query: "memory" });
    expect(RawArtifactRecordSchema.safeParse(stored.record).success).toBe(true);
  });

  it("lists stored artifact records in stable artifact-name order", async () => {
    // Given: two raw artifacts written for one capability call in non-sorted order.
    const rootDir = await makeTempRoot();
    const store = new LocalFsRawArtifactStore({ rootDir, now: () => new Date(fixedCreatedAt) });
    await store.writeRawArtifact({ callId: "call-tsc-1", artifactName: "z-output.txt", content: "clean z" });
    await store.writeRawArtifact({ callId: "call-tsc-1", artifactName: "a-output.txt", content: "clean a" });

    // When: records are listed for the call id.
    const records = await store.listRawArtifacts("call-tsc-1");

    // Then: callers receive schema-parseable metadata sorted by UTF-16 artifact name.
    expect(records.map((record) => record.artifactName)).toEqual(["a-output.txt", "z-output.txt"]);
    expect(records.map((record) => record.redactionState)).toEqual(["no_secrets_detected", "no_secrets_detected"]);
    expect(records.every((record) => RawArtifactRecordSchema.safeParse(record).success)).toBe(true);
  });

  it("rejects traversal-shaped artifact identifiers before touching the filesystem", async () => {
    // Given: a local raw-artifact store and an artifact name that would escape the call directory if accepted.
    const rootDir = await makeTempRoot();
    const store = new LocalFsRawArtifactStore({ rootDir, now: () => new Date(fixedCreatedAt) });

    // When/Then: boundary parsing rejects the unsafe name and no sibling file is created.
    await expect(
      store.writeRawArtifact({ callId: "call-safe-1", artifactName: "../escape.txt", content: "secret=abc" }),
    ).rejects.toThrow(/artifactName/);
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  it("rejects '.' and '..' callId segments before touching the filesystem", async () => {
    // Given: a local raw-artifact store and a callId of ".." that would resolve to the parent of root.
    const rootDir = await makeTempRoot();
    const store = new LocalFsRawArtifactStore({ rootDir, now: () => new Date(fixedCreatedAt) });

    // When/Then: boundary parsing rejects the traversal segment and nothing is written anywhere.
    await expect(
      store.writeRawArtifact({ callId: "..", artifactName: "x.txt", content: "traversal" }),
    ).rejects.toThrow(/callId/);
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  it("fails the integrity check when the on-disk content no longer matches the recorded sha256", async () => {
    // Given: a written artifact whose on-disk content file is then corrupted out-of-band.
    const rootDir = await makeTempRoot();
    const store = new LocalFsRawArtifactStore({ rootDir, now: () => new Date(fixedCreatedAt) });
    const record = await store.writeRawArtifact({
      callId: "call-int-1",
      artifactName: "out.txt",
      content: "hello world",
    });
    const contentPath = path.join(rootDir, "call-int-1", "out.txt");
    await fs.writeFile(contentPath, "corrupted content", "utf8");

    // When/Then: reading the artifact throws the integrity error instead of returning tampered content.
    await expect(store.readRawArtifact(record.uri)).rejects.toThrow(
      /Raw artifact integrity check failed/,
    );
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-artifact-store-"));
  tempRoots.push(root);
  return root;
}
