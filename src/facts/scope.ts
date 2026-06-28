import { FactScopeSchema, SafeFactPathSchema } from "./schemas";
import type { FactScope, GraphRef } from "./types";

export function parseFactPath(path: string): string {
  return SafeFactPathSchema.parse(path);
}

export function isSafeFactPath(path: string): boolean {
  return SafeFactPathSchema.safeParse(path).success;
}

export function createFactScope(input: {
  readonly scopeType?: FactScope["scopeType"];
  readonly workspacePaths?: readonly string[];
  readonly graphRefs?: readonly GraphRef[];
  readonly taskIds?: readonly string[];
} = {}): FactScope {
  return FactScopeSchema.parse({
    scopeType: input.scopeType ?? "run",
    workspacePaths: [...(input.workspacePaths ?? [])],
    graphRefs: [...(input.graphRefs ?? [])],
    taskIds: [...(input.taskIds ?? [])],
  });
}

export function assertSafeFactPath(path: string): void {
  SafeFactPathSchema.parse(path);
}

export function normalizeFactPath(path: string): string {
  const parsed = parseFactPath(path);
  return parsed === "." ? parsed : parsed.replace(/\\/g, "/");
}
