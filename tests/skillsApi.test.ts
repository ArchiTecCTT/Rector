import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

describe("Skills API", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    app = createApp(new TaskManager());
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

  async function api(path: string) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json" },
    });
    const data = res.ok ? await res.json().catch(() => ({})) : await res.text();
    return { status: res.status, data };
  }

  it("lists bundled skills without bodies or absolute paths", async () => {
    const { status, data } = await api("/api/skills");

    expect(status).toBe(200);
    expect(data.skills.map((skill: { id: string }) => skill.id)).toEqual([
      "engineering-debug",
      "engineering-plan",
      "engineering-tdd",
    ]);
    expect(JSON.stringify(data)).not.toContain(process.cwd());
    expect(JSON.stringify(data)).not.toContain("# Engineering Plan");
  });

  it("returns skill detail with an API-safe manifest", async () => {
    const { status, data } = await api("/api/skills/engineering-plan");

    expect(status).toBe(200);
    expect(data.summary.id).toBe("engineering-plan");
    expect(data.summary.risk).toBe("low");
    expect(data.prerequisitesResolved).toBe(true);
    expect(data.manifest.skillPath).toBe("skills/engineering-plan/SKILL.md");
    expect(JSON.stringify(data)).not.toContain(process.cwd());
  });

  it("returns 404 for unknown skills", async () => {
    const { status } = await api("/api/skills/does-not-exist");

    expect(status).toBe(404);
  });
});
