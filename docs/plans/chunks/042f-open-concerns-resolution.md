# Chunk 042f — Open Concerns Resolution and Release Readiness Audit

> Created: 2026-06-12
> Phase: 6 of 6
> Components: concerns register, docs, final verification, PR prep

## Goal

After Chunks 042a–042e, reconcile all open concerns against implementation
evidence. Close resolved items, downgrade partial items with exact remaining work,
and produce a PR-ready state for `rector-0.2.0`.

## Scope

### In Scope

- `docs/plans/concerns-and-vulnerabilities.md`
- `docs/plans/rector-master-roadmap.md`
- `docs/architecture/current-rector-byok-architecture.md`
- chunk plans 042–042f
- test/build/audit evidence
- PR description draft

### Out of Scope

- New feature implementation not already planned in 042a–042e
- Production billing/quotas/compliance beyond updated concern entries

## Work Items

### 1. Re-audit Concerns Register

For each open concern:

- Verify current implementation evidence.
- Mark one of:
  - `RESOLVED`
  - `PARTIALLY RESOLVED`
  - `DEFERRED`
  - `STILL OPEN`
- Add traceability:
  - chunk file
  - commit hash
  - code file(s)
  - test file(s)

Known concerns to revisit:

- SQL/TiDB advanced memory parity
- startup migration boot path
- deterministic placeholders in orchestration
- heuristic skeptic/crucible/planner
- sandbox mock runner
- rate limiter local-only
- truth library keyword-only
- provider adapter hardening
- telemetry no-ops
- operator API auth/local-only
- Linear UUID labels
- pruneMemory determinism

### 2. Update Architecture Docs

Update current architecture doc to reflect:

- hardened orchestration pipeline
- live vs local mode boundaries
- memory provider contracts
- security/sandbox policy
- remaining production gaps

### 3. Update Roadmap

Update master roadmap with:

- completed 042 hardening phase
- next recommended chunks
- updated release readiness estimate

### 4. Final Verification

Run fresh:

```bash
npm test
npm run build
npm audit
```

If optional live env is configured, also run:

```bash
npm run smoke:memory
npm run smoke:tidb
```

Record output summary in this chunk doc or a new audit artifact.

### 5. PR Preparation

Create PR draft content:

- Summary
- Chunk list
- Tests run
- Risk areas
- Rollback notes
- Follow-up work

Do not open PR unless user asks; prepare content only.

## Acceptance Criteria

- Concerns register accurately reflects current implementation state.
- Architecture and roadmap no longer contradict implemented behavior.
- All hardening chunks have evidence and tests.
- Final verification passes.
- PR draft exists or is included in final response.

## Stitch Audit — 2026-06-12

### Merged implementation commits

- `3c8cd47` — `work/042a-hardening`: orchestration core hardening.
- `fdca973` — `work/042b-hardening`: orchestration execution hardening.
- `03917e9` — `work/042c-hardening`: neuro-symbolic hardening.
- `74a8cc9` — `work/042d-hardening`: memory system hardening.
- `a472f31` — `work/042e-hardening`: security/sandbox hardening.
- `dd72087` — `work/043-implementation`: orchestration model assignments.
- `fb1d0af` — `work/044-implementation`: memory role assignments.
- `9e9bd76` — `work/045-implementation`: preset template system.
- `5be13ac` — `work/046-implementation`: commercial auth/RBAC controls.

### Conflict resolutions

- `src/orchestration/planner.ts`: preserved 042a fallback reason/plan metadata, 042c deep-planning trace metadata, and 043 concrete model assignment routing.
- `src/api/server.ts`: combined 043 orchestration model assignment APIs, 044 memory role assignment APIs, 045 template APIs, and 046 auth/RBAC/audit/quotas without requiring auth or external providers in local mode.
- `src/bin/server.ts`: injected local file-backed orchestration assignments, memory assignments, and durable audit log together.
- `src/security/userStores.ts`: kept per-user secret/provider/memory stores and added both orchestration and memory assignment stores.
- `src/providers/orchestrationAssignments.ts` and `src/providers/memoryAssignments.ts`: kept durable 043/044 implementations; retained 045 provider-selection aliases for template schema compatibility.
- `src/templates/templateService.ts`: redirected template apply/preview/export to durable `OrchestrationAssignmentStore` and `MemoryAssignmentStore` instead of the isolated 045 in-memory stubs.
- `src/public/app.js` and `tests/commandPalette.dom.test.ts`: kept the new Templates command in the command palette and updated the behavioral test registry.
- `src/orchestration/ponderSwarm.ts`: made duplicate lesson suppression robust to synthesized section wrappers around the same lesson content.
- `docs/plans/concerns-and-vulnerabilities.md`: added a 042f reconciliation matrix and retained open production risks.

### Reconciled concern statuses

See `docs/plans/concerns-and-vulnerabilities.md` for the detailed matrix. Summary:

- Resolved for default/test evidence: SQL/TiDB memory parity, startup migration boot wiring, prune-memory determinism coverage, template assignment store stitch.
- Partially resolved: deterministic orchestration placeholders, heuristic planner/skeptic/crucible, sandbox mock runner, local-only rate limiter, truth library keyword-only retrieval, provider adapter hardening, operator API auth, commercial auth/RBAC.
- Still open/deferred: distributed rate limiter backend, vector truth backend, live provider/memory/sandbox smoke, telemetry adapters, Linear UUID mapping, durable workspace membership/invite/backup/billing/compliance.

### Verification evidence

Fresh verification after integration fixes:

```bash
npm run build
npm test
npm audit
```

Results:

- `npm run build`: passed (`tsc` + `scripts/fix-dist-esm-imports.js`).
- `npm test`: passed — 265 files passed, 1 skipped; 1575 tests passed, 5 skipped.
- `npm audit`: passed — 0 vulnerabilities.

Optional live smoke commands (`npm run smoke:memory`, `npm run smoke:tidb`) were not run because the default local/provider-free verification environment does not configure live external credentials.

### PR draft

**Title:** `feat: stitch chunks 042a-046 hardening and commercial configurability`

**Summary:**

- Merge orchestration, execution, neuro-symbolic, memory, security/sandbox hardening chunks 042a-042e.
- Add UI/runtime assignment surfaces for orchestration models and memory roles.
- Add preset template system wired to the durable assignment stores.
- Add optional commercial auth/RBAC/quotas/audit/deployment-readiness controls while preserving zero-config local mode.
- Reconcile open concerns with implementation evidence and default verification results.

**Tests:** `npm run build`; `npm test`; `npm audit`.

**Risks / follow-ups:** no production/commercial readiness claim. Remaining work includes distributed rate limiting, live provider/memory/sandbox smokes, durable workspace membership/admin flows, telemetry adapters, Linear UUID mapping, vector truth retrieval, backup/restore, quotas/billing/compliance.

**Rollback notes:** revert the final stitch commit and/or individual merge commits for affected chunk areas; local/provider-free baseline is covered by tests and should be used as the regression check after any rollback.

## Commit

Suggested commit:

```text
docs(chunk-042f): reconcile concerns after hardening
```
