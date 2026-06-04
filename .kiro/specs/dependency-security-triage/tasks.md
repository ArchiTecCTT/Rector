# Implementation Plan: Dependency Security Triage

## Overview

This plan executes the 6-stage **Triage_Process** from the design: capture and commit a
structured Audit_Report, analyze root causes, apply the Safe_Fix for the Esbuild_Advisory
(`overrides.esbuild = ">=0.25.0"`), verify against the known-good baseline, optionally lock the
override in place with a config-assertion test, and update the Concerns_Register.

The deliverables are configuration (`package.json`, lockfile) and documentation (Audit_Report,
Concerns_Register), so correctness is enforced by the existing 278-test regression suite plus
`build`/`check` acting as a verification gate (no property-based tests — the design omits the
Correctness Properties section by design). Implementation language for the optional test is
**TypeScript** (Vitest), matching the existing suite.

Hard constraints honored throughout:

- No new runtime dependency, real-network test traffic, or required API key (`npm audit` /
  `npm install` package-manager registry calls are allowed; Rector application network is not).
- `npm audit fix --force` and any Forced_Fix requiring it MUST NOT be run autonomously; it
  requires explicit Maintainer approval.
- The baseline (`npm test` >= 28 files / >= 278 tests, `npm run build`, `npm run check`) must
  never regress.

## Tasks

- [ ] 1. Stage 1: Capture and commit the Audit Report
  - [ ] 1.1 Create `docs/security/` and capture audit output into a structured Audit_Report
    - Create the `docs/security/` directory (new committed Audit_Report_Directory)
    - Run `npm audit` and `npm audit --json`; capture the human-readable summary and the
      machine-readable per-finding detail
    - Create `docs/security/dependency-audit-<date>.md` using the design's Audit_Report schema:
      Date, Command(s), npm version, Node version, Summary (counts by severity), Metadata
      capture status; and per-finding fields (package, vulnerable range, severity, advisory ID)
    - Record the date and the exact commands used to produce the report; commit it as a tracked
      file
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 1.2 Implement the metadata-capture fallback (EH-1)
    - If the report file is written but metadata (date/command/tool versions) cannot be
      captured, retain the report file unchanged and set `Metadata capture status: partial`
      with a note describing what could not be captured (never discard or rewrite the findings)
    - _Requirements: 1.6_

- [ ] 2. Stage 2: Root-cause analysis and classification
  - [ ] 2.1 Enumerate findings with dependency paths, classification, and runtime exposure
    - For each vulnerable package: resolve the dependency path that introduces it (from
      `npm audit --json`), and classify it as direct, dev, or transitive
    - Where a finding affects only dev tooling and not the `dist` runtime, note the reduced
      runtime exposure in the finding analysis
    - Write these fields into the corresponding Finding sections of the Audit_Report
    - _Requirements: 2.1, 2.2, 2.5_

  - [ ] 2.2 Document the esbuild path and assign remediation categories
    - Document the Esbuild_Advisory (GHSA-67mh-4wv8-2f99) dependency path via the `vitest`/`vite`
      and `tsx` development tooling
    - Record, for each finding, the root cause and the remediation category per the Decision
      Matrix (Safe_Fix, deferral, or escalation for approval)
    - _Requirements: 2.3, 2.4_

- [ ] 3. Stage 3: Apply the Safe_Fix for the Esbuild_Advisory
  - [ ] 3.1 Add the esbuild override and regenerate the lockfile
    - Add `"overrides": { "esbuild": ">=0.25.0" }` to `package.json` (additive; leave runtime
      `dependencies`/`devDependencies` untouched to preserve Provider_Free_Mode)
    - Regenerate the lockfile by running `npm install` (do not hand-edit the lockfile)
    - Describe the applied change and the affected dependency in the Audit_Report records
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [ ] 3.2 Confirm the override resolved correctly (EH-7)
    - Run `npm ls esbuild` and confirm every resolved `esbuild` entry is `>=0.25.0`
    - If `npm ls esbuild` still reports a vulnerable version, or install reports peer/resolution
      conflicts, treat it as a failed verification: revert the change and record the cause
      (handoff to task 4.2)
    - _Requirements: 3.3_

  - [ ] 3.3 Enforce the Forced_Fix approval gate (no autonomous `--force`)
    - Do NOT run `npm audit fix --force`. If any finding's only remediation requires it, or a
      candidate remediation breaks the baseline, do not apply it; record the finding as a
      Remaining_Vulnerability requiring approval in the Audit_Report and route it to the
      Concerns_Register (task 7.2)
    - A Forced_Fix that does NOT require `--force` and does NOT break the baseline MAY be applied
      after recording the change; anything requiring `--force` is always escalated
    - **Maintainer approval required: applying a Forced_Fix that requires `npm audit fix --force`
      requires explicit user approval and MUST NOT be done autonomously.**
    - _Requirements: 3.4, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 6.4_

