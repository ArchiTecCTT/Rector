import { beforeEach, describe, expect, it } from "vitest";

import { createProviderPanelHarness, jsonResponse, type ProviderPanelHarness } from "./support/providerPanelHarness";

type AnyEl = any;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ROLES = [
  { role: "conversationStore", label: "Conversation store", purpose: "conversations" },
  { role: "episodicMemory", label: "Episodic memory", purpose: "episodes" },
  { role: "semanticMemory", label: "Semantic memory", purpose: "knowledge" },
  { role: "truthLibrary", label: "Truth library", purpose: "truth" },
  { role: "vectorSearch", label: "Vector search", purpose: "vectors" },
  { role: "reflectionLessons", label: "Reflection lessons", purpose: "lessons" },
  { role: "artifactIndex", label: "Artifact index", purpose: "artifacts" },
];

function effective(role: string, providerRecordId = "local") {
  return {
    role,
    status: "ready",
    source: "localFallback",
    providerRecordId,
    provider: { id: "local-inmemory:default", kind: "local-inmemory", label: "Local (in-memory)" },
    readiness: { ready: true, status: "ready" },
    warnings: [],
  };
}

function rowFor(harness: ProviderPanelHarness, role: string): AnyEl {
  return harness
    .getEl("memory-assignment-matrix")
    .querySelectorAll(".memory-assignment-row")
    .find((row: AnyEl) => row.dataset.role === role);
}

describe("Memory_Assignment_UI", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
  });

  it("renders a role/provider matrix with local defaults and configured providers", async () => {
    harness.setFetchHandler(async (url) => {
      if (url === "/api/memory-providers") {
        return jsonResponse({
          providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
          activeMemoryProviderId: null,
        });
      }
      if (url === "/api/memory-assignments") {
        return jsonResponse({ roles: ROLES, assignments: [], providers: [] });
      }
      if (url === "/api/memory-assignments/effective") {
        return jsonResponse({ roles: ROLES, effective: ROLES.map((role) => effective(role.role)) });
      }
      return jsonResponse({});
    });

    await harness.sandbox.loadMemoryProviderConfig();

    const rows = harness.getEl("memory-assignment-matrix").querySelectorAll(".memory-assignment-row");
    expect(rows).toHaveLength(7);
    const episodic = rowFor(harness, "episodicMemory");
    expect(episodic.querySelector(".provider-config-card__name").textContent).toBe("Episodic memory");
    const select = episodic.querySelector(".memory-assignment-provider");
    expect(select.value).toBe("local");
    expect(select.querySelectorAll("option").map((option: AnyEl) => option.value)).toContain("mem0:main");
  });

  it("saves a role assignment by provider id without sending secrets", async () => {
    let capturedBody: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/memory-providers") {
        return jsonResponse({
          providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
          activeMemoryProviderId: null,
        });
      }
      if (url === "/api/memory-assignments" && (!opts.method || opts.method === "GET")) {
        return jsonResponse({ roles: ROLES, assignments: [], providers: [] });
      }
      if (url === "/api/memory-assignments/effective") {
        return jsonResponse({ roles: ROLES, effective: ROLES.map((role) => effective(role.role)) });
      }
      if (url === "/api/memory-assignments/episodicMemory" && opts.method === "PUT") {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({
          assignment: { role: "episodicMemory", providerRecordId: capturedBody.providerRecordId },
          effective: effective("episodicMemory", capturedBody.providerRecordId),
        });
      }
      return jsonResponse({});
    });

    await harness.sandbox.loadMemoryProviderConfig();
    const episodic = rowFor(harness, "episodicMemory");
    const select = episodic.querySelector(".memory-assignment-provider");
    select.value = "mem0:main";
    episodic.querySelector(".memory-assignment-save").dispatch("click");
    await flush();

    expect(capturedBody).toEqual({ providerRecordId: "mem0:main" });
    expect(JSON.stringify(capturedBody)).not.toContain("secret");
    expect(JSON.stringify(capturedBody)).not.toContain("apiKey");
  });
});
