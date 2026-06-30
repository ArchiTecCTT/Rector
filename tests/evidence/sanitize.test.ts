import { describe, expect, it } from "vitest";

import { sanitizeEvidencePayload } from "../../src/evidence";

describe("sanitizeEvidencePayload", () => {
  it("delegates durable evidence redaction to Rector security redaction utilities", () => {
    const token = "tok_live_evidence_secret";
    const payload = {
      provider: {
        apiKey: token,
        baseUrl: "https://user:password@example.test/v1",
      },
      request: {
        authorization: `Bearer ${token}`,
        prompt: `Authorization: Bearer ${token}`,
      },
    };

    const sanitized = sanitizeEvidencePayload(payload);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("user:password");
    expect(sanitized.provider.apiKey).toBe("[REDACTED]");
    expect(sanitized.provider.baseUrl).toBe("https://[REDACTED]@example.test/v1");
    expect(sanitized.request.authorization).toBe("[REDACTED]");
    expect(sanitized.request.prompt).toContain("Bearer [REDACTED]");
  });
});
