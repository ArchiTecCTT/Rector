import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS,
  MIN_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS,
  normalizeProductOrchestrationMaxRuntimeMs,
} from "../../src/config/orchestrationMaxRuntime";
import {
  RuntimeSettingsPatchSchema,
  RuntimeSettingsSchema,
} from "../../src/config/runtimeSettings";
import { DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS } from "../../src/orchestration/chatRunner";

const BASE_SETTINGS = {
  schemaVersion: "rector.runtime.v1" as const,
  orchestrationProfile: "configured" as const,
  requireProvidersForChat: true,
  updatedAt: new Date().toISOString(),
};

describe("normalizeProductOrchestrationMaxRuntimeMs", () => {
  it("returns default when value is invalid", () => {
    expect(normalizeProductOrchestrationMaxRuntimeMs(undefined)).toBe(DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS);
    expect(normalizeProductOrchestrationMaxRuntimeMs(-1)).toBe(DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS);
  });

  it("clamps below minimum and above maximum", () => {
    expect(normalizeProductOrchestrationMaxRuntimeMs(1)).toBe(MIN_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS);
    expect(normalizeProductOrchestrationMaxRuntimeMs(9_999_999_999)).toBe(
      MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS,
    );
  });

  it("passes through in-range integers", () => {
    expect(normalizeProductOrchestrationMaxRuntimeMs(120_000)).toBe(120_000);
  });
});

describe("RuntimeSettingsSchema orchestration.maxRuntimeMs bounds", () => {
  it("clamps oversized persisted values on parse", () => {
    const parsed = RuntimeSettingsSchema.parse({
      ...BASE_SETTINGS,
      orchestration: { maxRuntimeMs: 86_400_000_000 },
    });
    expect(parsed.orchestration.maxRuntimeMs).toBe(MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS);
  });

  it("rejects patch values outside product bounds", () => {
    const tooLow = RuntimeSettingsPatchSchema.safeParse({
      orchestration: { maxRuntimeMs: MIN_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS - 1 },
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = RuntimeSettingsPatchSchema.safeParse({
      orchestration: { maxRuntimeMs: MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS + 1 },
    });
    expect(tooHigh.success).toBe(false);
  });
});