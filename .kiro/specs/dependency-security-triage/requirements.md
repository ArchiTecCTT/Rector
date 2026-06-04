# Requirements Document

## Introduction

This spec hardens the dependency security posture of the Rector `v0.1.0-alpha` local
developer preview. The goal is to resolve or formally document `npm audit` findings without
applying unsafe forced upgrades, and to keep the known-good verification baseline intact.

Rector is an Apache-2.0, chat-first, self-healing AI orchestration system. It is provider-free
by default, requires no API keys, and performs no real network access in normal tests. The
current verification baseline is `npm test` (28 test files / 278 tests), `npm run build`, and
`npm run check`, all passing. This spec MAY edit `package.json` and the lockfile to apply safe
upgrades and `overrides`, but MUST NOT apply breaking or forced fixes (notably
`npm audit fix --force`) without explicit user approval, and every change MUST be verified
against the full baseline.

A specific known finding in scope is the `esbuild <=0.24.2` advisory (GHSA-67mh-4wv8-2f99), a
development/transitive dependency reaching the tree via the `vitest`/`tsx` tooling, associated
with DNS rebinding and local development server exposure. The preferred mitigation is a safe
upgrade or an npm `overrides` entry forcing `esbuild >=0.25.0`.

## Glossary

- **Triage_Process**: The end-to-end process defined by this spec that captures, analyzes,
  remediates (safely), and documents dependency audit findings.
- **Audit_Report**: The captured textual and/or JSON output of `npm audit` stored in the
  documentation tree.
- **Audit_Report_Directory**: The committed location for the Audit_Report, under `docs/issues/`
  or `docs/security/`.
- **Concerns_Register**: The tracked file `docs/plans/concerns-and-vulnerabilities.md` recording
  concerns, severities, statuses, and remediation plans.
- **Dependency_Audit_Item**: The existing entry titled "Dependency audit reports
  vulnerabilities" in the Concerns_Register.
- **Safe_Fix**: A dependency change (version bump and/or npm `overrides` entry) that resolves an
  audit finding while keeping `npm test`, `npm run build`, and `npm run check` passing.
- **Forced_Fix**: Any remediation that npm classifies as breaking, including `npm audit fix
  --force`, or any major-version dependency change that breaks the baseline.
- **Verification_Baseline**: The set of commands `npm test`, `npm run build`, and `npm run check`
  passing with `npm test` reporting at least 28 test files and 278 tests.
- **Esbuild_Advisory**: The advisory GHSA-67mh-4wv8-2f99 affecting `esbuild <=0.24.2`, reaching
  Rector transitively via `vitest`/`tsx` development tooling.
- **Override_Entry**: An entry in the `overrides` section of `package.json` that pins a
  transitive dependency to a fixed version range (e.g. `esbuild >=0.25.0`).
- **Provider_Free_Mode**: Rector's default operating mode with external providers disabled, no
  required API keys, and no real network access in normal tests.
- **Maintainer**: The human user who runs the Triage_Process and grants or withholds approval.
- **Remaining_Vulnerability**: An audit finding that is not resolved by a Safe_Fix within this
  spec and is deferred with documented rationale.

## Requirements

### Requirement 1: Capture and Commit the Audit Report

**User Story:** As a maintainer, I want the current `npm audit` results captured and committed
into the documentation tree, so that the dependency risk state is recorded and reviewable.

#### Acceptance Criteria

1. WHEN the Triage_Process runs the dependency audit, THE Triage_Process SHALL execute
   `npm audit` and capture the audit output as an Audit_Report.
2. THE Triage_Process SHALL write the Audit_Report to a file within the Audit_Report_Directory
   (`docs/issues/` or `docs/security/`).
3. THE Audit_Report SHALL include, for each reported finding, the affected package name, the
   vulnerable version range, the severity, and the advisory identifier where npm provides one.
4. WHEN the Audit_Report is written, THE Triage_Process SHALL record the date and the command
   used to produce the Audit_Report.
5. THE Triage_Process SHALL commit the Audit_Report into the documentation tree as a tracked
   file.
6. IF the Audit_Report is written successfully but recording its metadata fails, THEN THE
   Triage_Process SHALL retain the Audit_Report file and SHALL record that metadata capture
   failed.

### Requirement 2: Identify Vulnerable Packages and Root Causes

**User Story:** As a maintainer, I want each vulnerable package and its root cause identified,
so that I can choose a safe remediation rather than a blind fix.

#### Acceptance Criteria

1. WHEN the Audit_Report is available, THE Triage_Process SHALL enumerate each vulnerable
   package together with the severity and the dependency path that introduces the package.
2. THE Triage_Process SHALL classify each vulnerable package as a direct dependency, a
   development dependency, or a transitive dependency.
3. THE Triage_Process SHALL document the dependency path for the Esbuild_Advisory, identifying
   the `vitest` and/or `tsx` development tooling that introduces `esbuild` transitively.
4. THE Triage_Process SHALL record, for each finding, the root cause and the proposed
   remediation category (Safe_Fix, deferral, or escalation for approval).
