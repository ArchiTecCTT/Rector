# Documentation Rules

## Source of Truth

Read and trust these first, in order, when they conflict with anything else:

1. `docs/architecture/rector-0.1.0-architecture.md` — authoritative architecture/product.
2. `docs/plans/rector-master-roadmap.md` — authoritative roadmap and chunk order.
3. `docs/plans/concerns-and-vulnerabilities.md` — running risk/limitation register.
4. `docs/audits/final-gemini-audit.md` — confirmed audit findings (fixed and open).
5. `docs/README.md` — docs index for current source-of-truth documents.

## Stale Docs Policy

Historical local-MVP and cloud-heavy docs were deleted after the alpha completion audit. Do not recreate them. If old design context is needed, use git history instead of restoring stale files.

Rules:

- Prefer updating current source-of-truth docs over adding parallel planning docs.
- If a new document becomes stale, either update it immediately or delete it when superseded.
- The brainstem pipeline in the architecture doc and steering is current.

## Concerns Register Policy

`docs/plans/concerns-and-vulnerabilities.md` is the running register. Update it whenever you
discover or introduce: dependency vulnerabilities, secret/PII leakage risks, sandbox risks,
provider/budget risks, stale/confusing docs, test gaps, or production-hardening limitations.
Each entry should include source, severity, status, and plan. Move items to "Closed / Mitigated"
with the fix and regression-test reference when resolved.

## Chunk Plan Docs

Per-chunk implementation plans live under `docs/plans/chunks/`. Roadmap chunks 0–25 are
implemented. Keep new plan docs consistent with the master roadmap and architecture phases.

## Issue Catalog

The contributor issue catalog is local-only and provider-free:

- `docs/issues/roadmap-issues.json` — canonical issue metadata.
- `docs/issues/generated/` — generated Markdown drafts.

Regenerate and verify with:

```bash
node scripts/generate-roadmap-issues.js
node scripts/generate-roadmap-issues.js --check
```

When roadmap chunks change, update the JSON, regenerate drafts, and run `--check`. The
generator never calls GitHub, Linear, or any network service.

## General

- Only create new Markdown docs when they add lasting value or are explicitly requested.
- Keep docs in sync with code when behavior or risk changes.
- Do not describe Rector as production-ready; it is a `v0.1.0-alpha` developer preview.
