import { createPublicKey, verify as cryptoVerify } from "node:crypto";
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
  /** Whether the module's signature was verified (true) or unsigned (false). */
  signatureVerified: boolean;
}

/**
 * Verify an Ed25519 signature on a module manifest.
 *
 * The signed payload is `JSON.stringify({ id, version, apiVersion })` —
 * the minimal identifying fields that bind a signature to a specific module release.
 *
 * @param manifest  The parsed module manifest (must include `.signature`)
 * @param publicKey The Ed25519 verification key in DER or SPKI PEM format
 * @returns `true` if the signature is valid, `false` otherwise
 */
export function verifyModuleSignature(
  manifest: ModuleManifest & { signature: string },
  publicKey: Buffer | string,
): boolean {
  const payload = JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
  });
  try {
    const keyBuf =
      typeof publicKey === "string" ? Buffer.from(publicKey, "base64") : publicKey;
    // Convert DER buffer to KeyObject for Ed25519 verify
    const keyObj = createPublicKey({ key: keyBuf, format: "der", type: "spki" });
    const sigBuf = Buffer.from(manifest.signature, "base64");
    return cryptoVerify(null, Buffer.from(payload), keyObj, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Get the module public key from the environment variable.
 * Returns `undefined` if RECTOR_MODULE_PUBLIC_KEY is not set.
 */
export function getModulePublicKey(): Buffer | undefined {
  const b64 = process.env.RECTOR_MODULE_PUBLIC_KEY;
  if (!b64) return undefined;
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return undefined;
  }
}

export class ModuleRegistry {
  private readonly modules = new Map<string, RegisteredModule>();

  register(module: RectorModule): void {
    const manifest = ModuleManifestSchema.parse(module.manifest);
    if (this.modules.has(manifest.id)) {
      throw new Error(`Module already registered: ${manifest.id}`);
    }

    let signatureVerified = false;

    if (manifest.signature) {
      // Signature present — verify it
      const publicKey = getModulePublicKey();
      if (!publicKey) {
        throw new Error(
          `Module ${manifest.id} has a signature but RECTOR_MODULE_PUBLIC_KEY is not set. ` +
            `Set the env var or remove the signature from the manifest.`,
        );
      }
      const valid = verifyModuleSignature(
        manifest as ModuleManifest & { signature: string },
        publicKey,
      );
      if (!valid) {
        throw new Error(
          `Module ${manifest.id} signature verification failed. Rejecting module.`,
        );
      }
      signatureVerified = true;
    } else if (getModulePublicKey() !== undefined) {
      // Unsigned module when a verification key IS configured — restrict capabilities
      console.warn(
        `[SECURITY] Module ${manifest.id} is unsigned. Restricting: no onBoot hooks, no secret access.`,
      );
      // Enforce restrictions by removing disallowed hooks
      if (manifest.hooks.includes("onBoot")) {
        manifest.hooks = manifest.hooks.filter((h) => h !== "onBoot");
        console.warn(
          `[SECURITY] Module ${manifest.id}: onBoot hook removed (unsigned module).`,
        );
      }
    }

    this.modules.set(manifest.id, {
      module: { ...module, manifest },
      enabled: manifest.defaultEnabled,
      signatureVerified,
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

  /** Returns true if the module's signature was verified at registration. */
  isSignatureVerified(id: string): boolean {
    return this.modules.get(id)?.signatureVerified ?? false;
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
      // If a module public key is configured, unsigned modules cannot invoke onBoot (defense-in-depth)
      if (getModulePublicKey() !== undefined) {
        const entry = this.modules.get(module.manifest.id);
        if (entry && !entry.signatureVerified) return;
      }
      await handlers.onBoot(ctx);
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