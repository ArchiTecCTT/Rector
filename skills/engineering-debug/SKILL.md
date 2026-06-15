---
name: engineering-debug
description: Debug production-style failures with evidence and bounded hypotheses.
metadata:
  tags:
    - engineering
    - debugging
  risk: low
---

# Engineering Debug

Use this skill when the cause of a failure is not yet known.

1. Capture the exact symptom, command, input, and observed output.
2. List plausible causes and identify the cheapest evidence for each.
3. Test hypotheses one at a time, preserving useful logs and reproduction notes.
4. Fix the root cause, then add regression coverage that would have caught it.

Avoid broad rewrites until the failure mechanism is proven.
