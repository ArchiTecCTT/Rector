# Requirements Document

## Introduction

This spec hardens the Rector `v0.1.0-alpha` local developer preview by adding a GitHub Actions
continuous integration (CI) workflow. The workflow protects branches from regressions and
supports alpha release safety by enforcing the project's known-good verification gates on every
push and pull request.

Rector is an Apache-2.0, chat-first, self-healing AI orchestration system. It is provider-free
by default, requires no API keys, and performs no real network access in normal tests. The
current verification baseline is `npm test` (29 test files / 280 tests), `npm run build`, and
`npm run check`, all passing, plus a deterministic, local-only issue-catalog drift check
(`node scripts/generate-roadmap-issues.js --check`). The project requires Node.js `>=20`.

The CI workflow MUST reproduce these local gates in GitHub Actions across a Node version matrix
(Node 20 and Node 22), install dependencies deterministically with `npm ci`, run a
non-blocking `npm audit` step that surfaces (but does not fail on) the deferred dev-tooling
advisories from the dependency-security-triage spec, and require no secrets or API keys. The
workflow MUST be structured so a separate release workflow can be added later without rework.

This spec explicitly does NOT publish, push, or tag releases. Release tagging remains a manual,
maintainer-gated action and is out of scope for this spec.

## Glossary

- **CI_Workflow**: The GitHub Actions workflow defined by this spec, stored at
  `.github/workflows/ci.yml`.
- **CI_Workflow_File**: The file `.github/workflows/ci.yml` containing the CI_Workflow
  definition in valid YAML.
- **CI_Provider**: GitHub Actions, the platform that executes the CI_Workflow.
- **Verification_Baseline**: The set of commands `npm test`, `npm run build`, and `npm run check`
  passing, with `npm test` reporting at least 29 test files and 280 tests.
- **Drift_Check**: The deterministic, local-only command
  `node scripts/generate-roadmap-issues.js --check` that verifies the generated issue catalog
  is in sync with the canonical catalog metadata.
- **Node_Version_Matrix**: The set of Node.js major versions the CI_Workflow runs against,
  consisting of Node 20 and Node 22.
- **Deterministic_Install**: Dependency installation performed with `npm ci` against the
  committed lockfile.
- **Audit_Step**: The CI_Workflow step that runs `npm audit` to surface dependency advisories.
- **Non_Blocking**: A CI_Workflow step configuration where step failure does not fail the
  overall job (e.g. `continue-on-error: true`), while the step output remains visible.
- **Deferred_Advisory**: A known dependency audit finding deferred by the
  dependency-security-triage spec (the deferred `vitest@4` dev-tooling findings) that must not
  fail the CI_Workflow.
- **Provider_Free_Mode**: Rector's default operating mode with external providers disabled, no
  required API keys, and no real network access beyond the package registry.
- **NPM_Cache**: The GitHub Actions caching of npm download/build artifacts used to reduce
  CI_Workflow run time.
- **Trigger_Event**: A GitHub event (`push` or `pull_request`) that starts the CI_Workflow.
- **Protected_Branch**: A branch the CI_Workflow guards, including `main` and the
  `rector-0.1.0` release branch.
- **Release_Action**: The manual, maintainer-gated act of tagging or publishing a release,
  which is explicitly out of scope for this spec.
- **CI_Documentation**: Project documentation (README or a referenced docs file) describing the
  CI gates enforced by the CI_Workflow.
- **Maintainer**: The human user who configures the repository and performs Release_Actions.

## Requirements

### Requirement 1: Provide a Valid CI Workflow File

**User Story:** As a maintainer, I want a valid GitHub Actions workflow file committed to the
repository, so that CI runs automatically without manual setup.

#### Acceptance Criteria

1. THE CI_Workflow_File SHALL exist at the path `.github/workflows/ci.yml`.
2. THE CI_Workflow_File SHALL be valid YAML parseable by the CI_Provider.
3. THE CI_Workflow_File SHALL define at least one named job that executes the verification
   steps described in this spec.
4. THE CI_Workflow SHALL define a workflow name that identifies the workflow as continuous
   integration.

### Requirement 2: Trigger CI on Push and Pull Request

**User Story:** As a maintainer, I want CI to run on pushes and pull requests to protected
branches, so that regressions are caught before merge.

#### Acceptance Criteria

1. WHEN a `push` Trigger_Event targets the `main` branch or the `rector-0.1.0` branch, THE
   CI_Workflow SHALL start.
2. WHEN a `pull_request` Trigger_Event targets the `main` branch or the `rector-0.1.0` branch,
   THE CI_Workflow SHALL start.
3. THE CI_Workflow SHALL declare its Trigger_Events explicitly in the CI_Workflow_File.

### Requirement 3: Install Dependencies Deterministically

**User Story:** As a maintainer, I want CI to install dependencies from the lockfile, so that
builds are reproducible and match the committed dependency tree.

#### Acceptance Criteria

1. WHEN the CI_Workflow installs dependencies, THE CI_Workflow SHALL run `npm ci` as the
   Deterministic_Install.
2. THE CI_Workflow SHALL run the Deterministic_Install before running any Verification_Baseline
   command or the Drift_Check.
3. IF the Deterministic_Install fails, THEN THE CI_Workflow SHALL fail the job and SHALL stop
   before running the Verification_Baseline commands.

### Requirement 4: Run the Verification Baseline

**User Story:** As a maintainer, I want CI to run the same test, build, and type-check commands
used locally, so that the known-good baseline is enforced on every change.

#### Acceptance Criteria

