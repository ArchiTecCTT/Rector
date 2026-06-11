import { ModuleRegistry } from "./registry";
import { registerBuiltinPlaceholders } from "./builtin/placeholders";

/**
 * Load all builtin module manifests into a fresh registry.
 * Chunk 038: placeholders only (no handlers). Chunk 039+ attach real handlers.
 */
export function createBuiltinModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registerBuiltinPlaceholders(registry);
  return registry;
}