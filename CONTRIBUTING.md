# Contributing to Rector

Thanks for helping Rector. Keep changes small, tested, and aligned with the current roadmap.

## Local provider-free setup

Rector must be usable for local development without paid provider keys. For a complete guide on setting up the environment without providers, see [`docs/getting-started/provider-free-quickstart.md`](docs/getting-started/provider-free-quickstart.md).

```bash
npm install
npm test
npm run build
npm run dev
```

Then open `http://localhost:3000` if the dev server is running. The default development path uses local/in-memory behavior where available. Copy `.env.example` to `.env` only when you need to test real provider integrations.

```bash
cp .env.example .env
```

Do not commit secrets. Keep examples provider-neutral or use empty placeholder values.

## Build and test

Before opening a PR:

```bash
npm test
npm run build
```

Add or update tests for behavior changes. Documentation-only PRs do not need new runtime tests but should still keep commands passing when possible.

## Chunk workflow

Rector development is organized in roadmap chunks.

1. Read `docs/README.md` first.
2. Follow `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md` as source of truth.
3. Implement only the assigned chunk scope.
4. Avoid unrelated refactors and runtime behavior changes.
5. Document verification evidence in the PR.

## Adapter contributions

Adapters connect Rector to model providers, sandboxes, storage, event buses, and observability systems. Adapter PRs should:

- keep provider-specific code behind the adapter boundary;
- preserve provider-free local development;
- fail safely when credentials are missing;
- avoid logging secrets or prompts containing sensitive data;
- include contract tests or focused unit tests.

See `docs/contributing/adapters.md` for the adapter guide skeleton.

## Sign-off / DCO

Rector uses a lightweight Developer Certificate of Origin sign-off. By signing off, you certify that you have the right to submit the contribution under this project's license.

Sign commits with:

```bash
git commit -s
```

This adds a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

## Code style

- TypeScript first.
- Prefer deterministic control flow around orchestration.
- Keep user experience chat-first; do not expose internal orchestration as the primary UX.
- Keep docs concise and current.