5. WHERE a finding affects only development tooling and not the runtime distribution, THE
   Triage_Process SHALL note the reduced runtime exposure in the finding analysis.

### Requirement 3: Apply Safe Fixes Only

**User Story:** As a maintainer, I want only safe dependency fixes applied automatically, so
that vulnerabilities are reduced without breaking the build or tests.

#### Acceptance Criteria

1. WHERE a Safe_Fix resolves a finding without breaking the Verification_Baseline, THE
   Triage_Process SHALL apply the Safe_Fix to `package.json` and the lockfile.
2. THE Triage_Process SHALL prefer a dependency version upgrade or an Override_Entry over any
   change that npm classifies as breaking.
3. WHEN remediating the Esbuild_Advisory, THE Triage_Process SHALL apply a Safe_Fix that
   resolves `esbuild` to a version `>=0.25.0`, using an Override_Entry when a direct upgrade is
   not available.
4. IF a candidate remediation breaks the Verification_Baseline or requires running
   `npm audit fix --force`, THEN THE Triage_Process SHALL NOT apply the candidate remediation
   automatically and SHALL record the finding as a Remaining_Vulnerability requiring approval.
5. WHEN the Triage_Process applies any Safe_Fix, THE Triage_Process SHALL describe the change
   and the affected dependency in the spec records.
6. WHERE a candidate remediation is classified as a Forced_Fix and the candidate remediation
   does not break the Verification_Baseline and the candidate remediation does not require
   running `npm audit fix --force`, THE Triage_Process MAY apply the candidate remediation
   after recording the change.
7. IF a candidate remediation requires running `npm audit fix --force`, THEN THE Triage_Process
   SHALL route the candidate remediation through the explicit-approval flow in Requirement 4
   regardless of whether the candidate remediation breaks the Verification_Baseline.

### Requirement 4: Prohibit Forced Fixes Without Approval

**User Story:** As a maintainer, I want forced upgrades blocked unless I explicitly approve
them, so that the alpha baseline is never silently broken.

#### Acceptance Criteria

1. IF a remediation requires `npm audit fix --force`, THEN THE Triage_Process SHALL request
   explicit approval from the Maintainer before running the command.
2. WHILE explicit Maintainer approval for a Forced_Fix is absent, THE Triage_Process SHALL
   refrain from executing `npm audit fix --force`.
3. IF the Maintainer declines a Forced_Fix, THEN THE Triage_Process SHALL record the affected
   finding as a Remaining_Vulnerability with a deferral rationale.
4. WHERE the Maintainer explicitly approves a specific Forced_Fix, THE Triage_Process SHALL
   apply that approved change and SHALL verify the result against the Verification_Baseline.

### Requirement 5: Preserve the Verification Baseline

**User Story:** As a maintainer, I want every dependency change verified against the full
baseline, so that the 278-test known-good state never regresses.

#### Acceptance Criteria

1. WHEN the Triage_Process applies any change to `package.json` or the lockfile, THE
   Triage_Process SHALL run `npm test`, `npm run build`, and `npm run check`.
2. THE Triage_Process SHALL confirm that `npm test` reports at least 28 test files and 278
   passing tests after applying changes.
3. THE Triage_Process SHALL confirm that `npm run build` completes successfully after applying
   changes.
4. THE Triage_Process SHALL confirm that `npm run check` completes successfully after applying
   changes.
5. IF any command in the Verification_Baseline fails after a change, THEN THE Triage_Process
   SHALL revert that change and record the failure cause.

### Requirement 6: Preserve Provider-Free and No-Network Policy

**User Story:** As a maintainer, I want the provider-free defaults and no-network test policy
preserved, so that the security and usability guarantees of the alpha remain intact.

#### Acceptance Criteria

1. THE Triage_Process SHALL keep external providers disabled by default after applying changes.
2. THE Triage_Process SHALL introduce no required API keys as part of any remediation.
3. THE Triage_Process SHALL keep the default `npm test` run free of real network access.
4. IF a remediation would require real network access during normal tests or would introduce a
   required API key, THEN THE Triage_Process SHALL NOT apply the remediation and SHALL record
   the finding as a Remaining_Vulnerability.

### Requirement 7: Update the Concerns Register

**User Story:** As a maintainer, I want the concerns register updated with the triage outcome,
so that resolved and remaining risks are clearly tracked.

#### Acceptance Criteria

1. WHERE the Triage_Process resolves the Esbuild_Advisory or other findings with a Safe_Fix,
   THE Triage_Process SHALL move the Dependency_Audit_Item to a mitigated state in the
   Concerns_Register with the applied fix described.
2. THE Concerns_Register SHALL document each Remaining_Vulnerability with its severity, root
   cause, and the rationale for deferral.
3. WHEN the Triage_Process updates the Concerns_Register, THE Concerns_Register SHALL reference
   the Audit_Report location for traceability.
4. WHILE any Remaining_Vulnerability is unresolved, THE Concerns_Register SHALL retain a
   tracked entry describing the open finding and its planned follow-up.
5. IF the Concerns_Register cannot be updated or cannot retain records during the
   Triage_Process, THEN THE Triage_Process SHALL halt and SHALL surface the failure to the
   Maintainer.