1. WHEN the CI_Workflow runs after a successful Deterministic_Install, THE CI_Workflow SHALL run
   `npm test`.
2. THE CI_Workflow SHALL run `npm run build`.
3. THE CI_Workflow SHALL run `npm run check`.
4. IF any Verification_Baseline command exits with a non-zero status, THEN THE CI_Workflow SHALL
   fail the job.

### Requirement 5: Run the Issue-Catalog Drift Check

**User Story:** As a maintainer, I want CI to verify the generated issue catalog is in sync, so
that catalog drift is caught automatically.

#### Acceptance Criteria

1. WHEN the CI_Workflow runs after a successful Deterministic_Install, THE CI_Workflow SHALL run
   `node scripts/generate-roadmap-issues.js --check` as the Drift_Check.
2. IF the Drift_Check exits with a non-zero status, THEN THE CI_Workflow SHALL fail the job.
3. THE CI_Workflow SHALL run the Drift_Check without any network access beyond the package
   registry used during the Deterministic_Install.

### Requirement 6: Test Across the Node Version Matrix

**User Story:** As a maintainer, I want CI to run on every supported Node version, so that the
project stays compatible with Node 20 and Node 22.

#### Acceptance Criteria

1. THE CI_Workflow SHALL run the Verification_Baseline and the Drift_Check on Node 20.
2. THE CI_Workflow SHALL run the Verification_Baseline and the Drift_Check on Node 22.
3. THE CI_Workflow SHALL define the Node_Version_Matrix using a CI_Provider matrix strategy.
4. IF the Verification_Baseline or the Drift_Check fails on any entry of the Node_Version_Matrix,
   THEN THE CI_Workflow SHALL fail the job for that entry.

### Requirement 7: Include a Non-Blocking Audit Step

**User Story:** As a maintainer, I want a dependency audit report surfaced in CI without
breaking the build, so that deferred advisories stay visible but do not block alpha work.

#### Acceptance Criteria

1. THE CI_Workflow SHALL include an Audit_Step that runs `npm audit`.
2. THE Audit_Step SHALL be Non_Blocking so that an Audit_Step failure does not fail the
   CI_Workflow job.
3. WHERE a Deferred_Advisory is reported by `npm audit`, THE CI_Workflow SHALL still report
   success for the overall job when the Verification_Baseline and the Drift_Check pass.
4. THE Audit_Step SHALL surface the audit output in the CI_Provider run logs.

### Requirement 8: Require No Secrets and Stay Provider-Free

**User Story:** As a maintainer, I want CI to run with no secrets or API keys, so that the
provider-free guarantees of the alpha hold in automation.

#### Acceptance Criteria

1. THE CI_Workflow SHALL run without referencing any repository secret or API key.
2. THE CI_Workflow SHALL run in Provider_Free_Mode with external providers disabled.
3. THE CI_Workflow SHALL perform no real network access beyond the package registry used during
   the Deterministic_Install and the Audit_Step.
4. IF a CI_Workflow step would require a secret, an API key, or real provider network access,
   THEN THE CI_Workflow SHALL exclude that step from this spec.

### Requirement 9: Cache npm Dependencies

**User Story:** As a maintainer, I want CI to cache npm downloads, so that runs stay fast and
light.

#### Acceptance Criteria

1. THE CI_Workflow SHALL enable NPM_Cache for dependency downloads.
2. THE NPM_Cache SHALL be keyed on the committed lockfile so that the cache invalidates when
   dependencies change.
3. WHERE a valid NPM_Cache exists for the current lockfile, THE CI_Workflow SHALL reuse the
   NPM_Cache during the Deterministic_Install.

### Requirement 10: Document the CI Gates

**User Story:** As a contributor, I want documentation describing the CI gates, so that I know
which checks must pass before merge.

#### Acceptance Criteria

1. THE CI_Documentation SHALL describe the CI gates enforced by the CI_Workflow, including the
   Verification_Baseline and the Drift_Check.
2. THE CI_Documentation SHALL state that the CI_Workflow runs on Node 20 and Node 22.
3. THE CI_Documentation SHALL state that the Audit_Step is Non_Blocking.
4. THE CI_Documentation SHALL reference the location of the CI_Workflow_File.

### Requirement 11: Verify Local-Equivalent Commands Pass

**User Story:** As a maintainer, I want the local-equivalent commands to pass before CI is
relied upon, so that the workflow reflects a genuinely green baseline.

#### Acceptance Criteria

1. WHEN the CI gates are validated locally, THE Maintainer SHALL confirm that `npm ci`,
   `npm test`, `npm run build`, `npm run check`, and the Drift_Check all complete successfully.
2. THE Verification_Baseline SHALL report at least 29 test files and 280 passing tests when run
   locally.
3. IF any local-equivalent command fails, THEN the CI_Workflow SHALL be corrected before the CI
   gates are treated as authoritative.

### Requirement 12: Keep Release Tagging Out of Scope

**User Story:** As a maintainer, I want release tagging to remain a manual action, so that the
alpha is never published or tagged automatically.

#### Acceptance Criteria

1. THE CI_Workflow SHALL NOT publish a package to any registry.
2. THE CI_Workflow SHALL NOT create, push, or modify any git tag.
3. THE CI_Workflow SHALL NOT push commits to any branch.
4. WHERE a future Release_Action is anticipated, THE CI_Workflow SHALL be structured so that a
   separate release workflow can be added later without modifying the CI_Workflow job that runs
   the Verification_Baseline.
5. THE Release_Action SHALL remain a manual, Maintainer-gated step outside this spec.
