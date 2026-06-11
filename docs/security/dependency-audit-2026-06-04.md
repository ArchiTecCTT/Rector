# Dependency Audit Report

- **Date:** 2026-06-04
- **Command(s):** `npm audit`, `npm audit --json`, `npm ls esbuild --all`, `npm ls vite`, `npm ls vitest`, `npm ls tsx`
- **npm version:** 11.12.1
- **Node version:** v24.15.0
- **Summary:** 5 vulnerabilities (1 critical, 0 high, 4 moderate, 0 low)
- **Metadata capture status:** complete

> Generated as part of the `dependency-security-triage` spec (Triage_Process, Stage 1–2).
> Captured against the `rector-0.1.0` worktree with a clean install tree. The pre-change
> verification baseline was confirmed green before any remediation: `npm test` reported
> 28 test files / 278 tests passing.

## Severity Counts (npm audit metadata)

| Severity | Count |
|----------|-------|
| critical | 1 |
| high     | 0 |
| moderate | 4 |
| low      | 0 |
| **total**| **5** |

Dependency tree scope at capture: prod 70, dev 157, optional 75, total 226.

## Remediation Strategy Summary

Only the **Esbuild_Advisory (GHSA-67mh-4wv8-2f99)** is resolvable with a **Safe_Fix** within
this spec — an additive npm `overrides` entry forcing `esbuild >=0.25.0`. npm reports the same
single fix path (`npm audit fix --force` → `vitest@4.1.8`, a `isSemVerMajor` breaking change)
for the remaining four findings. Per the Remediation Decision Matrix (rows 3 and 4) and
Requirement 4, any remediation requiring `npm audit fix --force` is escalated for explicit
Maintainer approval and MUST NOT be applied autonomously. The Maintainer is unavailable, so the
four `vitest`-major findings are recorded below as **Remaining_Vulnerabilities** and deferred.

## Findings

### Finding 1: esbuild

- **Package:** `esbuild`
- **Vulnerable range:** `<=0.24.2`
- **Severity:** moderate (CVSS 5.3, CWE-346)
- **Advisory ID:** GHSA-67mh-4wv8-2f99 — "esbuild enables any website to send any requests to the development server and read the response"
- **Dependency path:** `rector` > `vitest@2.1.9` > `vite@5.4.21` > `esbuild@0.21.5`
  (Note: `rector` > `tsx@4.22.4` > `esbuild@0.28.0` is already on a non-vulnerable version and is not flagged.)
- **Classification:** transitive (via the `vitest`/`vite` development tooling)
- **Runtime exposure:** None in the `dist` runtime. `esbuild` is pulled in only through `vitest` (test runner) and `tsx` (dev/watch entrypoint). It is dev/test tooling only; the published package (`dist/`) ships no `esbuild` and runs `express` + `zod` at runtime. The advisory concerns the local esbuild dev server (DNS rebinding), which Rector does not run in production.
- **Root cause:** `vite@5.4.21` (consumed internally by `vitest@2.1.9`) resolves `esbuild@0.21.5`, which falls inside the vulnerable `<=0.24.2` range. The vulnerable version is present transitively, not requested directly by Rector.
- **Remediation category:** **Safe_Fix** — add `overrides.esbuild = ">=0.25.0"` and regenerate the lockfile.
- **Action taken / planned:** Apply the `overrides` entry (Stage 3); verify against the full baseline (Stage 4); confirm `npm ls esbuild` shows all resolved entries `>=0.25.0` and that the advisory is no longer reported by `npm audit`.

### Finding 2: vitest

- **Package:** `vitest`
- **Vulnerable range:** `<=4.1.0-beta.6`
- **Severity:** critical (CVSS 9.8, CWE-862)
- **Advisory ID:** GHSA-5xrq-8626-4rwp — "When Vitest UI server is listening, arbitrary file can be read and executed" (advisory range `<4.1.0`)
- **Dependency path:** `rector` > `vitest@2.1.9` (direct devDependency)
- **Classification:** dev (direct development dependency)
- **Runtime exposure:** None in the `dist` runtime. `vitest` is a `devDependencies` test runner and is never bundled or executed by the published package. The advisory is exploitable only when the **Vitest UI server** is actively listening (`vitest --ui`), which Rector's `npm test` (`vitest run`) does not start.
- **Root cause:** Rector pins `vitest@^2.1.0`, resolving `vitest@2.1.9`, which is within the advisory's affected range. The only npm-offered fix is `vitest@4.1.8`, flagged `isSemVerMajor: true` — a breaking major upgrade requiring `npm audit fix --force`.
- **Remediation category:** **Forced_Fix (approval required)** → deferred as a Remaining_Vulnerability. Requires `npm audit fix --force` (Decision Matrix row 3, Requirement 3.7 / 4.1).
- **Action taken / planned:** Deferred. Not applied autonomously. Routed to the Concerns_Register as an Open Remaining_Vulnerability pending Maintainer approval for the major `vitest@4` upgrade.

