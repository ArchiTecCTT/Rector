import { VALID_TRANSITIONS } from "./states";

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

export function canTransition(from: string, to: string): boolean {
  return isValidTransition(from, to);
}

export function getNextState(from: string): string | null {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || allowed.size === 0) return null;
  // Deterministic: return first in insertion order
  return allowed.values().next().value ?? null;
}

export function getPossibleNextStates(from: string): string[] {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return [];
  return Array.from(allowed);
}
