import http from "node:http";
import { createApp } from "../api/server";
import { LocalTelemetry } from "../adapters/providers";
import { createGracefulShutdownHandler, parseDeploymentEnvironment } from "../deployment";
import { TaskManager } from "../thalamus/router";

const deploymentConfig = parseDeploymentEnvironment();
const port = deploymentConfig.port;
const host = process.env.HOST?.trim() || "127.0.0.1";

const telemetry = new LocalTelemetry();
const manager = new TaskManager({
  record: (event) => telemetry.record(event as Parameters<LocalTelemetry["record"]>[0]),
  getMetrics: () => telemetry.getMetrics(),
});

const app = createApp(manager);
const server = http.createServer(app);
const gracefulShutdown = createGracefulShutdownHandler({ server });

server.listen({ port, host }, () => {
  console.log(`Rector MVP running on http://${host}:${port}`);
});

gracefulShutdown.install();

export { app, deploymentConfig, gracefulShutdown, manager, telemetry };
