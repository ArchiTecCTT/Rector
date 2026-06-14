# Chunk 41 — Module Manager UI

**Status:** Complete.

## Goal

Hassle-free enable/disable for builtin modules via API and settings UI.

## Implemented

- `src/modules/moduleConfig.ts` + `moduleConfigStore.ts` — persist disabled ids to `.rector/modules.json`
- `GET /api/modules` — list modules + enabled state
- `POST /api/modules` — `{ moduleId, enabled }` toggles registry + persistence
- Settings → **Module manager** modal in `index.html` / `app.js`
- `tests/modulesApi.test.ts`

## Verification

```
npm test (modulesApi)
npm run build
```