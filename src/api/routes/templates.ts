import type { Application, Request, Response } from "express";
import { z } from "zod";
import {
  TemplateApplyRequestSchema,
  TemplateImportSecretError,
  TemplateSaveCurrentRequestSchema,
  type TemplatePreview,
  type TemplateService,
} from "../../templates";
import { sendRedactedRouteError, statusForMissingTemplate } from "./routeError";

const TemplateImportBodySchema = z.object({ template: z.union([z.string().min(1).max(1_000_000), z.record(z.unknown())]) }).passthrough();

export interface TemplateRoutesDeps {
  templateServiceFor(req: Request): TemplateService;
  scopeIdFor(req: Request): string;
  sendRedacted(res: Response, status: number, payload: unknown): void;
  sendTemplateResponse(res: Response, status: number, payload: unknown): void;
}


export function registerTemplateRoutes(app: Application, deps: TemplateRoutesDeps): void {
  const { templateServiceFor, scopeIdFor, sendRedacted, sendTemplateResponse } = deps;

  app.get("/api/templates", async (req, res) => {
    try {
      const templates = await templateServiceFor(req).listTemplates(scopeIdFor(req));
      sendTemplateResponse(res, 200, { templates });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 500, error);
    }
  });

  app.get("/api/templates/export/current", async (req, res) => {
    try {
      const template = await templateServiceFor(req).exportCurrentConfig({ scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 500, error);
    }
  });

  app.post("/api/templates/save-current", async (req, res) => {
    try {
      const body = TemplateSaveCurrentRequestSchema.parse(req.body ?? {});
      const template = await templateServiceFor(req).saveCurrentConfig({ ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  app.post("/api/templates/import/preview", async (req, res) => {
    try {
      const parsed = TemplateImportBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return sendRedacted(res, 400, { error: "Invalid import body" });
      const service = templateServiceFor(req);
      const template = service.importTemplate(parsed.data);
      const preview: TemplatePreview = await service.preview(template, undefined, scopeIdFor(req));
      sendTemplateResponse(res, 200, { template, preview });
    } catch (error) {
      if (error instanceof TemplateImportSecretError) {
        return sendTemplateResponse(res, 400, { error: error.message, findings: error.findings });
      }
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  app.post("/api/templates/import/apply", async (req, res) => {
    try {
      const parsed = TemplateImportBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return sendRedacted(res, 400, { error: "Invalid import body" });
      const service = templateServiceFor(req);
      const template = service.importTemplate(parsed.data);
      const rawBody = req.body && typeof req.body === "object" ? { ...(req.body as Record<string, unknown>) } : {};
      delete rawBody.template;
      const body = TemplateApplyRequestSchema.parse(rawBody);
      const result = await service.apply(template, { ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, result);
    } catch (error) {
      if (error instanceof TemplateImportSecretError) {
        return sendTemplateResponse(res, 400, { error: error.message, findings: error.findings });
      }
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  app.get("/api/templates/:id", async (req, res) => {
    try {
      const template = await templateServiceFor(req).getTemplate(req.params.id, scopeIdFor(req));
      if (!template) return sendRedacted(res, 404, { error: "Template not found" });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 500, error);
    }
  });

  app.post("/api/templates/:id/preview", async (req, res) => {
    try {
      const preview = await templateServiceFor(req).preview(req.params.id, undefined, scopeIdFor(req));
      sendTemplateResponse(res, 200, { preview });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, statusForMissingTemplate(error), error);
    }
  });

  app.post("/api/templates/:id/apply", async (req, res) => {
    try {
      const body = TemplateApplyRequestSchema.parse(req.body ?? {});
      const result = await templateServiceFor(req).apply(req.params.id, { ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, result);
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, statusForMissingTemplate(error), error);
    }
  });
}
