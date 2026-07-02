import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS,
  MAX_LIVE_HARNESS_MAX_RUNTIME_MS,
  resolveLiveHarnessMaxRuntimeMs,
} from "../../src/live/liveHarnessRuntime";

describe("liveHarnessRuntime", () => {
  it("defaults to 120s when env override is absent", () => {
    expect(resolveLiveHarnessMaxRuntimeMs({})).toBe(DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS);
  });

  it("honors finalist-style overrides within hard cap", () => {
    expect(resolveLiveHarnessMaxRuntimeMs({ RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS: "300000" })).toBe(300_000);
    expect(resolveLiveHarnessMaxRuntimeMs({ RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS: "9999999" })).toBe(
      MAX_LIVE_HARNESS_MAX_RUNTIME_MS,
    );
  });

  it("falls back on invalid env values", () => {
    expect(resolveLiveHarnessMaxRuntimeMs({ RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS: "nope" })).toBe(
      DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS,
    );
  });
});