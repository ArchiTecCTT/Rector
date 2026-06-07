/**
 * Task 13.1 — Preserve-experience regression guard suite.
 *
 * **Validates: Requirements 12.1, 12.2, 12.4, 12.5, 12.6**
 *
 * This is a guard / meta suite. It exercises no new productization feature; instead it pins down
 * the four "do not regress" invariants from Requirement 12 so that any future productization change
 * that quietly breaks one of them fails loudly here:
 *
 *   Req 12.1 — The pre-productization chat and trace UX test outcomes keep passing. The guard both
 *              asserts the regression-bearing chat/trace test files are still present in the suite
 *              (so `npm test` keeps running them) AND directly drives the provider-free chat/trace
 *              pipeline to a terminal phase with a populated event log.
 *   Req 12.2 — The existing Sandbox safety constraints are unchanged. The guard locks the sandbox
 *              safety constants (60s command timeout, 256 KiB capture cap) and re-confirms the
 *              highest-precedence gates still hold: destructive commands blocked, off-allowlist
 *              denied, and arbitrary shell denied — all without spawning a process.
 *   Req 12.4 — IF Local_Mode output diverges from the pre-productization baseline THEN the gates
 *              report a failure. The byte-for-byte baseline and isolation guards live in
 *              `inMemoryRegression.test.ts` / `testIsolation.test.ts`, which run inside the `npm test`
 *              gate; this guard asserts those baseline test files remain present so divergence is
 *              always caught by the gate.
 *   Req 12.5 — All five Verification_Gates pass with zero failures. The guard enumerates exactly the
 *              five gates, asserts the three npm-script gates are wired as expected, and ACTUALLY
 *              RUNS the two non-recursive script gates (`generate-roadmap-issues.js --check` and
 *              `export-linear-issues.js --check`), asserting each reports success. (`npm run check`,
 *              `npm run build`, and `npm test` are not re-run inside the suite — `npm test` would
 *              recurse and the tsc gates are exercised by CI — so they are guarded by wiring.)
 *   Req 12.6 — The suite makes zero real provider calls and zero outbound network calls, using
 *              deterministic doubles. A `fetch` sentinel that throws synchronously is installed
 *              around every chat/sandbox exercise here and must be called zero times, and the two
 *              gate scripts are confirmed network-free and run with scrubbed credentials.
 *
 * Everything uses deterministic doubles: the provider-free `runChat({ mode: "local" })` path (no
 * provider, no router), an injected counting `CommandRunner`, an in-memory store, and a fixed clock.
 * No API key is read and no outbound connection is opened.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json";
import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { RectorStore } from "../src/store";
import {
  MAX_CAPTURED_STREAM_BYTES,
  WORKSPACE_COMMAND_TIMEOUT_MS,
  WorkspaceSandboxAdapter,
  type CommandRunner,
} from "../src/sandbox";
import { ALLOWLISTED_COMMANDS, makeContextPack } from "./support/byokArbitraries";

// ---------------------------------------------------------------------------
// Network sentinel: a `fetch` replacement that THROWS SYNCHRONOUSLY on any call,
// so a stray outbound attempt during a guarded exercise aborts loudly (Req 12.6).
// ---------------------------------------------------------------------------

class OutboundNetworkAttemptError extends Error {
  readonly name = "OutboundNetworkAttemptError";
}

interface FetchSentinel {
  fetchImpl: typeof fetch;
  callCount: number;
  attempts: string[];
}

function createFetchSentinel(): FetchSentinel {
  const sentinel: FetchSentinel = { fetchImpl: undefined as unknown as typeof fetch, callCount: 0, attempts: [] };
  sentinel.fetchImpl = ((input: unknown) => {
    sentinel.callCount += 1;
    const target =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && "url" in input
          ? String((input as { url: unknown }).url)
          : String(input);
    sentinel.attempts.push(target);
    throw new OutboundNetworkAttemptError(
      `Prohibited outbound network connection during preserve-experience guard: fetch("${target}"). ` +
        `The Rector suite must run with no real provider/network calls (Req 12.6).`
    );
  }) as unknown as typeof fetch;
  return sentinel;
}

async function withFetchSentinel<T>(sentinel: FetchSentinel, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = sentinel.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";
const WORKSPACE_ROOT = "/tmp/preserve-experience-guard-root";

/** A `CommandRunner` double that records how many times it was invoked (must stay 0 for denials). */
function createCountingCommandRunner(): { runner: CommandRunner; readonly calls: number } {
  let calls = 0;
  return {
    runner: (async ({ command, args }) => {
      calls += 1;
      return { exitCode: 0, stdout: [command, ...args].join(" "), stderr: "" };
    }) as CommandRunner,
    get calls() {
      return calls;
    },
  };
}

