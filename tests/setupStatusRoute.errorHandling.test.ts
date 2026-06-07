// Unit tests for the `GET /api/setup/status` route's error handling (task 2.5).
//
// Validates (by example): Requirements 1.8, 1.10
//
// These exercise the wired Express route end-to-end over an injected SecretStore double, so
// they make zero network/provider calls and touch no disk. Two behaviors are covered:
//   - Internal-error structured response (Req 1.8): when the status composer throws, the route
//     responds with a structured, redacted error state (HTTP 500 + `{ error }`) instead of
//     crashing or leaking an unstructured failure.
//   - Redacted value omission (Req 1.10): no secret value is ever returned by the route. Secret
//     material embedded in an internal error message is redacted out of the error response, and
//     the success response carries presence booleans only — never a secret value.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";

import { createApp, type ApiSecurityOptions } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

/**
 * A {@link SecretStore} double whose `hasSecret` rejects, forcing `computeSetupStatus` to throw so
 * the route's catch block is exercised. The rejection message can carry secret material to prove
 * the error response is redacted before it leaves the process.
 */
function throwingSecretStore(message: string): SecretStore {
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      return { ok: false, error: "unused" };
    },
    async hasSecret(): Promise<boolean> {
      throw new Error(message);
    },
  };
}

/**
 * A {@link SecretStore} double reporting a fixed set of provider ids as present. `getSecret` would
 * surface a value if called, but the route consults `hasSecret` only — so this verifies the route
 * returns presence booleans without ever reaching for a secret value.
 */
function presenceSecretStore(presentProviderIds: string[]): SecretStore {
  const present = new Set(presentProviderIds);
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      // If the route ever called this, it would expose a secret value — it must not.
      return { ok: true, value: "sk-should-never-be-returned-by-route" };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return present.has(providerId);
    },
  };
}

/** Spin up a fresh server bound to an ephemeral port with the given security options. */
async function startServer(securityOptions: ApiSecurityOptions): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const app: express.Application = createApp(new TaskManager(), securityOptions);
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return {
    base: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function getStatus(base: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}/api/setup/status`);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

describe("GET /api/setup/status error handling", () => {
  describe("internal-error structured response (Req 1.8)", () => {
    let base: string;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ base, close } = await startServer({ secretStore: throwingSecretStore("setup backing unavailable") }));
    });

    afterAll(async () => {
      await close();
    });

    it("responds with HTTP 500 and a structured error body when the composer throws", async () => {
      const { status, data } = await getStatus(base);

      expect(status).toBe(500);
      expect(typeof data.error).toBe("string");
      expect(data.error.length).toBeGreaterThan(0);
      // A structured error state, not the success payload.
      expect(data.mode).toBeUndefined();
      expect(data.categories).toBeUndefined();
    });
  });

  describe("redacted value omission in the error path (Req 1.8, 1.10)", () => {
    const SECRET = "sk-live-SUPER-SECRET-TOKEN-9f8a7b6c";
    let base: string;
    let close: () => Promise<void>;

    beforeAll(async () => {
      // Secret material smuggled into an internal failure message must be scrubbed, never returned.
      const message = `setup backing failed: Authorization: Bearer ${SECRET}`;
      ({ base, close } = await startServer({ secretStore: throwingSecretStore(message) }));
    });

    afterAll(async () => {
      await close();
    });

    it("omits the raw secret from the returned error and uses the redaction placeholder", async () => {
      const { status, data } = await getStatus(base);

      expect(status).toBe(500);
      expect(typeof data.error).toBe("string");
      // The raw secret substring must not appear anywhere in the serialized response (Req 1.10).
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toMatch(/Bearer\s+sk-/);
      expect(data.error).toContain("[REDACTED]");
    });
  });

  describe("success path returns presence booleans only, never a value (Req 1.10)", () => {
    const ENV_SECRET = "sk-env-secret-value-do-not-leak-123";
    let base: string;
    let close: () => Promise<void>;
    let priorMode: string | undefined;
    let priorKey: string | undefined;

    beforeAll(async () => {
      priorMode = process.env.ORCHESTRATOR_MODE;
      priorKey = process.env.TOGETHER_API_KEY;
      process.env.ORCHESTRATOR_MODE = "external";
      process.env.TOGETHER_API_KEY = ENV_SECRET;
      ({ base, close } = await startServer({ secretStore: presenceSecretStore(["together"]) }));
    });

    afterAll(async () => {
      await close();
      if (priorMode === undefined) delete process.env.ORCHESTRATOR_MODE;
      else process.env.ORCHESTRATOR_MODE = priorMode;
      if (priorKey === undefined) delete process.env.TOGETHER_API_KEY;
      else process.env.TOGETHER_API_KEY = priorKey;
    });

    it("returns a redacted status with presence booleans and no secret value", async () => {
      const { status, data } = await getStatus(base);

      expect(status).toBe(200);
      expect(data.secretPresence.together).toBe(true);
      for (const value of Object.values(data.secretPresence)) {
        expect(typeof value).toBe("boolean");
      }
      // Neither the env secret nor the would-be getSecret value is ever returned (Req 1.10).
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(ENV_SECRET);
      expect(serialized).not.toContain("sk-should-never-be-returned-by-route");
    });
  });
});
