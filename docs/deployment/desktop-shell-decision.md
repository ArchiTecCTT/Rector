# Desktop Shell Decision — v0.1.0-alpha

Status: Decided
Scope: Design-only spike record. No runtime code, dependencies, or build steps are added by this document.

## Recommendation

**Rector's first desktop shell will be built with Tauri.**

This is a single, explicit recommendation. Electron was assessed as the serious alternative and is documented below for completeness, but Tauri is selected for the first shell.

The recommendation is recorded as a decision only. It does not yet add a desktop build target to the repository; see [Minimal prototype path](#minimal-prototype-path) for the steps that would realize it and [Verification posture](#verification-posture-no-gates-affected) for why the existing Node web application is unchanged.

## How Rector runs today (context for the assessment)

Rector is a local-first Node application. The web UI is static HTML/JS served from `src/public`, and the API is an Express app started by `src/bin/server.ts`:

- Build: `npm run build` (`tsc` + ESM import fixups).
- Start: `node dist/index.js` (or `npm run dev` for the watch loop), which calls `http.createServer(app)` and listens on `127.0.0.1` at the configured `PORT`.
- Default mode is provider-free Local_Mode with in-memory or SQLite persistence; secrets are handled through the redaction layer (`src/security/redaction.ts`) and the local secret store (`src/security/secretStore.ts`).

A desktop shell therefore has one core job: package the static UI, supervise the local Node server process (or an embedded equivalent), point a native window at `http://127.0.0.1:<port>`, and add native conveniences (folder picker, OS keychain, auto-update) without changing the control plane or weakening redaction and sandbox safety.

## Assessment

Both candidates are assessed against the six required factors: packaging complexity, local server lifecycle management, native folder picker support, secure secret storage, auto-update path, and Windows/macOS/Linux platform concerns.

### Tauri

| Factor | Assessment |
| --- | --- |
| **Packaging complexity** | Ships a small native binary (WebView + Rust core); typical installers are single-digit MB. Requires a Rust toolchain in the build environment, which is new to this repo's Node-only pipeline. Bundler targets `.msi`/`.exe` (Windows), `.dmg`/`.app` (macOS), `.deb`/`.AppImage` (Linux). Higher first-time setup cost, lower artifact size. |
| **Local server lifecycle management** | The Rust core can spawn and supervise the Node server as a managed sidecar process, tying its lifetime to the window and killing it on exit. This maps cleanly onto the existing `node dist/index.js` start command and the graceful-shutdown handler already installed in `src/bin/server.ts`. |
| **Native folder picker** | First-class. Tauri's dialog API exposes a native folder/open dialog and returns a path string, suitable for selecting the workspace root surfaced by the Workspace Safety panel. No browser `webkitdirectory` fallback needed. |
| **Secure secret storage** | Integrates with OS-native secure storage (Keychain / Credential Manager / libsecret) via community plugins, which is exactly the OS-keychain backing the `SecretStore` interface (`src/security/secretStore.ts`) was designed to accept without changing consumers. The local encrypted-file backing remains the cross-platform default. |
| **Auto-update path** | Built-in updater with signed update artifacts and a configurable release endpoint. Requires maintaining a signing key and an update manifest feed, but no third-party runtime dependency. |
| **Windows / macOS / Linux concerns** | Uses the OS-provided WebView (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux). Rendering can differ slightly per platform engine, so the UI must be tested on each. macOS notarization and Windows code-signing are required for smooth installs. Linux depends on a WebKitGTK runtime being present. |

### Electron

| Factor | Assessment |
| --- | --- |
| **Packaging complexity** | Mature, well-trodden Node-native tooling (`electron-builder`/`electron-forge`). No new language toolchain — it stays inside the existing Node ecosystem. Cost is artifact size: each app bundles a full Chromium + Node runtime, producing installers in the ~80–150 MB range. |
| **Local server lifecycle management** | The main process is itself Node, so it can `require`/spawn the Express app directly or as a child process and manage its lifetime with the existing graceful-shutdown logic. Lowest-friction fit for the current server because no cross-language boundary is involved. |
| **Native folder picker** | First-class via `dialog.showOpenDialog({ properties: ['openDirectory'] })`, returning a native path. Equivalent capability to Tauri for selecting the workspace root. |
| **Secure secret storage** | `safeStorage` provides OS-backed encryption (Keychain / DPAPI / libsecret), and `keytar`-style libraries add direct keychain access. Same `SecretStore` OS-keychain backing applies. Functionally comparable to Tauri here. |
| **Auto-update path** | Well-established via `autoUpdater` + `electron-updater`, with hosted feed options (e.g. static file server or release host). Mature and widely documented, at the cost of carrying the updater dependency stack. |
| **Windows / macOS / Linux concerns** | Bundles its own Chromium, so rendering is identical across platforms — fewer per-platform UI surprises. The tradeoff is larger downloads, higher memory footprint, and responsibility for shipping timely Chromium security updates. macOS notarization and Windows signing are still required. |

### Side-by-side summary

| Factor | Tauri | Electron |
| --- | --- | --- |
| Packaging complexity | New Rust toolchain; small artifacts | Node-native tooling; large artifacts |
| Local server lifecycle | Node server as supervised sidecar | Main process is Node; direct supervision |
| Native folder picker | First-class | First-class |
| Secure secret storage | OS keychain via plugin | OS keychain via `safeStorage`/keytar |
| Auto-update | Built-in signed updater | Mature `electron-updater` |
| Cross-platform rendering | OS WebView (per-platform variance) | Bundled Chromium (uniform) |
| Footprint / memory | Low | High |
| Security update burden | OS maintains WebView | App must ship Chromium updates |

## Rationale

Tauri is recommended because, weighed against the six assessed factors, it best fits Rector's local-first, security-conscious posture:

- **Secure secret storage and footprint** are the deciding factors. Rector's whole product story is local-first, redaction-everywhere, and minimal attack surface. Tauri's small binary and reliance on the OS-maintained WebView mean the OS — not Rector — carries the browser-engine security-update burden, whereas Electron makes Rector responsible for shipping timely Chromium patches. For a security-sensitive agent that stores provider secrets, a smaller, OS-backed surface is the better default. Tauri's OS-keychain plugin lands exactly on the swappable `SecretStore` backing the design already anticipates.
- **Local server lifecycle management** is a wash in capability: both can supervise the existing `node dist/index.js` process and reuse the graceful-shutdown handler. Tauri's sidecar model is a clean fit and does not regress this need.
- **Native folder picker and auto-update** are both first-class on Tauri (native dialog returning a path; built-in signed updater), satisfying the workspace-root selection and update factors without a third-party runtime stack.
- **Packaging complexity and cross-platform rendering** are where Tauri costs more: it introduces a Rust toolchain and exposes per-platform WebView rendering differences that must be tested on Windows, macOS, and Linux. This is the accepted tradeoff. It is outweighed by the footprint and security-surface benefits, and it is a build-time/test-time cost rather than a user-facing or safety cost.

Electron remains a reasonable fallback if the Rust toolchain or per-platform WebView variance proves too costly in practice; its Node-native packaging and uniform Chromium rendering are its strengths. The decision is revisable, but Tauri is the selected first shell.

## Minimal prototype path

The prototype is **scoped but deferred from implementation in this spike** (decision recorded now; build target added in a later chunk). The steps below describe how to launch the existing Node web application inside the recommended Tauri shell when that work is scheduled:

1. Add a `desktop/` workspace containing a Tauri project (`tauri init`) that is isolated from the Node build so the existing `npm run build`/`npm test` gates are untouched.
2. Configure the Node server as a Tauri **sidecar**: bundle the `node dist/index.js` start command (built via the existing `npm run build`) and have the Rust core spawn it on app launch, binding to `127.0.0.1` on an ephemeral or configured `PORT`.
3. Point the Tauri main window at `http://127.0.0.1:<port>` once the server's listen callback reports ready, reusing the static UI from `src/public` unchanged.
4. Tie the sidecar lifetime to the window: on app exit, signal the server so the existing graceful-shutdown handler (`createGracefulShutdownHandler`) runs and the process exits cleanly.
5. Wire the native folder dialog to the workspace-root selection and add the OS-keychain `SecretStore` backing behind the existing interface — no consumer changes required.
6. Smoke-test packaged installers on Windows, macOS, and Linux to surface WebView rendering differences early.

### Deferral reason

Implementation is deferred because the desktop shell is additive and must not perturb the current verification gates or the Local_Mode regression baseline during the alpha. The prototype introduces a new (Rust) build toolchain and platform-specific signing/notarization that belong in a dedicated chunk with its own CI lane, not in this design-only spike. Recording the decision and prototype path now unblocks that later work while keeping this change zero-risk to the shipping Node web app.

## Added dependencies

**No new dependencies were added by this spike.** This is a design-only document. The candidate technology each *future* dependency would support is documented here so the reason is on record before any code lands:

- `@tauri-apps/cli` / `@tauri-apps/api` (and the Rust `tauri` crate) — would be added only when the prototype is implemented, to support the **Tauri** recommended shell (windowing, sidecar supervision, dialog, updater).
- An OS-keychain Tauri plugin — would be added to provide the **Tauri** OS-backed `SecretStore` implementation behind the existing interface.

No Electron dependencies are added, since Electron is the documented fallback, not the selection.

## Verification posture (no gates affected)

Because this deliverable adds only a Markdown document under `docs/` and changes no source, build config, or dependencies:

- The existing Node web application remains runnable exactly as before (`npm run build` then `node dist/index.js`, or `npm run dev`).
- All five Verification_Gates (`npm test`, `npm run build`, `npm run check`, the roadmap-issues check, and the Linear-export check) are unaffected.
- The Local_Mode regression baseline is unchanged.

## Validation commands

```bash
npm test
npm run build
npm run check
```
