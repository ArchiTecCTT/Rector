# Requirements Document

## Introduction

This effort overhauls Rector's browser UI and adds an in-app, persisted Bring-Your-Own-Key (BYOK) provider configuration flow. It has two coordinated workstreams:

1. **Themed UI overhaul.** Replace the current single dark stylesheet with a runtime **Theme_System** that ships five distinct, selectable themes — Halo, Aether, Cairn, Penumbra, and Vellum Tessera — each carrying its own fonts, color palette, corner radii, accent, and ornament (not just recolors). The chat column, sidebar, and trace drawer are restyled into a calmer, "supervision-surface" experience informed by modern agent IDEs, while preserving every existing behavior (SSE streaming, polling fallback, trace timeline, cost panel, approval flow). The UI must stay **fast and light**: dependency-free vanilla HTML/CSS/JS served from `src/public/`, no build step, self-hosted fonts, and zero CDN or external network dependency.

2. **In-app BYOK provider configuration.** Add a UI and supporting API that let a user enter, persist, test, and select provider credentials from the browser — including API keys for preset providers and a base URL + key + model for any OpenAI-compatible endpoint — modeled on OpenHands' two-tier (Basic/Advanced) settings. Secrets persist locally across restarts through the existing encrypted **Secret_Store**; non-secret configuration persists through a new **Provider_Config_Store**. A **Config_Bridge** makes persisted configuration and secrets drive provider construction and the connection test, which today read process environment variables only.

This effort also **removes Perplexity** as a supported provider across the codebase.

Constraints carried from the existing architecture: the provider-free **Local_Mode** remains the regression baseline and must keep working; the automated test suite makes no real provider or network calls; secrets are redacted at every persistence, streaming, API, and UI boundary; the established Verification_Gates must keep passing.

## Glossary

- **Rector**: The local-first BYOK neuro-symbolic AI coding/orchestration agent that is the subject of this effort.
- **Theme_System**: The runtime mechanism that defines, loads, applies, persists, and switches the visual themes via CSS custom properties, without a build step.
- **Theme**: A complete, named visual definition — color palette, font families, corner radii, accent, elevation, motion, and ornament — selectable at runtime. The five themes are Halo, Aether, Cairn, Penumbra, and Vellum Tessera.
- **Theme_Token_Set**: The collection of CSS custom properties (colors, typography, spacing, radii, elevation, motion) that one Theme provides.
- **Active_Theme**: The Theme currently applied to the UI.
- **Self_Hosted_Font**: A font file (e.g. `.woff2`) served from `src/public/` rather than from a CDN or remote host, with its license file shipped alongside.
- **Appearance_Settings**: The UI surface where a user selects the Active_Theme and adjusts available customization options (e.g. accent, density, reduced motion).
- **Trace_Drawer**: The existing right-hand panel that displays a run's phase timeline, observability stats, cost/token panel, decision, and run events.
- **Phase_Card**: A collapsible per-phase element in the Trace_Drawer representing one pipeline phase (triage, context, planning, skeptic, crucible, DAG compilation, execution, validation/healing, synthesis) and its status.
- **Provider_Config_UI**: The browser surface that lets a user view, enter, edit, test, select, and remove provider configurations.
- **Preset_Provider**: A built-in provider Rector ships an adapter for: Together AI, Cloudflare Workers AI, Azure OpenAI, and the OpenAI-compatible provider.
- **OpenAI_Compatible_Provider**: A new provider adapter that calls any OpenAI-compatible `/chat/completions` endpoint defined by a user-supplied base URL, API key, and model id.
- **Provider_Config_Record**: A persisted, non-secret configuration entry describing one configured provider deployment (id, kind/adapter, label, base URL, model ids, optional headers, and a reference to its secret — never the secret value).
- **Provider_Config_Store**: The persistence component that stores and retrieves Provider_Config_Records (non-secret configuration only).
- **Secret_Store**: The existing abstraction (`src/security/secretStore.ts`, `createLocalSecretStore`) that stores provider secrets in an authenticated-encryption envelope, persists them across restarts, and exposes value-bearing reads only through `getSecret` while exposing presence through `hasSecret`.
- **Config_Bridge**: The component that resolves persisted Provider_Config_Records plus their Secret_Store secrets into the input used to construct providers and to run a connection test.
- **Active_Route_Map**: The per-role mapping (flagship and SLM) that selects which configured provider serves each model role.
- **Connection_Test_API**: The `/api/setup/test-connection` endpoint that validates a provider's credentials with at most one minimal network ping.
- **Provider_Config_API**: The new API endpoints that create, read, update, delete, and select Provider_Config_Records and store their secrets.
- **ModelRouter**: The existing router (`src/providers/llm.ts`) that selects a provider/model for a request.
- **Redaction_Layer**: The secret-scrubbing layer (`src/security/redaction.ts`) applied at persistence, streaming, API, and UI boundaries.
- **Local_Mode**: The provider-free deterministic orchestration mode (`ORCHESTRATOR_MODE=local`) that is the regression baseline.
- **External_Mode**: The BYOK orchestration mode (`ORCHESTRATOR_MODE=external`) that calls live providers.
- **Reduced_Motion**: The accessibility preference (`prefers-reduced-motion`) under which non-essential animation is disabled.
- **Verification_Gates**: The required checks: `npm test`, `npm run build`, and `npm run check`.