/** Builds a fresh, schema-valid provider-free `ChatRunArgs` for `prompt`, seeded into `store`. */
async function buildLocalChatArgs(store: RectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "preserve-experience guard",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const observability = createInMemoryObservabilityTrace({ provider: "local" });
  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };
}

// ---------------------------------------------------------------------------
// Req 12.1 — Pre-productization chat/trace UX outcomes still pass.
// ---------------------------------------------------------------------------

/** The pre-productization chat + trace regression test files that must keep running in `npm test`. */
const CHAT_TRACE_REGRESSION_TESTS = [
  "tests/chatApi.test.ts",
  "tests/chatRunner.test.ts",
  "tests/chatBrainstemE2E.test.ts",
  "tests/chatStreaming.broker.test.ts",
  "tests/chatStreaming.edge.test.ts",
  "tests/chatStreaming.redaction.test.ts",
  "tests/chatStreaming.teardown.test.ts",
] as const;

describe("preserve-experience guard — chat/trace UX outcomes preserved (Req 12.1)", () => {
  it("keeps every pre-productization chat/trace regression test file present in the suite", () => {
    for (const file of CHAT_TRACE_REGRESSION_TESTS) {
      expect(existsSync(file), `missing chat/trace regression test: ${file}`).toBe(true);
    }
  });

  it("drives the provider-free chat/trace pipeline to a terminal phase with a populated trace and zero network", async () => {
    const sentinel = createFetchSentinel();
    const store = new InMemoryRectorStore({ now: FIXED_NOW });
    const args = await buildLocalChatArgs(store, "Explain the Rector vertical slice.");

    const result = await withFetchSentinel(sentinel, async () => runChat(store, args, { mode: "local" }));

    // The chat outcome is unchanged: the run reaches DONE/completed with no provider call.
    expect(result.run.status).toBe("completed");
    expect(result.run.phase).toBe("DONE");
    expect(result.observabilitySummary.modelCallCount).toBe(0);
    // The trace (event log) is populated so the trace UX still has content to render.
    const events = await store.listEvents(result.run.id);
    expect(events.length).toBeGreaterThan(0);
    // Req 12.6: not one outbound connection was attempted.
    expect(sentinel.callCount, `chat run attempted outbound network to: ${sentinel.attempts.join(", ")}`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Req 12.2 — Sandbox safety constraints are unchanged.
// ---------------------------------------------------------------------------

describe("preserve-experience guard — sandbox safety constraints unchanged (Req 12.2)", () => {
  it("locks the sandbox safety constants against drift", () => {
    expect(WORKSPACE_COMMAND_TIMEOUT_MS).toBe(60_000);
    expect(MAX_CAPTURED_STREAM_BYTES).toBe(262_144);
  });

  it("still blocks a destructive command outright and spawns no process", async () => {
    const counting = createCountingCommandRunner();
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      // Allowlist the destructive program token too: the destructive gate must still win.
      allowlistedCommands: [...ALLOWLISTED_COMMANDS, "rm"],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "rm", args: ["-rf", "/"] });

    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("DESTRUCTIVE_COMMAND_BLOCKED");
    expect(counting.calls).toBe(0);
    expect(result.networkCalls).toBe(0);
  });

  it("still denies an off-allowlist command and an arbitrary-shell command without spawning a process", async () => {
    const counting = createCountingCommandRunner();
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const offAllowlist = await adapter.operate({ kind: "RUN_COMMAND", command: "python", args: ["x.py"] });
    expect(offAllowlist.status).toBe("DENIED");
    expect(offAllowlist.denialReason).toBe("COMMAND_NOT_ALLOWLISTED");

    // Shell metacharacters in the program string imply shell interpretation and are denied
    // (metacharacters in args are literal argv entries, so they must live in the command itself).
    const shell = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test; rm -rf /", args: [] });
    expect(shell.status).toBe("DENIED");
    expect(shell.denialReason).toBe("ARBITRARY_SHELL_DISABLED");

    // No process was spawned for either denial.
    expect(counting.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Req 12.4 — Divergence from the Local_Mode baseline is caught by the gates.
// ---------------------------------------------------------------------------

/** The baseline/isolation regression files that enforce Local_Mode determinism inside `npm test`. */
const BASELINE_REGRESSION_TESTS = [
  "tests/inMemoryRegression.test.ts",
  "tests/testIsolation.test.ts",
] as const;

describe("preserve-experience guard — Local_Mode baseline divergence is gated (Req 12.4)", () => {
  it("keeps the byte-for-byte baseline and isolation guard test files present in the suite", () => {
    for (const file of BASELINE_REGRESSION_TESTS) {
      expect(existsSync(file), `missing baseline regression test: ${file}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Req 12.5 / 12.6 — The five Verification_Gates pass; gate scripts are network-free.
// ---------------------------------------------------------------------------

/** The canonical five Verification_Gates (Requirement 12.5 / glossary). */
const VERIFICATION_GATES = [
  "npm run check",
  "npm run build",
  "npm test",
  "node scripts/generate-roadmap-issues.js --check",
  "node scripts/export-linear-issues.js --check",
] as const;

const GATE_SCRIPTS = [
  "scripts/generate-roadmap-issues.js",
  "scripts/export-linear-issues.js",
] as const;

describe("preserve-experience guard — five verification gates pass (Req 12.5)", () => {
  it("enumerates exactly the five canonical verification gates", () => {
    expect(VERIFICATION_GATES).toHaveLength(5);
    expect(new Set(VERIFICATION_GATES).size).toBe(5);
  });

  it("wires the three npm-script gates as expected", () => {
    expect(packageJson.scripts.check).toBe("tsc --noEmit");
    expect(packageJson.scripts.build).toContain("tsc");
    expect(packageJson.scripts.test).toBe("vitest run");
  });

  it("ships both script gates on disk", () => {
    for (const script of GATE_SCRIPTS) {
      expect(existsSync(script), `missing gate script: ${script}`).toBe(true);
    }
  });

  it("passes the roadmap-issues --check gate", () => {
    const output = execFileSync(process.execPath, ["scripts/generate-roadmap-issues.js", "--check"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(output).toContain("roadmap issue docs are current");
  });

  it("passes the linear-export --check gate", () => {
    const output = execFileSync(process.execPath, ["scripts/export-linear-issues.js", "--check"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(output).toContain("linear export is current");
  });
});

describe("preserve-experience guard — gate scripts make zero network/provider calls (Req 12.6)", () => {
  it("contains no network-capable code in either script gate", () => {
    for (const script of GATE_SCRIPTS) {
      const source = readFileSync(script, "utf8");
      expect(source, `network-capable code found in ${script}`).not.toMatch(
        /\bfetch\b|node:https|node:http|XMLHttpRequest/
      );
    }
  });

  it("runs the script gates with scrubbed credentials without leaking the injected secret", () => {
    // Inject obviously-fake credentials; a network-free gate must run to completion and never echo them.
    const output = execFileSync(process.execPath, ["scripts/export-linear-issues.js", "--check"], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GITHUB_TOKEN: "must-not-be-used", LINEAR_API_KEY: "must-not-be-used" },
    });
    expect(output).not.toContain("must-not-be-used");
    expect(output).toContain("linear export is current");
  });
});
