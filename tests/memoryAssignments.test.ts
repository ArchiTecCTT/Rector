import { describe, expect, it } from "vitest";

import {
  MEMORY_ROLES,
  MemoryRoleSchema,
  createMemoryRoleAssignment,
} from "../src/providers/memoryAssignments";
import { createInMemoryMemoryAssignmentStore, selectMemoryAssignmentForRole } from "../src/providers/memoryAssignmentStore";

const NOW = "2026-06-12T12:00:00.000Z";

describe("Memory role assignment schema/store", () => {
  it("declares the canonical Chunk 044 memory roles", () => {
    expect(MEMORY_ROLES).toEqual([
      "conversationStore",
      "episodicMemory",
      "semanticMemory",
      "truthLibrary",
      "vectorSearch",
      "reflectionLessons",
      "artifactIndex",
    ]);
    expect(MemoryRoleSchema.parse("episodicMemory")).toBe("episodicMemory");
    expect(() => MemoryRoleSchema.parse("unknownRole")).toThrow();
  });

  it("upserts non-secret provider links and resets them", async () => {
    const store = createInMemoryMemoryAssignmentStore();
    const assignment = createMemoryRoleAssignment({
      role: "episodicMemory",
      providerRecordId: "local",
      now: NOW,
    });

    const result = await store.upsertAssignment(assignment);
    expect(result.ok).toBe(true);
    expect((await store.listAssignments())[0]).toMatchObject({
      role: "episodicMemory",
      providerRecordId: "local",
      enabled: true,
    });

    await store.resetAssignments();
    expect(await store.listAssignments()).toEqual([]);
  });

  it("selects the most specific per-user/workspace assignment", async () => {
    const store = createInMemoryMemoryAssignmentStore();
    await store.upsertAssignment(createMemoryRoleAssignment({ role: "semanticMemory", providerRecordId: "local", now: NOW }));
    await store.upsertAssignment(
      createMemoryRoleAssignment({
        role: "semanticMemory",
        providerRecordId: "mem0:alice",
        userId: "alice",
        now: "2026-06-12T12:01:00.000Z",
      }),
    );
    await store.upsertAssignment(
      createMemoryRoleAssignment({
        role: "semanticMemory",
        providerRecordId: "chroma:alice-project",
        userId: "alice",
        workspaceId: "project",
        now: "2026-06-12T12:02:00.000Z",
      }),
    );

    const assignments = await store.listAssignments();
    expect(selectMemoryAssignmentForRole(assignments, { role: "semanticMemory", userId: "alice" })?.providerRecordId)
      .toBe("mem0:alice");
    expect(
      selectMemoryAssignmentForRole(assignments, { role: "semanticMemory", userId: "alice", workspaceId: "project" })
        ?.providerRecordId,
    ).toBe("chroma:alice-project");
    expect(selectMemoryAssignmentForRole(assignments, { role: "semanticMemory", userId: "bob" })?.providerRecordId)
      .toBe("local");
  });

  it("preserves existing user/workspace scope when updating an assignment", () => {
    const existing = createMemoryRoleAssignment({
      role: "semanticMemory",
      providerRecordId: "local",
      userId: "alice",
      workspaceId: "project",
      now: NOW,
    });

    const updated = createMemoryRoleAssignment({
      role: "semanticMemory",
      providerRecordId: "mem0:alice-project",
      existing,
      now: "2026-06-12T12:30:00.000Z",
    });

    expect(updated).toMatchObject({
      id: existing.id,
      userId: "alice",
      workspaceId: "project",
      providerRecordId: "mem0:alice-project",
    });
  });
});
