# Release Readiness — `v0.1.0-alpha`

## Current State

- Roadmap chunks 0–25 are implemented.
- Brainstem pipeline runs end-to-end locally on fake/local adapters with no network.
- Verification baseline: `npm test` (28 files / 278 tests), `npm run build`, `npm run check`
  all passing. `import('rector')` and `import('rector/sandbox')` work.
- Branch `rector-0.1.0` is ahead of `main`; worktree clean.

This is a **local developer preview**, not production. Do not label it production-ready.

## Remaining Pre-Release Tasks

- **Dependency audit triage** — run `npm audit`, identify root causes (incl. `esbuild
  <=0.24.2` / GHSA-67mh-4wv8-2f99), apply safe upgrades/overrides, document the rest. No
  `npm audit fix --force` without explicit approval.
- **CI workflow** — GitHub Actions running `npm test`, `npm run build`, `npm run check`, and
  the issue-generator drift check; optional non-blocking audit step.
- **Local UI polish** — clear chat demo showing status/route/trace, provider-free/local mode,
  run phase timeline, and error/`NEEDS_DECISION` states; lightweight, no heavy framework
  unless explicitly approved.
- **Screenshots / GIF** — placeholders, then real captures of the local demo.
- **Final README cleanup** — working provider-free quickstart, no required API keys; reconcile
  the older "Thalamus" architecture section with the current brainstem pipeline.
- **Release tagging** — tag `v0.1.0-alpha` once verification and the above pass.
- **Dependency upgrades** — resolve or document the esbuild advisory path safely.

## Open / Tracked Limitations (alpha-acceptable)

These are documented in `docs/plans/concerns-and-vulnerabilities.md` and are acceptable for
alpha as long as they remain documented:

- Operator API local-only / no-auth.
- In-memory store (resets on restart).
- Provider/workflow/deployment integrations are stubs/contracts.
- Real sandbox isolation not implemented.
- Synthesis is a deterministic trace summary, not provider-backed generation.

## Release Gate

Do not tag a release unless, in a fresh run:

```bash
npm test
npm run build
npm run check
```

all pass, audit findings are triaged into docs/issues, CI config exists, and the README
quickstart works with no API keys.

## Do Not

- Do not push or tag unless the user explicitly asks.
- Do not start live-provider integration or production deployment until the user approves.
- Do not call the alpha "production".
