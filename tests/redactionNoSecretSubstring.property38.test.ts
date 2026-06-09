/**
 * Feature: cloud-capable-transition, Property 38: Redacted output contains no
 * secret substring.
 *
 * **Validates: Requirements 10.3, 2.13, 4.4, 6.8, 7.6, 8.7**
 *
 *   Req 10.3: "WHEN any value is redacted for a log or telemetry sink, THE
 *   redacted output SHALL contain no substring of any Secret_Store secret value,
 *   API key, or authorization credential."
 *
 * The cited per-sink requirements (2.13 discovery errors, 4.4 sandbox
 * stream/artifact capture, 6.8 Settings_API discovery response, 7.6 synthesizer
 * answers/citations, 8.7 TiDB error messages) all funnel their string content
 * through the same Redaction_Layer primitives in `src/security/redaction.ts`
 * (`redactString` for free-form strings, `redactSecrets` for structured
 * payloads). This property pins the shared guarantee those sinks rely on: once a
 * secret-bearing value passes through redaction, the output retains *no*
 * substring of the original secret — not the whole secret, and not even a
 * partial fragment of it.
 *
 * WHY THE STRONGER "no substring" CLAIM HOLDS (confirmed by reading the code):
 * the redactor's carrier patterns (`BEARER_PATTERN`, `BASIC_PATTERN`,
 * `INLINE_SECRET_PATTERN`, `CREDENTIAL_URI_PATTERN`) each match the *entire*
 * delimiter-free credential token and replace it WHOLLY with the fixed
 * `[REDACTED]` placeholder. Because the generated secret is composed only of a
 * known prefix plus URL/JSON-safe alphanumerics (no spaces, `,`, `;`, `&`, `/`,
 * or `@`), the carrier match consumes the token in one piece, so no leading or
 * trailing slice of it can survive.
 *
 * The property embeds an arbitrary key-like secret inside every carrier the
 * redactor targets, wraps that carrier in arbitrary surrounding text, and then
 * asserts the redacted output contains:
 *   - not the whole secret, and
 *   - no length-`FRAGMENT_LEN` window of the secret (checking every length-N
 *     window is sufficient: any surviving substring of length >= N would itself
 *     contain such a window).
 *
 * Non-vacuity: the redacted output is asserted to actually contain the fixed
 * `[REDACTED]` placeholder, proving the carrier was genuinely recognized and
 * scrubbed (rather than the secret being trivially absent because nothing
 * matched). A `fc.pre` guard skips the astronomically rare case where the random
 * surrounding text itself happens to contain a secret fragment, keeping the
 * assertion exclusively about redaction behaviour.
 *
 * Hermetic: pure function calls against `src/security/redaction.ts`. ZERO disk,
 * ZERO network, ZERO API key.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactSecrets, redactString } from "../src/security/redaction";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

const REDACTED = "[REDACTED]";

/**
 * Window length for the "no partial fragment" check. Checking every contiguous
 * window of this length is sufficient to prove no substring of length >= N
 * survives, since any longer surviving substring necessarily contains one of
 * these windows. Kept comfortably shorter than the minimum secret length
 * (prefix + 24 alnum chars) so multiple windows always exist.
 */
const FRAGMENT_LEN = 8;

/** Every contiguous length-`len` window of `value` (or `[value]` when shorter). */
function windowsOf(value: string, len: number): string[] {
  if (value.length <= len) return [value];
  const out: string[] = [];
  for (let i = 0; i + len <= value.length; i += 1) {
    out.push(value.slice(i, i + len));
  }
  return out;
}

/** True when `haystack` contains any of the supplied fragments. */
function containsAnyFragment(haystack: string, fragments: string[]): boolean {
  return fragments.some((fragment) => haystack.includes(fragment));
}

/**
 * The set of redactable carriers the Redaction_Layer is guaranteed to target. A
 * delimiter-free key-like secret embedded in any of these is removed wholly:
 *  - `Bearer <token>` / `Basic <token>` => BEARER_PATTERN / BASIC_PATTERN,
 *  - `api_key=`/`apikey=`/`token=`/`secret=`/`password=` => INLINE_SECRET_PATTERN,
 *  - a credential URI userinfo (`scheme://user:<secret>@host`) => CREDENTIAL_URI_PATTERN.
 */
const CARRIERS: Array<{ name: string; wrap: (secret: string) => string }> = [
  { name: "Bearer authorization header", wrap: (s) => `Authorization: Bearer ${s}` },
  { name: "Basic authorization header", wrap: (s) => `Authorization: Basic ${s}` },
  { name: "inline api_key= pair", wrap: (s) => `api_key=${s}` },
  { name: "inline apikey= pair", wrap: (s) => `apikey=${s}` },
  { name: "inline token= pair", wrap: (s) => `token=${s}` },
  { name: "inline secret= pair", wrap: (s) => `secret=${s}` },
  { name: "inline password= pair", wrap: (s) => `password=${s}` },
  { name: "credential connection URI", wrap: (s) => `https://admin:${s}@db.example.com/v1` },
];

const carrierIndexArb = fc.nat(CARRIERS.length - 1);

/** Arbitrary surrounding text (free-form printable strings around the carrier). */
const surroundingArb = fc.string({ maxLength: 60 });

describe("Property 38: redacted output contains no secret substring (Req 10.3)", () => {
  it("removes every secret fragment when a key-like secret is embedded in arbitrary surrounding text", () => {
    fc.assert(
      fc.property(
        arbKeyLikeSecret(),
        carrierIndexArb,
        surroundingArb,
        surroundingArb,
        (secret, carrierIndex, prefix, suffix) => {
          const fragments = windowsOf(secret, FRAGMENT_LEN);

          // Keep the assertion exclusively about redaction: skip the (astronomically rare)
          // case where the random surrounding text already contains a secret fragment.
          fc.pre(!containsAnyFragment(`${prefix} ${suffix}`, fragments));

          const carrier = CARRIERS[carrierIndex];
          const input = `${prefix} ${carrier.wrap(secret)} ${suffix}`;

          // (a) Free-form string redaction (the path used by discovery errors, sandbox
          // capture, synthesizer answers/citations, and TiDB error messages).
          const redacted = redactString(input);

          // (b) Structured redaction over the same content under a NON-sensitive key, which
          // routes the string through the same `redactString` core (Settings_API responses
          // and other structured payloads take this path).
          const redactedStructured = JSON.stringify(redactSecrets({ detail: input }));

          for (const [label, output] of [
            ["redactString", redacted],
            ["redactSecrets", redactedStructured],
          ] as const) {
            // Non-vacuity: the carrier was genuinely recognized and scrubbed.
            expect(output, `${carrier.name}: ${label} did not redact the carrier`).toContain(REDACTED);
            // The whole secret must be absent...
            expect(output, `${carrier.name}: ${label} leaked the whole secret`).not.toContain(secret);
            // ...and so must every partial fragment of it.
            for (const fragment of fragments) {
              expect(
                output.includes(fragment),
                `${carrier.name}: ${label} leaked secret fragment "${fragment}"`
              ).toBe(false);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
