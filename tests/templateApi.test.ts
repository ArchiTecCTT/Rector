import { afterAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import {
  BUILT_IN_TEMPLATES,
  createInMemoryUserTemplateStore,
} from "../src/templates";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { createInMemoryOrchestrationAssignmentStore } from "../src/providers/orchestrationAssignments";
import { createInMemoryMemoryRoleAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { createInMemoryModuleConfigStore } from "../src/modules/moduleConfigStore";
import type { SecretStore } from "../src/security/secretStore";

function secretStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async setSecret(ref, value) {
      values.set(ref, value);
      return { ok: true, value: undefined };
    },
    async getSecret(ref) {
      const value = values.get(ref);
      return value === undefined ? { ok: false, error: "missing" } : { ok: true, value };
    },
    async hasSecret(ref) {
      return values.has(ref);
    },
    async deleteSecret(ref) {
      values.delete(ref);
      return { ok: true, value: undefined };
    },
  };
}

interface Harness {
  server: http.Server;
  base: string;
  orchestrationAssignmentStore: ReturnType<typeof createInMemoryOrchestrationAssignmentStore>;
}

async function startHarness(): Promise<Harness> {
  const orchestrationAssignmentStore = createInMemoryOrchestrationAssignmentStore();
  const app = createApp(new TaskManager(), {
    secretStore: secretStore({}),
    providerConfigStore: createInMemoryProviderConfigStore(),
    memoryConfigStore: createInMemoryMemoryConfigStore(),
    moduleConfigStore: createInMemoryModuleConfigStore(),
    orchestrationAssignmentStore,
    memoryRoleAssignmentStore: createInMemoryMemoryRoleAssignmentStore(),
    userTemplateStore: createInMemoryUserTemplateStore(),
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://localhost:${port}`, orchestrationAssignmentStore };
}

function stopHarness(harness: Harness): Promise<void> {
  return new Promise((resolve, reject) => {
    harness.server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface ApiResult {
  status: number;
  data: any;
  text: string;
}

function api(base: string, path: string, opts: { method?: string; body?: unknown } = {}): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${path}`);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, data: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("Template_API", () => {
  let harness: Harness | undefined;

  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });

  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("lists and previews built-in templates without secret fields", async () => {
    const listed = await api(harness!.base, "/api/templates");
    expect(listed.status).toBe(200);
    expect(listed.data.templates.map((template: any) => template.id)).toContain("local-free");
    expect(listed.text).not.toContain("apiKey");
    expect(listed.text).not.toContain("secretRef");

    const preview = await api(harness!.base, "/api/templates/local-free/preview", { method: "POST", body: {} });
    expect(preview.status).toBe(200);
    expect(preview.data.preview.valid).toBe(true);
    expect(preview.data.preview.missingSecrets).toEqual([]);
    expect(preview.text).not.toContain("[REDACTED]");
  });

  it("applies Local Free and exports the current assignment template", async () => {
    const applied = await api(harness!.base, "/api/templates/local-free/apply", {
      method: "POST",
      body: { mode: "replaceAssignments", confirmReplace: true },
    });
    expect(applied.status).toBe(200);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.changed.orchestrationAssignments).toBeGreaterThan(0);

    const assignments = await harness!.orchestrationAssignmentStore.listAssignments();
    expect(assignments.length).toBeGreaterThan(0);

    const exported = await api(harness!.base, "/api/templates/export/current");
    expect(exported.status).toBe(200);
    expect(exported.data.template.schemaVersion).toBe("rector.template.v1");
    expect(exported.text).not.toContain("apiKey");
    expect(exported.text).not.toContain("secretRef");
  });

  it("rejects imported templates that contain secret-like material", async () => {
    const local = BUILT_IN_TEMPLATES.find((template) => template.id === "local-free")!;
    const res = await api(harness!.base, "/api/templates/import/preview", {
      method: "POST",
      body: { template: { ...local, password: "sk-live-1234567890abcdef" } },
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toContain("secret-like");
    expect(res.text).not.toContain("sk-live-1234567890abcdef");
  });

  it("saves current config as a user template and returns it in the template list", async () => {
    await api(harness!.base, "/api/templates/local-free/apply", {
      method: "POST",
      body: { mode: "replaceAssignments", confirmReplace: true },
    });
    const saved = await api(harness!.base, "/api/templates/save-current", {
      method: "POST",
      body: { id: "my-template", name: "My Template" },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.template.id).toBe("my-template");

    const listed = await api(harness!.base, "/api/templates");
    expect(listed.data.templates.map((template: any) => template.id)).toContain("my-template");
  });
});
