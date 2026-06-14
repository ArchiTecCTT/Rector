# Concerns Register Format

File location: `docs/plans/concerns-and-vulnerabilities.md`

## Document Structure

```markdown
# Rector Concerns and Vulnerabilities Register

> Living document tracking security, architectural, and operational concerns.

## Open

### {Concern Title — descriptive, action-oriented}

- **Status:** Open | Partially resolved ({details}).
- **Traceability:** {File paths with line numbers, commit hashes, spec references}
- **Source:** {Where discovered — chunk N, audit, user report, review}
- **Severity:** {Low | Medium | High} ({qualifier}).
- **Root cause:** {Technical explanation of why the issue exists}
- **Plan / Mitigations ({status note}):**
  - {Bullet list of what was done or will be done}
- **Future work:** {What remains}
- **Traceability:** {Repeated at end with cross-references}

## Closed / Mitigated

### {Concern Title}

- **Source:** {origin}
- **Severity:** {level}
- **Fix:** {What resolved it}
- **Status:** Closed.
- **Traceability:** {doc reference}
```

## Entry Guidelines

### When to Add an Entry

- Dependency vulnerabilities (from `npm audit`)
- Secret/PII leakage risks
- Sandbox escape or isolation risks
- Provider reliability or budget overrun risks
- Stale docs or confusing architecture
- Test gaps or coverage holes
- Production-hardening limitations
- Performance concerns
- Accessibility gaps

### Severity Levels

- **High** — Security breach, data loss, or service outage risk
- **Medium** — Functional degradation, maintainability concern, or moderate security risk
- **Low** — Minor quality issue, cosmetic, or future technical debt

### Traceability Requirements

Always include concrete file paths with line numbers:
```
src/providers/configBridge.ts:145
src/memory/mem0Adapter.ts:89-102
.kiro/specs/cloud-capable-transition/requirements.md (Req 11.3)
```

### Lifecycle

1. Discovered → Create entry under `## Open`
2. Partially fixed → Update status to `Partially resolved ({what remains})`
3. Fully resolved → Add bold `**RESOLVED**` to status, add traceability block
4. Audited as closed → Move entire entry to `## Closed / Mitigated`

### RESOLVED Entry (stays in Open section until audit migration)

```markdown
### {Title}

- **Status:** **RESOLVED** — {brief fix summary}.
- **Traceability:** {commit hash, file paths}
- **Source:** Chunk {N}
- **Severity:** {level}
- **Root cause:** {retained for audit trail}
- **Fix applied:** {what was done}
```
