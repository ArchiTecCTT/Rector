/**
 * Feature: cloud-capable-transition, Property 40.
 *
 * Task 14.6 — Property test for connection-URL redaction.
 *
 * **Property 40: Connection-URL redaction replaces userinfo and retains other components.**
 * **Validates: Requirements 10.5**
 *
 * Requirement 10.5: "WHEN a value containing a credential-bearing connection URL is logged, THE
 * Redaction_Layer SHALL replace the userinfo credential component with the placeholder while
 * retaining the other URL components."
 *
 * For any connection URL of the shape `scheme://user:password@host[:port][/path]`, running it
 * through the Redaction_Layer's `redactString` must:
 *   1. replace the `user:password` userinfo component with the fixed `[REDACTED]` placeholder, and
 *   2. retain every other component verbatim — the scheme, host, port, and path.
 *
 * The test is fully hermetic: it exercises the pure `redactString` function only — no network, no
 * filesystem, no provider, no API key.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactString } from "../src/security/redaction";

const REDACTED = "[REDACTED]";

/**
 * Schemes that match the Redaction_Layer's credential-URI scheme grammar `[a-z][a-z0-9+.-]*`.
 * These cover the realistic connection-URL family (databases, brokers, caches, generic HTTP).
 */
const arbScheme = fc.constantFrom(
  "mysql",
  "mysql2",
  "postgres",
  "postgresql",
  "redis",
  "rediss",
  "mongodb",
  "amqp",
  "https",
);

/**
 * Userinfo tokens (user + password) constrained to the userinfo character space the redactor
 * targets: the pattern consumes `[^\s/@]*` before the `@`, so the token must contain no
 * whitespace, `/`, or `@`. We use a distinctive alphanumeric charset so the generated value cannot
 * coincidentally appear inside the fixed host/path components below.
 */
const userinfoChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const arbUserinfoToken = fc
  .array(fc.constantFrom(...userinfoChars), { minLength: 3, maxLength: 16 })
  .map((chars) => chars.join(""));

/** A distinctive host with no overlap with the uppercase/digit userinfo charset. */
const arbHost = fc.constantFrom(
  "db.internal.example.com",
  "primary.tidb.example.net",
  "cache.svc.cluster.local",
  "queue.broker.example.org",
);

/** Optional `:port` component. */
const arbPort = fc.option(
  fc.integer({ min: 1, max: 65535 }).map((p) => `:${p}`),
  { nil: "" },
);

/** Optional `/path` component (database name / resource path), lowercase to avoid charset overlap. */
const arbPath = fc.option(
  fc.constantFrom("/appdb", "/rector", "/v1/resource", "/metrics", "/0"),
  { nil: "" },
);

describe("Connection-URL redaction (Feature: cloud-capable-transition, Property 40, Req 10.5)", () => {
  it("replaces the userinfo credential component with the placeholder and retains scheme, host, port, and path", () => {
    fc.assert(
      fc.property(
        arbScheme,
        arbUserinfoToken,
        arbUserinfoToken,
        arbHost,
        arbPort,
        arbPath,
        (scheme, user, password, host, port, path) => {
          const rest = `${host}${port}${path}`;
          const url = `${scheme}://${user}:${password}@${rest}`;

          const redacted = redactString(url);

          // (1) The userinfo is replaced by the fixed placeholder, immediately before the `@`.
          const expected = `${scheme}://${REDACTED}@${rest}`;
          expect(redacted).toBe(expected);

          // (2) The other components are retained verbatim.
          expect(redacted.startsWith(`${scheme}://`)).toBe(true); // scheme retained
          expect(redacted).toContain(host); // host retained
          if (port !== "") expect(redacted).toContain(port); // port retained
          if (path !== "") expect(redacted).toContain(path); // path retained
          expect(redacted).toContain(`${REDACTED}@`); // placeholder occupies the userinfo slot

          // (3) Neither the user nor the password credential survives in the output.
          expect(redacted).not.toContain(`${user}:${password}`);
          expect(redacted).not.toContain(`${user}:${password}@`);
        },
      ),
      { numRuns: 200 },
    );
  });
});
