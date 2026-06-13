import type { Application, Request, Response } from "express";
import { STATES } from "../../domain/states";
import type { Permission } from "../../security/rbac";
import type { TaskManager } from "../../thalamus/router";

type Authorize = (
  req: Request,
  res: Response,
  permission: Permission,
  options: { targetType?: string; targetId?: string },
) => Promise<unknown>;

export interface TaskRoutesDeps {
  manager: TaskManager;
  authorize: Authorize;
}

export function registerTaskRoutes(app: Application, deps: TaskRoutesDeps): void {
  const { manager, authorize } = deps;

  // --- Task routes ---

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.use("/api/tasks", async (req, res, next) => {
    let permission: Permission = "runs.read";
    if (req.method === "POST" && req.path === "/") permission = "runs.create";
    else if (req.method === "POST" && req.path.endsWith("/approve")) permission = "runs.approve";
    else if (req.method === "POST" && req.path.endsWith("/abort")) permission = "runs.abort";
    else if (req.method === "POST") permission = "operator.manage";
    const access = await authorize(req, res, permission, { targetType: "task" });
    if (!access) return;
    next();
  });

  app.post("/api/tasks", (req, res) => {
    try {
      const { description } = req.body ?? {};
      if (!description || typeof description !== "string") {
        return res.status(400).json({ error: "description (string) is required" });
      }
      const task = manager.createTask(description);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tasks", async (_req, res) => {
    try {
      const tasks = await manager.listTasks();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/tasks/:id", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Control routes ---

  app.post("/api/tasks/:id/retry", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.PAUSED) {
        return res.status(400).json({ error: `Cannot retry from ${task.state}` });
      }
      const updated = await manager.transition(req.params.id, STATES.INTAKE);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/pause", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.PAUSED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/approve", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.HUMAN_HANDOFF) {
        return res.status(400).json({ error: `Cannot approve from ${task.state}` });
      }
      const approved = await manager.approve(req.params.id);
      res.json(approved);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/abort", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.ABORTED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Advance pipeline one step ---

  app.post("/api/tasks/:id/advance", async (req, res) => {
    try {
      const task = await manager.advance(req.params.id);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Telemetry ---

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/telemetry", async (req, res) => {
    const access = await authorize(req, res, "operator.read", { targetType: "telemetry" });
    if (!access) return;
    res.json(manager.telemetry.getMetrics());
  });
}