## Requirements

### Requirement 1: Runtime Theme System

**User Story:** As a Rector user, I want to switch between distinct visual themes at runtime, so that I can make the interface match my taste without restarting or rebuilding the app.

#### Acceptance Criteria

1. THE Theme_System SHALL define each Theme as a Theme_Token_Set expressed in CSS custom properties, with no build, compile, or bundling step required to apply it.
2. THE Theme_System SHALL provide exactly five selectable themes: Halo, Aether, Cairn, Penumbra, and Vellum Tessera.
3. WHEN a user selects a Theme in Appearance_Settings, THE Theme_System SHALL apply that Theme as the Active_Theme to the entire UI without a full-page reload.
4. WHERE a Theme defines its own font families, color palette, corner radii, accent, and ornament, THE Theme_System SHALL apply all of those token categories when that Theme becomes the Active_Theme, not color tokens alone.
5. THE Theme_System SHALL apply exactly one Active_Theme at a time.
6. WHEN no Theme has been selected by the user, THE Theme_System SHALL apply a defined default Theme.
7. WHEN the Active_Theme is applied, THE Theme_System SHALL style every existing UI surface — sidebar, chat column, composer, Trace_Drawer, modals, and the Provider_Config_UI — using that Theme's tokens.

### Requirement 2: Theme Fidelity

**User Story:** As a Rector user, I want each theme to faithfully reflect its source design, so that the themes feel genuinely different rather than minor variations.

#### Acceptance Criteria

1. THE Halo Theme SHALL render as a dark interface using its three charcoal surface tiers, hairline borders, a single indigo accent, and an Inter + JetBrains Mono type pairing.
2. THE Aether Theme SHALL render as a near-black editorial interface whose only chromatic ornament is a single prism (cyan/magenta/amber) gradient accent, paired with a grotesk display and monospace labels.
3. THE Cairn Theme SHALL render as a near-black editorial interface using a serif display face, a single mint accent threading interactive and active states, and hairline dividers.
4. THE Penumbra Theme SHALL render as a monochrome dark interface using only grayscale tones with no chromatic accent, a serif display, and widely tracked monospace labels.
5. THE Vellum Tessera Theme SHALL render as a light interface using a warm cream canvas, a serif display, and a single teal-to-iris-to-blue gradient reserved for primary emphasis.
6. WHERE a Theme is light rather than dark, THE Theme_System SHALL apply that Theme's foreground/background polarity and contrast such that body text meets the contrast requirement in Requirement 9.
7. THE Theme_System SHALL apply each Theme's own corner-radius scale and accent token rather than a shared global radius or accent.

### Requirement 3: Theme Persistence and Customization

**User Story:** As a Rector user, I want my theme and appearance choices to stick and be adjustable, so that the app keeps my preferred look across sessions.

#### Acceptance Criteria

1. WHEN a user selects an Active_Theme, THE Theme_System SHALL persist that selection so that it is reapplied on the next load of the UI.
2. WHEN the UI loads and a previously persisted Active_Theme exists, THE Theme_System SHALL apply that persisted Theme before first paint of themed content, without a visible flash of an unstyled or wrong-theme interface.
3. THE Appearance_Settings SHALL persist no secret value in browser storage.
4. THE Appearance_Settings SHALL allow the user to toggle Reduced_Motion behavior and SHALL persist that choice.
5. THE Appearance_Settings SHALL allow the user to override the Active_Theme's accent color with a chosen accent, SHALL apply that override at runtime, and SHALL persist it per Theme.
6. THE Appearance_Settings SHALL allow the user to select an interface density from a defined set (such as comfortable and compact), SHALL apply it at runtime, and SHALL persist the choice.
7. THE Appearance_Settings SHALL allow the user to select an interface font-size scale from a defined set, SHALL apply it at runtime, and SHALL persist the choice.
8. WHEN a user clears or resets a customization override, THE Theme_System SHALL revert that property to the Active_Theme's defined token value.
9. WHERE a user-chosen accent color fails the contrast requirement in Requirement 9 against the Active_Theme's surfaces, THE Appearance_Settings SHALL warn the user while still allowing the choice.
10. IF a persisted appearance preference is missing or unreadable, THEN THE Theme_System SHALL fall back to the default Theme and the Active_Theme's default tokens without error.

