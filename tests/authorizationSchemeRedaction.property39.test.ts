import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactString, redactSecrets } from "../src/security/redaction";

/**
 * Task 14.5 — Authorization-scheme redaction property test.
 *
 * **Feature: cloud-capable-transition, Property 39: Authorization-scheme redaction retains the
 * scheme and replaces the token**
 * **Validates: Requirements 10.4**
 *
 * Property 39: *For any* Authorization header value of the form `Bearer <token>` or
 * `Basic <token>`, the Redaction_Layer (`src/security/redaction.ts`) retains the scheme keyword
 * (`Bearer` / `Basic`) and replaces the credential token that follows it with the fixed
 * `[REDACTED]` placeholder, so the scheme is observable in logs while the token never is.
 *
 * The test drives both the bare header value and the same value embedded in a surrounding log
 * line, and exercises the two boundary entry points the layer exposes for free text:
 * `redactString` (the primitive) and `redactSecrets` (the structured walker, which routes plain
 * strings through `redactString`). Everything is pure and in-memory — zero network, zero provider
 * calls — so every run is deterministic and hermetic.
 */

/** The fixed placeholder the Redaction_Layer substitutes for a redacted value. */
const REDACTED = "[REDACTED]";

/** The two HTTP authorization schemes the Redaction_Layer targets by keyword. */
const arbScheme: fc.Arbitrary<"Bearer" | "Basic"> = fc.constantFrom("Bearer", "Basic");

/**
 * A non-empty credential token in a realistic charset (base64url / JWT-like): letters, digits,
 * and `._-`. The charset deliberately excludes whitespace, `,`, and `;` (which terminate the
 * layer's `Bearer\s+[^\s,;]+` / `Basic\s+[^\s,;]+` match), so the whole token — and nothing more —
 * is the credential that must be replaced.
 *
 * Correctness of the "token replaced" claim is asserted by exact-equality against the expected
 * redacted string (the token swapped for the fixed placeholder), not by a raw substring-absence
 * check: a short token like `a` is legitimately a substring of the retained scheme keyword
 * (`Bearer`) or the placeholder, so substring-absence would be an incorrect statement of the
 * property. Exact equality precisely encodes "scheme keyword retained, token replaced".
 */
const arbToken: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9._-]+$/)
  .filter((token) => token.length > 0);

describe("Feature: cloud-capable-transition, Property 39: Authorization-scheme redaction retains the scheme and replaces the token", () => {
  it("retains the scheme keyword and replaces the token with the placeholder", () => {
    fc.assert(
      fc.property(arbScheme, arbToken, (scheme, token) => {
        const headerValue = `${scheme} ${token}`;

        // (1) Bare header value through the redaction primitive: the scheme keyword is retained
        //     verbatim and the token is replaced wholesale by the fixed placeholder.
        const redactedBare = redactString(headerValue);
        expect(redactedBare).toBe(`${scheme} ${REDACTED}`);
        expect(redactedBare.startsWith(scheme)).toBe(true);
        expect(redactedBare).toContain(REDACTED);

        // (2) Same header value embedded in a surrounding log line: the scheme keyword and all
        //     surrounding context survive, and only the token is swapped for the placeholder.
        const logLine = `request failed: Authorization: ${headerValue} (status 401)`;
        const redactedLine = redactString(logLine);
        expect(redactedLine).toBe(`request failed: Authorization: ${scheme} ${REDACTED} (status 401)`);

        // (3) The structured walker routes plain strings through the same scheme redaction, so a
        //     header carried in a (non-sensitive-keyed) field is scrubbed identically.
        const redactedStructured = redactSecrets({ note: headerValue });
        expect(redactedStructured).toEqual({ note: `${scheme} ${REDACTED}` });
      }),
      { numRuns: 200 },
    );
  });
});
