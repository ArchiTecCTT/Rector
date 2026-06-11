import { z } from "zod";
import {
  ExtensionCapabilitySchema,
  PUBLIC_EXTENSION_API_VERSION,
} from "../extensions";

export const PUBLIC_MODULE_API_VERSION = "rector.modules.v1alpha1";

export const ModuleTierSchema = z.enum(["core", "builtin", "optional"]);
export type ModuleTier = z.infer<typeof ModuleTierSchema>;

export const ModuleHookNameSchema = z.enum([
  "onBoot",
  "onExternalRunStart",
  "onExternalRunPhase",
  "onRunCompleted",
  "enrichContext",
]);
export type ModuleHookName = z.infer<typeof ModuleHookNameSchema>;

export const ModuleManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.string().min(1).default(PUBLIC_MODULE_API_VERSION),
  description: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  homepage: z.string().url().optional(),
  tier: ModuleTierSchema.default("builtin"),
  /** Hooks this module may register handlers for. */
  hooks: z.array(ModuleHookNameSchema).default([]),
  /** Maps to Chunk 020 extension capability points when applicable. */
  capabilities: z.array(ExtensionCapabilitySchema).default([]),
  /** Whether the module is on by default when registered. */
  defaultEnabled: z.boolean().default(true),
  /** External-mode only modules skip invocation in local deterministic baseline. */
  externalModeOnly: z.boolean().default(false),
});
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export function checkModuleManifestCompatibility(
  manifestInput: unknown,
  options: { supportedApiVersion?: string } = {},
): { compatible: boolean; errors: string[]; manifest: ModuleManifest } {
  const manifest = ModuleManifestSchema.parse(manifestInput);
  const supportedApiVersion = options.supportedApiVersion ?? PUBLIC_MODULE_API_VERSION;
  const errors: string[] = [];

  if (manifest.apiVersion !== supportedApiVersion) {
    errors.push(
      `Unsupported module apiVersion ${manifest.apiVersion}; expected ${supportedApiVersion}`,
    );
  }

  return { compatible: errors.length === 0, errors, manifest };
}