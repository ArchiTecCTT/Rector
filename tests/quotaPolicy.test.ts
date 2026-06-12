import { describe, expect, it } from "vitest";
import { createInMemoryQuotaService } from "../src/security/quotas";

describe("Quota policy service", () => {
  it("blocks run creation before spend when maxRunsPerDay is exceeded", async () => {
    const quotas = createInMemoryQuotaService({ policies: { team: { maxRunsPerDay: 1 } } });

    expect((await quotas.checkRunCreation("team")).allowed).toBe(true);
    await quotas.recordRunCreated("team");

    const denied = await quotas.checkRunCreation("team");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("Daily run quota exceeded");
  });

  it("gates provider calls by per-run call count and USD ceilings", async () => {
    const quotas = createInMemoryQuotaService({
      policies: { team: { maxProviderCallsPerRun: 1, maxUsdPerDay: 0.05, maxUsdPerMonth: 0.1 } },
    });

    expect((await quotas.checkProviderCall("team", "run-1", { estimatedUsd: 0.02 })).allowed).toBe(true);
    await quotas.recordProviderCall("team", "run-1", { estimatedUsd: 0.02 });

    const callDenied = await quotas.checkProviderCall("team", "run-1", { estimatedUsd: 0.02 });
    expect(callDenied.allowed).toBe(false);
    expect(callDenied.reason).toContain("Provider-call quota");

    const spendDenied = await quotas.checkProviderCall("team", "run-2", { estimatedUsd: 0.06 });
    expect(spendDenied.allowed).toBe(false);
    expect(spendDenied.reason).toContain("Daily USD quota");
  });

  it("tracks sandbox and storage limits", async () => {
    const quotas = createInMemoryQuotaService({ policies: { team: { maxSandboxMinutesPerDay: 5, maxStorageMb: 10 } } });

    await quotas.recordSandboxMinutes("team", 4);
    expect((await quotas.checkSandboxMinutes("team", 2)).allowed).toBe(false);

    expect((await quotas.checkStorage("team", 9)).allowed).toBe(true);
    expect((await quotas.checkStorage("team", 11)).allowed).toBe(false);
  });
});
