import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";

/**
 * Tests for CSP + HSTS security headers (Task 1.4, H4).
 *
 * Verifies that securityHeadersMiddleware emits:
 *  - Content-Security-Policy with strict directives
 *  - Strict-Transport-Security in production mode only
 *  - HSTS env var configurability
 */
describe("CSP + HSTS security headers (H4)", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    app = createApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("sets Content-Security-Policy header with strict directives", async () => {
    const res = await fetch(base);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();

    // Parse CSP directives
    const directives = new Map<string, string[]>();
    if (csp) {
      for (const part of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
        const [name, ...values] = part.split(/\s+/);
        directives.set(name, values);
      }
    }

    // Verify each required directive
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("font-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
  });

  it("does not set Strict-Transport-Security in non-production mode", async () => {
    const res = await fetch(base);
    const hsts = res.headers.get("strict-transport-security");
    // In test mode NODE_ENV is not "production", so no HSTS header.
    expect(hsts).toBeNull();
  });

  it("sets other baseline security headers", async () => {
    const res = await fetch(base);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("HSTS in production mode", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHstsMaxAge = process.env.HSTS_MAX_AGE;
  const originalHstsIncludeSub = process.env.HSTS_INCLUDE_SUB_DOMAINS;
  const originalHstsPreload = process.env.HSTS_PRELOAD;

  let app: express.Application;
  let server: http.Server;
  let base: string;

  async function startServer(): Promise<void> {
    app = createApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  }

  async function stopServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  afterAll(() => {
    // Restore env vars
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalHstsMaxAge === undefined) {
      delete process.env.HSTS_MAX_AGE;
    } else {
      process.env.HSTS_MAX_AGE = originalHstsMaxAge;
    }
    if (originalHstsIncludeSub === undefined) {
      delete process.env.HSTS_INCLUDE_SUB_DOMAINS;
    } else {
      process.env.HSTS_INCLUDE_SUB_DOMAINS = originalHstsIncludeSub;
    }
    if (originalHstsPreload === undefined) {
      delete process.env.HSTS_PRELOAD;
    } else {
      process.env.HSTS_PRELOAD = originalHstsPreload;
    }
  });

  it("sets default HSTS header when NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HSTS_MAX_AGE;
    delete process.env.HSTS_INCLUDE_SUB_DOMAINS;
    delete process.env.HSTS_PRELOAD;

    await startServer();
    const res = await fetch(base);
    await stopServer();

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=31536000");
  });

  it("respects HSTS_MAX_AGE env var", async () => {
    process.env.NODE_ENV = "production";
    process.env.HSTS_MAX_AGE = "86400";
    delete process.env.HSTS_INCLUDE_SUB_DOMAINS;
    delete process.env.HSTS_PRELOAD;

    await startServer();
    const res = await fetch(base);
    await stopServer();

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=86400");
  });

  it("includes includeSubDomains when HSTS_INCLUDE_SUB_DOMAINS is true", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HSTS_MAX_AGE;
    process.env.HSTS_INCLUDE_SUB_DOMAINS = "true";
    delete process.env.HSTS_PRELOAD;

    await startServer();
    const res = await fetch(base);
    await stopServer();

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
  });

  it("includes preload when HSTS_PRELOAD is true", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HSTS_MAX_AGE;
    delete process.env.HSTS_INCLUDE_SUB_DOMAINS;
    process.env.HSTS_PRELOAD = "true";

    await startServer();
    const res = await fetch(base);
    await stopServer();

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=31536000; preload");
  });

  it("includes both includeSubDomains and preload when both are true", async () => {
    process.env.NODE_ENV = "production";
    process.env.HSTS_MAX_AGE = "86400";
    process.env.HSTS_INCLUDE_SUB_DOMAINS = "true";
    process.env.HSTS_PRELOAD = "true";

    await startServer();
    const res = await fetch(base);
    await stopServer();

    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=86400; includeSubDomains; preload");
  });
});
