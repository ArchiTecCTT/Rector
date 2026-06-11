import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactSecrets, redactString, redactOutbound } from "../src/security/redaction";
import { computeSetupStatus } from "../src/setupStatus";
import { buildWorkspaceSafetyResponse } from "../src/api/server";
import { presentApprovalRequest } from "../src/api/approvalFlow";
import { InMemoryRectorStore, type Budget, type CreateRunInput } from "../src/store";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

/**
 * Task 10.2 — Boundary redaction property test.
 *
 * **Property 1: Boundary redaction leaves no secret substring**
 * **Validates: Requirements 1.3, 1.4, 2.3, 2.5, 3.7, 5.7, 7.8, 8.5, 9.6, 11.1, 11.2, 11.3, 11.4**
 *
 * For any value or structure that crosses a productization boundary and carries provider or
 * environment secret material, the redacted output SHALL contain no substring of the original
 * secret value and SHALL use the fixed `[REDACTED]` placeholder. This property drives every NEW
 * boundary introduced by productization with a generated, key-like secret embedded in a carrier
 * the Redaction_Layer is designed to target, then asserts the secret is wholly absent from the
 * emitted output:
 *
 *   1. the redaction primitives themselves — `redactString`, `redactSecrets`, `redactOutbound`
 *      (`src/security/redaction.ts`), exercised over plain strings, nested API/error structures
 *      (including metadata and stack-trace content), and the outbound-suppression wrapper;
 *   2. the setup-status response — `computeSetupStatus` (`src/setupStatus.ts`), with the secret
 *      injected into an env value that flows into a category `detail` (Req 1.3, 1.4);
 *   3. the workspace-safety response — `buildWorkspaceSafetyResponse` (`src/api/server.ts`), with
 *      the secret embedded in the configured workspace root (Req 3.7);
 *   4. the approval view/response — `presentApprovalRequest` (`src/api/approvalFlow.ts`), with the
 *      secret embedded in the diff, command, and target path of the presented operation (Req 9.6).
 *
 * Everything here is pure/in-memory: zero network and zero provider calls. The `SecretStore` double
 * only answers presence (`hasSecret`); `getSecret`/`setSecret` throw if ever touched.
 */

/** The fixed redaction placeholder emitted by the Redaction_Layer. */
const REDACTED = "[REDACTED]";

/**
 * Secret carriers the project's `redactString`/`redactSecrets` are guaranteed to target. A
 * delimiter-free (prefix + alnum) secret embedded in any of these is removed WHOLLY by redaction:
 *  - `Bearer <token>`                  => BEARER_PATTERN,
 *  - `api_key=`/`token=`/`secret=` pair => INLINE_SECRET_PATTERN,
 *  - credential URI (`scheme://user:pass@`) => CREDENTIAL_URI_PATTERN strips the userinfo.
 */
const carriers: Array<(secret: string) => string> = [
  (s) => `Authorization: Bearer ${s}`,
  (s) => `api_key=${s}`,
  (s) => `token=${s}`,
  (s) => `secret=${s}`,
  (s) => `https://admin:${s}@db.example.com/v1`,
];

const carrierIndexArb = fc.nat(carriers.length - 1);

/**
 * Presence-only {@link SecretStore} double. `hasSecret` reports a fixed empty set; `getSecret` and
 * `setSecret` throw so no secret VALUE can be read or written through the setup-status boundary.
 */
function fakeSecretStore(): SecretStore {
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      throw new Error("setSecret must not be called during boundary redaction");
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      throw new Error("getSecret must not be called during boundary redaction");
    },
    async hasSecret(): Promise<boolean> {
      return false;
    },
  };
}

const budget: Budget = {
  maxUsd: 2,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: ["local"],
  approvalRequiredAboveUsd: 1,
};

/** A run already in an acting phase, so `presentApprovalRequest` can move it to NEEDS_DECISION. */
function makeRunInput(): CreateRunInput {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "EXECUTING",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
  };
}

describe("boundary redaction leaves no secret substring (Property 1)", () => {
  // Feature: productization-alpha, Property 1: Boundary redaction leaves no secret substring
  it("redacts every injected secret across all new productization boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), carrierIndexArb, async (secret, carrierIndex) => {
        const leak = carriers[carrierIndex](secret);

        /** Assert the whole injected secret is absent from a boundary's serialized output. */
        const assertNoSecret = (label: string, text: string): void => {
          expect(text, `secret leaked into ${label}`).not.toContain(secret);
        };

        // --- (1) Redaction primitives ---------------------------------------------------------

        // redactString: the secret inside its carrier is removed and replaced with the placeholder.
        const redactedString = redactString(leak);
        assertNoSecret("redactString", redactedString);
        expect(redactedString).toContain(REDACTED);

        // redactSecrets: a nested API/error structure with the secret under sensitive keys AND
        // inside string fields, metadata, nested arrays, and stack-trace content.
        const structured = {
          apiKey: secret,
          token: secret,
          password: secret,
          message: leak,
          metadata: {
            authorization: secret,
            detail: leak,
            nested: [{ secret }, leak],
          },
          stack: `Error: boom\n    at handler (${leak})\n    at next (${leak})`,
        };
        const redactedStructured = redactSecrets(structured);
        const redactedStructuredJson = JSON.stringify(redactedStructured);
        assertNoSecret("redactSecrets", redactedStructuredJson);
        expect(redactedStructuredJson).toContain(REDACTED);

        // redactOutbound: the outbound-suppression wrapper succeeds and carries no secret substring.
        const outcome = redactOutbound(structured);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          assertNoSecret("redactOutbound", JSON.stringify(outcome.value));
        }

        // --- (2) Setup-status response (Req 1.3, 1.4) -----------------------------------------

        // The secret is injected as an (unknown) persistence driver and sandbox runtime value, so it
        // flows into the category `detail` strings, then is scrubbed by the boundary redaction pass.
        const status = await computeSetupStatus(
          { ORCHESTRATOR_MODE: "external", RECTOR_PERSISTENCE: leak, SANDBOX_RUNTIME: leak },
          fakeSecretStore()
        );
        assertNoSecret("computeSetupStatus", JSON.stringify(status));

        // --- (3) Workspace-safety response (Req 3.7) ------------------------------------------

        // The workspace root is the redacted field; embedding the secret there must not survive.
        const safety = buildWorkspaceSafetyResponse({ workspaceRoot: leak });
        const safetyJson = JSON.stringify(safety);
        assertNoSecret("buildWorkspaceSafetyResponse", safetyJson);
        expect(safety.available).toBe(true);
        expect(safety.workspaceRoot).toContain(REDACTED);

        // --- (4) Approval view/response (Req 9.6) ---------------------------------------------

        // Present an operation whose diff, command, and target path all carry the secret; the
        // persisted/streamed decision request must be fully redacted.
        const store = new InMemoryRectorStore();
        const run = await store.createRun(makeRunInput());
        await presentApprovalRequest(store, {
          runId: run.id,
          operationId: "op-1",
          riskyCommand: true,
          view: { runId: run.id, operationId: "op-1", diff: leak, command: leak, targetPath: leak },
        });
        const pending = await store.getRun(run.id);
        assertNoSecret("approval decisionRequest", JSON.stringify(pending?.decisionRequest ?? null));
      }),
      { numRuns: 100 }
    );
  }, 60_000);
});
