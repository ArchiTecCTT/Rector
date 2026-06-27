import { z } from "zod";

export const ToolProductionAdmissionSchema = z.enum([
  "production",
  "test_only",
  "report_only",
  "quarantined",
]);
export type ToolProductionAdmission = z.infer<typeof ToolProductionAdmissionSchema>;

export const CapabilityRiskSchema = z.enum(["low", "medium", "high", "destructive"]);
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;

export const CapabilityGraphRecordSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    toolNames: z.array(z.string().min(1)),
    evalCaseIds: z.array(z.string().min(1)),
    productionAdmission: ToolProductionAdmissionSchema,
    risk: CapabilityRiskSchema,
    source: z.enum(["phase0_eval", "tool_registry", "manual_fixture"]),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type CapabilityGraphRecord = z.infer<typeof CapabilityGraphRecordSchema>;

export const CapabilityGraphRecordsSchema = z.array(CapabilityGraphRecordSchema);
