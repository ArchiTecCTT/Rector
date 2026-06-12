import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { BUILT_IN_TEMPLATES, TemplateImportSecretError, TemplateService } from "../src/templates";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { createInMemoryOrchestrationAssignmentStore } from "../src/providers/orchestrationAssignments";
import { createInMemoryMemoryRoleAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { createInMemoryModuleConfigStore } from "../src/modules/moduleConfigStore";
import type { SecretStore } from "../src/security/secretStore";

const emptySecretStore: SecretStore = {
  async setSecret() {
    return { ok: true, value: undefined };
  },
  async getSecret() {
    return { ok: false, error: "missing" };
  },
  async hasSecret() {
    return false;
  },
  async deleteSecret() {
    return { ok: true, value: undefined };
  },
};

function service() {
  return new TemplateService({
    orchestrationAssignmentStore: createInMemoryOrchestrationAssignmentStore(),
    memoryAssignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    providerConfigStore: createInMemoryProviderConfigStore(),
    memoryConfigStore: createInMemoryMemoryConfigStore(),
    secretStore: emptySecretStore,
    moduleConfigStore: createInMemoryModuleConfigStore(),
  });
}

describe("template import secret guard", () => {
  it("rejects arbitrary secret-like field names", () => {
    const base = BUILT_IN_TEMPLATES.find((template) => template.id === "__test_profile__")!;
    fc.assert(
      fc.property(
        fc.constantFrom("apiKey", "token", "password", "secretRef", "authorization", "connectionString"),
        fc.string({ minLength: 1, maxLength: 40 }),
        (field, value) => {
          const input = { ...base, [field]: value || "not-empty" };
          expect(() => service().importTemplate(input)).toThrow(TemplateImportSecretError);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("rejects arbitrary OpenAI-style secret values anywhere in the template tree", () => {
    const base = BUILT_IN_TEMPLATES.find((template) => template.id === "__test_profile__")!;
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{16,32}$/), (suffix) => {
        const input = {
          ...base,
          description: `safe words sk-${suffix}`,
        };
        expect(() => service().importTemplate(input)).toThrow(TemplateImportSecretError);
      }),
      { numRuns: 40 },
    );
  });

  it("never includes the rejected secret value in the thrown error message", () => {
    const base = BUILT_IN_TEMPLATES.find((template) => template.id === "__test_profile__")!;
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    try {
      service().importTemplate({ ...base, description: secret });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateImportSecretError);
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
