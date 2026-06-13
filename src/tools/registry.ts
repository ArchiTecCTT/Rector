import { redactSecrets, redactString } from "../security/redaction";
import {
  ToolResultSchema,
  ToolSchemaDefinitionSchema,
  toolError,
  type ToolRegistryEntry,
  type ToolSchemaDefinition,
  type ToolHandlerContext,
  type ToolResult,
} from "./types";

export interface ToolRegistryOptions {
  checkCacheTtlMs?: number;
  nowMs?: () => number;
}

interface CheckCacheEntry {
  expiresAt: number;
  value: boolean;
}

const DEFAULT_CHECK_CACHE_TTL_MS = 30_000;

export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();
  private readonly checkCache = new Map<string, CheckCacheEntry>();
  private readonly checkCacheTtlMs: number;
  private readonly nowMs: () => number;

  constructor(options: ToolRegistryOptions = {}) {
    this.checkCacheTtlMs = options.checkCacheTtlMs ?? DEFAULT_CHECK_CACHE_TTL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  register(entry: ToolRegistryEntry): void {
    const definition = ToolSchemaDefinitionSchema.parse(entry.definition);
    if (this.entries.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.entries.set(definition.name, {
      ...entry,
      definition,
    });
  }

  unregister(name: string): void {
    this.entries.delete(name);
    for (const key of this.checkCache.keys()) {
      if (key.startsWith(`${name}\u0000`)) {
        this.checkCache.delete(key);
      }
    }
  }

  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name);
  }

  list(): ToolSchemaDefinition[] {
    return [...this.entries.values()]
      .map((entry) => ToolSchemaDefinitionSchema.parse(redactSecrets(entry.definition)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  snapshot(): ReadonlyMap<string, ToolRegistryEntry> {
    return new Map(this.entries);
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolHandlerContext,
  ): Promise<ToolResult> {
    const entry = this.entries.get(name);
    if (!entry) {
      return toolError(name, "TOOL_NOT_FOUND", `Unknown tool: ${redactString(name)}`, {
        halt: true,
        details: { toolName: redactString(name) },
      });
    }

    if (entry.source === "module" && entry.moduleId && ctx.moduleRegistry?.isEnabled(entry.moduleId) === false) {
      return toolError(name, "TOOL_UNAVAILABLE", `Tool ${redactString(name)} is unavailable because its module is disabled`, {
        halt: true,
        details: { moduleId: redactString(entry.moduleId) },
      });
    }

    const available = await this.checkAvailability(name, entry, ctx);
    if (!available) {
      return toolError(name, "TOOL_UNAVAILABLE", `Tool ${redactString(name)} is unavailable in this context`, {
        halt: true,
      });
    }

    try {
      const result = await entry.handler(args, ctx);
      return ToolResultSchema.parse(redactSecrets({ ...result, toolName: result.toolName ?? name }));
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      return toolError(name, "TOOL_HANDLER_FAILED", `Tool ${redactString(name)} failed`, {
        halt: true,
        details: { message },
      });
    }
  }

  private async checkAvailability(
    name: string,
    entry: ToolRegistryEntry,
    ctx: ToolHandlerContext,
  ): Promise<boolean> {
    if (!entry.checkFn) return true;
    const key = `${name}\u0000${ctx.runId}`;
    const now = this.nowMs();
    const cached = this.checkCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const value = Boolean(await entry.checkFn(ctx));
    this.checkCache.set(key, { value, expiresAt: now + this.checkCacheTtlMs });
    return value;
  }
}
