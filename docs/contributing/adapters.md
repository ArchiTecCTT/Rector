# Adapter Contribution Guide

Adapters let Rector talk to external systems while keeping the core orchestration deterministic and provider-neutral.

This is a skeleton guide for early 0.1.x work. Expand it as adapter contracts stabilize.

## Adapter goals

- Keep provider-specific code out of domain and routing logic.
- Preserve provider-free local setup.
- Make missing credentials explicit and safe.
- Avoid leaking secrets, private prompts, repository contents, or tool outputs.
- Provide deterministic errors that the orchestration layer can classify.

## Common adapter types

- LLM/model providers
- Sandbox and execution backends
- Event bus and queue systems
- Task/state stores
- Vector memory and retrieval
- Telemetry and observability sinks

## Minimum checklist

For a new or changed adapter:

- [ ] Define the adapter boundary and inputs/outputs.
- [ ] Validate configuration with clear errors.
- [ ] Support a local/in-memory or disabled mode where practical.
- [ ] Redact secrets in logs and thrown errors.
- [ ] Add unit or contract tests for success, missing config, and provider failure.
- [ ] Document required environment variables in `.env.example` if live credentials are needed.

## Failure behavior

Adapters should fail closed. Prefer typed/domain errors over raw provider exceptions. Do not retry forever inside an adapter; retries and self-healing belong in the orchestration layer unless the adapter owns a narrow transport retry.

## Testing guidance

Default tests should not require live credentials or network access. Live-provider tests, if added later, should be opt-in and clearly documented.
