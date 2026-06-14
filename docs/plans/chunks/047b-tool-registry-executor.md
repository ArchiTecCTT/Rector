# Chunk 047b — Tool Registry & Executor Middleware

> **Created:** 2026-06-12
> **Phase:** 3 of 6 (Runtime Maturity)
> **Depends on:** Chunk 042b (executor/sandbox hardening)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Replace ad hoc DAG-node-to-operation mapping with a central **tool registry** and **middleware pipeline** so executor operations are discoverable, gated, observable, and extensible via modules. Introduce a **sandbox environment abstraction** (local / e2b / stub) selectable from runtime settings.

## Scope

### In Scope

- New package: `src/tools/registry.ts`
- New: `src/tools/middleware.ts`
- New: `src/tools/builtinTools.ts` (explicit builtin registration list)
- New: `src/tools/types.ts`
- `src/orchestration/sandboxExecutor.ts`
- `src/orchestration/executorSimulator.ts` (align event shapes with registry dispatch)
- `src/sandbox/index.ts` (environment ABC)
- `src/modules/registry.ts` (optional `registerTools` hook via manifest extension)
- `src/config/runtimeSettings.ts` (sandbox environment selection)
- `src/api/server.ts` (expose registered tool metadata read-only for settings UI)
- Tests under `tests/`

### Out of Scope

- Porting large third-party tool catalogs
- MCP dynamic tool discovery (future chunk)
- Full sandbox security redesign — Chunk 042e remains authoritative for security gates
- Run interrupt/steer — Chunk 047c

## Design Principles

1. **Single dispatch path.** All executor operations go through `ToolRegistry.dispatch()`; no parallel switch statements in sandboxExecutor.
2. **Registry is explicit in TypeScript.** Unlike dynamic import-time registration in interpreted agents, use `loadBuiltinTools()` called at server boot + module `onBoot` contributions.
3. **Middleware is ordered.** Pre-hooks run: budget → redaction → approval → crucible policy → handler → post-hooks (trace, redact output).
4. **Fail closed.** Unknown tool name returns structured error JSON; middleware halt stops DAG branch with `PERMISSION_DENIED` or `VALIDATION_FAILED`.
5. **Simulator and sandbox share handlers.** Same registry entries; environment backend varies by `SandboxEnvironment` selection.

## Data Model

### `src/tools/types.ts`

```ts
export const ToolSchemaDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()), // JSON Schema subset for UI/docs
  risk: z.enum(["low", "medium", "high", "destructive"]).default("low"),
  requiresApproval: z.boolean().default(false),
  requiresSandbox: z.boolean().default(false),
});

export type ToolHandlerContext = {
  runId: string;
  nodeId: string;
  conversationId: string;
  workspaceRoot?: string;
  fsImpl?: WorkspaceFs;
  commandRunner?: CommandRunner;
  approvals?: SandboxApproval[];
  budget?: Budget;
  abortSignal?: AbortSignal;
};

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<ToolResult>;

export type ToolCheckFn = (ctx: ToolHandlerContext) => boolean | Promise<boolean>;

export type ToolRegistryEntry = {
  definition: ToolSchemaDefinition;
  handler: ToolHandler;
  checkFn?: ToolCheckFn;
  source: "builtin" | "module";
  moduleId?: string;
};
```

### Sandbox environment ABC — extend `src/sandbox/index.ts`

```ts
export const SandboxEnvironmentKindSchema = z.enum(["stub", "local", "e2b"]);

export interface SandboxEnvironment {
  kind: z.infer<typeof SandboxEnvironmentKindSchema>;
  execute(command: SandboxCommand, ctx: SandboxExecutionContext): Promise<SandboxExecutionResult>;
  supportsArbitraryShell: boolean;
}
```

Implementations:

- `StubSandboxEnvironment` — current fake/echo behavior for spy CI
- `LocalSandboxEnvironment` — workspace-scoped `commandRunner` + path guards
- `E2BSandboxEnvironment` — existing E2B adapter behind unified interface

### Runtime settings extension

```ts
sandboxEnvironment: SandboxEnvironmentKindSchema.default("stub"),
```

Resolved at executor init from `runtime-settings.json` (UI-written), not env vars.

## Work Items

### 1. Tool registry core

Create `src/tools/registry.ts`:

- `class ToolRegistry`
  - `register(entry: ToolRegistryEntry): void` — throws on duplicate name
  - `unregister(name: string): void` — for tests only
  - `get(name: string): ToolRegistryEntry | undefined`
  - `list(): ToolSchemaDefinition[]` — for settings UI
  - `snapshot(): ReadonlyMap<string, ToolRegistryEntry>` — thread-safe read for dispatch
  - `dispatch(name, args, ctx): Promise<ToolResult>` — wraps handler, catches, redacts errors
- `checkFn` caching: optional TTL cache keyed by `(name, runId)` for expensive checks (30s default)

### 2. Middleware pipeline

Create `src/tools/middleware.ts`:

