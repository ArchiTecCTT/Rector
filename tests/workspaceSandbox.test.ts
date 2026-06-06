/**
 * Workspace sandbox property tests (ORN-37).
 *
 * Property 2: No path escapes the workspace root.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 *
 * The containment gate `resolveWithinWorkspace` is the single choke point every
 * file/patch operation passes through before any I/O. This property asserts the
 * design invariant directly:
 *
 *   ∀ workspaceRoot w, ∀ candidate path c (arbitrary relative, absolute,
 *   ".."-laden, or symlink target):
 *     resolveWithinWorkspace(w, c).ok = true
 *       ⟹ result.absolutePath = w ∨ result.absolutePath.startsWith(w + SEP)
 *     ∧ no read/list/write ever touched a path outside w.
 *
 * For every adversarial category the resolver must deny the path with the exact
 * `denialReason` defined by the fixed check order (empty → absolute → `..` →
 * symlink), withhold the resolved absolute path on denial, and never perform
 * out-of-root I/O. The workspace filesystem is injected via the in-memory
 * `WorkspaceFs` double, so no real disk, API key, or network is used.
 */
import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { resolveWithinWorkspace } from "../src/sandbox";
import {
  arbAdversarialPathCase,
  arbSafeRelativePathCase,
  arbSymlinkEscapeCase,
  arbWorkspacePathCase,
  createWorkspaceFs,
  isWithinRoot,
  type CandidatePathCase,
} from "./support/byokArbitraries";

// A genuine absolute path on the host platform (POSIX or Windows). Using
// `path.resolve` keeps the fixture cross-platform: the injected `WorkspaceFs`
// normalizes to POSIX internally, while `resolveWithinWorkspace` uses the
// platform `node:path` for resolution.
const WORKSPACE_ROOT = nodePath.resolve("workspace-sandbox-fixture-root");

/**
 * Builds an injected in-memory workspace filesystem for a candidate case,
 * registering the symlink entry (pointing outside the root) when the case is a
 * symlink-escape so the realpath check can detect the escape.
 *
 * `resolveWithinWorkspace` extracts `fsImpl.realpathSync` as a standalone
 * reference (the production default is `node:fs.realpathSync`, a free function),
 * so the in-memory double's bound method is supplied explicitly to preserve
 * `this`. The same `fs` instance is returned for access-tracking assertions.
 */
function buildWorkspaceFs(testCase: CandidatePathCase) {
  const fs = createWorkspaceFs({ root: WORKSPACE_ROOT });
  if (testCase.symlink) {
    fs.addSymlink(testCase.symlink.linkRelativePath, testCase.symlink.targetAbsolutePath);
  }
  const fsImpl = { realpathSync: (path: string) => fs.realpathSync(path) };
  return { fs, fsImpl };
}

describe("Property 2: no path escapes the workspace root", () => {
  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
  it("resolves contained paths and denies every escape with the correct reason, never touching out-of-root paths", () => {
    fc.assert(
      fc.property(arbWorkspacePathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        if (testCase.expectedDenial === null) {
          // Req 3.6: a successful resolution returns an absolute path equal to,
          // or a descendant of, the workspace root.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(isWithinRoot(WORKSPACE_ROOT, result.absolutePath)).toBe(true);
          }
        } else {
          // Reqs 3.2/3.3/3.4/3.5: denial carries the reason for the FIRST failed
          // check in the fixed order (empty → absolute → `..` → symlink).
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe(testCase.expectedDenial);
          }
          // Req 3.7: the resolved absolute path is withheld on denial.
          expect("absolutePath" in result).toBe(false);
        }

        // Reqs 3.1/3.5: containment is decided before any I/O, and resolution
        // never reads, lists, or writes a path outside the workspace root.
        expect(fs.accessedOutsideRoot()).toEqual([]);
        // The gate is side-effect-free with respect to the workspace contents.
        expect(fs.writes).toEqual([]);
        expect(fs.reads).toEqual([]);
        expect(fs.lists).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7
  it("denies every adversarial path (empty, absolute, `..`, symlink-escape) with no out-of-root access", () => {
    fc.assert(
      fc.property(arbAdversarialPathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe(testCase.expectedDenial);
        }
        // No resolved path is leaked for a denied operation.
        expect("absolutePath" in result).toBe(false);
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirement 3.5 — symlink realpath escape is denied even though
  // the candidate is a syntactically safe relative path.
  it("denies a safe-looking relative path whose realpath resolves outside the root via a symlink", () => {
    fc.assert(
      fc.property(arbSymlinkEscapeCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("SYMLINK_ESCAPE");
        }
        expect("absolutePath" in result).toBe(false);
        // The escaping realpath was resolved but never read/listed/written.
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirement 3.6 — a contained relative path resolves to a
  // workspace-rooted absolute path.
  it("resolves safe relative paths to a contained absolute path", () => {
    fc.assert(
      fc.property(arbSafeRelativePathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(isWithinRoot(WORKSPACE_ROOT, result.absolutePath)).toBe(true);
        }
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });
});
