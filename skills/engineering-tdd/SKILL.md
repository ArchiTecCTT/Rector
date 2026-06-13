---
name: engineering-tdd
description: Apply a compact test-first loop for code changes.
metadata:
  tags:
    - engineering
    - testing
  risk: low
---

# Engineering TDD

Use this skill when behavior can be verified with focused tests.

1. Write or identify the smallest failing test for the requested behavior.
2. Implement the least code needed to satisfy that test.
3. Add edge-case coverage where the bug or feature can regress.
4. Run targeted tests first, then broader checks when the changed surface is shared.

Prefer hermetic doubles for provider, network, filesystem, and clock boundaries.