- [ ] 4. Stage 4: Verification gate
  - [ ] 4.1 Run the full Verification_Baseline after applying the fix
    - Run `npm test`, `npm run build`, and `npm run check`
    - Confirm `npm test` reports at least 28 test files and 278 passing tests; confirm
      `npm run build` and `npm run check` complete successfully
    - Confirm the change kept providers disabled by default, added no required API key, and kept
      the default `npm test` run free of real network access
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3_

  - [ ] 4.2 Implement revert-on-regression handling (EH-4, EH-7)
    - If any baseline command fails after the change — including `npm test` reporting fewer than
      28 files or fewer than 278 tests — revert `package.json` and the lockfile to their
      pre-change state and record the failure cause
    - Reclassify the affected finding as a Remaining_Vulnerability; leave no partially verified
      change in the tree
    - _Requirements: 5.5_

- [ ] 5. Checkpoint - Ensure the fix verifies cleanly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Stage 5: Optional regression test for the override
  - [ ]* 6.1 Add `tests/dependencySecurity.test.ts` asserting the esbuild override
    - Model it on `tests/releasePackaging.test.ts`: import `../package.json` and assert
      `packageJson.overrides.esbuild === ">=0.25.0"` (and that `overrides` is defined)
    - Keep it deterministic, with no network access, no API keys, and fully in-process so it
      raises the baseline test count rather than lowering it
    - _Requirements: 3.1, 3.5_

- [ ] 7. Stage 6: Update documentation and the Concerns_Register
  - [ ] 7.1 Move the Dependency_Audit_Item to mitigated and reference the Audit_Report
    - In `docs/plans/concerns-and-vulnerabilities.md`, move the "Dependency audit reports
      vulnerabilities" item from Open to Closed / Mitigated once the Safe_Fix resolves the
      Esbuild_Advisory, describing the applied override fix
    - Reference the `docs/security/dependency-audit-<date>.md` path for traceability
    - _Requirements: 7.1, 7.3_

  - [ ] 7.2 Record Remaining_Vulnerabilities and enforce the register-retention guard (EH-6)
    - For each Remaining_Vulnerability, add or keep an Open entry documenting its severity, root
      cause, and the rationale for deferral; retain the tracked entry while it is unresolved
    - If the Concerns_Register cannot be written, or an edit would drop unresolved records, halt
      the process and surface the failure to the Maintainer rather than proceeding
    - _Requirements: 7.2, 7.4, 7.5_

- [ ] 8. Final verification - re-run the full baseline and capture evidence
  - [ ] 8.1 Re-run the Verification_Baseline and record the resolved state
    - Re-run `npm test`, `npm run build`, and `npm run check` with the optional config-assertion
      test included; confirm at least 28 files / 278 tests pass (>= 29 files / >= 279 tests if
      task 6.1 was added) and that build and check succeed
    - Re-run `npm audit` and `npm ls esbuild`; confirm the Esbuild_Advisory is no longer reported
      and all resolved `esbuild` is `>=0.25.0`
    - Capture the command evidence into the Audit_Report for traceability
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.3_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; task 6.1 is optional
  because the override's real-world effect is already proven by the build/test gate — its value
  is regression protection against accidental removal of the override.
- Each task references the specific requirement clauses it satisfies for traceability, with the
  relevant Error Handling section (EH-1, EH-4, EH-6, EH-7) noted inline.
- This spec adds no property-based tests: per the design, the change is configuration and
  documentation with no "for all inputs" property, so the existing regression suite plus
  `build`/`check` is the correctness gate.
- Maintainer approval gate: applying any Forced_Fix that requires `npm audit fix --force` must
  not be done autonomously and requires explicit user approval (task 3.3).
- The checkpoint (task 5) provides an incremental validation break before the optional test and
  documentation updates.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2", "3.3"] },
    { "id": 6, "tasks": ["4.1"] },
    { "id": 7, "tasks": ["4.2"] },
    { "id": 8, "tasks": ["6.1", "7.1"] },
    { "id": 9, "tasks": ["7.2"] },
    { "id": 10, "tasks": ["8.1"] }
  ]
}
```