- `type ToolMiddleware = (ctx: MiddlewareContext, next: () => Promise<ToolResult>) => Promise<ToolResult>`
- Built-in middleware order:
  1. `budgetMiddleware` — deny if run budget exhausted
  2. `redactionInputMiddleware` — redact args before logging
  3. `approvalMiddleware` — block FILE_WRITE / destructive until approval satisfied
  4. `policyMiddleware` — read DAG node permissions; deny `PERMISSION_DENIED`
  5. `handler` — actual tool
  6. `redactionOutputMiddleware` — redact result
  7. `traceMiddleware` — append `TOOL_INVOKED` / `TOOL_COMPLETED` run events
- `runToolWithMiddleware(registry, name, args, ctx): Promise<ToolResult>`
- `shouldHalt(result): boolean` — if middleware sets `halt: true`, executor stops branch

### 3. Builtin tool registration

Create `src/tools/builtinTools.ts`:

Register handlers mapping existing sandbox executor operations:

| Tool name | DAG node mapping | Risk | Approval |
|-----------|------------------|------|----------|
| `sandbox.execute` | COMMAND nodes | high | if destructive |
| `workspace.read_file` | READ nodes | low | no |
| `workspace.write_file` | WRITE nodes | high | yes |
| `workspace.apply_patch` | PATCH nodes | high | yes |
| `workspace.validate` | VALIDATION nodes | low | no |
| `simulator.echo` | SIMULATOR-only tasks | low | no |

- `loadBuiltinTools(registry: ToolRegistry): void` — called from `src/bin/server.ts` at boot
- Each handler delegates to existing functions in `sandbox/index.ts` / `sandboxExecutor.ts` (minimal move, no rewrite)

### 4. Refactor `sandboxExecutor.ts`

- Replace internal operation switch with:
  ```ts
  const toolName = mapDagNodeToTool(node);
  return runToolWithMiddleware(registry, toolName, args, ctx);
  ```
- `mapDagNodeToTool(node: DagNode): string` — explicit mapping table with exhaustiveness check
- Reject ambiguous nodes with `OPERATION_MAPPING_FAILED`
- Pass `abortSignal` from 047c stub (no-op until 047c)

### 5. Align `executorSimulator.ts`

- Simulator uses same `mapDagNodeToTool` + `simulator.echo` fallback for non-sandbox nodes
- Event payloads include `toolName`, `middlewareHalt`, `approvalGateId` for trace UI parity

### 6. Module extension point

Extend `src/modules/manifest.ts`:

```ts
providesTools: z.array(z.string().min(1)).optional(),
```

- Modules register tools in `onBoot`:
  ```ts
  onBoot(ctx) {
    ctx.toolRegistry?.register({ ... entry, source: "module", moduleId: manifest.id });
  }
  ```
- Extend `ModuleBootContext` with optional `toolRegistry`
- Disabled modules: tools unavailable (`checkFn` returns false when module disabled)

### 7. Settings API surface

In `src/api/server.ts`:

- `GET /api/tools` — returns `registry.list()` redacted definitions (no secrets)
- Gated on configured product + auth as per existing settings routes

### 8. Boot wiring

In `src/bin/server.ts`:

```ts
const toolRegistry = new ToolRegistry();
loadBuiltinTools(toolRegistry);
app.locals.toolRegistry = toolRegistry;
// pass to chatRunner deps
```

## TDD Plan

### `tests/toolRegistry.test.ts`

- Register duplicate name throws
- `checkFn` false → dispatch returns `TOOL_UNAVAILABLE` without calling handler
- Unknown tool → structured error, no throw
- Async handler works; errors redacted

### `tests/toolMiddleware.test.ts`

- Approval middleware blocks write without approval
- Budget middleware blocks when `maxModelCalls` exhausted (tool budget slice)
- Halt flag stops pipeline before handler
- Output redaction applied

### `tests/sandboxExecutorRegistry.integration.test.ts`

- DAG COMMAND node dispatches via `sandbox.execute`
- Denied permission node → middleware halt, `PERMISSION_DENIED` in result
- Simulator and sandbox produce same `ToolResult` shape for equivalent nodes

### Property test — `tests/toolRegistry.property.test.ts`

- **Property 47b-1:** For any registered tool name, `list()` includes definition with same name
- **Property 47b-2:** `dispatch` never throws uncaught; always returns `ToolResult` with `ok` boolean

## Acceptance Criteria

- [ ] Zero direct operation switches remain in `sandboxExecutor.ts` (grep audit)
- [ ] `GET /api/tools` returns builtin tool catalog
- [ ] Module-disabled tool not dispatchable
- [ ] Trace events include tool name and middleware outcome
- [ ] Stub/local/e2b environment selectable via runtime settings
- [ ] `npm test`, `npm run build`, `npm audit` pass

## Concerns to Register

- Registry explicit list requires manual update when adding tools (trade-off vs magic import)
- Module-provided tools need ACL review before registration
- E2B environment misconfiguration could expose network; gate on readiness checks

## Commit

```text
feat(chunk-047b): tool registry and executor middleware
```