# Chunk 047d — Procedural Memory & Skills Catalog

> **Created:** 2026-06-12
> **Phase:** 2 of 6 (Runtime Maturity)
> **Depends on:** Chunk 042a (crucible governance), Chunk 019 (truth library baseline)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Extend the truth library with a **skills catalog** that scans `.rector/skills/` for `SKILL.md` manifests (agentskills.io-compatible frontmatter), gates activation through **crucible policy**, and injects deferred procedural context into the context builder under strict char budgets.

## Scope

### In Scope

- New: `src/memory/skillsCatalog.ts`
- New: `src/memory/skillSchema.ts`
- `src/memory/truthLibrary.ts` (extend `TruthItemKind` with `skill`)
- `src/orchestration/crucible.ts` (skill activation policy)
- `src/orchestration/contextBuilder.ts` (deferred skill load)
- `src/orchestration/planner.ts` (optional `requestedSkills` in plan output schema extension)
- `src/api/server.ts` (`GET /api/skills`, `GET /api/skills/:id`)
- New bundled skills under `skills/` repo directory (2–3 reference skills)
- `src/templates/builtInTemplates.ts` (enable skills in templates)
- Tests under `tests/`

### Out of Scope

- Skills marketplace / hub install from network
- Automatic skill authoring by agent (read-only catalog in v0.3.0)
- Full import of large external skill libraries
- Skill write guard scanning (defer to security chunk)

## Design Principles

1. **Crucible gates activation.** Planner may propose skills; crucible approves/denies before context injection.
2. **Passive files, active governance.** Skills are filesystem docs; control plane decides what enters prompts.
3. **Deferred loading.** Only SKILL.md summary in context tier by default; `references/` loaded on explicit `loadSkillPartial` up to cap.
4. **Truth library integration.** Approved skills surface as `TruthItem` kind `skill` for citation and search.
5. **Bundled vs optional.** Bundled skills ship in repo `skills/`; user skills live in `.rector/skills/` only.

## Data Model

### `src/memory/skillSchema.ts`

```ts
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  prerequisites: z.object({
    commands: z.array(z.string()).optional(),
    env_vars: z.array(z.string()).optional(),
    platforms: z.array(z.string()).optional(),
  }).optional(),
  metadata: z.object({
    tags: z.array(z.string()).optional(),
    related_skills: z.array(z.string()).optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
  }).optional(),
});

export const SkillManifestSchema = z.object({
  id: z.string().min(1), // folder name
  frontmatter: SkillFrontmatterSchema,
  skillPath: z.string().min(1), // absolute or workspace-relative
  bundled: z.boolean(),
  files: z.array(z.object({
    relativePath: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })),
});
```

### Truth library extension

```ts
// TruthItemKindSchema adds "skill"
export const TruthItemKindSchema = z.enum(["memory", "doc", "skill"]);
```

Skill truth items:

- `title` = skill name
- `content` = SKILL.md body (truncated for index)
- `tags` = frontmatter tags + `["skill", skillId]`
- `provenance.sourceType` = `"file"`

### Planner schema extension (additive)

```ts
// PlannerOutputSchema optional field:
requestedSkills: z.array(z.string().min(1)).optional(),
```

Planner proposes skill IDs; skeptic flags unknown/high-risk; crucible resolves.

### Crucible decision extension

```ts
// CrucibleDecisionTrace adds:
skillActivation: z.array(z.object({
  skillId: z.string(),
  decision: z.enum(["approved", "denied", "deferred"]),
  reason: z.string(),
})),
```

Policy rules:

- `risk: high` skills require `approvalRequired` on related plan tasks
- Unknown skill ID → denied with blocker
- Skills with unmet prerequisites (commands not in sandbox policy) → denied or deferred

## Work Items

### 1. Skills catalog scanner

Create `src/memory/skillsCatalog.ts`:

- `class SkillsCatalog`
  - `scanBundled(root = "skills/"): SkillManifest[]`
  - `scanUser(root = ".rector/skills/"): SkillManifest[]`
  - `get(id: string): SkillManifest | undefined`
  - `list(opts?: { bundledOnly?, tags? }): SkillManifest[]`
