import type { Response } from "express";
import { redactString } from "../../security/redaction";

export type SendRedacted = (res: Response, status: number, payload: unknown) => void;

export const errorMessageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function sendRedactedRouteError(
  sendRedacted: SendRedacted,
  res: Response,
  status: number,
  error: unknown,
): void {
  sendRedacted(res, status, { error: redactString(errorMessageOf(error)) });
}

export function statusForMissingTemplate(error: unknown): 400 | 404 {
  return errorMessageOf(error).startsWith("Template not found") ? 404 : 400;
}
