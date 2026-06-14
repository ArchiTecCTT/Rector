import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { migrateRuntimeSettingsFromEnv } from "../src/config/runtimeSettings";

const WHITESPACE_CHARS = [" ", "\t", "\n", "\r", "\f", "\v"] as const;

const arbWhitespaceOnly = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

const arbBlankMode = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant<string | undefined>(""),
  arbWhitespaceOnly,
);

describe("runtime settings migration from legacy ORCHESTRATOR_MODE", () => {
  it("maps unset/blank mode to unconfigured regardless of provider count", async () => {
    await fc.assert(
      fc.asyncProperty(arbBlankMode, fc.integer({ min: 0, max: 5 }), async (mode, providerCount) => {
        const settings = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: mode }, providerCount);
        expect(settings.orchestrationProfile).toBe("unconfigured");
        expect(settings.requireProvidersForChat).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it("maps explicit local mode to unconfigured", () => {
    const settings = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: "local" }, 3);
    expect(settings.orchestrationProfile).toBe("unconfigured");
  });

  it("maps external mode with providers to configured", () => {
    const settings = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: "external" }, 2);
    expect(settings.orchestrationProfile).toBe("configured");
  });

  it("maps external mode without providers to unconfigured", () => {
    const settings = migrateRuntimeSettingsFromEnv({ ORCHESTRATOR_MODE: "external" }, 0);
    expect(settings.orchestrationProfile).toBe("unconfigured");
  });
});