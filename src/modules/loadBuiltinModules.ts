import { ModuleRegistry } from "./registry";
import { registerBuiltinPlaceholders } from "./builtin/placeholders";
import { createNeuroAliveModule } from "./builtin/neuro-alive";
import { createNeuroPreprocessModule } from "./builtin/neuro-preprocess";
import { createNeuroPlanningModule } from "./builtin/neuro-planning";
import {
  DEFAULT_NEURO_FEATURE_FLAGS,
  resolveNeuroFeatureFlags,
  type NeuroFeatureFlags,
} from "./featureFlags";

export interface BuiltinModuleOptions {
  neuroFlags?: Partial<NeuroFeatureFlags>;
}

/**
 * Load all builtin modules into a fresh registry.
 * Chunk 039: neuro-symbolic modules with real handlers; provider placeholders remain for Chunk 040.
 */
export function createBuiltinModuleRegistry(
  options: BuiltinModuleOptions = {},
): ModuleRegistry {
  const registry = new ModuleRegistry();
  const neuroFlags = resolveNeuroFeatureFlags(options.neuroFlags);

  registry.register(createNeuroPreprocessModule());
  registry.register(createNeuroPlanningModule());
  registry.register(createNeuroAliveModule(neuroFlags));

  if (!neuroFlags.preprocessor) {
    registry.disable("@rector/builtin/neuro-preprocess");
  }
  if (!neuroFlags.decomposition && !neuroFlags.deepPlanning) {
    registry.disable("@rector/builtin/neuro-planning");
  }
  if (!neuroFlags.proactive && !neuroFlags.ponder) {
    registry.disable("@rector/builtin/neuro-alive");
  }

  registerBuiltinPlaceholders(registry);
  return registry;
}

export { DEFAULT_NEURO_FEATURE_FLAGS };