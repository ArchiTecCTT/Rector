import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { triageUserMessage, TRIAGE_ROUTES } from "../src/orchestration/triage";

/**
 * Task 3.2 — whitespace-only input property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 5: Empty or whitespace input routes to
 * clarification**
 * **Validates: Requirements 3.2**
 *
 * For any string consisting solely of whitespace (including the empty string, spaces, tabs, and
 * newlines), `triageUserMessage` SHALL assign the `NEEDS_CLARIFICATION` route.
 *
 * `triageUserMessage` trims its input and treats an empty trimmed message as
 * `NEEDS_CLARIFICATION` (Req 3.2). To exercise the full whitespace input space we generate
 * arbitrary-length sequences drawn from a representative set of Unicode whitespace characters —
 * spaces, tabs, newlines, carriage returns, vertical tabs, form feeds, and a non-breaking space —
 * including the empty string. Any such string must route to clarification regardless of its
 * length or the particular mix of whitespace it contains.
 */

// Whitespace characters that `String.prototype.trim()` removes. The empty string is covered by
// allowing a zero-length array.
const WHITESPACE_CHARS = [
  " ", // space
  "\t", // tab
  "\n", // line feed
  "\r", // carriage return
  "\v", // vertical tab
  "\f", // form feed
  "\u00a0", // non-breaking space
  "\u2028", // line separator
  "\u2029", // paragraph separator
] as const;

/** Arbitrary string composed only of whitespace characters, including the empty string. */
const arbWhitespaceOnly = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 0, maxLength: 40 })
    .map((chars) => chars.join(""));

describe("Empty or whitespace input routes to clarification (Property 5)", () => {
  // Feature: byok-chat-ux-and-model-discovery, Property 5: Empty or whitespace input routes to clarification
  it("assigns NEEDS_CLARIFICATION for any empty or whitespace-only message", () => {
    fc.assert(
      fc.property(arbWhitespaceOnly(), (message) => {
        // Guard: the generated input must actually be whitespace-only (trims to empty).
        expect(message.trim()).toBe("");

        const triage = triageUserMessage(message);

        // Req 3.2: empty/whitespace-only messages classify as NEEDS_CLARIFICATION.
        expect(triage.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
      }),
      { numRuns: 100 },
    );
  });
});
