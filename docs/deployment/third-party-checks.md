# Third-Party Checks and GitHub App Setup

> Created: 2026-06-12

This repo includes lightweight configuration for third-party GitHub review/security tools. All checks must preserve Rector's local/provider-free default: no secrets or live cloud credentials required for normal CI.

## Enabled / Configured Files

| Tool | Repo file | Purpose |
|------|-----------|---------|
| Codecov | `codecov.yml`, `.github/workflows/ci.yml` coverage job | Coverage upload and PR coverage comments |
| CodeRabbit | `.coderabbit.yaml` | AI PR review focused on Rector architecture/security/testing rules |
| Qodo / PR-Agent | `.pr_agent.toml` | PR descriptions, reviews, improvement suggestions |
| Socket Security | `socket.yml` | Dependency/supply-chain alerts for package manifests |
| Cursor | `.cursor/rules/rector-core.mdc` | Project rules for Cursor agents |
| OpenHands | `.openhands/microagents/repo.md` | Repository context for OpenHands agents |

## CodeScene Delta Analysis / PR Refactoring Agent

CodeScene's GitHub integration can perform delta/code-health analysis on pull requests. Its PR Refactoring Agent is a review-flow tool that can be triggered from a PR to apply targeted, Code-Health-guided refactorings and commit them back to the PR branch for review.

Typical uses:

- detect code-health regressions introduced by a PR;
- suggest or apply maintainability refactors;
- keep technical debt from entering via pull requests;
- focus refactoring on changed/hotspot code rather than broad rewrites.

Notes for this repo:

- The CodeScene GitHub App can run checks without a repo config file if configured in CodeScene/GitHub.
- A local `cs` / `codescene` CLI was not available in PATH during setup, so no CLI workflow is committed yet.
- If CLI credentials are available later, add a separate CodeScene workflow that runs only on PRs and stores tokens in GitHub Secrets.
- Do not allow an automated refactoring agent to push directly to protected branches. It should only update PR branches.

## Render and Sentry

Render and Sentry are intentionally not wired in this checker setup.

- `render.yaml` should wait until the production process model, persistence, and environment variables are stable.
- Sentry SDK setup should happen alongside observability hardening, with explicit redaction and environment controls.

## Required GitHub Secrets

Codecov may require:

- `CODECOV_TOKEN`

CodeScene CLI workflow, if added later, may require CodeScene project/account tokens. Keep those in GitHub Secrets only.
