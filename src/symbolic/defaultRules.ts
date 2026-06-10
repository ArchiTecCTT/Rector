import type { Rule } from "./symbolicEngine";

/**
 * Default symbolic rules for preprocessor tool validation and healing hints.
 * Conditions match the {@link SimpleRuleEngine} format:
 *   - "tool === '<name>'"
 *   - "path startsWith !src/" (matches when path does NOT start with src/)
 */
export const DEFAULT_PREPROCESSOR_RULES: Rule[] = [
  {
    id: "write-file-src-only",
    condition: "tool === 'write_file' && path startsWith !src/",
    action: "block",
    priority: 10,
  },
  {
    id: "write-file-prefer-src-hint",
    condition: "tool === 'write_file' && path startsWith !src/",
    action: "suggest:Prefer writing application code under src/",
    priority: 5,
  },
  {
    id: "write-file-update-tests",
    condition: "tool === 'write_file'",
    action: "suggest:Consider updating related tests when modifying source files",
    priority: 1,
  },
];