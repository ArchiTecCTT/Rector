import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildEvidenceManifest, EVIDENCE_TRACKS } from "../../src/evidence";
import { verifyEvidencePaths } from "../../scripts/evidence/verify-evidence-paths";

const tempRoots: string[] = [];

describe("verify-evidence-paths script", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("fails on unsafe evidence directory overrides", async () => {
    const repoRoot = await makeRepo();

    const result = await verifyEvidencePaths({
      repoRoot,
      env: { RECTOR_EVIDENCE_DIR: "../outside" },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsafe_override",
          message: expect.stringMatching(/RECTOR_EVIDENCE_DIR/i),
        }),
      ]),
    );
  });

  it("fails when expected track directories are required after a run but missing", async () => {
    const repoRoot = await makeRepo();
    await fs.mkdir(path.join(repoRoot, ".rector", "evidence", "phase0"), { recursive: true });

    const result = await verifyEvidencePaths({ repoRoot, requireTrackDirs: true });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_track_dir", track: "phase2" }),
        expect.objectContaining({ code: "missing_track_dir", track: "live/zai" }),
      ]),
    );
  });

  it("fails when manifest pointers resolve outside the evidence root", async () => {
    const repoRoot = await makeRepo();
    const evidenceRoot = path.join(repoRoot, ".rector", "evidence");
    await makeAllTrackDirs(repoRoot);
    const manifestPath = path.join(evidenceRoot, "evidence-manifest.json");
    const outsideDir = path.join(repoRoot, "outside-phase2");
    const manifest = buildEvidenceManifest({
      tracks: {
        phase2: {
          directory: outsideDir,
          latestJson: ".rector/evidence/phase2/fact-report.json",
        },
      },
      now: () => new Date("2026-06-30T00:00:00.000Z"),
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await verifyEvidencePaths({
      repoRoot,
      requireTrackDirs: true,
      manifestPath,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest_pointer_outside_root",
          track: "phase2",
          pointer: "directory",
        }),
      ]),
    );
  });

  it("fails when manifest pointers contain traversal segments", async () => {
    const repoRoot = await makeRepo();
    const evidenceRoot = path.join(repoRoot, ".rector", "evidence");
    await makeAllTrackDirs(repoRoot);
    const manifestPath = path.join(evidenceRoot, "evidence-manifest.json");
    const manifest = buildEvidenceManifest({
      tracks: {
        phase2: {
          directory: ".rector/evidence/phase2",
          latestJson: ".rector/evidence/phase2/../outside/fact-report.json",
        },
      },
      now: () => new Date("2026-06-30T00:00:00.000Z"),
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await verifyEvidencePaths({ repoRoot, manifestPath });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest_pointer_invalid",
          track: "phase2",
          pointer: "latestJson",
        }),
      ]),
    );
  });

  it("passes when required track directories and manifest pointers stay inside the evidence root", async () => {
    const repoRoot = await makeRepo();
    const evidenceRoot = path.join(repoRoot, ".rector", "evidence");
    await makeAllTrackDirs(repoRoot);
    const manifestPath = path.join(evidenceRoot, "evidence-manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(buildEvidenceManifest({ now: () => new Date("2026-06-30T00:00:00.000Z") }), null, 2),
      "utf8",
    );

    const result = await verifyEvidencePaths({
      repoRoot,
      requireTrackDirs: true,
      manifestPath,
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-evidence-verify-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".rector", "evidence"), { recursive: true });
  return root;
}

async function makeAllTrackDirs(repoRoot: string): Promise<void> {
  await Promise.all(
    EVIDENCE_TRACKS.map((track) => fs.mkdir(path.join(repoRoot, ".rector", "evidence", ...track.split("/")), { recursive: true })),
  );
}
