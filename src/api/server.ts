import express from "express";
import path from "node:path";
import { TaskManager } from "../thalamus/router";
import { getSetupChecklist } from "../setupChecklist";
import { STATES } from "../domain/states";

export function createApp(manager: TaskManager): express.Application {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json());
  const publicDir = path.resolve(process.cwd(), "src/public");
  app.use(express.static(publicDir));

  // --- Task routes ---

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

  app.get("/api/telemetry", (_req, res) => {
    res.json(manager.telemetry.getMetrics());
  });

  // --- Setup checklist ---

  app.get("/api/setup", (_req, res) => {
    res.json(getSetupChecklist());
  });

  // --- Scenario seeding ---

  app.post("/api/dev/scenario", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const { type } = req.body ?? {};
      if (type === "happy") {
        const t = manager.createTask("Build a REST API for task management");
        res.status(201).json(t);
      } else if (type === "healing") {
        const t = manager.createTask("Refactor the broken retry logic to work correctly");
        res.status(201).json(t);
      } else {
        return res.status(400).json({ error: "type must be 'happy' or 'healing'" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- SPA fallback ---
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}
