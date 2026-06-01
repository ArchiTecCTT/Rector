import { createApp } from "./api/server";
import { TaskManager } from "./thalamus/router";
import { LocalTelemetry } from "./adapters/providers";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3000);

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

export { app, manager, telemetry };