### Requirement 4: Performance and Lightness

**User Story:** As a Rector user, I want the UI to stay fast and lightweight, so that switching themes and using the app feels instant and the app runs without heavy dependencies.

#### Acceptance Criteria

1. THE UI SHALL be served as static assets from `src/public/` and SHALL require no client-side build, bundler, or transpile step.
2. THE UI SHALL add no runtime npm dependency to the served client and SHALL load no script, style, or font from a third-party or remote origin.
3. WHEN a user switches the Active_Theme, THE Theme_System SHALL complete the visual switch within 200 milliseconds on a typical local machine.
4. THE Theme_System SHALL load only the Active_Theme's required font faces rather than all five themes' fonts simultaneously.
5. WHERE the Theme_System animates a transition or interaction, THE Theme_System SHALL animate only compositor-friendly properties (such as transform and opacity) and SHALL keep durations at or below 300 milliseconds.
6. THE UI SHALL preserve the existing SSE streaming and polling-fallback behavior with no added latency to first token or first phase event introduced by the Theme_System.

### Requirement 5: Self-Hosted Fonts and Licensing

**User Story:** As a Rector maintainer, I want all theme fonts bundled locally under clear licenses, so that the app works offline and complies with font licensing.

#### Acceptance Criteria

1. THE Theme_System SHALL load every theme font as a Self_Hosted_Font served from `src/public/` and SHALL NOT reference any web font CDN.
2. THE repository SHALL include, alongside each bundled font, the font's license file.
3. THE Theme_System SHALL use only fonts whose license permits bundling and redistribution within an application.
4. WHEN a bundled font fails to load, THE Theme_System SHALL fall back to a defined system font stack so that text remains legible.
5. THE Theme_System SHALL serve fonts in a compressed web font format (such as WOFF2).

### Requirement 6: Chat Experience Overhaul

**User Story:** As a Rector user, I want a refined chat surface, so that conversations and agent activity read clearly and the interface feels designed rather than plain.

#### Acceptance Criteria

1. THE chat column SHALL preserve all existing chat behavior, including sending messages, streaming assistant responses, rendering historical conversations, the conversation list, and per-message trace access.
2. THE chat column SHALL constrain message content to a readable maximum line length even when the window is wide.
3. WHEN an assistant message contains Markdown, THE chat column SHALL render it as formatted content rather than raw Markdown source.
4. THE chat column SHALL render the run status and live-connection indicators using the Active_Theme's status tokens, paired with text or an icon and never color alone.
5. WHILE a run is in progress, THE chat column SHALL present an unambiguous in-progress state that updates as run phases advance.
6. THE sidebar SHALL group the system-status actions (setup status, provider configuration, workspace safety, pending approvals) and SHALL display a count indicator for pending approvals when any exist.

### Requirement 7: Trace Drawer as Supervision Surface

**User Story:** As a Rector user, I want the trace drawer to present each pipeline phase as an inspectable card, so that I can follow and audit what the agent did rather than scroll a raw event log.

#### Acceptance Criteria

1. THE Trace_Drawer SHALL render the pipeline phases as a Phase_Card list covering triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation/healing, and synthesis.
2. WHEN run events are received, THE Trace_Drawer SHALL update each Phase_Card's status from the actual persisted run events, distinguishing at least pending, active, done, and failed/decision states.
3. THE Trace_Drawer SHALL allow each Phase_Card to be expanded and collapsed to reveal or hide that phase's detail.
4. THE Trace_Drawer SHALL preserve the existing observability summary, cost/token panel, decision section, and access to raw run events.
5. THE Trace_Drawer SHALL derive all displayed values from real run data and SHALL NOT fabricate phase, cost, or event data.
6. WHEN a run reaches a non-success terminal phase (failed, aborted, or needs-decision), THE Trace_Drawer SHALL indicate that terminal outcome distinctly from a successful completion.

### Requirement 8: Theme-Aware Existing Surfaces

**User Story:** As a Rector user, I want every existing panel to respect the active theme, so that the experience is consistent everywhere.

#### Acceptance Criteria

