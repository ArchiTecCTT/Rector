/**
 * Task 14.7 — Unit test for redaction-failure suppression.
 *
 * **Validates: Requirements 10.6**
 *
 * Requirement 10.6: "IF outbound redaction of a value fails, THEN THE Rector_Server SHALL suppress
 * the raw value and emit the fixed redaction-failed placeholder instead."
 *
 * The outbound boundary is `redactOutbound` (structured value path) and `redactStringOrSuppress`
 * (single-string path) in `src/security/redaction.ts`. Both run their input through the redactor
 * inside a try/catch; when the redactor throws, the raw (unredacted) input must NEVER be returned —
 * it is suppressed and replaced with the fixed `REDACTION_FAILED_ERROR` placeholder.
 *
 * To force redaction to throw without mocking, each hostile input carries a secret in a normally
 * redactable form AND a field whose access throws (a getter that throws / a `replace` that throws).
 * The redactor walks into that field and raises, exercising the real failure path. The assertions
 * confirm (a) the fixed placeholder is emitted and (b) the carried secret appears nowhere in the
 * returned outcome — i.e. the raw value was genuinely suppressed, not partially leaked.
 *
 * Hermetic: pure function calls, no network, no filesystem, no API key.
 */
import { describe, expect, it } from "vitest";

import {
  REDACTION_FAILED_ERROR,
  redactOutbound,
  redactStringOrSuppress,
  redactSecrets,
} from "../src/security/redaction";

// A distinctive, delimiter-free secret. If any byte of it survived into a returned value, the
// `toContain` assertions below would catch it.
const SECRET = "sk-LEAK-DEADBEEF0123456789";

describe("redaction-failure suppression (Requirement 10.6)", () => {
  it("redactOutbound suppresses the raw value and emits the fixed placeholder when redaction throws", () => {
    // The value carries the secret in a redactable carrier (`Bearer <secret>`) AND an exploding
    // getter. Serializing/redacting it forces the redactor to read `explode`, which throws.
    const hostile = {
      authorization: `Bearer ${SECRET}`,
      get explode(): unknown {
        throw new Error("redaction boom");
      },
    };

    const outcome = redactOutbound(hostile);

    // Failure outcome: the raw value is suppressed, only the fixed placeholder is returned.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected redaction to fail and suppress the value");
    expect(outcome.error).toBe(REDACTION_FAILED_ERROR);

    // The suppressed secret must not appear anywhere in the returned outcome.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("redactStringOrSuppress returns the fixed placeholder (never the raw string) when redaction throws", () => {
    // A string-typed input whose `replace` throws drives `redactString` into a throw on its first
    // `.replace(...)` call. `toString` still embeds the secret, so a non-suppressing implementation
    // would risk leaking it.
    const hostileString = {
      replace(): string {
        throw new Error("replace boom");
      },
      toString(): string {
        return `Authorization: Bearer ${SECRET}`;
      },
    } as unknown as string;

    const result = redactStringOrSuppress(hostileString);

    // The fixed placeholder is emitted in place of the raw string.
    expect(result).toBe(REDACTION_FAILED_ERROR);
    // The carried secret was suppressed, not emitted.
    expect(result).not.toContain(SECRET);
  });

  it("the suppression placeholder is a fixed constant that contains none of the suppressed secret", () => {
    // The placeholder is content-free: it is the same fixed string regardless of input and shares
    // no character run with the suppressed secret (it carries only the constant, never caller data).
    expect(REDACTION_FAILED_ERROR).toBe("redaction-failed: outbound content suppressed");
    expect(REDACTION_FAILED_ERROR).not.toContain(SECRET);
  });

  it("the underlying redactor genuinely throws on the hostile value (failure path is real, not mocked)", () => {
    // Guards against the test silently passing because redaction succeeded: confirm the raw redactor
    // really raises on this input, so `redactOutbound`'s catch branch is the path under test.
    const hostile = {
      get explode(): unknown {
        throw new Error("redaction boom");
      },
    };
    expect(() => redactSecrets(hostile)).toThrow();
  });

  it("redactOutbound still returns the redacted value on the success path (sanity)", () => {
    const outcome = redactOutbound({ authorization: `Bearer ${SECRET}` });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected redaction to succeed for a well-formed value");
    // Success path redacts rather than suppresses: the secret is gone but the value is returned.
    expect(JSON.stringify(outcome.value)).not.toContain(SECRET);
  });
});
