# Chunk 30 — Opt-in MCTS + Multi-Path Exploration (Neuro-Symbolic Step 5)

## Goal
Add optional deep planning with MCTS-style branching in the planner phase (only when deepPlanning flag is set). SLM proposes paths, limited debate with skeptic, symbolic pruning, budget, cache.

## Scope
- Extend planner input with deepPlanning.
- In runLivePlanner or new deep path: generate 3-5 paths, critique, prune, pick best.
- Use existing skeptic and budget.
- Cache in memory (from Step 2).
- Tests, concerns, commit as 30.

Implementation will be behind flag so local tests unaffected.