import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock node:os before importing the module under test
vi.mock("node:os", () => ({
  platform: vi.fn().mockReturnValue("linux"),
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { mkdirSync, chmodSync } from "node:fs";
import { platform } from "node:os";
import { execSync } from "node:child_process";
import {
  ensureRestrictedDir,
  ensureRestrictedFile,
  fixExistingDirPermissions,
} from "../src/security/filePermissions";

const mockedPlatform = vi.mocked(platform);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedChmodSync = vi.mocked(chmodSync);
const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("ensureRestrictedDir", () => {
  it("creates directory with 0o700 mode on POSIX", () => {
    mockedPlatform.mockReturnValue("linux");

    ensureRestrictedDir("/tmp/test-dir");

    expect(mockedMkdirSync).calledOnceWith("/tmp/test-dir", {
      recursive: true,
      mode: 0o700,
    });
    expect(mockedChmodSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("creates directory and applies icacls on win32", () => {
    mockedPlatform.mockReturnValue("win32");

    ensureRestrictedDir("C:\\Users\\test\\.rector");

    expect(mockedMkdirSync).calledOnceWith("C:\\Users\\test\\.rector", {
      recursive: true,
      mode: 0o700,
    });
    expect(mockedExecSync).calledOnceWith(
      'icacls "C:\\Users\\test\\.rector" /inheritance:r /grant:r "%USERNAME%:F"',
      { stdio: "pipe" },
    );
    expect(mockedChmodSync).not.toHaveBeenCalled();
  });

  it("warns but does not throw when icacls fails on win32", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockImplementation(() => {
      throw new Error("icacls failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => ensureRestrictedDir("C:\\bad\\path")).not.toThrow();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("Failed to set restrictive ACL");
    warnSpy.mockRestore();
  });
});

describe("ensureRestrictedFile", () => {
  it("chmods file to 0o600 on POSIX", () => {
    mockedPlatform.mockReturnValue("linux");

    ensureRestrictedFile("/tmp/test-file");

    expect(mockedChmodSync).calledOnceWith("/tmp/test-file", 0o600);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("applies icacls on win32", () => {
    mockedPlatform.mockReturnValue("win32");

    ensureRestrictedFile("C:\\Users\\test\\.rector\\secret.key");

    expect(mockedExecSync).calledOnceWith(
      'icacls "C:\\Users\\test\\.rector\\secret.key" /inheritance:r /grant:r "%USERNAME%:F"',
      { stdio: "pipe" },
    );
    expect(mockedChmodSync).not.toHaveBeenCalled();
  });

  it("warns but does not throw when icacls fails on win32", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockImplementation(() => {
      throw new Error("access denied");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => ensureRestrictedFile("C:\\locked\\file")).not.toThrow();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("Failed to set restrictive ACL");
    warnSpy.mockRestore();
  });
});

describe("fixExistingDirPermissions", () => {
  it("chmods existing directory to 0o700 on POSIX", () => {
    mockedPlatform.mockReturnValue("linux");

    fixExistingDirPermissions("/tmp/existing-dir");

    expect(mockedChmodSync).calledOnceWith("/tmp/existing-dir", 0o700);
    expect(mockedMkdirSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("re-applies icacls on win32", () => {
    mockedPlatform.mockReturnValue("win32");

    fixExistingDirPermissions("C:\\Users\\test\\.rector");

    expect(mockedExecSync).calledOnceWith(
      'icacls "C:\\Users\\test\\.rector" /inheritance:r /grant:r "%USERNAME%:F"',
      { stdio: "pipe" },
    );
    expect(mockedMkdirSync).not.toHaveBeenCalled();
    expect(mockedChmodSync).not.toHaveBeenCalled();
  });

  it("warns but does not throw when icacls fails on win32", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockImplementation(() => {
      throw new Error("permission error");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => fixExistingDirPermissions("C:\\bad\\dir")).not.toThrow();

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("also works on darwin (POSIX path)", () => {
    mockedPlatform.mockReturnValue("darwin");

    fixExistingDirPermissions("/Users/test/.rector");

    expect(mockedChmodSync).calledOnceWith("/Users/test/.rector", 0o700);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});
