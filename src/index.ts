import { createApp } from "./api/server";
import { TaskManager } from "./thalamus/router";
import { LocalTelemetry } from "./adapters/providers";
import { createGracefulShutdownHandler, parseDeploymentEnvironment } from "./deployment";
import http from "node:http";

const deploymentConfig = parseDeploymentEnvironment();
const PORT = deploymentConfig.port;

const telemetry = new LocalTelemetry();
const manager = new TaskManager({
  record: (event) => telemetry.record(event as Parameters<LocalTelemetry["record"]>[0]),
  getMetrics: () => telemetry.getMetrics(),
});

const app = createApp(manager);

const server = http.createServer(app);

server.listen({ port: PORT }, () => {
  console.log(`Rector MVP running on http://localhost:${PORT}`);
});

const gracefulShutdown = createGracefulShutdownHandler({ server });
gracefulShutdown.install();

export { app, deploymentConfig, gracefulShutdown, manager, telemetry };
