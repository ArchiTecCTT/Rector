import { describe, it, expect } from "vitest";
import {
  validateSessionSecretEntropy,
  checkSessionSecretEntropy,
  parseAuthConfig,
} from "../src/security/auth";

describe("validateSessionSecretEntropy", () => {
  it("accepts a strong 64-char hex secret", () => {
    expect(() =>
      validateSessionSecretEntropy("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"),
    ).not.toThrow();
  });

  it("accepts a 32-char secret with 8+ unique characters", () => {
    expect(() =>
      validateSessionSecretEntropy("abcdefghijklmnopqrstuvwxyz123456"),
    ).not.toThrow();
  });

  it("throws for secrets shorter than 32 characters", () => {
    expect(() => validateSessionSecretEntropy("short")).toThrow(
      /at least 32 characters/,
    );
  });

  it("throws for a 31-character secret", () => {
    expect(() =>
      validateSessionSecretEntropy("abcdefghijklmnopqrstuvwxyz12345"),
    ).toThrow(/at least 32 characters/);
  });

  it("includes generation hint in the length error", () => {
    try {
      validateSessionSecretEntropy("short");
    } catch (err) {
      expect((err as Error).message).toContain(
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
      return;
    }
    expect.unreachable("Expected an error to be thrown");
  });

  it("throws for secrets with fewer than 8 unique characters", () => {
    // 32 chars but only 2 unique characters
    expect(() => validateSessionSecretEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab")).toThrow(
      /at least 8 unique characters/,
    );
  });

  it("throws for a secret with exactly 7 unique characters", () => {
    // 32 chars but only 7 unique: a, b, c, d, e, f, g
    expect(() =>
      validateSessionSecretEntropy("abcdefgabcdefgabcdefgabcdefgabcde"),
    ).toThrow(/at least 8 unique characters/);
  });

  it("includes generation hint in the uniqueness error", () => {
    try {
      validateSessionSecretEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    } catch (err) {
      expect((err as Error).message).toContain(
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
      return;
    }
    expect.unreachable("Expected an error to be thrown");
  });

  it("accepts a secret with exactly 8 unique characters and 32 length", () => {
    expect(() =>
      validateSessionSecretEntropy("abcdefghabcdefghabcdefghabcdefgh"),
    ).not.toThrow();
  });

  it("reports actual length in the error message", () => {
    try {
      validateSessionSecretEntropy("tooshort");
    } catch (err) {
      expect((err as Error).message).toContain("got 8");
      return;
    }
    expect.unreachable("Expected an error to be thrown");
  });

  it("reports actual unique count in the error message", () => {
    try {
      validateSessionSecretEntropy("ababababababababababababababababab");
    } catch (err) {
      expect((err as Error).message).toContain("got 2");
      return;
    }
    expect.unreachable("Expected an error to be thrown");
  });
});

describe("checkSessionSecretEntropy", () => {
  it("returns null for a strong secret", () => {
    expect(
      checkSessionSecretEntropy(
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      ),
    ).toBeNull();
  });

  it("returns null for empty secret", () => {
    expect(checkSessionSecretEntropy("")).toBeNull();
  });

  it("returns warning for short secret", () => {
    const warning = checkSessionSecretEntropy("short");
    expect(warning).not.toBeNull();
    expect(warning).toContain("shorter than 32 characters");
  });

  it("returns warning for low-unique-char secret", () => {
    const warning = checkSessionSecretEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab");
    expect(warning).not.toBeNull();
    expect(warning).toContain("only 2 unique characters");
  });
});

describe("parseAuthConfig integration", () => {
  it("throws on low-entropy session secret when auth is enabled", () => {
    expect(() =>
      parseAuthConfig({
        RECTOR_AUTH_ENABLED: "true",
        RECTOR_AUTH_SESSION_SECRET: "short",
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("throws on low-unique-char secret when auth is enabled", () => {
    expect(() =>
      parseAuthConfig({
        RECTOR_AUTH_ENABLED: "true",
        RECTOR_AUTH_SESSION_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/at least 8 unique characters/);
  });

  it("accepts a strong secret when auth is enabled", () => {
    const config = parseAuthConfig({
      RECTOR_AUTH_ENABLED: "true",
      RECTOR_AUTH_SESSION_SECRET:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    });
    expect(config.enabled).toBe(true);
    expect(config.sessionSecret).toBe(
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    );
  });

  it("does not validate entropy when auth is disabled", () => {
    // No throw even though secret is short — auth is off
    const config = parseAuthConfig({
      RECTOR_AUTH_ENABLED: "false",
      RECTOR_AUTH_SESSION_SECRET: "short",
    });
    expect(config.enabled).toBe(false);
  });
});