1. WHEN the Active_Theme changes, THE setup status panel, provider connection panel, workspace safety panel, and run approval panel SHALL each adopt the Active_Theme's tokens.
2. THE modals and overlays SHALL use the Active_Theme's elevation and surface tokens for backdrops and panels.
3. THE Theme_System SHALL apply the Active_Theme's focus-ring token to all interactive controls.
4. THE existing approval flow SHALL retain its current behavior, including displaying redacted operation details before any approve or deny action is enabled.

### Requirement 9: Accessibility

**User Story:** As a Rector user who relies on accessibility features, I want the themed UI to remain usable, so that I can operate Rector regardless of theme.

#### Acceptance Criteria

1. THE Theme_System SHALL ensure body text in every Theme meets a contrast ratio of at least 4.5:1 against its background.
2. WHEN Reduced_Motion is active, THE Theme_System SHALL disable non-essential animation while preserving full state feedback.
3. THE UI SHALL render a visible focus indicator on every interactive control in every Theme.
4. THE Theme_System SHALL never use color as the only means of conveying status, pairing every status color with text or an icon.
5. THE UI SHALL preserve the existing semantic roles and ARIA attributes on chat, trace, modal, and form surfaces.

### Requirement 10: In-App Provider Configuration UI

**User Story:** As a Rector user configuring BYOK, I want to enter and manage my provider settings from the browser, so that I can set up External_Mode without editing `.env` or restarting.

#### Acceptance Criteria

1. THE Provider_Config_UI SHALL present a two-tier structure: a Basic tier listing the Preset_Providers and an Advanced tier for configuring an OpenAI_Compatible_Provider.
2. WHEN a user selects a Preset_Provider, THE Provider_Config_UI SHALL display only the configuration fields that provider requires.
3. WHEN a user configures an OpenAI_Compatible_Provider, THE Provider_Config_UI SHALL present fields for a base URL, an API key, and a model id.
4. THE Provider_Config_UI SHALL display, for each provider, a configuration status indicating at least: not configured, configured, and active.
5. WHEN a user saves a provider configuration, THE Provider_Config_UI SHALL persist the non-secret fields through the Provider_Config_Store and the secret through the Secret_Store.
6. THE Provider_Config_UI SHALL allow a user to remove a saved provider configuration, which SHALL delete its Provider_Config_Record and its stored secret.
7. WHILE the Provider_Config_UI is displayed, THE UI SHALL keep the existing chat and trace surfaces accessible.

### Requirement 11: Secret Entry and Handling

**User Story:** As a Rector user, I want my API keys handled safely when I enter them, so that my credentials are never exposed or leaked.

#### Acceptance Criteria

1. THE Provider_Config_UI SHALL render every API key input as a masked field with an explicit show/hide control.
2. WHEN a secret is already stored for a provider, THE Provider_Config_API SHALL expose only a presence indicator for that secret and SHALL NOT return the secret value to the browser.
3. WHEN a secret is already stored and the user saves other fields without entering a new secret, THE System SHALL retain the existing stored secret unchanged.
4. THE Provider_Config_API SHALL pass every response through the Redaction_Layer so that no full or partial secret value appears in any response.
5. THE Provider_Config_UI SHALL store no secret value in browser localStorage or sessionStorage.
6. WHEN a secret is submitted from the browser, THE Provider_Config_API SHALL persist it only through the Secret_Store and SHALL NOT write it to the Provider_Config_Store, run events, logs, or any non-secret store.
7. IF persisting a secret fails, THEN THE Provider_Config_API SHALL leave any previously stored secret for that provider intact and SHALL return a redacted error.

### Requirement 12: OpenAI-Compatible Provider Adapter

**User Story:** As a Rector user, I want to connect any OpenAI-compatible endpoint by giving its URL, key, and model, so that I can use providers Rector does not ship a dedicated adapter for.

#### Acceptance Criteria

1. THE OpenAI_Compatible_Provider SHALL implement the existing provider interface (metadata, validateConfig, estimateRequest, invoke).
2. THE OpenAI_Compatible_Provider SHALL call the configured base URL's chat-completions endpoint using the configured API key and model id.
3. WHEN the OpenAI_Compatible_Provider is configured without a base URL, without an API key, or without a model id, THE OpenAI_Compatible_Provider SHALL fail validation with a configuration error and SHALL NOT attempt a network call.
4. THE OpenAI_Compatible_Provider SHALL default its network access to disabled and SHALL make a network call only when network access is explicitly enabled, consistent with the existing provider adapters.
5. THE OpenAI_Compatible_Provider SHALL parse responses into Rector's common response shape and SHALL raise a structured provider error on HTTP failure or an invalid response.
6. THE OpenAI_Compatible_Provider SHALL route every error message through the Redaction_Layer so that no secret appears in an error.

