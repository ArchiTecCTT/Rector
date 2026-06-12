import express from "express";
import http from "node:http";

import { createApp, type ApiSecurityOptions } from "../../src/api/server";
import { TaskManager } from "../../src/thalamus/router";
import { PlannerOutputSchema } from "../../src/orchestration/planner";
import type { ModelRouter } from "../../src/providers/llm";
import {
  createConfiguredProductStores,
  type ConfiguredProductStores,
} from "./configuredProductHarness";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./byokArbitraries";

/** Spy-router plan with only no-op DAG nodes for deterministic CI pipelines. */
export const CONFIGURED_SPY_PIPELINE_PLAN = PlannerOutputSchema.parse({
  goal: "Answer the user question from available conversation context",
  assumptions: ["User expects a concise synthesis, not changes."],
  tasks: [
    {
      id: "answer.synthesize",
      title: "Synthesize direct answer",
      description: "Use available conversation context to produce a concise response.",
      dependencies: [],
      expectedArtifacts: ["Assistant answer"],
      validation: ["Answer addresses the stated question"],
      risk: "low",
      approvalRequired: false,
    },
  ],
  dependencies: [],
  validation: { summary: "Direct answer plan stays non-executing", checks: ["Confirm response is grounded in context"] },
  riskLevel: "low",
  approvalGates: [],
});

export function configuredSpyRouter(prompt = "configured spy pipeline"): ModelRouter {
  const provider = new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    onOverflow: "repeat-last",
    responses: [
      {
        content: JSON.stringify({
          distilledContext: prompt,
          proposedToolCalls: [],
          entities: [],
          intent: "Explain",
          constraints: [],
        }),
      },
      { content: planToJson(CONFIGURED_SPY_PIPELINE_PLAN) },
      { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
      {
        content: synthesisDraftToJson({
          response: "Completed the configured spy pipeline run.",
          citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "ok" }],
        }),
      },
    ],
  });

  return {
    select: () => ({
      provider,
      modelRoute: "flagship",
      model: provider.metadata.models.flagship,
      reason: "configured-app-spy-router",
    }),
  };
}

export interface ConfiguredAppHarness {
  app: express.Application;
  server: http.Server;
  base: string;
  stores: ConfiguredProductStores;
  close(): Promise<void>;
}

export async function configuredAppOptions(
  overrides: Partial<ApiSecurityOptions> = {},
): Promise<ApiSecurityOptions> {
  const stores = await createConfiguredProductStores();
  const router = overrides.orchestration?.router ?? configuredSpyRouter();
  return {
    ...stores,
    ...overrides,
    orchestration: {
      mode: "external",
      router,
      preferInjectedRouter: true,
      sandboxConfigured: true,
      ...overrides.orchestration,
    },
  };
}

export async function createConfiguredApp(
  options: Partial<ApiSecurityOptions> = {},
): Promise<ConfiguredAppHarness> {
  const app = createApp(new TaskManager(), await configuredAppOptions(options));

  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;

  return {
    app,
    server,
    base: `http://127.0.0.1:${port}`,
    stores,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}