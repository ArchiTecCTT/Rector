# Chunk 045 — Preset Template System

> **Created:** 2026-06-12
> **Branch:** `rector-0.2.0`
> **Depends on:** Chunk 043 orchestration assignments; Chunk 044 memory assignments
> **Goal:** Add reusable configuration templates for model routing, memory roles, sandbox policy, budgets, and module toggles so users can configure Rector in one click without understanding every low-level component.

## Why This Chunk Exists

Per-role model and memory assignment is powerful, but too much raw configuration can overwhelm users. Rector needs a preset/template layer:

- local free baseline
- cheap BYOK setup
- premium engineering setup
- research-heavy setup
- privacy/local-first setup
- user's personal template

This makes the system hassle-free while preserving full customization.

## Target Product Experience

User opens Settings → Templates:

```text
Choose a Rector Setup

[Local Free]          No API keys, deterministic, SQLite local
[Cheap BYOK]          Low-cost models for most roles
[Premium Engineering] Strong planner/reviewer/synthesizer
[Research Mode]       Better research/context models
[Privacy First]       Local storage, external calls disabled unless selected
[Import Template]     Upload/share JSON template
```

User clicks preview:

- shows model assignments
- shows memory assignments
- shows estimated monthly/runs costs
- shows missing providers/secrets
- shows capability mismatches
- can apply safely

## Template Data Model

Create `src/templates/templateSchema.ts` or `src/config/templates.ts`.

```ts
interface RectorTemplate {
  schemaVersion: "rector.template.v1";
  id: string;
  name: string;
  description: string;
  author?: string;
  tags: string[];
  intendedUse: string[];
  riskLevel: "local" | "low" | "medium" | "high";
  orchestrationAssignments: TemplateOrchestrationAssignment[];
  memoryAssignments: TemplateMemoryAssignment[];
  moduleToggles?: TemplateModuleToggle[];
  sandboxPolicy?: TemplateSandboxPolicy;
  budgets?: TemplateBudgetPolicy;
  requiredProviderKinds?: string[];
  requiredCapabilities?: string[];
  createdAt?: string;
  updatedAt?: string;
}
```

Template records should not include secrets.

## Built-In Templates

### 1. Local Free

Purpose: contributor-friendly zero-cost baseline.

- all orchestration roles deterministic or disabled
- memory local SQLite/in-memory
- sandbox fake/safe local only
- no network
- ponder disabled
- cost $0

### 2. Cheap BYOK

Purpose: good daily use with low cost.

- triage/preprocessor/ponder: cheap fast model
- planner/skeptic: mid-tier model
- synthesizer: mid-tier prose model
- memory: SQLite + optional Chroma
- sandbox: fake/local safe unless E2B configured

### 3. Premium Engineering

Purpose: high-quality autonomous coding.

- planner/deepPlanner: strongest reasoning model available
- skeptic/crucible: strong critic model
- synthesizer: polished model
- ponder: cheap model with budget cap
- memory: Mem0/Chroma/TiDB if configured
- sandbox: E2B if configured

### 4. Privacy First

Purpose: minimize external data transfer.

- deterministic/local defaults
- external model roles disabled unless explicitly set
- memory local SQLite
- sandbox local fake/safe
- strong redaction warnings

### 5. Research Heavy

Purpose: better context/research workflows.

- triage: cheap
- planner: strong context model
- context/retrieval roles: memory/vector provider
- synthesizer: citation-aware model

### 6. Personal Template Placeholder

Purpose: user can create/export their own tuned setup.

- initially empty/example
- later user can save current config as template

## Template Engine

Create `TemplateService`:

```ts
class TemplateService {
  listBuiltIns(): RectorTemplate[];
  validate(template: unknown): TemplateValidationResult;
  preview(templateId, currentConfig): TemplatePreview;
  apply(templateId, options): TemplateApplyResult;
  exportCurrentConfig(options): RectorTemplate;
  importTemplate(json): RectorTemplate;
}
```

Preview must show:

- what will change
- missing provider configs
- missing secrets
- capability mismatches
- external network implications
- estimated cost tier
- rollback snapshot ID if implemented

## Applying Templates

Template apply rules:

1. Never write secrets.
2. Never delete existing provider records unless explicitly requested later.
3. Update assignment records only.
4. Preserve user overrides if `merge` mode selected.
5. Full replace mode requires confirmation.
6. Always validate after apply.

Apply modes:

- `previewOnly`
- `mergeMissing`
- `replaceAssignments`
- `saveAsDraft`

## API Surface

```http
GET  /api/templates
GET  /api/templates/:id
POST /api/templates/:id/preview
POST /api/templates/:id/apply
POST /api/templates/import/preview
POST /api/templates/import/apply
GET  /api/templates/export/current
POST /api/templates/save-current
```

All responses redact secrets and provider errors.

## UI Work

Add Settings → Templates:

- template gallery
- preview drawer
- missing requirements checklist
- apply button
- save current as template
- export/import JSON
- warnings for external services/costs
- reset to Local Free

## Validation

Template validation checks:

- schema version supported
- role IDs known
- memory roles known
- provider kinds available or marked missing
- required capabilities satisfiable
- no secret-like fields present
- budget values sane
- sandbox policy safe

Add secret scanning on imported template. Reject if it looks like it contains API keys/passwords.

## Tests

Add:

- `tests/templateSchema.test.ts`
- `tests/templateService.test.ts`
- `tests/templateApi.test.ts`
- `tests/templateImportSecretGuard.property.test.ts`
- `tests/templateApply.dom.test.ts`

Test cases:

- built-ins validate
- Local Free has zero external provider requirements
- import rejects secret-looking fields
- preview identifies missing provider/secrets
- apply updates assignments without touching secrets
- export omits secret values
- per-user isolation

## Acceptance Criteria

- Built-in templates exist and validate.
- Users can preview/apply templates from UI.
- Users can save/export/import templates.
- Templates include orchestration + memory assignments.
- No template contains or returns secrets.
- Applying Local Free restores deterministic zero-network baseline.
- `npm test`, `npm run build`, and `npm audit` pass.

## Risks

| Risk | Mitigation |
|------|------------|
| Imported template leaks secrets | secret scanner + reject secret-looking keys |
| Template overwrites user config unexpectedly | preview + merge/replace modes + confirmation |
| Built-ins drift from real roles | schema validation in tests |
| Unsupported provider in template | missing requirement checklist |
| UI too complex | gallery + recommended defaults |

## Follow-Up

- Template marketplace/share later.
- Cloud-hosted managed templates later.
- Team/admin-enforced templates after RBAC in Chunk 046.

## Suggested Commit

```text
feat(chunk-045): add preset template system plan
```
