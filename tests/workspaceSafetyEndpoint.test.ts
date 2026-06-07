// Unit tests for the Workspace Safety endpoint (`GET /api/setup/workspace`, Requirement 3).
//
// The existing `tests/workspaceSafety.test.ts` exercises the pure builder
// (`buildWorkspaceSafetyResponse`) for policy rendering, redaction (Req 3.7), and the
// unavailable-root cases. This suite deliberately does NOT repeat those builder assertions.
// Instead it covers the two behaviors task 5.3 calls out at the live HTTP surface that the
// Workspace_Safety_Panel actually consumes:
//
//   - Req 3.6  the no-exec-control invariant: the safety surface is read-only status data. Its
//              payload carries no executable affordance, and the HTTP surface exposes no
//              command-execution / mutation route — so a panel built on it cannot run a command.
//   - Req 3.8  the unavailable state: when the configured workspace root / policy cannot be
//              retrieved, the endpoint reports `available:false` with no workspace action surface.
//
// There is no Workspace_Safety_Panel client harness yet (task 5.2), so panel coverage is deferred;
// these tests pin the endpoint contract the panel relies on. Zero network/provider calls: the app
// runs against an injected deterministic `WorkspaceSafetyConfig` and the in-memory store.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type express from "express";

import { createApp, type WorkspaceSafetyConfig } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

// The exact, documented read-only field set of a WorkspaceSafetyResponse. The panel renders only
// status; any field outside this set (e.g. an action handler or an exec endpoint) would be an
// execution affordance and violate Req 3.6.
const ALLOWED_RESPONSE_KEYS = [
  "workspaceRoot",
  "allowlistedCommands",
  "destructiveProtection",
  "approvalRequiredCategories",
  "available",
].sort();

interface RunningApp {
  base: string;
  close: () => Promise<void>;
}

/** Start the API over an injected workspace-safety config and return its base URL + a closer. */
async function startApp(workspaceSafety: WorkspaceSafetyConfig): Promise<RunningApp> {
  const manager = new TaskManager();
  const app: express.Application = createApp(manager, { workspaceSafety });
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("GET /api/setup/workspace endpoint", () => {
  let running: RunningApp | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  describe("no-exec-control invariant (Req 3.6)", () => {
    beforeEach(async () => {
      running = await startApp({
        workspaceRoot: "/srv/rector/workspace",
        allowlistedCommands: ["npm:build", "npm:test"],
        riskyCommands: ["git:push"],
        destructiveProtectionEnabled: true,
      });
    });

    it("returns only read-only status fields with no executable affordance", async () => {
      const res = await fetch(`${running!.base}/api/setup/workspace`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      // The payload is exactly the documented read-only field set — nothing that names or carries a
      // command-execution control (e.g. no `run`/`exec`/`command`/`action`/`endpoint`).
      expect(Object.keys(body).sort()).toEqual(ALLOWED_RESPONSE_KEYS);

      // Every value is plain JSON status data: string, string[], or boolean. A function/handler
      // would be an exec affordance — and JSON cannot carry one, which is the point: the panel only
      // ever receives inert data.
      for (const value of Object.values(body)) {
        const isStringArray = Array.isArray(value) && value.every((v) => typeof v === "string");
        expect(typeof value === "string" || typeof value === "boolean" || isStringArray).toBe(true);
      }

      // The approval-required categories describe *policy*, not invokable actions.
      expect(body.approvalRequiredCategories).toEqual(["FILE_WRITE", "COMMAND"]);
      expect(body.available).toBe(true);
    });

    it("exposes no command-execution or mutation route on the safety surface", async () => {
      // A read-only surface answers GET only. Any attempt to drive execution/mutation through the
      // workspace-safety path is not an accepted route (no exec control from the UI, Req 3.6).
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await fetch(`${running!.base}/api/setup/workspace`, { method });
        expect(res.status).toBe(404);
      }

      // There is likewise no command-run sub-route hanging off the safety surface.
      for (const path of ["/api/setup/workspace/run", "/api/setup/workspace/execute"]) {
        const res = await fetch(`${running!.base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "rm -rf /" }),
        });
        expect(res.status).toBe(404);
      }
    });
  });

  describe("unavailable state (Req 3.8)", () => {
    it("reports available:false with no workspace action surface when the root is missing", async () => {
      running = await startApp({ workspaceRoot: "" });

      const res = await fetch(`${running.base}/api/setup/workspace`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      // Still only the documented read-only fields (no action controls leak in on the error path).
      expect(Object.keys(body).sort()).toEqual(ALLOWED_RESPONSE_KEYS);

      // The panel renders an "unavailable" error state and presents no workspace actions: no root,
      // no allowlist, and no approval-required policy to act on.
      expect(body.available).toBe(false);
      expect(body.workspaceRoot).toBe("");
      expect(body.allowlistedCommands).toEqual([]);
      expect(body.approvalRequiredCategories).toEqual([]);
    });
  });
});
