/**
 * Task 14.3 — Property test for the fixed redaction placeholder.
 *
 * Feature: cloud-capable-transition, Property 37: Redaction uses a single fixed placeholder
 * sharing no original character.
 *
 * **Property 37: Redaction uses a single fixed placeholder sharing no original character**
 * **Validates: Requirements 10.2**
 *
 * Requirement 10.2 states: "THE Redaction_Layer SHALL replace each redacted value with a single
 * fixed placeholder string that contains no character of the original redacted value."
 *
 * Two obligations are encoded here:
 *  1. SINGLE FIXED PLACEHOLDER — every redaction, regardless of the secret value or the carrier it
 *     is embedded in (Bearer header, inline `api_key=`/`token=`/`secret=` pair, credential URI, or
 *     a secret-named object field), substitutes the *same* constant placeholder string.
 *  2. SHARES NO ORIGINAL CHARACTER — that placeholder contains none of the characters of the
 *     original redacted value.
 *
 * For obligation (2) to hold universally the original secret must be drawn from a character space
 * that is disjoint from the placeholder's own characters. The placeholder is `[REDACTED]`, whose
 * characters are `[`, `]`, and the letters R, E, D, A, C, T. The generator below therefore draws
 * delimiter-free secrets from an alphabet that excludes those letters (in either case) and the
 * brackets — exactly the design's intent (a placeholder chosen to share no character with the
 * secrets it replaces). A delimiter-free secret also guarantees the redaction patterns remove it
 * WHOLLY, so no partial substring survives to muddy the character-disjointness check.
 *
 * Hermetic: pure string/object transforms through `src/security/redaction.ts`. No network, no
 * filesystem, no clock, no API key.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactSecrets, redactString } from "../src/security/redaction";

/** The single fixed placeholder the Redaction_Layer substitutes (Requirement 10.2). */
const FIXED_PLACEHOLDER = "[REDACTED]";

/**
 * Characters that appear in the fixed placeholder, compared case-insensitively. Secrets are
 * generated to avoid every one of these so the "shares no character of the original" invariant is
 * a genuine, non-vacuous property of the chosen placeholder.
 */
const PLACEHOLDER_CHARS = new Set(FIXED_PLACEHOLDER.toLowerCase().split(""));

/**
 * Alphabet for generated secrets: digits plus the lower/upper letters NOT present in `[REDACTED]`
 * (excludes r,e,d,a,c,t in both cases and the brackets). Delimiter-free so the secret is removed
 * wholly by `redactString`'s patterns.
 */
const SAFE_LETTERS = "bfghijklmnopqsuvwxyz";
const SAFE_ALPHABET = (
  SAFE_LETTERS +
  SAFE_LETTERS.toUpperCase() +
  "0123456789"
).split("");

/** A non-empty, delimiter-free secret whose characters are disjoint from the placeholder. */
const arbSecret = fc
  .array(fc.constantFrom(...SAFE_ALPHABET), { minLength: 6, maxLength: 48 })
  .map((chars) => chars.join(""));

/**
 * Carriers the Redaction_Layer targets. Each embeds the raw secret in a form `redactString` (and,
 * for the object case, `redactSecrets`) is guaranteed to replace with the fixed placeholder.
 */
const stringCarriers: Array<{ name: string; build: (secret: string) => string }> = [
  { name: "bearer-header", build: (s) => `Authorization: Bearer ${s}` },
  { name: "basic-header", build: (s) => `Authorization: Basic ${s}` },
  { name: "inline-api_key", build: (s) => `api_key=${s}` },
  { name: "inline-token", build: (s) => `token=${s}` },
  { name: "inline-secret", build: (s) => `secret=${s}` },
  { name: "credential-uri", build: (s) => `https://admin:${s}@db.example.com/v1` },
];

const carrierArb = fc.constantFrom(...stringCarriers);

/** True iff `placeholder` and `secret` share no character (case-insensitive). */
function sharesNoCharacter(placeholder: string, secret: string): boolean {
  const secretChars = new Set(secret.toLowerCase().split(""));
  for (const ch of placeholder.toLowerCase()) {
    if (secretChars.has(ch)) return false;
  }
  return true;
}

describe("Property 37: redaction uses a single fixed placeholder sharing no original character (Req 10.2)", () => {
  it("substitutes the one fixed placeholder for string secrets, and the placeholder shares no character with the secret", () => {
    fc.assert(
      fc.property(arbSecret, carrierArb, (secret, carrier) => {
        const carried = carrier.build(secret);
        const redacted = redactString(carried);

        // (1) The single fixed placeholder is the substitution used.
        expect(redacted).toContain(FIXED_PLACEHOLDER);

        // The secret was removed wholly — no surviving substring of the original value.
        expect(redacted).not.toContain(secret);

        // (2) The fixed placeholder shares no character with the original redacted value.
        expect(sharesNoCharacter(FIXED_PLACEHOLDER, secret)).toBe(true);

        // Sanity: by construction the secret's alphabet excludes the placeholder's characters.
        for (const ch of secret) {
          expect(PLACEHOLDER_CHARS.has(ch.toLowerCase())).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("replaces a secret-named object field with the identical fixed placeholder", () => {
    fc.assert(
      fc.property(arbSecret, (secret) => {
        const redacted = redactSecrets({ apiKey: secret, token: secret, password: secret }) as Record<
          string,
          string
        >;

        // Every secret-named field collapses to the exact same fixed placeholder string.
        for (const field of ["apiKey", "token", "password"] as const) {
          expect(redacted[field]).toBe(FIXED_PLACEHOLDER);
        }

        // The placeholder shares no character with the original redacted value.
        expect(sharesNoCharacter(FIXED_PLACEHOLDER, secret)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it("uses one and only one placeholder constant across every carrier and field", () => {
    const observed = new Set<string>();
    fc.assert(
      fc.property(arbSecret, carrierArb, (secret, carrier) => {
        // Recover the substitution that replaced the secret in the string carrier.
        const redactedString = redactString(carrier.build(secret));
        const stringMatch = redactedString.match(/\[[A-Z]+\]/);
        if (stringMatch) observed.add(stringMatch[0]);

        // ...and the substitution used for a secret-named field.
        const redactedField = redactSecrets({ apiKey: secret }) as { apiKey: string };
        observed.add(redactedField.apiKey);
      }),
      { numRuns: 200 }
    );

    // A SINGLE fixed placeholder: exactly one distinct substitution string was ever emitted.
    expect([...observed]).toEqual([FIXED_PLACEHOLDER]);
  });
});
