import { describe, expect, it } from "vitest";

import { CredentialPool } from "../src/providers/credentialPool";

describe("CredentialPool", () => {
  it("acquires credentials round-robin for a provider", () => {
    const pool = new CredentialPool([
      { providerId: "primary", secretRef: "secret-a" },
      { providerId: "primary", secretRef: "secret-b" },
    ]);

    expect(pool.acquire("primary")?.secretRef).toBe("secret-a");
    expect(pool.acquire("primary")?.secretRef).toBe("secret-b");
    expect(pool.acquire("primary")?.secretRef).toBe("secret-a");
  });

  it("skips cooled-down entries", () => {
    const now = new Date("2026-06-13T00:00:00.000Z");
    const pool = new CredentialPool([
      { providerId: "primary", secretRef: "secret-a", cooldownUntil: "2026-06-13T00:01:00.000Z" },
      { providerId: "primary", secretRef: "secret-b" },
    ], () => now);

    expect(pool.acquire("primary")?.secretRef).toBe("secret-b");
  });

  it("returns undefined for an empty provider pool", () => {
    const pool = new CredentialPool([]);

    expect(pool.acquire("missing")).toBeUndefined();
  });
});
