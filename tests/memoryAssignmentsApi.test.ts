import { afterAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createLocalSecretStore, type SecretFs, type SecretStore } from "../src/security/secretStore";
import { createInMemoryMemoryConfigStore, type MemoryConfigStore } from "../src/providers/memoryConfigStore";
import { createInMemoryMemoryAssignmentStore, type MemoryAssignmentStore } from "../src/providers/memoryAssignmentStore";

function createInMemorySecretFs(): SecretFs {
  const files = new Map<string, string>();
  return {
    async readFile(path: string): Promise<string | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      const data = files.get(fromPath);
      if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(toPath, data);
      files.delete(fromPath);
    },
    async mkdir(): Promise<void> {
      /* no-op */
    },
  };
}

function makeSecretStore(): SecretStore {
  return createLocalSecretStore({
    filePath: ".rector/secrets.enc",
    encryptionKey: Buffer.alloc(32, 7),
    fsImpl: createInMemorySecretFs(),
  });
}

interface Harness {
  server: http.Server;
  base: string;
  memoryConfigStore: MemoryConfigStore;
  memoryAssignmentStore: MemoryAssignmentStore;
  secretStore: SecretStore;
}

async function startHarness(): Promise<Harness> {
  const secretStore = makeSecretStore();
  const memoryConfigStore = createInMemoryMemoryConfigStore();
  const memoryAssignmentStore = createInMemoryMemoryAssignmentStore();
  const app = createApp(new TaskManager(), { secretStore, memoryConfigStore, memoryAssignmentStore });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://localhost:${port}`, memoryConfigStore, memoryAssignmentStore, secretStore };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => harness.server.close((err) => (err ? reject(err) : resolve())));
}

interface ApiResult {
  status: number;
  data: any;
  text: string;
}

function api(base: string, path: string, opts: { method?: string; body?: string } = {}): Promise<ApiResult> {
  return new Promise<ApiResult>((resolve, reject) => {
    const url = new URL(`${base}${path}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: text ? JSON.parse(text) : {}, text }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("Memory_Assignment_API", () => {
  let harness: Harness;

  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });

  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("lists roles and effective local defaults", async () => {
    const roles = await api(harness.base, "/api/memory-roles");
    expect(roles.status).toBe(200);
    expect(roles.data.roles.map((role: any) => role.role)).toContain("episodicMemory");

    const effective = await api(harness.base, "/api/memory-assignments/effective");
    expect(effective.status).toBe(200);
    expect(effective.data.effective).toHaveLength(7);
    const episodic = effective.data.effective.find((item: any) => item.role === "episodicMemory");
    expect(episodic.provider.kind).toBe("local-inmemory");
    expect(episodic.readiness.ready).toBe(true);
  });

  it("assigns a configured provider to a role and tests it without network", async () => {
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify({ id: "local-sqlite-mem:main", kind: "local-sqlite-mem", label: "Local SQLite", config: {} }),
    });

    const assigned = await api(harness.base, "/api/memory-assignments/semanticMemory", {
      method: "PUT",
      body: JSON.stringify({ providerRecordId: "local-sqlite-mem:main", retentionPolicy: "durable" }),
    });
    expect(assigned.status).toBe(200);
    expect(assigned.data.assignment.role).toBe("semanticMemory");
    expect(assigned.data.assignment.providerRecordId).toBe("local-sqlite-mem:main");
    expect(assigned.data.effective.provider.kind).toBe("local-sqlite-mem");

    const tested = await api(harness.base, "/api/memory-assignments/semanticMemory/test", { method: "POST" });
    expect(tested.status).toBe(200);
    expect(tested.data.ok).toBe(true);
    expect(tested.data.networkAttempted).toBe(false);
  });

  it("does not return submitted provider secrets through assignment endpoints", async () => {
    const secret = "sk-MEMORY-ASSIGNMENT-SECRET-1234567890";
    await api(harness.base, "/api/memory-providers", {
      method: "POST",
      body: JSON.stringify({
        id: "mem0:main",
        kind: "mem0",
        label: "Mem0",
        config: { baseUrl: "https://api.mem0.test" },
        apiKey: secret,
      }),
    });

    const bodies: string[] = [];
    bodies.push(
      (
        await api(harness.base, "/api/memory-assignments/episodicMemory", {
          method: "PUT",
          body: JSON.stringify({ providerRecordId: "mem0:main", maxUsdPerDay: 1 }),
        })
      ).text,
    );
    bodies.push((await api(harness.base, "/api/memory-assignments")).text);
    bodies.push((await api(harness.base, "/api/memory-assignments/effective")).text);
    bodies.push((await api(harness.base, "/api/memory-assignments/episodicMemory/test", { method: "POST" })).text);
    bodies.push((await api(harness.base, "/api/memory-assignments/episodicMemory/migrate/plan", { method: "POST" })).text);

    for (const body of bodies) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("apiKey");
    }
  });

  it("returns a non-destructive migration plan only", async () => {
    const res = await api(harness.base, "/api/memory-assignments/vectorSearch/migrate/plan", {
      method: "POST",
      body: JSON.stringify({ targetProviderRecordId: "local" }),
    });

    expect(res.status).toBe(200);
    expect(res.data.destructive).toBe(false);
    expect(res.data.automaticExecution).toBe(false);
    expect(res.data.steps.join(" ")).toContain("Copy to the target provider in a later migration chunk");
  });
});