### Finding 3: vite

- **Package:** `vite`
- **Vulnerable range:** `<=6.4.1`
- **Severity:** moderate (CWE-22, CWE-200)
- **Advisory ID:** GHSA-4w7w-66w2-5vf9 — "Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling" (plus a transitive dependency on vulnerable `esbuild`)
- **Dependency path:** `rector` > `vitest@2.1.9` > `vite@5.4.21`
- **Classification:** transitive (via the `vitest` development tooling)
- **Runtime exposure:** None in the `dist` runtime. `vite` is consumed only inside `vitest`; it is not part of the published runtime. The path-traversal advisory affects Vite's dev server optimized-deps `.map` handling, not Rector's `express` runtime.
- **Root cause:** `vitest@2.1.9` depends on `vite@5.4.21`, within the advisory's `<=6.4.1` range. `vite` also has its own dependency on vulnerable `esbuild` (addressed by the override in Finding 1), but the path-traversal advisory (GHSA-4w7w-66w2-5vf9) is intrinsic to `vite` itself and is not cleared by the esbuild override. npm's only offered fix is `vitest@4.1.8` (`isSemVerMajor`).
- **Remediation category:** **Forced_Fix (approval required)** → deferred. The only fix is the `vitest@4.1.8` major upgrade via `npm audit fix --force` (Decision Matrix row 3/4).
- **Action taken / planned:** Deferred. Recorded as a Remaining_Vulnerability pending Maintainer approval. The esbuild override reduces this node's transitive esbuild exposure but does not resolve the vite path-traversal advisory.

### Finding 4: @vitest/mocker

- **Package:** `@vitest/mocker`
- **Vulnerable range:** `<=3.0.0-beta.4`
- **Severity:** moderate
- **Advisory ID:** none provided directly (flagged via dependency on vulnerable `vite`)
- **Dependency path:** `rector` > `vitest@2.1.9` > `@vitest/mocker@2.1.9` > `vite@5.4.21`
- **Classification:** transitive (via the `vitest` development tooling)
- **Runtime exposure:** None in the `dist` runtime. Part of the `vitest` test-runner internals only.
- **Root cause:** `@vitest/mocker@2.1.9` depends on a vulnerable `vite` version. It is flagged transitively because of the upstream `vite` advisory, not its own CVE. npm's only offered fix is `vitest@4.1.8` (`isSemVerMajor`).
- **Remediation category:** **Forced_Fix (approval required)** → deferred. Resolution is bundled with the `vitest@4.1.8` major upgrade (`--force`).
- **Action taken / planned:** Deferred. Recorded as a Remaining_Vulnerability pending Maintainer approval. Clears automatically once the `vitest@4` upgrade is approved and the underlying `vite` advisory is resolved.

### Finding 5: vite-node

- **Package:** `vite-node`
- **Vulnerable range:** `<=2.2.0-beta.2`
- **Severity:** moderate
- **Advisory ID:** none provided directly (flagged via dependency on vulnerable `vite`)
- **Dependency path:** `rector` > `vitest@2.1.9` > `vite-node@2.1.9` > `vite@5.4.21`
- **Classification:** transitive (via the `vitest` development tooling)
- **Runtime exposure:** None in the `dist` runtime. Part of the `vitest` test-runner internals only.
- **Root cause:** `vite-node@2.1.9` depends on a vulnerable `vite` version and is flagged transitively. npm's only offered fix is `vitest@4.1.8` (`isSemVerMajor`).
- **Remediation category:** **Forced_Fix (approval required)** → deferred. Resolution is bundled with the `vitest@4.1.8` major upgrade (`--force`).
- **Action taken / planned:** Deferred. Recorded as a Remaining_Vulnerability pending Maintainer approval. Clears automatically once the `vitest@4` upgrade is approved and the underlying `vite` advisory is resolved.

## Remaining_Vulnerabilities (deferred — require Maintainer approval)

The following four findings share a single remediation: upgrading to `vitest@4.1.8`, which npm
flags as `isSemVerMajor: true` and only offers via `npm audit fix --force`. Per Requirement 4
and the Decision Matrix (row 3), this is escalated for explicit Maintainer approval and is NOT
applied autonomously. The Maintainer is away, so these are deferred and tracked in the
Concerns_Register.