### Requirement 13: Persisted Configuration Drives Providers and Tests

**User Story:** As a Rector user, I want the keys I save in the UI to actually be used by the agent and the connection test, so that configuring a provider in the browser is sufficient to use it.

#### Acceptance Criteria

1. THE Config_Bridge SHALL resolve persisted Provider_Config_Records and their Secret_Store secrets into the input used to construct providers.
2. WHEN a connection test is requested for a configured provider, THE Connection_Test_API SHALL test using the persisted configuration and secret rather than process environment variables only.
3. WHEN External_Mode selects a provider for a request, THE ModelRouter SHALL be able to use a provider constructed from persisted configuration and secrets.
4. WHERE both an environment-provided value and a persisted UI-provided value exist for the same provider, THE Config_Bridge SHALL apply a single, documented precedence order deterministically.
5. THE Config_Bridge SHALL NOT inject provider secrets into the sandbox executor environment or into any command the sandbox can run.
6. THE Config_Bridge SHALL surface secret presence to status and configuration responses as a presence boolean only, never as a value.

### Requirement 14: Active Provider and Model Selection

**User Story:** As a Rector user with more than one provider configured, I want to choose which one is active for each model role, so that I control which provider handles flagship versus small/fast work.

#### Acceptance Criteria

1. THE Provider_Config_UI SHALL allow a user to designate, from the configured providers, which provider serves each model role in the Active_Route_Map.
2. WHEN the user sets the active provider for a role, THE Provider_Config_Store SHALL persist that Active_Route_Map selection.
3. WHEN the ModelRouter selects a provider in External_Mode for a role, THE ModelRouter SHALL honor the Active_Route_Map when a provider is designated for that role.
4. IF the provider designated for a role is no longer configured, THEN THE System SHALL fall back to its existing route-selection behavior rather than fail the run.
5. THE Provider_Config_UI SHALL clearly indicate which provider is currently active for each role.

### Requirement 15: Connection Test Upgrade

**User Story:** As a Rector user, I want to test a provider I just configured in the UI, so that I can confirm it works before relying on it.

#### Acceptance Criteria

1. WHEN a user triggers a connection test from the Provider_Config_UI, THE Connection_Test_API SHALL validate the selected provider's configuration before attempting any network call.
2. WHEN a connection test succeeds, THE Provider_Config_UI SHALL display a human-language success message that contains no secret material.
3. IF a connection test fails, THEN THE Provider_Config_UI SHALL display a human-language failure message that identifies the failure reason, contains no secret material, and retains the user's input.
4. WHILE a connection test is in progress, THE Provider_Config_UI SHALL display a loading indicator and SHALL disable the test action.
5. IF a connection test does not return within 30 seconds, THEN THE Provider_Config_UI SHALL terminate the test, clear the loading indicator, and display a redacted timeout message.
6. THE Connection_Test_API SHALL reject an unsupported provider id before constructing any provider or attempting any network call.

### Requirement 16: Remove Perplexity Provider

**User Story:** As a Rector maintainer, I want Perplexity removed as a provider, so that the codebase no longer offers or references a provider we do not support.

#### Acceptance Criteria

1. THE System SHALL NOT offer Perplexity as a selectable or configurable provider in the Provider_Config_UI.
2. THE System SHALL remove the Perplexity provider adapter and its references from provider construction, the supported-provider set, orchestration configuration, setup status, and the setup checklist.
3. THE Connection_Test_API SHALL NOT accept Perplexity as a provider id.
4. WHEN the codebase is searched after removal, THE System SHALL contain no remaining Perplexity provider wiring in the provider, deployment, API, and setup modules.
5. THE removal SHALL NOT break the Local_Mode regression baseline or the remaining providers, verified by the Verification_Gates passing.

### Requirement 17: Preserve Baseline, Safety, and Verification

**User Story:** As a Rector maintainer, I want this overhaul to preserve the control plane, safety guarantees, and verification gates, so that productization does not regress the core.

#### Acceptance Criteria

1. THE effort SHALL preserve Local_Mode as a working provider-free regression baseline.
2. THE automated test suite SHALL make no real provider or network calls and SHALL use deterministic test doubles.
3. THE effort SHALL preserve secret redaction at every persistence, streaming, API, and UI boundary, such that the count of detected secrets in those outputs is zero.
4. THE effort SHALL preserve all existing sandbox containment constraints.
5. WHEN the effort is complete, THE Verification_Gates (`npm test`, `npm run build`, `npm run check`) SHALL pass.
6. THE effort SHALL keep the existing API route contracts working for any behavior not explicitly changed by these requirements.
