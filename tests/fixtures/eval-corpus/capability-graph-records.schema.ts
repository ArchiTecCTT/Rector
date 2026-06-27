/**
 * Eval-corpus mirror: re-export canonical schemas from src to prevent drift.
 */
export {
  CapabilityGraphRecordSchema,
  CapabilityGraphRecordsSchema,
  CapabilityRiskSchema,
  ToolProductionAdmissionSchema,
  type CapabilityGraphRecord,
  type CapabilityRisk,
  type ToolProductionAdmission,
} from "../../../src/cartographer/capabilityGraphRecords";