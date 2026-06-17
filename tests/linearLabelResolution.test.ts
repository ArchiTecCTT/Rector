import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LinearWorkflowAdapter,
  EscalationTicketPayloadSchema,
  clearLabelCache,
  labelCache,
  LABEL_CACHE_TTL_MS,
  LINEAR_LABELS_QUERY,
} from "../src/workflows/index.js";

function makeAdapter(options?: { fetchImpl?: typeof fetch }) {
  return new LinearWorkflowAdapter({
    apiKey: "lin_api_testkey123",
    teamId: "team-uuid-001",
    enableNetwork: true,
    ...options,
  });
}

function makeLabelResponse(nodes: Array<{ id: string; name: string }>) {
  return {
    data: {
      team: {
        labels: { nodes },
      },
    },
  };
}

function mockFetch(responses: unknown[]) {
  let callIndex = 0;
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const response = responses[callIndex++];
    if (response instanceof Error) throw response;
    if ((response as { ok?: boolean }).ok === false) {
      return {
        ok: false,
        status: (response as { status?: number }).status ?? 500,
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  }) as unknown as typeof fetch;
}

describe("Linear label UUID resolution", () => {
  beforeEach(() => {
    clearLabelCache();
  });

  // --- resolveLinearLabelIds ---

  it("resolves label names to UUIDs via Linear GraphQL API", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
      { id: "uuid-rector", name: "rector" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds(["bug", "rector"], "team-uuid-001");
    expect(result).toEqual(["uuid-bug", "uuid-rector"]);
  });

  it("passes through unresolved labels as-is", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds(["bug", "unknown-label"], "team-uuid-001");
    expect(result).toEqual(["uuid-bug", "unknown-label"]);
  });

  it("returns empty array for empty labels input", async () => {
    const fetch = mockFetch([]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds([], "team-uuid-001");
    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches label mapping and does not re-fetch within TTL", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result1 = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result1).toEqual(["uuid-bug"]);
    const result2 = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result2).toEqual(["uuid-bug"]);
    // Only one fetch call (cache hit on second call)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache TTL expires", async () => {
    const fetch = mockFetch([
      makeLabelResponse([{ id: "uuid-bug-v1", name: "bug" }]),
      makeLabelResponse([{ id: "uuid-bug-v2", name: "bug" }]),
    ]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result1 = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result1).toEqual(["uuid-bug-v1"]);

    // Expire the cache
    const cached = labelCache.get("team-uuid-001")!;
    cached.fetchedAt = Date.now() - LABEL_CACHE_TTL_MS - 1000;

    const result2 = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result2).toEqual(["uuid-bug-v2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("separates cache by teamId", async () => {
    const fetch = mockFetch([
      makeLabelResponse([{ id: "uuid-bug-team1", name: "bug" }]),
      makeLabelResponse([{ id: "uuid-bug-team2", name: "bug" }]),
    ]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result1 = await adapter.resolveLinearLabelIds(["bug"], "team-1");
    const result2 = await adapter.resolveLinearLabelIds(["bug"], "team-2");
    expect(result1).toEqual(["uuid-bug-team1"]);
    expect(result2).toEqual(["uuid-bug-team2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to labels as-is when API returns HTTP error", async () => {
    const fetch = mockFetch([{ ok: false, status: 500 }]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds(["bug", "rector"], "team-uuid-001");
    expect(result).toEqual(["bug", "rector"]);
  });

  it("falls back to labels as-is when API returns malformed response", async () => {
    const fetch = mockFetch([{ data: { team: null } }]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result).toEqual(["bug"]);
  });

  it("falls back to labels as-is when fetch throws", async () => {
    const fetch = mockFetch([new Error("Network timeout")]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    const result = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result).toEqual(["bug"]);
  });

  it("falls back to labels as-is when no API key is configured", async () => {
    const fetch = mockFetch([]);
    const adapter = new LinearWorkflowAdapter({
      apiKey: "",
      teamId: "team-uuid-001",
      enableNetwork: true,
      fetchImpl: fetch,
    });
    const result = await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(result).toEqual(["bug"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends correct GraphQL query in the request body", async () => {
    const fetch = mockFetch([makeLabelResponse([])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.query).toContain("team(id: $teamId)");
    expect(body.query).toContain("labels");
    expect(body.variables).toEqual({ teamId: "team-uuid-001" });
  });

  // --- resolveLinearLabelIdsFromCache ---

  it("resolveLinearLabelIdsFromCache returns resolved IDs from cache", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    const result = adapter.resolveLinearLabelIdsFromCache(["bug"], "team-uuid-001");
    expect(result).toEqual(["uuid-bug"]);
  });

  it("resolveLinearLabelIdsFromCache returns labels as-is when no cache", () => {
    const adapter = makeAdapter();
    const result = adapter.resolveLinearLabelIdsFromCache(["bug"], "team-uuid-001");
    expect(result).toEqual(["bug"]);
  });

  it("resolveLinearLabelIdsFromCache returns labels as-is when cache is expired", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    // Expire the cache
    const cached = labelCache.get("team-uuid-001")!;
    cached.fetchedAt = Date.now() - LABEL_CACHE_TTL_MS - 1000;
    const result = adapter.resolveLinearLabelIdsFromCache(["bug"], "team-uuid-001");
    expect(result).toEqual(["bug"]);
  });

  // --- buildCreateIssueRequest integration ---

  it("buildCreateIssueRequest uses resolved label IDs from cache", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
      { id: "uuid-rector", name: "rector" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    // Pre-populate cache via async resolver
    await adapter.resolveLinearLabelIds(["bug", "rector"], "team-uuid-001");

    const payload = EscalationTicketPayloadSchema.parse({
      kind: "escalationTicket",
      title: "Test issue",
      labels: ["bug", "rector"],
      priority: "medium",
    });
    const built = adapter.buildCreateIssueRequest(payload);
    const body = JSON.parse(built.init.body);
    expect(body.variables.input.labelIds).toEqual(["uuid-bug", "uuid-rector"]);
  });

  it("buildCreateIssueRequest passes labels as-is when no cache available", () => {
    const adapter = makeAdapter();
    const payload = EscalationTicketPayloadSchema.parse({
      kind: "escalationTicket",
      title: "Test issue",
      labels: ["bug", "rector"],
      priority: "medium",
    });
    const built = adapter.buildCreateIssueRequest(payload);
    const body = JSON.parse(built.init.body);
    expect(body.variables.input.labelIds).toEqual(["bug", "rector"]);
  });

  // --- Constants ---

  it("LABEL_CACHE_TTL_MS equals 1 hour", () => {
    expect(LABEL_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("LINEAR_LABELS_QUERY contains team labels query structure", () => {
    expect(LINEAR_LABELS_QUERY).toContain("team(id: $teamId)");
    expect(LINEAR_LABELS_QUERY).toContain("labels");
    expect(LINEAR_LABELS_QUERY).toContain("nodes");
    expect(LINEAR_LABELS_QUERY).toContain("id");
    expect(LINEAR_LABELS_QUERY).toContain("name");
  });

  // --- clearLabelCache ---

  it("clearLabelCache clears all cached entries", async () => {
    const fetch = mockFetch([makeLabelResponse([
      { id: "uuid-bug", name: "bug" },
    ])]);
    const adapter = makeAdapter({ fetchImpl: fetch });
    await adapter.resolveLinearLabelIds(["bug"], "team-uuid-001");
    expect(labelCache.has("team-uuid-001")).toBe(true);
    clearLabelCache();
    expect(labelCache.has("team-uuid-001")).toBe(false);
  });
});
