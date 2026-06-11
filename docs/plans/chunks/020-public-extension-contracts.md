# Chunk 20 — Public Extension Contracts

## Goal

Define Rector's first public, provider-free extension contracts so contributors can build adapters against stable-ish typed seams without wiring real integrations.

## Scope

- Add a public extension contracts module with a single API version string.
- Define manifest schemas and typed interfaces for LLM, memory, sandbox, telemetry, search, issue tracker, validator, and UI client extension points.
- Add compatibility validation that rejects unsupported API versions and missing required capabilities.
- Document the extension contract surface and no-network expectation for sample/local extensions.
- Export the contracts from the package entry points.
- Add tests for manifest validation, compatibility failures, and sample contract compile/validation.
- Update docs index/README if suitable and concerns register.

## Non-goals

- No real external integrations.
- No network calls.
- No plugin loading/runtime isolation system.
- No durable extension registry.
- No provider-specific SDK dependencies.

## TDD Plan

1. Add tests for extension manifest schema validation.
2. Add tests for compatibility validator rejecting wrong `apiVersion` and missing capabilities.
3. Add tests with sample extension implementations for all extension point contracts that compile and validate.
4. Implement the smallest `src/extensions` contract module needed to pass tests.
5. Export the module from public package barrels.
6. Add docs and concerns updates.
7. Run `npm test` and `npm run build`.
