import { describe, expect, it } from "vitest";

import { BUILT_IN_TEMPLATES } from "../src/templates";
import { createProviderPanelHarness, jsonResponse, type ProviderPanelHarness } from "./support/providerPanelHarness";

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function localTemplate() {
  return BUILT_IN_TEMPLATES.find((template) => template.id === "local-free")!;
}

function previewPayload() {
  return {
    template: localTemplate(),
    valid: true,
    validationIssues: [],
    changes: {
      orchestrationAssignments: [
        { role: "triage", action: "add", from: null, to: localTemplate().orchestrationAssignments[0] },
        { role: "planner", action: "add", from: null, to: localTemplate().orchestrationAssignments[1] },
      ],
      memoryAssignments: [
        { role: "conversationStore", action: "add", from: null, to: localTemplate().memoryAssignments[0] },
      ],
      moduleToggles: [],
    },
    missingProviderConfigs: [],
    missingSecrets: [],
    capabilityMismatches: [],
    externalNetworkImplications: [],
    estimatedCostTier: "free",
    warnings: [],
    rollbackSnapshotId: "template-preview:default:local-free",
  };
}

describe("Template_Manager_UI", () => {
  it("loads built-in templates and renders a preview summary", async () => {
    const harness: ProviderPanelHarness = createProviderPanelHarness();
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/templates") return jsonResponse({ templates: [localTemplate()] });
      if (url === "/api/templates/local-free/preview" && opts.method === "POST") {
        return jsonResponse({ preview: previewPayload() });
      }
      return jsonResponse({});
    });

    harness.sandbox.openTemplateManager();
    await flush();

    expect(harness.getEl("template-manager-modal").hidden).toBe(false);
    const cards = harness.getEl("template-manager-gallery").querySelectorAll(".template-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".provider-config-card__name").textContent).toContain("Local Free");
    expect(harness.getEl("template-manager-preview-title").textContent).toBe("Local Free");
    expect(harness.getEl("template-manager-preview-summary").textContent).toContain("2 orchestration changes");
    expect(harness.getEl("template-manager-preview-summary").textContent).toContain("0 missing secrets");
  });

  it("applies the selected template through the Template_API", async () => {
    const harness = createProviderPanelHarness();
    let capturedApply: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/templates") return jsonResponse({ templates: [localTemplate()] });
      if (url === "/api/templates/local-free/preview") return jsonResponse({ preview: previewPayload() });
      if (url === "/api/templates/local-free/apply") {
        capturedApply = JSON.parse(opts.body);
        return jsonResponse({
          applied: true,
          template: localTemplate(),
          preview: previewPayload(),
          changed: { orchestrationAssignments: 2, memoryAssignments: 1, moduleToggles: 0 },
        });
      }
      return jsonResponse({});
    });

    harness.sandbox.openTemplateManager();
    await flush();
    harness.getEl("template-manager-apply").dispatch("click");
    await flush();

    expect(capturedApply).toEqual({ mode: "mergeMissing", confirmReplace: false });
    expect(harness.getEl("template-manager-result").textContent).toContain("Applied Local Free");
  });

  it("applies the current import text instead of a stale preview cache", async () => {
    const harness = createProviderPanelHarness();
    const previewed = { ...localTemplate(), id: "previewed-import", name: "Previewed Import" };
    const edited = { ...localTemplate(), id: "edited-import", name: "Edited Import" };
    const textarea = harness.getEl("template-manager-import-json");
    let capturedApply: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/templates/import/preview") {
        return jsonResponse({ template: previewed, preview: { ...previewPayload(), template: previewed } });
      }
      if (url === "/api/templates/import/apply") {
        capturedApply = JSON.parse(opts.body);
        return jsonResponse({
          applied: true,
          template: edited,
          preview: { ...previewPayload(), template: edited },
          changed: { orchestrationAssignments: 1, memoryAssignments: 0, moduleToggles: 0 },
        });
      }
      if (url === "/api/templates") return jsonResponse({ templates: [localTemplate()] });
      if (url === "/api/templates/local-free/preview") return jsonResponse({ preview: previewPayload() });
      return jsonResponse({});
    });

    textarea.value = JSON.stringify(previewed);
    await harness.sandbox.previewImportedTemplate();
    await flush();
    textarea.value = JSON.stringify(edited);
    await harness.sandbox.applyImportedTemplate();
    await flush();

    expect(capturedApply.template.id).toBe("edited-import");
    expect(capturedApply.template.name).toBe("Edited Import");
  });

  it("renders imported-template secret rejection without storing the secret in browser storage", async () => {
    const harness = createProviderPanelHarness();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const textarea = harness.getEl("template-manager-import-json");
    textarea.value = JSON.stringify({ ...localTemplate(), description: secret });
    harness.sandbox.localStorage = { setItem: () => { throw new Error("should not write localStorage"); } };
    harness.sandbox.sessionStorage = { setItem: () => { throw new Error("should not write sessionStorage"); } };
    harness.setFetchHandler(async (url) => {
      if (url === "/api/templates/import/preview") {
        return jsonResponse(
          { error: "Template import rejected because it contains secret-like fields or values." },
          { status: 400 },
        );
      }
      return jsonResponse({});
    });

    await harness.sandbox.previewImportedTemplate();
    await flush();

    const result = harness.getEl("template-manager-result");
    expect(result.className).toContain("provider-config-result--err");
    expect(result.textContent).toContain("secret-like");
    expect(result.textContent).not.toContain(secret);
  });
});
