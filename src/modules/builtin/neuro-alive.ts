import { createProactiveAgent, type ProactiveAgent } from "../../proactive";
import {
  createNeuroBackgroundHooks,
  type NeuroBackgroundHooks,
} from "../../orchestration/backgroundHooks";
import type { ModuleBootContext, RunCompletedContext } from "../context";
import { PUBLIC_MODULE_API_VERSION, type ModuleManifest } from "../manifest";
import type { RectorModule } from "../registry";
import { DEFAULT_NEURO_FEATURE_FLAGS, type NeuroFeatureFlags } from "../featureFlags";

export const NEURO_ALIVE_MODULE_ID = "@rector/builtin/neuro-alive";

export const neuroAliveManifest: ModuleManifest = {
  id: NEURO_ALIVE_MODULE_ID,
  name: "Neuro Alive",
  version: "0.2.0",
  apiVersion: PUBLIC_MODULE_API_VERSION,
  description: "Proactive companion and ponder swarm background hooks (Chunks 28, 31).",
  tier: "builtin",
  hooks: ["onBoot", "onRunCompleted"],
  capabilities: [],
  defaultEnabled: true,
  externalModeOnly: true,
};

export interface NeuroAliveState {
  proactiveAgent?: ProactiveAgent;
  backgroundHooks?: NeuroBackgroundHooks;
}

let neuroAliveState: NeuroAliveState = {};

export function getNeuroAliveState(): NeuroAliveState {
  return neuroAliveState;
}

export function resetNeuroAliveStateForTests(): void {
  neuroAliveState = {};
}

export function createNeuroAliveModule(
  flags: NeuroFeatureFlags = DEFAULT_NEURO_FEATURE_FLAGS,
): RectorModule {
  return {
    manifest: neuroAliveManifest,
    handlers: {
      onBoot(ctx: ModuleBootContext) {
        if (ctx.mode !== "external") return;

        if (flags.proactive && ctx.store && ctx.router) {
          neuroAliveState.proactiveAgent = createProactiveAgent({
            store: ctx.store,
            router: ctx.router,
            mode: ctx.mode,
          });
          neuroAliveState.proactiveAgent.startTimer(1000 * 60 * 60 * 6);
        }

        if (flags.ponder && ctx.getMemoryProvider && ctx.router) {
          neuroAliveState.backgroundHooks = createNeuroBackgroundHooks({
            getMemoryProvider: ctx.getMemoryProvider,
            router: ctx.router,
            mode: ctx.mode,
            store: ctx.store,
          });
          neuroAliveState.backgroundHooks.startIdleTimer();
        }
      },

      onRunCompleted(ctx: RunCompletedContext) {
        if (!flags.ponder) return;
        neuroAliveState.backgroundHooks?.onRunCompleted(ctx.run);
      },
    },
  };
}