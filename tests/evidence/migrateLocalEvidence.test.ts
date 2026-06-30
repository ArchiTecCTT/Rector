import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLocalEvidence } from "../../scripts/evidence/migrate-local-evidence";

const tempRoots: string[] = [];

describe("migrate-local-evidence script", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("does not write imported evidence during the default dry run", async () => {
    const repoRoot = await makeRepo({
      "eval-report.md": "offline report\n",
    });

    const result = await migrateLocalEvidence({ repoRoot, apply: false });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.files).toEqual([expect.objectContaining({ sourceRelativePath: "eval-report.md", action: "would_copy" })]);
    await expect(fs.stat(path.join(repoRoot, ".rector", "evidence", "legacy-omo-import"))).rejects.toThrow(/ENOENT/);
  });

  it("imports text and JSON evidence only after redaction", async () => {
    const markdownSecret = "tok_legacy_markdown_secret";
    const jsonSecret = "tok_legacy_json_secret";
    const repoRoot = await makeRepo({
      "eval-report.md": `phase0\nAuthorization: Bearer ${markdownSecret}\napi_key=${markdownSecret}\n`,
      "nested/fact-report.json": JSON.stringify({
        provider: "zai",
        apiKey: jsonSecret,
        url: "https://user:password@example.test/v1",
      }),
    });

    const result = await migrateLocalEvidence({ repoRoot, apply: true, now: () => new Date("2026-06-30T00:00:00.000Z") });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceRelativePath: "eval-report.md", action: "copied" }),
        expect.objectContaining({ sourceRelativePath: "nested/fact-report.json", action: "copied" }),
      ]),
    );

    const importedMarkdown = await fs.readFile(
      path.join(repoRoot, ".rector", "evidence", "legacy-omo-import", "eval-report.md"),
      "utf8",
    );
    const importedJson = await fs.readFile(
      path.join(repoRoot, ".rector", "evidence", "legacy-omo-import", "nested", "fact-report.json"),
      "utf8",
    );
    const summary = await fs.readFile(
      path.join(repoRoot, ".rector", "evidence", "legacy-omo-import", "import-summary.json"),
      "utf8",
    );

    expect(importedMarkdown).not.toContain(markdownSecret);
    expect(importedMarkdown).toContain("Bearer [REDACTED]");
    expect(importedMarkdown).toContain("api_key=[REDACTED]");
    expect(importedJson).not.toContain(jsonSecret);
    expect(importedJson).not.toContain("user:password");
    expect(JSON.parse(importedJson)).toMatchObject({ apiKey: "[REDACTED]", url: "https://[REDACTED]@example.test/v1" });
    expect(summary).not.toContain(markdownSecret);
    expect(summary).not.toContain(jsonSecret);
  });

  it("writes metadata-only summaries for unsafe files instead of durable raw content", async () => {
    const repoRoot = await makeRepo({});
    const binaryPath = path.join(repoRoot, ".omo", "evidence", "raw.bin");
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 4]));

    const result = await migrateLocalEvidence({ repoRoot, apply: true });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([
      expect.objectContaining({
        sourceRelativePath: "raw.bin",
        action: "summarized",
        reason: expect.stringMatching(/binary/i),
      }),
    ]);
    await expect(fs.stat(path.join(repoRoot, ".rector", "evidence", "legacy-omo-import", "raw.bin"))).rejects.toThrow(
      /ENOENT/,
    );
    const metadata = JSON.parse(
      await fs.readFile(path.join(repoRoot, ".rector", "evidence", "legacy-omo-import", "raw.bin.metadata.json"), "utf8"),
    );
    expect(metadata).toMatchObject({
      schemaVersion: "rector.legacy-omo-import-file.v1",
      sourceRelativePath: "raw.bin",
      action: "summarized",
      reason: expect.stringMatching(/binary/i),
      sizeBytes: 5,
    });
    expect(JSON.stringify(metadata)).not.toContain("\u0000");
  });
});

async function makeRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-evidence-migrate-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ".omo", "evidence", ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  await fs.mkdir(path.join(root, ".omo", "evidence"), { recursive: true });
  return root;
}
