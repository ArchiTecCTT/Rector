import { z } from "zod";

export const TurnBudgetConfigSchema = z.object({
  maxIterations: z.number().int().positive().default(40),
  maxToolCalls: z.number().int().positive().default(80),
  graceCallOnExhaustion: z.boolean().default(true),
});
export type TurnBudgetConfig = z.infer<typeof TurnBudgetConfigSchema>;

export interface TurnBudgetSnapshot {
  iterationsUsed: number;
  iterationsRemaining: number;
  toolCallsUsed: number;
  toolCallsRemaining: number;
  graceCallAvailable: boolean;
  graceCallUsed: boolean;
}

export class IterationBudget {
  private readonly config: TurnBudgetConfig;
  private iterationsUsed = 0;
  private toolCallsUsed = 0;
  private graceAvailable = false;
  private graceUsed = false;

  constructor(config: Partial<TurnBudgetConfig> = {}) {
    this.config = TurnBudgetConfigSchema.parse(config);
  }

  get remaining(): number {
    return Math.max(0, this.config.maxIterations - this.iterationsUsed);
  }

  get toolCallsRemaining(): number {
    return Math.max(0, this.config.maxToolCalls - this.toolCallsUsed);
  }

  get usedIterations(): number {
    return this.iterationsUsed;
  }

  get usedToolCalls(): number {
    return this.toolCallsUsed;
  }

  get graceCallAvailable(): boolean {
    return this.graceAvailable && !this.graceUsed;
  }

  consumeToolCall(): boolean {
    if (this.toolCallsRemaining <= 0) return false;
    this.toolCallsUsed += 1;
    return true;
  }

  consumeIteration(): boolean {
    if (this.remaining > 0) {
      this.iterationsUsed += 1;
      return true;
    }
    if (this.graceCallAvailable) {
      this.graceUsed = true;
      return true;
    }
    return false;
  }

  grantGraceCall(): void {
    if (this.config.graceCallOnExhaustion && !this.graceUsed) {
      this.graceAvailable = true;
    }
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      iterationsUsed: this.iterationsUsed,
      iterationsRemaining: this.remaining,
      toolCallsUsed: this.toolCallsUsed,
      toolCallsRemaining: this.toolCallsRemaining,
      graceCallAvailable: this.graceCallAvailable,
      graceCallUsed: this.graceUsed,
    };
  }
}

