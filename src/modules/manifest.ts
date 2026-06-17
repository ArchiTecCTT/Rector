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
  /** Tool names this module may register during onBoot. Metadata only; registration happens through ModuleBootContext.toolRegistry. */
  providesTools: z.array(z.string().min(1)).default([]),
  /** Whether the module is on by default when registered. */
  defaultEnabled: z.boolean().default(true),
  /** External-mode only modules skip invocation in local deterministic baseline. */
  externalModeOnly: z.boolean().default(false),
  /** Ed25519 signature of the manifest payload (id + version + apiVersion). Verified via RECTOR_MODULE_PUBLIC_KEY. */
  signature: z.string().optional(),
});
export type ParsedModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type ModuleManifest = Omit<ParsedModuleManifest, "providesTools"> & {
  providesTools?: ParsedModuleManifest["providesTools"];
};

export type ModuleManifestCompatibilityResult =
  | { compatible: true; errors: []; manifest: ModuleManifest }
  | { compatible: false; errors: string[]; manifest?: undefined };

export function checkModuleManifestCompatibility(
  manifestInput: unknown,
  options: { supportedApiVersion?: string } = {},
): ModuleManifestCompatibilityResult {
  const parsed = ModuleManifestSchema.safeParse(manifestInput);
  if (!parsed.success) {
    return {
      compatible: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`,
      ),
    };
  }

  const manifest = parsed.data;
  const supportedApiVersion = options.supportedApiVersion ?? PUBLIC_MODULE_API_VERSION;
  const errors: string[] = [];

  if (manifest.apiVersion !== supportedApiVersion) {
    errors.push(
      `Unsupported module apiVersion ${manifest.apiVersion}; expected ${supportedApiVersion}`,
    );
  }

  if (errors.length > 0) {
    return { compatible: false, errors };
  }

  return { compatible: true, errors: [], manifest };
}
