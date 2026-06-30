import { describe, expect, it } from "vitest";

import {
  buildEvidenceManifest,
  defaultEvidenceTrackPointers,
  type EvidenceManifest,
} from "../../src/evidence";

const NOW = new Date("2026-06-30T00:00:00.000Z");

describe("evidence manifest helpers", () => {
  it("builds a v1 manifest with canonical track pointers and live evidence metadata", () => {
    const campaignBudget = {
      schemaVersion: "rector.campaign-budget.v1" as const,
      generatedAt: NOW.toISOString(),
      limits: { maxTotalTokens: 100_000 },
      sources: {
        provider_smoke: { modelCalls: 1, inputTokens: 100, outputTokens: 25, totalTokens: 125, estimatedCostUsd: 0.01 },
        phase2f_shadow: { modelCalls: 5, inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, estimatedCostUsd: 0.1 },
        harness_smoke: { modelCalls: 3, inputTokens: 2_000, outputTokens: 750, totalTokens: 2_750, estimatedCostUsd: 0.2 },
      },
      total: { modelCalls: 9, inputTokens: 3_100, outputTokens: 1_275, totalTokens: 4_375, estimatedCostUsd: 0.31 },
      withinTokenBudget: true,
      overTokenBudgetBy: 0,
      status: "within_budget" as const,
    };

    const manifest = buildEvidenceManifest({
      now: () => NOW,
      repoRef: "rector-0.3.0",
      liveEvidenceStatus: "skipped",
      secretScanPassedAt: "2026-06-30T00:01:00.000Z",
      campaignBudget,
    });

    expect(manifest).toEqual<EvidenceManifest>({
      schemaVersion: "rector.evidence-manifest.v1",
      generatedAt: NOW.toISOString(),
      repoRef: "rector-0.3.0",
      tracks: defaultEvidenceTrackPointers(),
      liveEvidenceStatus: "skipped",
      secretScanPassedAt: "2026-06-30T00:01:00.000Z",
      campaignBudget,
    });
    expect(manifest.tracks.phase2.latestJson).toBe(".rector/evidence/phase2/fact-report.json");
    expect(manifest.tracks["live/zai"].latestMarkdown).toBe(".rector/evidence/live/zai/latest.md");
  });

  it("omits optional live fields until live evidence exists", () => {
    const manifest = buildEvidenceManifest({ now: () => NOW });

    expect(manifest.schemaVersion).toBe("rector.evidence-manifest.v1");
    expect(manifest.generatedAt).toBe(NOW.toISOString());
    expect(manifest.liveEvidenceStatus).toBeUndefined();
    expect(manifest.secretScanPassedAt).toBeUndefined();
    expect(manifest.campaignBudget).toBeUndefined();
  });
});
