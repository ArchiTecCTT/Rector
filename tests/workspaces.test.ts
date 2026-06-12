import { describe, expect, it } from "vitest";

import { createInMemoryWorkspaceDirectory } from "../src/security/workspaces";

describe("workspace directory semantics", () => {
  it("does not auto-provision personal workspaces when disabled", async () => {
    const directory = createInMemoryWorkspaceDirectory({ autoProvisionPersonalWorkspaces: false });

    await expect(directory.getDefaultWorkspaceForUser("alice")).rejects.toThrow(/No default workspace/);
    expect(await directory.listWorkspacesForUser("alice")).toEqual([]);
    expect(await directory.getMembership("alice", "user-alice")).toBeUndefined();
  });

  it("returns a user's personal workspace as the default instead of an arbitrary existing membership", async () => {
    const directory = createInMemoryWorkspaceDirectory();
    const team = await directory.createWorkspace({ id: "team-1", name: "Team", ownerUserId: "owner" });
    await directory.addMembership({ workspaceId: team.id, userId: "alice", role: "developer" });

    const personal = await directory.getDefaultWorkspaceForUser("alice");

    expect(personal.id).toBe("user-alice");
    expect(personal.ownerUserId).toBe("alice");
    expect(personal.id).not.toBe(team.id);
    expect((await directory.getMembership("alice", personal.id))?.role).toBe("owner");
  });

  it("avoids generated id collisions and rejects explicit duplicate workspace ids", async () => {
    const directory = createInMemoryWorkspaceDirectory({
      workspaces: [{ id: "ws-1", name: "Existing", ownerUserId: "alice", createdAt: "2026-06-12T00:00:00.000Z", updatedAt: "2026-06-12T00:00:00.000Z" }],
    });

    const created = await directory.createWorkspace({ name: "Next", ownerUserId: "alice" });
    expect(created.id).toBe("ws-2");
    await expect(directory.createWorkspace({ id: "ws-1", name: "Duplicate", ownerUserId: "alice" })).rejects.toThrow(/already exists/);
  });

  it("keeps personal workspace ids distinct when sanitized user ids would collide", async () => {
    const directory = createInMemoryWorkspaceDirectory();

    const first = await directory.getDefaultWorkspaceForUser("a/b");
    const second = await directory.getDefaultWorkspaceForUser("a_b");

    expect(first.id).not.toBe(second.id);
    expect(first.ownerUserId).toBe("a/b");
    expect(second.ownerUserId).toBe("a_b");
  });
});
