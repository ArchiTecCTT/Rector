# Rector Release/Docs/Deployment/Provider Integration Audit Report

This audit reports confirmed valid release-blocking inconsistencies, broken export paths, environment configuration mismatches, and deployment/usability issues in Rector v0.1.0-alpha. 

---

## Findings Summary

1. **Missing Root Export `"."` in `package.json`** (Package Usability Blocker)
2. **Side-Effectful Root Entry Point (`src/index.ts`) Automatically Starts HTTP Server** (Package Usability Blocker)
3. **`process.cwd()` Used to Resolve Static Public Directory in Express Server** (Deployment Blocker)
4. **Missing Environment Variable Loader for Local/Paid Provider Development** (Usability Issue)
5. **Discrepancy in `AGENTS.md` Build/Test Commands (`npm run check`)** (Tooling Inconsistency)
6. **Minor: `MAKE_WEBHOOK_SECRET` Missing from `SETUP_ITEMS`** (Programmatic Checklist Mismatch)

---

## Detailed Findings

### 1. Missing Root Export `"."` in `package.json`
* **File/Line:** `package.json` (lines 8–24)
* **Severity:** Release Blocker (Package Usability)
* **Impact:** It is currently impossible to import the app instance, managers, config, or helpers from the root package name (e.g., `import { app } from "rector"`). Any external script, operator dashboard, or integration attempting to use `rector` as an npm dependency will fail to resolve the module.
* **Proof:** `package.json` `"exports"` block defines `./extensions`, `./sandbox`, `./workflows`, and `./deployment`, but does not define `.`.
* **Suggested Fix:** Add the root entrypoint export to `"exports"` in `package.json`:
  ```json
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
  ```

---

### 2. Side-Effectful Root Entry Point (`src/index.ts`) Automatically Starts HTTP Server
* **File/Line:** `src/index.ts` (lines 18–22)
* **Severity:** Release Blocker (Architecture/Usability)
* **Impact:** If root export `.` is added as described above, importing any programmatic export from the root package (e.g., `app`, `deploymentConfig`, `gracefulShutdown`, `manager`, `telemetry`) immediately executes `server.listen(PORT)` and binds to a local port. This introduces side-effects on module import, prevents integration testing without starting a server, and causes port collisions.
* **Proof:** `server.listen({ port: PORT }, ...)` and `gracefulShutdown.install()` are executed unconditionally at the top level of `src/index.ts`.
* **Suggested Fix:** Keep `src/index.ts` strictly as an export-only entry point. Move the HTTP server listener and bootstrap side-effects into a dedicated executable entry point (e.g., `src/bin/server.ts` or `src/start.ts`), and update `"dev"` in `package.json` to target that script:
  ```json
  "dev": "tsx watch src/bin/server.ts"
  ```

---

### 3. `process.cwd()` Used to Resolve Static Public Directory in Express Server
* **File/Line:** `src/api/server.ts` (line 46, line 495)
* **Severity:** Release Blocker (Deployment / Cloud Execution)
* **Impact:** In the Express server, `publicDir` is resolved relative to `process.cwd()`. When Rector is executed from any directory other than the project root (e.g., as a global or local npm dependency), `process.cwd()` refers to the caller's directory, causing Express static serving and SPA fallback endpoints to fail or crash because `src/public` is missing. Furthermore, standard production packaging strategies only package built files (under `dist/`) to optimize size, meaning `src/public` will be absent, breaking the frontend interface completely.
* **Proof:** 
  ```typescript
  const publicDir = path.resolve(process.cwd(), "src/public");
  app.use(express.static(publicDir));
  ```
* **Suggested Fix:**
  1. Copy the static files to `dist/public` as part of the build step (or build site step).
  2. Resolve the directory path relative to the module's file location using `import.meta.url` rather than `process.cwd()`:
     ```typescript
     import { fileURLToPath } from "node:url";
     // ...
     const currentDir = path.dirname(fileURLToPath(import.meta.url));
     const publicDir = path.resolve(currentDir, "../public"); // or path.resolve(currentDir, "../../src/public") depending on dev/prod build layout
     ```

---

### 4. Missing Environment Variable Loader for Local/Paid Provider Development
* **File/Line:** `package.json` (line 16)
* **Severity:** Usability / Contributor Experience
* **Impact:** The documentation instructions instruct developers to copy `.env.example` to `.env` to configure optional paid providers (such as Together AI, Perplexity, or Azure OpenAI). However, Rector does not use `dotenv` and the start scripts do not utilize Node's native `--env-file` flag. Running `npm run dev` or `npm test` completely ignores any variables defined in the `.env` file, meaning credentials are not loaded and paid integrations fail silently/fall back to fake local providers.
* **Proof:** There is no `dotenv` dependency in `package.json` and the `"dev"` script is simply `tsx watch src/index.ts`.
* **Suggested Fix:** Add `--env-file=.env` to the `"dev"` script in `package.json`:
  ```json
  "dev": "tsx watch --env-file=.env src/index.ts"
  ```
  *(Note: Native `--env-file` requires Node.js v20.6.0 or newer; if Node v20.0.0-v20.5.0 needs to be supported, `dotenv` should be added as a dependency).*

---

### 5. Discrepancy in `AGENTS.md` Build/Test Commands (`npm run check`)
* **File/Line:** `AGENTS.md` (line 12)
* **Severity:** Tooling Inconsistency
* **Impact:** Both developers and automation/agent workflows are instructed to run `npm run check` for type checking and linting. Running this command will fail with an error since no `check` script exists in `package.json`.
* **Proof:** `package.json` contains no `"check"` script.
* **Suggested Fix:** Define a `"check"` script in `package.json` that performs type-checking or update `AGENTS.md`:
  ```json
  "check": "tsc --noEmit"
  ```

---

### 6. Minor: `MAKE_WEBHOOK_SECRET` Missing from `SETUP_ITEMS`
* **File/Line:** `src/setupChecklist.ts` (lines 9–66) vs `src/workflows/index.ts` (line 304)
* **Severity:** Configuration Inconsistency
* **Impact:** `MAKE_WEBHOOK_SECRET` is defined in `.env.example` and used by `MakeWorkflowAdapter` to authenticate webhook payloads, but it is absent from the `SETUP_ITEMS` list in the programmatic setup checklist. Consequently, it will not be displayed or validated by diagnostic utilities or user-facing setup scripts.
* **Proof:** `MAKE_WEBHOOK_SECRET` is not declared in `SETUP_ITEMS` in `src/setupChecklist.ts`.
* **Suggested Fix:** Add `MAKE_WEBHOOK_SECRET` under the `integrations` category of `SETUP_ITEMS` in `src/setupChecklist.ts`:
  ```typescript
  { key: "MAKE_WEBHOOK_SECRET", label: "Make Webhook Secret", description: "Secret to authenticate incoming Make webhooks.", required: false, category: "integrations" }
  ```
