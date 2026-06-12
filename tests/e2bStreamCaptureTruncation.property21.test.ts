/**
 * Feature: cloud-capable-transition, Property 21: Captured streams are recorded,
 * truncated to the cap, and flagged.
 *
 * Validates: Requirements 6.4, 6.5
 *
 *   6.4 "WHEN the E2B_Sandbox_Adapter completes a command, THE E2B_Sandbox_Adapter
 *        SHALL capture the command exit code, stdout, and stderr into the
 *        Sandbox_Execution_Result."
 *   6.5 "WHEN a captured stdout or stderr stream exceeds MAX_CAPTURED_STREAM_BYTES
 *        (262144 bytes), THE E2B_Sandbox_Adapter SHALL truncate that stream to
 *        MAX_CAPTURED_STREAM_BYTES in the Sandbox_Execution_Result and SHALL set an
 *        indication that the stream was truncated."
 *
 * The property is observed directly through the real `createE2BSandboxAdapter`
 * path, with a deterministic in-memory `E2BClient` double injected via the
 * adapter's `clientFactory` seam. The fake client returns arbitrary-length
 * stdout/stderr and never spawns a container or touches the network, so the
 * test is fully hermetic. For any command result, the resulting
 * Sandbox_Execution_Result must:
 *   - capture the exit code and both streams (6.4),
 *   - hold each captured stream to at most MAX_CAPTURED_STREAM_BYTES bytes (6.5),
 *   - set the per-stream truncation indicator *iff* that stream's original byte
 *     length exceeded the cap (6.5).
 *
 * Stream content is drawn from a benign ASCII alphabet (letters + digits only)
 * so the Redaction_Layer is an identity transform on it: that isolates the
 * capture/truncation behavior under test from redaction, and keeps each
 * character exactly one UTF-8 byte so the byte-length boundary is exercised
 * precisely.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createE2BSandboxAdapter, type E2BClient } from "../src/sandbox/e2bSandboxAdapter";
import { MAX_CAPTURED_STREAM_BYTES } from "../src/sandbox/index";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const CAP = MAX_CAPTURED_STREAM_BYTES;
const ALLOWLISTED_COMMAND = "echo";

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

/**
 * Build a benign, single-byte-per-character string of exactly `length`
 * characters by tiling `seed`. Single-byte ASCII keeps byte length === string
 * length so the cap boundary is hit exactly, and the alphabet contains no
 * token the Redaction_Layer would rewrite.
 */
function buildStream(seed: string, length: number): string {
  if (length <= 0) return "";
  const repeats = Math.ceil(length / seed.length);
  return seed.repeat(repeats).slice(0, length);
}

/** A deterministic, in-memory E2B client double — no container, no network. */
function fakeClient(stdout: string, stderr: string, exitCode: number): E2BClient {
  return {
    runCommand: () => ({ exitCode, stdout, stderr }),
    writeFile: () => {},
  };
}

const benignChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
);
const seedArb = fc.array(benignChar, { minLength: 1, maxLength: 24 }).map((chars) => chars.join(""));

// Lengths spanning well below the cap, straddling the exact boundary, and
// clearly above it, so both the truncated and non-truncated branches and the
// boundary itself are all exercised.
const lengthArb = fc.oneof(
  fc.integer({ min: 0, max: 4_000 }),
  fc.integer({ min: CAP - 64, max: CAP + 64 }),
  fc.integer({ min: CAP + 1, max: CAP + 8_192 }),
);

const exitCodeArb = fc.integer({ min: 0, max: 255 });

describe("E2B_Sandbox_Adapter — Property 21: captured streams are recorded, truncated to the cap, and flagged (Req 6.4, 6.5)", () => {
  it("captures exit code + both streams, caps each stream at MAX_CAPTURED_STREAM_BYTES, and flags truncation iff the original exceeded the cap", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        lengthArb,
        seedArb,
        lengthArb,
        exitCodeArb,
        async (outSeed, outLen, errSeed, errLen, exitCode) => {
          const stdout = buildStream(outSeed, outLen);
          const stderr = buildStream(errSeed, errLen);
          const originalStdoutBytes = byteLength(stdout);
          const originalStderrBytes = byteLength(stderr);

          const adapter = createE2BSandboxAdapter({
            apiKey: "test-key",
            workspaceRoot: "/workspace",
            allowlistedCommands: [ALLOWLISTED_COMMAND],
            clientFactory: () => fakeClient(stdout, stderr, exitCode),
            now: () => FIXED_TS,
          });

          const result = await adapter.execute({
            kind: "local",
            command: ALLOWLISTED_COMMAND,
            args: [],
            timeoutMs: 1_000,
          });

          // 6.4 — the exit code and both streams are captured.
          expect(result.exitCode).toBe(exitCode);
          expect(typeof result.stdout).toBe("string");
          expect(typeof result.stderr).toBe("string");

          // 6.5 — each captured stream is held to at most the cap (byte length).
          expect(byteLength(result.stdout)).toBeLessThanOrEqual(CAP);
          expect(byteLength(result.stderr)).toBeLessThanOrEqual(CAP);

          // 6.5 — the truncation indicator is set iff the original exceeded the cap.
          const stdoutTruncated = result.metadata.stdoutTruncated as boolean;
          const stderrTruncated = result.metadata.stderrTruncated as boolean;
          expect(stdoutTruncated).toBe(originalStdoutBytes > CAP);
          expect(stderrTruncated).toBe(originalStderrBytes > CAP);

          // 6.4 — capture fidelity: an un-truncated stream is recorded verbatim;
          // a truncated stream is a leading slice of the original (and the
          // benign alphabet guarantees redaction is an identity transform).
          if (!stdoutTruncated) {
            expect(result.stdout).toBe(stdout);
          } else {
            expect(stdout.startsWith(result.stdout)).toBe(true);
          }
          if (!stderrTruncated) {
            expect(result.stderr).toBe(stderr);
          } else {
            expect(stderr.startsWith(result.stderr)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 20_000);
});
