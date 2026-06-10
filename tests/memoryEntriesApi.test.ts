/**
 * Chunk 36 stretch — GET /api/memory/entries tests.
 *
 * Exercises the read-only memory browser list route over a real Express app with
 * injected in-memory stores. ZERO disk and network.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fc from "fast-check";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createLocalSecretStore, type SecretFs, type SecretStore } from "../src/security/secretStore";
import {
  createInMemoryMemoryConfigStore,
  type MemoryConfigStore,
} from "../src/providers/memoryConfigStore";
import { MEMORY_ENTRIES_API_LIMIT } from "../src/api/server";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

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
      if (data === undefined) {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
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
}

async function startHarness(): Promise<Harness> {
  const secretStore = makeSecretStore();
  const configStore = createInMemoryMemoryConfigStore();
  const app = await createApp(new TaskManager(), { secretStore, memoryConfigStore: configStore });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://localhost:${port}` };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err ? reject(err) : resolve()));
  });
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
        res.on("end", () => {
          const data = text ? JSON.parse(text) : {};
          resolve({ status: res.statusCode ?? 0, data, text });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("Memory_Entries_API — GET /api/memory/entries", () => {
  let harness: Harness;

  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });
  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("returns an empty list when no entries exist", async () => {
    const res = await api(harness.base, "/api/memory/entries");
    expect(res.status).toBe(200);
    expect(res.data.entries).toEqual([]);
    expect(res.data.count).toBe(0);
    expect(res.data.provider.kind).toBe("local-inmemory");
  });

  it("lists episodic entries created via POST /api/notes", async () => {
    await api(harness.base, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: "Remember pagination on the users API" }),
    });
    await api(harness.base, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: "Ship memory browser stretch goal" }),
    });

    const res = await api(harness.base, "/api/memory/entries?layer=episodic");
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(2);
    expect(res.data.entries).toHaveLength(2);
    for (const entry of res.data.entries) {
      expect(entry.layer).toBe("episodic");
      expect(typeof entry.content).toBe("string");
      expect(entry.id).toBeTruthy();
    }
    const contents = res.data.entries.map((e: { content: string }) => e.content).join(" ");
    expect(contents).toContain("pagination");
    expect(contents).toContain("memory browser");
  });

  it("filters core layer separately from episodic", async () => {
    await api(harness.base, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: "Episodic only note" }),
    });

    const episodic = await api(harness.base, "/api/memory/entries?layer=episodic");
    const core = await api(harness.base, "/api/memory/entries?layer=core");

    expect(episodic.data.count).toBe(1);
    expect(core.data.count).toBe(0);
  });

  it("rejects invalid layer query values", async () => {
    const res = await api(harness.base, "/api/memory/entries?layer=working");
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("episodic or core");
  });

  it("never returns submitted API keys in list responses", async () => {
    const secret = "sk-MEMORY-LIST-egress-test-key-123456";

    await api(harness.base, "/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: `Use apiKey=${secret} for memory` }),
    });

    const res = await api(harness.base, "/api/memory/entries");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(secret);
    expect(res.data.entries[0].content).not.toContain(secret);
    expect(res.data.entries[0].content).toContain("[REDACTED]");
  });

  it(
    "caps results at MEMORY_ENTRIES_API_LIMIT even when more entries exist",
    async () => {
      const overLimit = MEMORY_ENTRIES_API_LIMIT + 5;
      for (let i = 0; i < overLimit; i += 1) {
        await api(harness.base, "/api/notes", {
          method: "POST",
          body: JSON.stringify({ content: `bulk note ${i}` }),
        });
      }

      const res = await api(harness.base, "/api/memory/entries?layer=episodic");
      expect(res.status).toBe(200);
      expect(res.data.entries).toHaveLength(MEMORY_ENTRIES_API_LIMIT);
      expect(res.data.count).toBe(MEMORY_ENTRIES_API_LIMIT);
    },
    120_000,
  );

  it(
    "never leaks arbitrary submitted secrets across generated note bodies",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbKeyLikeSecret(), async (secret) => {
          if (harness) await stopHarness(harness);
          harness = await startHarness();

          await api(harness.base, "/api/notes", {
            method: "POST",
            body: JSON.stringify({ content: `apiKey=${secret}` }),
          });

          const res = await api(harness.base, "/api/memory/entries");
          expect(res.text).not.toContain(secret);
        }),
        { numRuns: 25 },
      );
    },
    120_000,
  );
});