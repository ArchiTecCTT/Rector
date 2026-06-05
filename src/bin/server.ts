import http from "node:http";
import { createApp } from "../api/server";
import { LocalTelemetry } from "../adapters/providers";
import {
  OrchestrationConfigError,
  createGracefulShutdownHandler,
  parseDeploymentEnvironment,
  parseOrchestrationConfig,
  type OrchestrationConfig,
} from "../deployment";
import { buildModelRouter } from "../providers/llm";
import { TaskManager } from "../thalamus/router";

const deploymentConfig = parseDeploymentEnvironment();
const port = deploymentConfig.port;
const host = process.env.HOST?.trim() || "127.0.0.1";

// Resolve and validate the orchestration mode before serving (fail fast — Req 1.2). In local mode
// (the default) no provider is required. In external mode this throws OrchestrationConfigError when
// no supported provider validates; we log the redacted setup hint (never any secret value) and exit
// non-zero rather than starting in a misconfigured state.
let orchestrationConfig: OrchestrationConfig;
try {
  orchestrationConfig = parseOrchestrationConfig(process.env);
} catch (error) {
  if (error instanceof OrchestrationConfigError) {
    console.error(`Rector startup failed (${error.code}): ${error.message}`);
    console.error(error.setupHint);
    process.exit(1);
  }
  throw error;
}

// Build the model router once for the lifetime of the app. Local mode uses the provider-free
// (fake) router; external mode builds the router from configured providers. No network call is made
// at startup — the router only selects providers lazily per request.
const orchestrationRouter =
  orchestrationConfig.mode === "external"
    ? buildModelRouter({ mode: "external", env: process.env })
    : buildModelRouter({ mode: "local" });

const telemetry = new LocalTelemetry();
const manager = new TaskManager({
  record: (event) => telemetry.record(event as Parameters<LocalTelemetry["record"]>[0]),
  getMetrics: () => telemetry.getMetrics(),
});

const app = createApp(manager, {
  orchestration: { mode: orchestrationConfig.mode, router: orchestrationRouter },
});
const server = http.createServer(app);
const gracefulShutdown = createGracefulShutdownHandler({ server });

server.listen({ port, host }, () => {
  console.log(`Rector MVP running on http://${host}:${port} (orchestration mode: ${orchestrationConfig.mode})`);
});

gracefulShutdown.install();

export { app, deploymentConfig, gracefulShutdown, manager, orchestrationConfig, telemetry };
