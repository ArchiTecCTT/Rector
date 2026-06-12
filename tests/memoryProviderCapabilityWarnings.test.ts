import { describe, expect, it } from "vitest";

import {
  memoryCapabilityWarningsForRole,
  memoryProviderCapabilitiesForKind,
} from "../src/providers/memoryAssignments";

describe("memory provider capability warnings", () => {
  it("warns when vectorSearch is assigned to a non-vector provider", () => {
    const warnings = memoryCapabilityWarningsForRole({
      role: "vectorSearch",
      capabilities: memoryProviderCapabilitiesForKind("local-sqlite-mem"),
      providerKind: "local-sqlite-mem",
      providerLabel: "Local SQLite",
      providerRecordId: "local-sqlite-mem:main",
    });

    expect(warnings.map((warning) => warning.code)).toContain("VECTOR_UNAVAILABLE");
    expect(warnings[0].message).toContain("does not support vector search");
  });

  it("surfaces external-memory cost/data policy warnings in external mode", () => {
    const warnings = memoryCapabilityWarningsForRole({
      role: "episodicMemory",
      capabilities: memoryProviderCapabilitiesForKind("mem0"),
      providerKind: "mem0",
      providerLabel: "Mem0",
      providerRecordId: "mem0:main",
      mode: "external",
    });

    expect(warnings.map((warning) => warning.code)).toContain("EXTERNAL_MEMORY");
  });
});
