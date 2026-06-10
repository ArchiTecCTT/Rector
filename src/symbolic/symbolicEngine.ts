import { z } from "zod";

/**
 * Pluggable Deterministic / Expert Systems (Chunk 29 / Step 4)
 * Lean pure-TS forward chaining + decision tables.
 * Used for tool validation, contradictions, healing suggestions.
 */

export const RuleSchema = z.object({
  id: z.string(),
  condition: z.string(), // simple "tool == 'write_file' && !path.startsWith('src/')"
  action: z.string(),    // "block" | "warn" | "suggest:<text>"
  priority: z.number().default(0),
});
export type Rule = z.infer<typeof RuleSchema>;

export const FactSchema = z.record(z.unknown());
export type Fact = z.infer<typeof FactSchema>;

export interface EvaluationResult {
  matched: Rule[];
  actions: string[];
  blocked: boolean;
}

export interface SymbolicEngine {
  name: string;
  evaluate(rules: Rule[], facts: Fact): EvaluationResult;
}

export const symbolicRegistry = new Map<string, SymbolicEngine>();

/**
 * Very small forward-chaining engine for alpha.
 * Supports simple conditions like "tool === 'X'" and "path starts with".
 */
export class SimpleRuleEngine implements SymbolicEngine {
  name = "simple-ts-rules";

  evaluate(rules: Rule[], facts: Fact): EvaluationResult {
    const matched: Rule[] = [];
    const actions: string[] = [];
    let blocked = false;

    const tool = String(facts.tool ?? "");
    const path = String((facts.args as any)?.path ?? "");

    for (const rule of [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
      const hasToolCondition = rule.condition.includes("tool ===");
      const hasPathCondition = rule.condition.includes("path") && rule.condition.includes("startsWith");
      const requiresBoth = rule.condition.includes("&&");

      const toolMatch = hasToolCondition ? rule.condition.includes(`'${tool}'`) : false;
      let pathMatch = false;
      if (hasPathCondition && path) {
        if (rule.condition.includes("!src/")) {
          pathMatch = !path.startsWith("src/");
        } else if (rule.condition.includes("src/")) {
          pathMatch = path.startsWith("src/");
        }
      }

      const match = requiresBoth
        ? toolMatch && pathMatch
        : hasToolCondition
          ? toolMatch
          : hasPathCondition
            ? pathMatch
            : false;

      if (match) {
        matched.push(rule);
        actions.push(rule.action);
        if (rule.action === "block") blocked = true;
      }
    }

    return { matched, actions, blocked };
  }
}

// Register default
symbolicRegistry.set("default", new SimpleRuleEngine());

export function getSymbolicEngine(name = "default"): SymbolicEngine {
  return symbolicRegistry.get(name) ?? symbolicRegistry.get("default")!;
}