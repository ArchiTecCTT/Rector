/**
 * Centralized utility for restrictive file/directory permissions.
 *
 * Ensures that sensitive directories (e.g. `.rector/`) and files (e.g.
 * `secret.key`, `secrets.enc`, `rector.db`) are created with the most
 * restrictive permissions available on the current platform.
 *
 * - POSIX: directories get 0o700, files get 0o600
 * - Windows: uses `icacls` to remove inheritance and grant only the
 *   current user full control (best-effort, warns on failure)
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { execSync } from "node:child_process";

/**
 * Apply Windows ACL restrictions via icacls (best-effort).
 * Removes inheritance and grants full control to the current user only.
 */
function win32RestrictAcl(targetPath: string): void {
  const command = `icacls "${targetPath}" /inheritance:r /grant:r "%USERNAME%:F"`;
  try {
    execSync(command, { stdio: "pipe" });
  } catch (err) {
    console.warn(
      `[SECURITY] Failed to set restrictive ACL on "${targetPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isWin32(): boolean {
  return platform() === "win32";
}

/**
 * Ensure a directory exists with restrictive permissions (0o700 on POSIX,
 * owner-only ACL on Windows).
 *
 * Creates the directory (and parents) if it doesn't exist, then applies
 * platform-appropriate permission restrictions.
 */
export function ensureRestrictedDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (isWin32()) {
    win32RestrictAcl(dirPath);
  }
}

/**
 * Apply restrictive permissions to an existing file (0o600 on POSIX,
 * owner-only ACL on Windows).
 *
 * On Windows, uses icacls to remove inheritance and grant only the current
 * user full control. On POSIX, uses chmod 0o600.
 */
export function ensureRestrictedFile(filePath: string): void {
  if (isWin32()) {
    win32RestrictAcl(filePath);
  } else {
    chmodSync(filePath, 0o600);
  }
}

/**
 * Re-apply restrictive permissions on an existing directory.
 *
 * Used during server startup to fix permissions on directories that may have
 * been created with overly permissive defaults by earlier versions or by
 * external tools. On POSIX, re-applies 0o700. On Windows, re-applies the
 * owner-only ACL.
 */
export function fixExistingDirPermissions(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  if (isWin32()) {
    win32RestrictAcl(dirPath);
  } else {
    chmodSync(dirPath, 0o700);
  }
}
