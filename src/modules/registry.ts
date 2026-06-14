import type { OrchestratorMode } from "../deployment";
import type { ModuleManifest, ModuleHookName } from "./manifest";
import { ModuleManifestSchema } from "./manifest";
import type {
  EnrichContextInput,
  EnrichContextResult,
  ExternalRunPhaseContext,
  ExternalRunStartContext,
  ExternalRunStartResult,
  ModuleBootContext,
  RunCompletedContext,
} from "./context";

export interface RectorModuleHandlers {
  onBoot?: (ctx: ModuleBootContext) => void | Promise<void>;
  onExternalRunStart?: (
    ctx: ExternalRunStartContext,
  ) => void | Promise<void | ExternalRunStartResult>;
  onExternalRunPhase?: (ctx: ExternalRunPhaseContext) => void | Promise<void>;
  onRunCompleted?: (ctx: RunCompletedContext) => void | Promise<void>;
  enrichContext?: (input: EnrichContextInput) => void | Promise<void | EnrichContextResult>;
}

export interface RectorModule {
  manifest: ModuleManifest;
  handlers?: RectorModuleHandlers;
}

interface RegisteredModule {
  module: RectorModule;
  enabled: boolean;
}

export class ModuleRegistry {
  private readonly modules = new Map<string, RegisteredModule>();

  register(module: RectorModule): void {
    const manifest = ModuleManifestSchema.parse(module.manifest);
    if (this.modules.has(manifest.id)) {
      throw new Error(`Module already registered: ${manifest.id}`);
    }
    this.modules.set(manifest.id, {
      module: { ...module, manifest },
      enabled: manifest.defaultEnabled,
    });
  }

  enable(id: string): void {
    const entry = this.require(id);
    entry.enabled = true;
  }

  disable(id: string): void {
    const entry = this.require(id);
    if (entry.module.manifest.tier === "core") {
      throw new Error(`Cannot disable core module: ${id}`);
    }
    entry.enabled = false;
  }

  isEnabled(id: string): boolean {
    return this.modules.get(id)?.enabled ?? false;
  }

  list(): ModuleManifest[] {
    return [...this.modules.values()].map((entry) => entry.module.manifest);
  }

  listEnabled(): ModuleManifest[] {
    return [...this.modules.values()]
      .filter((entry) => entry.enabled)
      .map((entry) => entry.module.manifest);
  }

  async invokeOnBoot(ctx: ModuleBootContext): Promise<void> {
    await this.invokeHook("onBoot", ctx.mode, async (handlers, module) => {
      if (!handlers.onBoot) return;
      await handlers.onBoot(ctx);
      void module;
    });
  }

  async invokeOnExternalRunStart(
    ctx: ExternalRunStartContext,
    mode: OrchestratorMode,
  ): Promise<ExternalRunStartResult> {
    const merged: ExternalRunStartResult = {};
    await this.invokeHook("onExternalRunStart", mode, async (handlers) => {
      if (!handlers.onExternalRunStart) return;
      const result = await handlers.onExternalRunStart(ctx);
      if (!result) return;
      if (result.effectiveMessageContent !== undefined) {
        merged.effectiveMessageContent = result.effectiveMessageContent;
      }
      if (result.contextPack !== undefined) {
        merged.contextPack = result.contextPack;
      }
    });
    return merged;
  }

  async invokeOnExternalRunPhase(
    ctx: ExternalRunPhaseContext,
    mode: OrchestratorMode,
  ): Promise<void> {
    await this.invokeHook("onExternalRunPhase", mode, async (handlers) => {
      if (!handlers.onExternalRunPhase) return;
      await handlers.onExternalRunPhase(ctx);
    });
  }

  async invokeOnRunCompleted(ctx: RunCompletedContext): Promise<void> {
    await this.invokeHook("onRunCompleted", ctx.mode, async (handlers) => {
      if (!handlers.onRunCompleted) return;
      await handlers.onRunCompleted(ctx);
    });
  }

  async invokeEnrichContext(
    input: EnrichContextInput,
    mode: OrchestratorMode,
  ): Promise<EnrichContextResult> {
    let contextPack = input.contextPack;
    for (const entry of this.modules.values()) {
      if (!entry.enabled) continue;
      const { manifest, handlers = {} } = entry.module;
      if (!manifest.hooks.includes("enrichContext")) continue;
      if (manifest.externalModeOnly && mode === "local") continue;
      if (!handlers.enrichContext) continue;
      const result = await handlers.enrichContext({
        ...input,
        contextPack,
      });
      if (result?.contextPack) {
        contextPack = result.contextPack;
      }
    }
    return { contextPack };
  }

  private require(id: string): RegisteredModule {
    const entry = this.modules.get(id);
    if (!entry) {
      throw new Error(`Unknown module: ${id}`);
    }
    return entry;
  }

  private async invokeHook(
    hook: ModuleHookName,
    mode: OrchestratorMode,
    fn: (handlers: RectorModuleHandlers, module: RectorModule) => Promise<void>,
  ): Promise<void> {
    for (const entry of this.modules.values()) {
      if (!entry.enabled) continue;
      const { manifest, handlers = {} } = entry.module;
      if (!manifest.hooks.includes(hook)) continue;
      if (manifest.externalModeOnly && mode === "local") continue;
      if (!handlers[hook]) continue;
      await fn(handlers, entry.module);
    }
  }
}