# Security Policy

## Supported versions

Rector is pre-1.0. Security fixes target the active `0.1.x` development line unless a maintainer states otherwise.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Report security concerns privately to the maintainers. If no private security advisory channel is available for the repository, contact the project owner directly and include `SECURITY` in the subject. Provide enough detail to reproduce or assess the issue.

Useful report details:

- affected commit, version, or deployment mode;
- reproduction steps or proof of concept;
- expected and actual impact;
- logs, screenshots, or traces with secrets removed;
- whether the issue is already public.

Maintainers should acknowledge reports, investigate, and coordinate disclosure once a fix or mitigation is available.

## Security areas of interest

Rector is agentic software. Please report issues such as:

- sandbox escape, command injection, or unintended filesystem/network access;
- prompt injection that bypasses deterministic guardrails or approval boundaries;
- model/tool routing that exposes secrets or private repository data;
- self-healing loops that repeatedly apply unsafe changes;
- missing isolation between users, tasks, workspaces, or provider credentials;
- dependency, build, or release-chain compromise;
- logs, telemetry, traces, or error messages that leak secrets or sensitive prompts.

## Safe research expectations

- Use test repositories and dummy credentials.
- Do not access, modify, or exfiltrate data you do not own.
- Stop testing and report if you discover live secrets or cross-tenant access.
- Give maintainers reasonable time to fix before public disclosure.
