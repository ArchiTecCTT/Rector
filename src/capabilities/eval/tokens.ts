/**
 * Single deterministic token estimator used everywhere Phase 0 approximates tokens.
 * 4 chars ≈ 1 token (rough ASCII heuristic). Always returns ≥1.
 */
export function estimateApproxTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