- Parse YAML frontmatter between `---` fences in `SKILL.md`
- Ignore directories without valid `SKILL.md`
- Cache scan results with mtime-based invalidation (injectable `fsImpl` for tests)
- Max scan depth: 3 levels

### 2. Bundled reference skills

Add under repo `skills/` (not `.rector/`):

| Skill ID | Purpose | Source inspiration |
|----------|---------|-------------------|
| `engineering-plan` | Structured planning workflow before code changes | plan / spike patterns |
| `engineering-tdd` | Test-first implementation loop | TDD skill |
| `engineering-debug` | Systematic debugging phases | systematic-debugging |

Each contains:

```
skills/engineering-plan/SKILL.md
skills/engineering-plan/references/checklist.md  (optional)
```

SKILL.md ≤ 4KB body; frontmatter includes `metadata.risk: low`.

### 3. Truth library bridge

In `skillsCatalog.ts`:

- `skillToTruthItem(manifest: SkillManifest): TruthItem`
- `syncSkillsToTruthLibrary(catalog, truthLibrary): void` — upsert on boot (idempotent)

Wire in `src/bin/server.ts` after store init for configured deployments.

### 4. Context builder deferred load

In `contextBuilder.ts`:

- New input: `approvedSkillIds?: string[]`
- `buildSkillContext(manifest, opts): InlineContext | ArtifactHandle`
  - Summary mode: frontmatter description + first 500 chars of body
  - Partial mode: load `references/foo.md` up to `maxSkillPartialChars` (default 2000)
- Inject into **context tier** only (047a integration point)
- Total skills context capped: `maxSkillContextChars` (default 6000) across all approved skills

### 5. Crucible skill policy

In `crucible.ts`:

- `evaluateSkillActivations(plan, catalog, context): SkillActivationDecision[]`
- Rules:
  1. Every `requestedSkills[]` entry must exist in catalog
  2. `high` risk skills require explicit `approvalRequired` task in plan
  3. Prerequisites checked against `runtimeSettings` sandbox + provider readiness
  4. Max 5 skills per run (configurable)
- Denied skills → `NEEDS_REVISION` with targeted finding
- Approved skills passed to context builder on next context build after crucible accept

### 6. Settings API

In `src/api/server.ts`:

```
GET /api/skills
→ { skills: SkillManifestSummary[] }  // no full body, redacted paths

GET /api/skills/:id
→ { manifest, summary, prerequisitesResolved: boolean }
```

Gated: configured product + existing auth middleware.

### 7. Template integration

In `builtInTemplates.ts`:

- Premium Engineering template enables tags `engineering` skills by default
- Local Free template: skills catalog available but planner `requestedSkills` discouraged via prompt note

## TDD Plan

### `tests/skillSchema.test.ts`

- Valid frontmatter parses
- Missing name fails
- Invalid risk enum fails

### `tests/skillsCatalog.test.ts`

- Scans fixture skill directory
- Ignores invalid folders
- Bundled vs user merge; user overrides bundled same id
- mtime cache invalidation

### `tests/skillCrucible.integration.test.ts`

- Plan requests unknown skill → crucible NEEDS_REVISION
- High-risk skill without approval gate → blocked
- Approved skills appear in context pack `inlineContext` with kind `skill`
- Denied skill content absent from context

### `tests/skillsApi.test.ts`

- GET /api/skills returns seeded bundled skills
- GET /api/skills/:id 404 for unknown

### Property test

- **Property 47d-1:** Total injected skill chars ≤ `maxSkillContextChars` for any approved skill set

## Acceptance Criteria

- [ ] 3 bundled reference skills ship in `skills/`
- [ ] Catalog scans `.rector/skills/` at boot
- [ ] Crucible denies unknown/high-risk skills without approval
- [ ] Context builder injects only approved skills
- [ ] Truth library search finds skill items by tag
- [ ] API lists skills without leaking absolute filesystem paths outside workspace
- [ ] `npm test`, `npm run build`, `npm audit` pass

## Concerns to Register

- Skill body may contain untrusted instructions; crucible gating is security-critical
- Large `references/` trees need strict partial load caps
- User skills in `.rector/skills/` are user-supplied code-adjacent content

## Commit

```text
feat(chunk-047d): procedural memory skills catalog
```