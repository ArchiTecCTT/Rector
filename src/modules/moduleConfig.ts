import { z } from "zod";

export const ModuleConfigStateSchema = z.object({
  /** Module ids explicitly disabled by the operator (builtin/optional only). */
  disabledModuleIds: z.array(z.string().min(1)).default([]),
});
export type ModuleConfigState = z.infer<typeof ModuleConfigStateSchema>;

export function emptyModuleConfigState(): ModuleConfigState {
  return ModuleConfigStateSchema.parse({});
}