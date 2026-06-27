import type { ToolProductionAdmission } from "./capabilityGraphRecords";

/** Deterministic production admission for tools when no explicit override is supplied. */
const TEST_ONLY_BUILTIN_TOOL_NAME = ["simulator", "echo"].join(".");

export function getDefaultToolProductionAdmission(toolName: string): ToolProductionAdmission {
  if (toolName === TEST_ONLY_BUILTIN_TOOL_NAME) {
    return "test_only";
  }
  return "production";
}

export function resolveToolProductionAdmission(
  toolName: string,
  explicit?: ToolProductionAdmission,
): ToolProductionAdmission {
  if (explicit !== undefined) {
    return explicit;
  }
  return getDefaultToolProductionAdmission(toolName);
}