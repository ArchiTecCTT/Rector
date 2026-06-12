import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TEMPLATES,
  TemplateImportSecretError,
  TemplateService,
  createInMemoryUserTemplateStore,
} from "../src/templates";
import {
  ORCHESTRATION_ROLES,
  createInMemoryOrchestrationAssignmentStore,
} from "../src/providers/orchestrationAssignments";
import { MEMORY_ROLES } from "../src/providers/memoryAssignments";
import { createInMemoryMemoryRoleAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { createInMemoryModuleConfigStore } from "../src/modules/moduleConfigStore";
import type { SecretStore } from "../src/security/secretStore";

function secretStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async setSecret(ref, value) {
      values.set(ref, value);
      return { ok: true, value: undefined };
    },
    async getSecret(ref) {
      const value = values.get(ref);
      return value === undefined ? { ok: false, error: "missing" } : { ok: true, value };
    },
    async hasSecret(ref) {
      return values.has(ref);
    },
    async deleteSecret(ref) {
      values.delete(ref);
      return { ok: true, value: undefined };
    },
  };
}

function providerRecord(overrides: Record<string, unknown> = {}) {
  const now = "2026-06-12T00:00:00.000Z";
  return {
    id: "openai-compatible:cheap",
    kind: "openai-compatible" as const,
    label: "Cheap endpoint",
    baseUrl: "https://proxy.example.test/v1",
    model: "fast-small",
    secretRef: "openai-compatible:cheap",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeService(options: { withProvider?: boolean; withSecret?: boolean } = {}) {
  const now = "2026-06-12T12:00:00.000Z";
  const providerConfigStore = createInMemoryProviderConfigStore(
    options.withProvider
      ? { version: 1, providers: [providerRecord()], activeRoutes: {} }
      : undefined,
  );
  const memoryConfigStore = createInMemoryMemoryConfigStore();
  const orchestrationAssignmentStore = createInMemoryOrchestrationAssignmentStore();
  const memoryAssignmentStore = createInMemoryMemoryRoleAssignmentStore();
  const moduleConfigStore = createInMemoryModuleConfigStore();
  const service = new TemplateService({
    orchestrationAssignmentStore,
    memoryAssignmentStore,
    providerConfigStore,
    memoryConfigStore,
    secretStore: secretStore(options.withSecret ? { "openai-compatible:cheap": "sk-test-value-not-exported" } : {}),
    moduleConfigStore,
    userTemplateStore: createInMemoryUserTemplateStore(),
    now: () => now,
  });
  return { service, orchestrationAssignmentStore, memoryAssignmentStore, moduleConfigStore };
}

describe("TemplateService", () => {
  it("previews missing providers and missing credentials without reading secret values", async () => {
    const { service } = makeService({ withProvider: true, withSecret: false });

    const preview = await service.preview("cheap-byok");

    expect(preview.valid).toBe(true);
    expect(preview.missingSecrets).toContainEqual(
      expect.objectContaining({ providerId: "openai-compatible:cheap", reason: "provider credential is not stored" }),
    );
    expect(JSON.stringify(preview)).not.toContain("sk-test-value-not-exported");
  });

  it("applies Local Free as a full replacement of assignment records", async () => {
    const { service, orchestrationAssignmentStore, memoryAssignmentStore } = makeService();

    const result = await service.apply("local-free", { mode: "replaceAssignments", confirmReplace: true });

    expect(result.applied).toBe(true);
    expect(result.changed.orchestrationAssignments).toBe(ORCHESTRATION_ROLES.length);
    expect(result.changed.memoryAssignments).toBe(MEMORY_ROLES.length);

    const orchestration = await orchestrationAssignmentStore.listAssignments();
    const memory = await memoryAssignmentStore.listAssignments();
    expect(orchestration).toHaveLength(ORCHESTRATION_ROLES.length);
    expect(memory).toHaveLength(MEMORY_ROLES.length);
    expect(orchestration.every((assignment) => assignment.providerId === "deterministic" || assignment.providerId === "disabled")).toBe(true);
    expect(memory.every((assignment) => assignment.providerRecordId === "local" || assignment.providerRecordId === "disabled")).toBe(true);
  });

  it("mergeMissing preserves existing role assignments", async () => {
    const { service, orchestrationAssignmentStore } = makeService();
    await service.apply("local-free", { mode: "mergeMissing" });
    const first = await orchestrationAssignmentStore.listAssignments();

    const second = await service.apply("cheap-byok", { mode: "mergeMissing" });
    const after = await orchestrationAssignmentStore.listAssignments();

    expect(second.skipped).toContain("orchestration:triage");
    expect(after.find((assignment) => assignment.role === "triage")?.providerId).toBe(
      first.find((assignment) => assignment.role === "triage")?.providerId,
    );
  });

  it("exports current config without secret values", async () => {
    const { service } = makeService({ withProvider: true, withSecret: true });
    await service.apply("cheap-byok", { mode: "mergeMissing" });

    const exported = await service.exportCurrentConfig({ name: "My setup" });
    const text = JSON.stringify(exported);

    expect(exported.name).toBe("My setup");
    expect(text).not.toContain("sk-test-value-not-exported");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("secretRef");
  });

  it("does not count disabled optional provider assignments as missing preview providers", async () => {
    const { service } = makeService({ withProvider: true });

    const preview = await service.preview("cheap-byok");

    expect(preview.missingProviderConfigs.map((item) => item.providerId)).toContain("openai-compatible:mid");
    expect(preview.missingProviderConfigs.map((item) => item.providerId)).not.toContain("chroma:optional");
    expect(preview.externalNetworkImplications.join("\n")).not.toContain("chroma:optional");
  });

  it("handles malformed template JSON as validation/import errors", () => {
    const { service } = makeService();

    expect(service.validate({ template: "{not-json" })).toEqual({
      ok: false,
      issues: [{ path: "template", message: "Template JSON is malformed." }],
    });
    expect(() => service.importTemplate({ template: "{not-json" })).toThrow("Template JSON is malformed.");
  });

  it("keeps scoped module toggle application from mutating global module config", async () => {
    const { service, moduleConfigStore } = makeService();

    const result = await service.apply("local-free", {
      mode: "replaceAssignments",
      confirmReplace: true,
      scopeId: "user-a",
    });

    expect(result.changed.moduleToggles).toBe(0);
    expect(result.skipped).toContain("module:neuro-alive:scoped-scope");
    await expect(moduleConfigStore.getState()).resolves.toEqual({ disabledModuleIds: [], enabledModuleIds: [] });
  });

  it("rejects imported secret-like fields before schema parsing", () => {
    const { service } = makeService();
    const local = BUILT_IN_TEMPLATES.find((template) => template.id === "local-free")!;

    expect(() => service.importTemplate({ ...local, apiKey: "sk-live-1234567890abcdef" })).toThrow(
      TemplateImportSecretError,
    );
  });
});
