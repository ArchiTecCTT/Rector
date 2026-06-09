/**
 * Optional-dependency absence unit tests (cloud-capable-transition, task 15.2).
 *
 * Validates: Requirements 11.5
 *
 * Both cloud clients are optional peer dependencies kept out of the static
 * module graph and loaded lazily via `createRequire`, so the build and the
 * local test suite succeed without them installed. This file pins down the
 * other half of that contract: when an operator selects a path whose optional
 * dependency is ABSENT, the lazy load surfaces a clear, actionable error that
 * names the missing package and tells the operator how to install it — never a
 * bare module-not-found stack trace.
 *
 * Neither `sync-mysql` nor `@e2b/code-interpreter` is installed in this
 * workspace, so the default load paths under test throw naturally. The tests
 * are fully hermetic: no network, no container, no real database, no API key.
 */
import nodePath from "node:path";
import { describe, it, expect } from "vitest";

import { createTiDBDriver, type TiDBDriverInput } from "../src/store/tidbRectorStore";
import {
  createE2BSandboxAdapter,
  type SandboxAdapter,
} from "../src/sandbox/e2bSandboxAdapter";
import {
  type SandboxOperationInput,
  type SandboxOperationResult,
  type WorkspaceFs,
} from "../src/sandbox";
import { ALLOWLISTED_COMMANDS, createWorkspaceFs } from "./support/byokArbitraries";

const OPTIONAL_MYSQL_CLIENT = "sync-mysql";
const OPTIONAL_E2B_CLIENT = "@e2b/code-interpreter";

// A complete TiDB connection block — every required field present — so the
// driver clears any field validation and reaches the lazy optional-dependency
// load. No connection is opened because the load fails first.
const COMPLETE_TIDB: TiDBDriverInput = {
  host: "gateway.tidbcloud.example",
  port: 4000,
  user: "alpha-user",
  password: "not-a-real-password",
  database: "rector",
  tls: true,
};

describe("TiDB driver: absent sync-mysql dependency (task 15.2, Req 11.5)", () => {
  it("throws an actionable error naming the missing sync-mysql package", () => {
    let caught: unknown;
    try {
      createTiDBDriver(COMPLETE_TIDB);
    } catch (error) {
      caught = error;
    }

    // The optional-dependency load failed — a plain Error, not a network failure.
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Names the missing package and the install command (actionable guidance).
    expect(message).toContain(OPTIONAL_MYSQL_CLIENT);
    expect(message).toContain(`npm install ${OPTIONAL_MYSQL_CLIENT}`);
    // It is a clear dependency message, not a bare module-resolution stack trace.
    expect(message).toMatch(/not installed/i);
    expect(message).not.toMatch(/Cannot find module/i);
  });
});

describe("E2B sandbox: absent @e2b/code-interpreter dependency (task 15.2, Req 11.5)", () => {
  // An absolute, cross-platform workspace root used as the containment boundary.
  const WORKSPACE_ROOT = nodePath.resolve("missing-e2b-dependency-fixture-root");

  type OperableAdapter = SandboxAdapter & {
    operate(input: SandboxOperationInput): Promise<SandboxOperationResult>;
  };

  function buildFsImpl(): WorkspaceFs {
    const store = createWorkspaceFs({ root: WORKSPACE_ROOT, files: {} });
    return {
      realpathSync: (p) => store.realpathSync(p),
      readFileSync: (p) => store.readFileSync(p),
      readdirSync: (p) => store.readdirSync(p),
      writeFileSync: (p, d) => store.writeFileSync(p, d),
      existsSync: () => true,
    };
  }

  it("surfaces an actionable error naming the missing @e2b/code-interpreter package", async () => {
    // No `clientFactory` is supplied, so the adapter falls back to the default
    // factory, which lazily requires the absent E2B client and throws. The
    // adapter catches that init failure and surfaces it on the failure result.
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      now: () => "2026-01-01T00:00:00.000Z",
      fsImpl: buildFsImpl(),
    }) as OperableAdapter;

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: ["--run"] });

    // Client init failed before any container was spawned (Req 6.9 path), and
    // the absence is reported as an actionable, package-naming message.
    expect(result.status).toBe("FAILED");
    expect(result.stderr).toContain(OPTIONAL_E2B_CLIENT);
    expect(result.stderr).toContain(`npm install ${OPTIONAL_E2B_CLIENT}`);
    expect(result.stderr).toMatch(/not installed/i);
    expect(result.stderr).not.toMatch(/Cannot find module/i);
    // No container process was spawned and no network call was made.
    expect(result.networkCalls).toBe(0);
  });
});
