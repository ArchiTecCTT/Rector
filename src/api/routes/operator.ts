import crypto from "node:crypto";
import type { Application, Request, Response } from "express";
import { redactSecrets } from "../../security/redaction";
import type { Permission } from "../../security/rbac";
import type { RectorStore } from "../../store";
import type { Artifact, Run, RunEvent } from "../../store/schemas";

type Authorize = (
  req: Request,
  res: Response,
  permission: Permission,
  options: { targetType?: string; targetId?: string },
) => Promise<unknown>;

export interface OperatorRoutesDeps {
  store: RectorStore;
  authorize: Authorize;
}

export function registerOperatorRoutes(app: Application, deps: OperatorRoutesDeps): void {
  const { store, authorize } = deps;

  // --- Local-only operator routes for optional Retool console ---

  app.use("/api/operator", async (req, res, next) => {
    const permission: Permission = req.method === "GET" ? "operator.read" : "operator.manage";
    const access = await authorize(req, res, permission, { targetType: "operator" });
    if (!access) return;
    next();
  });

  app.get("/api/operator/runs", async (_req, res) => {
    try {
      const runs = await store.listRuns();
      res.json(operatorEnvelope({ runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/runs/:id", async (req, res) => {
    try {
      const run = await store.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });

      const conversation = await store.getConversation(run.conversationId);
      const messages = await store.listMessages(run.conversationId);
      const events = await store.listEvents(run.id);
      const artifactHandles = collectArtifactHandles(events);

      res.json(
        operatorEnvelope({
          run,
          conversation,
          userMessage: messages.find((message) => message.id === run.userMessageId),
          assistantMessages: messages.filter((message) => message.role === "assistant" && message.runId === run.id),
          events,
          artifactHandles,
        }),
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/failures", async (_req, res) => {
    try {
      const runs = await store.listRuns();
      const events = await store.listEvents();
      const failures = runs
        .filter(isOperatorFailureRun)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          lastError: run.lastError,
          failureEvents: events.filter((event) => event.runId === run.id && isFailureEvent(event)),
        }));

      res.json(operatorEnvelope({ failures }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/approvals", async (_req, res) => {
    try {
      const runs = await store.listRuns();
      const approvals = runs
        .filter((run) => run.phase === "NEEDS_DECISION" || run.decisionRequest !== undefined)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          decisionRequest: run.decisionRequest ?? {},
        }));

      res.json(operatorEnvelope({ approvals }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/approvals/:runId/decision", async (req, res) => {
    try {
      const run = await store.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const { decision, note } = req.body ?? {};
      if (decision === undefined) {
        return res.status(400).json({ error: "decision is required" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          mutated: false,
          run: summarizeOperatorRun(run),
          decision: redactSecrets({ decision, note }),
          message: "Decision captured as a local-only placeholder; approval resume is not implemented in Chunk 21.",
        }),
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/costs", async (_req, res) => {
    try {
      const runs = await store.listRuns();
      res.json(operatorEnvelope({ summary: summarizeOperatorCosts(runs), runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/retry", async (req, res) => {
    try {
      const run = await store.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "retry",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Retry control is a local-only placeholder until real executor resume semantics exist.",
        }),
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/abort", async (req, res) => {
    try {
      const run = await store.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "abort",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Abort control is a local-only placeholder until cancellable execution exists.",
        }),
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/artifacts/:id", async (req, res) => {
    try {
      const artifact = await store.getArtifact(req.params.id);
      if (!artifact) return res.status(404).json({ error: "Artifact not found" });
      res.json(operatorEnvelope({ artifact: artifactMetadataOnly(artifact) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/linear/issues", async (req, res) => {
    try {
      const { runId, title, description } = req.body ?? {};
      if (runId !== undefined && typeof runId !== "string") {
        return res.status(400).json({ error: "runId must be a string when provided" });
      }
      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "title (string) is required" });
      }
      if (description !== undefined && typeof description !== "string") {
        return res.status(400).json({ error: "description must be a string when provided" });
      }
      if (runId) {
        const run = await store.getRun(runId);
        if (!run) return res.status(404).json({ error: "Run not found" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "stubbed",
          networkCalls: 0,
          issue: {
            key: `LOCAL-LINEAR-${stableStubIssueNumber(runId ?? title)}`,
            title: title.trim(),
            description: description?.trim() ?? "",
            runId,
            url: null,
          },
          message: "Linear issue creation is stubbed locally; no network request was made.",
        }),
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
}

type OperatorEnvelopePayload = Record<string, unknown>;

type OperatorArtifactHandle = {
  artifactId: string;
  kind?: string;
  uri?: string;
  summary?: string;
  hash?: string;
  sizeBytes?: number;
  piiState?: string;
  retentionPolicy?: string;
};

function operatorEnvelope(payload: OperatorEnvelopePayload): OperatorEnvelopePayload {
  return {
    localOnly: true,
    auth: "local-only-no-auth",
    surface: "retool-operator-console-api",
    ...payload,
  };
}

function summarizeOperatorRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
    status: run.status,
    phase: run.phase,
    route: run.route,
    complexity: run.complexity,
    traceId: run.traceId,
    attempts: run.attempts,
    healingAttempts: run.healingAttempts,
    validationAttempts: run.validationAttempts,
    lastError: run.lastError,
    dagId: run.dagId,
    estimatedUsd: numericField(run.costEstimate, "usd"),
    actualUsd: numericField(run.actualCost, "usd"),
    estimatedInputTokens: numericField(run.tokenEstimate, "input"),
    estimatedOutputTokens: numericField(run.tokenEstimate, "output"),
    actualInputTokens: numericField(run.actualTokens, "input"),
    actualOutputTokens: numericField(run.actualTokens, "output"),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function summarizeOperatorCosts(runs: Run[]): Record<string, unknown> {
  return runs.reduce(
    (summary, run) => ({
      runCount: summary.runCount + 1,
      estimatedUsd: summary.estimatedUsd + numericField(run.costEstimate, "usd"),
      actualUsd: summary.actualUsd + numericField(run.actualCost, "usd"),
      estimatedInputTokens: summary.estimatedInputTokens + numericField(run.tokenEstimate, "input"),
      estimatedOutputTokens: summary.estimatedOutputTokens + numericField(run.tokenEstimate, "output"),
      actualInputTokens: summary.actualInputTokens + numericField(run.actualTokens, "input"),
      actualOutputTokens: summary.actualOutputTokens + numericField(run.actualTokens, "output"),
      modelCalls: summary.modelCalls + numericField(run.actualCost, "modelCalls"),
    }),
    {
      runCount: 0,
      estimatedUsd: 0,
      actualUsd: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      modelCalls: 0,
    },
  );
}

function isOperatorFailureRun(run: Run): boolean {
  return run.status === "failed" || run.status === "aborted" || run.status === "needs_decision" || run.lastError !== undefined;
}

function isFailureEvent(event: RunEvent): boolean {
  return event.type === "RUN_FAILED" || event.type === "RUN_ABORTED" || event.type === "DECISION_REQUESTED";
}

function collectArtifactHandles(events: RunEvent[]): OperatorArtifactHandle[] {
  const handles = new Map<string, OperatorArtifactHandle>();
  for (const event of events) {
    collectArtifactHandlesFromValue(event.payload, handles);
  }
  return Array.from(handles.values());
}

function collectArtifactHandlesFromValue(value: unknown, handles: Map<string, OperatorArtifactHandle>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactHandlesFromValue(item, handles);
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.artifactId === "string") {
    handles.set(value.artifactId, {
      artifactId: value.artifactId,
      kind: stringField(value, "kind"),
      uri: stringField(value, "uri"),
      summary: stringField(value, "summary"),
      hash: stringField(value, "hash"),
      sizeBytes: numberField(value, "sizeBytes"),
      piiState: stringField(value, "piiState"),
      retentionPolicy: stringField(value, "retentionPolicy"),
    });
  }

  for (const nested of Object.values(value)) {
    collectArtifactHandlesFromValue(nested, handles);
  }
}

function artifactMetadataOnly(artifact: Artifact): Artifact {
  const { content: _content, ...metadata } = artifact.metadata;
  return {
    ...artifact,
    metadata,
  };
}

function stableStubIssueNumber(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return String(Number.parseInt(hash.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

function numericField(value: Record<string, unknown> | undefined, key: string): number {
  if (value === undefined) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
