# Chunk 5: Run State Machine and Event Log

## Scope
- Add focused orchestration run state machine module.
- Validate canonical run phase transitions.
- Emit run events for every phase change.
- Support NEEDS_DECISION request and explicit resume target.
- Add focused tests before implementation.

## Out of scope
- API/UI/provider integration.
- Existing task state machine changes.

## TDD plan
1. Add failing tests for allowed/invalid/terminal transitions, event order, decision request/resume, and missing run.
2. Implement minimal orchestration module and exports.
3. Run tests and build.