| Package | Severity | Advisory | Deferral rationale |
|---------|----------|----------|--------------------|
| `vitest` | critical | GHSA-5xrq-8626-4rwp | Fix requires `vitest@4.1.8` (major, `--force`). Dev-only; UI server not used by `npm test`. Awaiting approval for the `vitest@4` major upgrade. |
| `vite` | moderate | GHSA-4w7w-66w2-5vf9 | Fix requires `vitest@4.1.8` (major, `--force`). Dev tooling only, not in `dist` runtime. |
| `@vitest/mocker` | moderate | (transitive via `vite`) | Fix requires `vitest@4.1.8` (major, `--force`). Dev tooling only. |
| `vite-node` | moderate | (transitive via `vite`) | Fix requires `vitest@4.1.8` (major, `--force`). Dev tooling only. |

**Why not applied:** A `vitest@2 → vitest@4` upgrade is a major breaking change to the test
toolchain. Applying it could destabilize the 278-test baseline, and it can only be applied via
`npm audit fix --force`, which the hard constraints (Requirement 4, steering `security.md`)
forbid without explicit Maintainer approval. Deferred for maintainer follow-up.

### Status note (2026-06-10, Chunk 036 Wave 3)

The `vitest@4` major upgrade **remains deferred** pending explicit maintainer approval. No
`npm audit fix --force` was applied during Chunk 036 (Waves 1–3). The four dev-tooling findings
(`vitest`, `vite`, `@vitest/mocker`, `vite-node`) are unchanged; runtime exposure is still nil
(`npm test` runs `vitest run` without the Vitest UI server). When approved, upgrade to
`vitest >= 4.1.8`, regenerate the lockfile, and re-run the full verification baseline.

## Verification Evidence

### Stage 4 — Verification gate (after applying the esbuild override, before adding the regression test)

| Check | Command | Result |
|-------|---------|--------|
| Tests | `npm test` (`vitest run`) | **PASS** — 28 test files / 278 tests passing |
| Build | `npm run build` (`tsc && node scripts/fix-dist-esm-imports.js`) | **PASS** — exit 0 |
| Type check | `npm run check` (`tsc --noEmit`) | **PASS** — exit 0 |
| Override resolution (EH-7) | `npm ls esbuild --all` | **PASS** — `tsx > esbuild@0.28.0`, `vitest > vite > esbuild@0.28.0` (deduped); all `>=0.25.0` |

No regression: the change kept providers disabled by default, added no required API key, and
introduced no real network access in `npm test`. No revert was required (EH-4 not triggered).

### Final verification (Task 8.1 — with `tests/dependencySecurity.test.ts` included)

| Check | Command | Result |
|-------|---------|--------|
| Tests | `npm test` (`vitest run`) | **PASS** — 29 test files / 280 tests passing |
| Build | `npm run build` | **PASS** — exit 0 |
| Type check | `npm run check` | **PASS** — exit 0 |
| Advisory cleared | `npm audit` | **Esbuild_Advisory GHSA-67mh-4wv8-2f99 no longer reported.** Remaining: 4 vulnerabilities (3 moderate, 1 critical) — the deferred `vitest@4` major-upgrade findings. |
| Resolved esbuild | `npm ls esbuild --all` | **PASS** — all resolved `esbuild@0.28.0` (`>=0.25.0`) |

#### Before vs. after

- **Before:** 5 vulnerabilities (4 moderate, 1 critical) — `esbuild`, `vite`, `@vitest/mocker`, `vite-node`, `vitest`.
- **After:** 4 vulnerabilities (3 moderate, 1 critical) — `esbuild` advisory resolved via the override; the remaining four are deferred (require `npm audit fix --force` → `vitest@4.1.8`, a breaking major change).

#### Applied change

- `package.json`: added additive `"overrides": { "esbuild": ">=0.25.0" }` (runtime `dependencies`/`devDependencies` untouched).
- `package-lock.json`: regenerated via `npm install` (not hand-edited).
- `tests/dependencySecurity.test.ts`: added regression guard asserting `packageJson.overrides.esbuild === ">=0.25.0"`.
- `npm audit fix` / `npm audit fix --force` were **not** run at any point.

## Post-resolution update (Chunk 37, 2026-06-11)

The four deferred `vitest@4` major-upgrade findings were resolved by upgrading `vitest` to `^4.1.8` (resolves `4.1.8`) in `package.json` / `package-lock.json` without `npm audit fix --force`. Post-upgrade verification:

| Check | Result |
|-------|--------|
| `npm audit` | **0 vulnerabilities** |
| `npm test` | **PASS** — 213 files / 1369 tests (4 skipped live-memory) |
| `npm run build` | **PASS** |

Traceability: `docs/plans/chunks/037-vitest-auth-live-memory.md`, commit `5d04499`.

