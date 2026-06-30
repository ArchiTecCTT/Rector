import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createDefaultToolRegistry, toolSuccess } from "../src/tools";

describe("Tools API", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const registry = createDefaultToolRegistry();
    registry.register({
      definition: {
        name: "module.hidden",
        description: "module tool should not appear in builtin catalog endpoint",
        inputSchema: {},
        risk: "low",
        requiresApproval: false,
        requiresSandbox: false,
      },
      source: "module",
      moduleId: "module-test",
      handler: async () => toolSuccess("module.hidden"),
    });
    app = createApp(new TaskManager(), { toolRegistry: registry });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns read-only builtin tool metadata without module tools", async () => {
    const response = await fetch(`${base}/api/tools`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "sandbox.execute",
      "workspace.apply_patch",
      "workspace.list_dir",
      "workspace.read_file",
      "workspace.validate",
      "workspace.write_file",
    ]);
    expect(data.tools.some((tool: { name: string }) => tool.name === "module.hidden")).toBe(false);
    expect(JSON.stringify(data)).not.toContain("apiKey");
  });
});
