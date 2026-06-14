import { describe, expect, it } from "vitest";

import {
  InMemoryTruthLibrary,
  truthItemHasValidCitation,
  validateCitation,
  validateProvenance,
  type TruthRetriever,
} from "../src/memory/truthLibrary";

const NOW = "2026-06-10T12:00:00.000Z";

describe("Truth Library ranking hardening", () => {
  it("excludes rejected items by default but allows explicit rejected inclusion", () => {
    const library = new InMemoryTruthLibrary({ now: () => NOW });
    library.upsert({
      id: "trusted",
      kind: "doc",
      title: "Planner architecture",
      content: "Planner architecture facts.",
      status: "TRUSTED",
      provenance: { source: "docs/planner.md", sourceType: "file" },
      tags: ["planner"],
    });
    library.upsert({
      id: "rejected",
      kind: "doc",
      title: "Planner architecture rejected",
      content: "Planner architecture false claim.",
      status: "REJECTED",
      provenance: { source: "stale-doc", sourceType: "file" },
      tags: ["planner", "stale"],
    });

    expect(library.search({ query: "planner architecture" }).map((result) => result.item.id)).toEqual([
      "trusted",
    ]);
    expect(library.search({ query: "planner architecture", includeRejected: true }).map((result) => result.item.id))
      .toEqual(["trusted", "rejected"]);
  });

  it("boosts trusted provenance with valid citations over unverified keyword overlap", () => {
    const library = new InMemoryTruthLibrary({ now: () => NOW });
    library.upsert({
      id: "unverified-overlap",
      kind: "memory",
      title: "Rector memory planner planner",
      content: "Planner planner memory has lots of planner keyword overlap.",
      status: "UNVERIFIED",
      provenance: { source: "chat", sourceType: "user" },
      tags: ["planner"],
    });
    library.upsert({
      id: "trusted-cited",
      kind: "doc",
      title: "Rector planner",
      content: "Planner memory is supported by architecture documentation.",
      status: "TRUSTED",
      provenance: {
        source: "docs/architecture.md",
        sourceType: "file",
        citations: [{ title: "Architecture", uri: "file:///docs/architecture.md", quote: "Planner memory" }],
      },
      citations: [{ title: "Planner contract", uri: "file:///docs/planner.md", quote: "Planner memory" }],
      tags: ["planner"],
    });

    const results = library.search({ query: "planner memory" });
    expect(results[0]?.item.id).toBe("trusted-cited");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(truthItemHasValidCitation(results[0]!.item)).toBe(true);
  });

  it("penalizes stale docs and keeps deterministic ordering on ties", () => {
    const library = new InMemoryTruthLibrary({ now: () => NOW });
    library.upsert({
      id: "b-fresh",
      kind: "doc",
      title: "Deployment memory",
      content: "Deployment memory guidance.",
      status: "TRUSTED",
      provenance: { source: "docs/deploy.md", sourceType: "file" },
      tags: ["deployment"],
      updatedAt: "2026-06-10T12:00:00.000Z",
    });
    library.upsert({
      id: "a-fresh",
      kind: "doc",
      title: "Deployment memory",
      content: "Deployment memory guidance.",
      status: "TRUSTED",
      provenance: { source: "docs/deploy-2.md", sourceType: "file" },
      tags: ["deployment"],
      updatedAt: "2026-06-10T12:00:00.000Z",
    });
    library.upsert({
      id: "stale",
      kind: "doc",
      title: "Deprecated deployment memory",
      content: "Deployment memory guidance.",
      status: "TRUSTED",
      provenance: { source: "stale-doc", sourceType: "file" },
      tags: ["deployment", "stale"],
      updatedAt: "2026-06-10T12:00:00.000Z",
    });

    const results = library.search({ query: "deployment memory" });
    expect(results.map((result) => result.item.id)).toEqual(["a-fresh", "b-fresh", "stale"]);
    expect(results[1]!.score).toBeGreaterThan(results[2]!.score);
  });

  it("exports adapter-neutral TruthRetriever and citation/provenance validation helpers", () => {
    const library: TruthRetriever = new InMemoryTruthLibrary({ now: () => NOW });
    expect(library.search({ query: "nothing" })).toEqual([]);

    expect(validateCitation({ title: "Valid", uri: "file:///docs/valid.md" })).toEqual({
      valid: true,
      reasons: [],
    });
    expect(validateCitation({ title: "Invalid", uri: "not a uri" }).valid).toBe(false);
    expect(validateProvenance({ source: "docs", sourceType: "file", citations: [{ title: "Valid" }] })).toEqual({
      valid: true,
      reasons: [],
    });
  });
});
