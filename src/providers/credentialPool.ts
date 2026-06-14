import { z } from "zod";
import type { LLMProvider } from "./llm";

const NonEmptyStringSchema = z.string().min(1);

export const CredentialPoolEntrySchema = z
  .object({
    providerId: NonEmptyStringSchema,
    secretRef: NonEmptyStringSchema,
    label: NonEmptyStringSchema.optional(),
    cooldownUntil: z.string().datetime().optional(),
    provider: z.custom<LLMProvider>().optional(),
  })
  .strict();
export type CredentialPoolEntry = z.infer<typeof CredentialPoolEntrySchema>;

export class CredentialPool {
  private readonly entries: CredentialPoolEntry[];
  private readonly cursorByProvider = new Map<string, number>();
  private readonly clock: () => Date;

  constructor(entries: CredentialPoolEntry[], clock: () => Date = () => new Date()) {
    this.entries = entries.map((entry) => CredentialPoolEntrySchema.parse(entry));
    this.clock = clock;
  }

  acquire(providerId: string): CredentialPoolEntry | undefined {
    const candidates = this.availableEntries(providerId);
    if (candidates.length === 0) return undefined;

    const cursor = this.cursorByProvider.get(providerId) ?? 0;
    const selected = candidates[cursor % candidates.length];
    this.cursorByProvider.set(providerId, (cursor + 1) % candidates.length);
    return { ...selected };
  }

  markCooldown(providerId: string, secretRef: string, until: Date): void {
    const cooldownUntil = until.toISOString();
    for (const entry of this.entries) {
      if (entry.providerId === providerId && entry.secretRef === secretRef) {
        entry.cooldownUntil = cooldownUntil;
      }
    }
  }

  reset(providerId: string): void {
    for (const entry of this.entries) {
      if (entry.providerId === providerId) {
        delete entry.cooldownUntil;
      }
    }
    this.cursorByProvider.delete(providerId);
  }

  private availableEntries(providerId: string): CredentialPoolEntry[] {
    const now = this.clock().getTime();
    return this.entries.filter((entry) => {
      if (entry.providerId !== providerId) return false;
      if (!entry.cooldownUntil) return true;
      const cooldownUntil = Date.parse(entry.cooldownUntil);
      return Number.isNaN(cooldownUntil) || cooldownUntil <= now;
    });
  }
}
