# Implementation Plan: UI Structural Redesign

## Overview

This plan converts the region-based shell design into incremental code changes across the four
served client files only: `src/public/styles/base.css`, `src/public/index.html`, `src/public/app.js`,
and (no functional change) `src/public/theme.js`. Work proceeds CSS-first (structural tokens + shell
grid + overlay surface styles), then HTML restructure (top bar, slimmed rail, focused canvas,
dockable trace, command palette overlay), then JS wiring (settings-menu controller, command-palette
controller, approval-badge mirroring, `cacheEls()`/`init()` updates). Every existing element id is
preserved or moved with its id intact, so all `bind*()` handlers attach unchanged. Tests follow the
repo's existing DOM/unit (`*.dom.test.ts`) and static-scan conventions; the design's Correctness
Properties are validated by DOM tests and static inspection (no generative property-based library —
the properties are DOM-structural per the Testing Strategy).

## Tasks

- [x] 1. CSS shell foundation (`src/public/styles/base.css`)
  - [x] 1.1 Add structural tokens and the two-row shell grid
    - Add the seven Structural_Tokens to `:root` with non-empty defaults: `--topbar-h: 48px`, `--rail-w: 248px`, `--trace-w: 380px`, `--z-topbar: 30`, `--z-overlay-panel: 45`, `--z-menu: 50`, `--z-palette: 60`
    - Replace `.app { grid-template-columns }` with `.app { display: grid; grid-template-rows: var(--topbar-h) 1fr; height: 100vh }`
    - Add `.topbar` / `.topbar__lead` / `.topbar__actions` rules and the `.content` grid (`var(--rail-w) 1fr 0`) with the `.app.trace-open .content` docked variant
    - Rename `.sidebar*` structural rules to `.rail*` (conversation-first, list fills available height) and delete `.sidebar__cluster*`, `.sidebar__action*`, and `.mode-banner` rules; drop the `.chat__head` block and add the `--measure`-capped, horizontally centered messages rule
    - Use only Theme_System token custom properties (color/type/radius/elevation/motion) — no literal color/length/duration values
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 3.2, 4.4, 12.1, 12.3_

  - [x] 1.2 Add overlay surface styles, trace responsive overlay, and motion
    - Add `.menu` / `.menu__popover` / `.menu__item` / `.menu__sep` / `.menu__badge` rules at `var(--z-menu)` and `.palette` / `.palette__backdrop` / `.palette__panel` / `.palette__list` / `.palette__option[aria-selected="true"]` rules at `var(--z-palette)`
    - Add the `@media (max-width: 900px)` rule so `.app.trace-open .trace` becomes a fixed overlay at `var(--z-overlay-panel)`; keep the docked column for wider viewports
    - Add `pop-in` keyframes animating only `transform`/`opacity` under 300ms, gated by `@media (prefers-reduced-motion: no-preference)` and disabled under `[data-reduced-motion="true"]`
    - Style the focus indicator with the `--focus-ring` token on menu/palette/top-bar controls
    - _Requirements: 5.2, 5.3, 12.1, 13.1, 13.2, 13.3_

  - [x] 1.3 Write theme-token DOM test for the new regions
    - **Property 7: Theme switching still works**
    - **Property 8: No flash of unstyled/wrong-theme content**
    - **Validates: Requirements 12.1, 12.2, 12.4**
    - Add `tests/uiShellTheme.dom.test.ts`; apply each of the five themes via `window.RectorTheme.applyTheme` and assert `getComputedStyle` color/type/radius/elevation/motion change on `.topbar`, `.rail`, `.chat`, `.trace`, `.menu__popover`, `.palette__panel`; assert the `<head>` no-flash boot script is present and unchanged

- [x] 2. HTML shell restructure (`src/public/index.html`)
  - [x] 2.1 Add the inline SVG sprite and the top bar region
    - Add the inline `<svg>` sprite defining `#i-gear`, `#i-cmd`, `#i-trace`, `#i-plus`, `#i-chevron` symbols referenced via `<use>` (no icon font, no remote fetch)
    - Add the `.topbar` header hosting the moved `chat-title`, `run-status`, and `live-indicator` in `.topbar__lead`, and `open-command-palette`, `toggle-trace`, and the `settings-menu-wrap` gear (`open-settings-menu`) with the `settings-menu` popover in `.topbar__actions`
    - Populate the `settings-menu` popover with one `menu__item` per System_Action using the preserved ids `open-setup-wizard`, `open-provider-config`, `open-provider-test`, `open-workspace-safety`, `open-appearance`, and `open-approval` (with `approval-badge`), plus the gear `settings-approval-dot`
    - Give every top-bar and menu control a non-empty accessible name and the correct ARIA (`aria-haspopup`, `aria-expanded`, `aria-controls`, `role="menu"`/`menuitem`)
    - Keep all `<head>` references (fonts, base.css, lazy theme `<link>`, no-flash boot script) under `src/public/` and unchanged
    - _Requirements: 2.1, 2.2, 6.2, 8.1, 11.1, 11.2, 12.4, 13.4_

  - [x] 2.2 Restructure the content row: rail, chat canvas, trace panel
    - Wrap the three regions in `.content` in document order rail → canvas → trace
    - Slim `.rail` to brand mark, `new-conversation`, `conversation-list` (with `conversation-empty`), and `.rail__foot` (version + `health-indicator`); delete the `mode-banner` and the six-button `sidebar__cluster` markup from the rail
    - Reduce `.chat` to `messages` (with `empty-state`, `suggestions`), `composer` (`composer-input`, `composer-send`), and the hint; remove the `.chat__head` element entirely
    - Keep the `.trace` (`trace-drawer`) container and all inner trace content with `close-trace`, `trace-*`, `obs-*`, `cost-*`, `phase-cards`, `decision-*`, and `events` ids preserved
    - _Requirements: 1.2, 3.1, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.5, 5.1, 10.5_

  - [x] 2.3 Add the command palette overlay markup
    - Add the `command-palette` dialog with `command-palette-backdrop`, the `command-palette-input` combobox, and the `command-palette-list` listbox, hidden by default with `role="dialog"`/`aria-modal` and proper combobox/listbox ARIA
    - _Requirements: 7.1, 11.1_

  - [x] 2.4 Write static-scan and no-build tests for the served document
    - **Property 4: No external network calls**
    - **Property 5: No client build step**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.5**
    - Add `tests/uiShellStaticScan.test.ts`; assert `index.html` and `base.css` contain no `http://`/`https://` references in `link`/`script`/`src`/`href`/`@font-face url()`, that icons are inline `<svg>`, and that the app loads from `src/public` verbatim with no build artifact

- [x] 3. Checkpoint - structure renders and stays offline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. JS controllers and wiring (`src/public/app.js`)
  - [x] 4.1 Implement the settings-menu controller
    - Add `openSettingsMenu`, `closeSettingsMenu`, `onDocClickForMenu`, `onMenuKeydown`, and `bindSettingsMenu`
    - On open: unhide popover, set `aria-expanded="true"`, move focus to the first menu item, attach exactly one document outside-click listener and one Escape listener; on close: reverse all of these and return focus to the gear on Escape
    - Toggle on repeated gear activation; close after any `menu__item` activation so the item's existing `bind*()` handler runs unchanged; guard all DOM refs and return early if missing
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 8.1, 8.3, 13.5, 14.1, 14.2, 14.3, 14.4, 15.1, 15.3_

  - [x] 4.2 Write settings-menu DOM test
    - **Property 1: Action reachability (menu side)**
    - **Property 6: Keyboard accessibility (menu side)**
    - **Property 9: Overlay listener hygiene (menu side)**
    - **Validates: Requirements 6.1, 6.3, 6.4, 6.5, 8.1, 8.3, 14.1, 14.2, 14.3, 14.4**
    - Add `tests/settingsMenu.dom.test.ts`; spy on each `open*` function and assert the matching menu item invokes it then closes; assert Escape/outside-click close and that document listener counts return to baseline after close

  - [x] 4.3 Implement the command-palette controller
    - Add `commandRegistry` (one entry per System_Action plus "Toggle trace panel" and "New conversation", each `run` referencing an existing function — no re-implementation), `openCommandPalette`, `closeCommandPalette`, `renderPaletteList`, `invokePaletteCommand`, `onPaletteKeydown`, and `bindCommandPalette`
    - Filter by case-insensitive trimmed substring, set `aria-selected` on the first match (none on no results), move selection with ArrowUp/ArrowDown clamped without wrapping, invoke on Enter only when an option is selected, close on Escape/backdrop, and toggle on global Cmd/Ctrl+K
    - In `invokePaletteCommand`, close the palette and remove its document listeners before calling `cmd.run()`; guard all DOM refs and return early if missing
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 8.2, 8.4, 8.5, 13.5, 14.1, 14.2, 14.3, 14.5, 15.1, 15.3_

  - [x] 4.4 Write command-palette DOM test
    - **Property 1: Action reachability (palette side)**
    - **Property 6: Keyboard accessibility (palette side)**
    - **Property 9: Overlay listener hygiene (palette side)**
    - **Validates: Requirements 7.1, 7.2, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 8.2, 14.5**
    - Add `tests/commandPalette.dom.test.ts`; assert Cmd/Ctrl+K toggles open/close, filter-as-you-type updates `aria-selected`, Arrow keys clamp at ends, Enter invokes the selected command's spy and closes, Enter with no selection is a no-op, and Escape/backdrop close

  - [x] 4.5 Wire approval-badge mirroring, `cacheEls()`, and `init()`
    - Extend `setApprovalBadge` to toggle `settings-approval-dot` in sync with `approval-badge` (hide both at zero, show "99+" above 99) and have the palette approval command read the same count source
    - Add the new ids to `cacheEls()` (`open-command-palette`, `command-palette`, `command-palette-backdrop`, `command-palette-input`, `command-palette-list`, `open-settings-menu`, `settings-menu`, `settings-menu-wrap`, `settings-approval-dot`) and call `bindSettingsMenu()` and `bindCommandPalette()` from `init()` without removing any existing bind call
    - Make `init()`/each `bind*()` skip absent targets without throwing and emit a developer-facing diagnostic for a missing controller reference
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 15.2, 15.4_

  - [x] 4.6 Write id-preservation and handler-integrity DOM test
    - **Property 2: ID preservation**
    - **Property 3: Handler integrity**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
    - Add `tests/uiShellWiring.dom.test.ts`; assert every id in the `cacheEls()` list resolves to a non-null element after load, that `init()` attaches all `bind*()` handlers without throwing (including when a target is absent), and that each preserved control invokes the same open/close/toggle function as before

  - [x] 4.7 Write behavior-preservation regression guard test
    - **Property 10: Behavior preservation**
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5**
    - Add `tests/uiShellBehaviorPreservation.dom.test.ts`; assert trace docking via the existing `toggleTrace`/`closeTrace` (close returns focus to `toggle-trace`), the run-status pill idle/active/failed states, and the live-indicator live/polling/disconnected modes match pre-redesign observable output for identical inputs; confirm the existing pipeline/SSE/cost/approval/provider suites still pass unchanged

- [x] 5. Final checkpoint - full suite green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirement clauses for traceability.
- Property tests here are DOM-structural and static-scan checks run by the existing vitest harness (`*.dom.test.ts`), not a generative property-based library, per the design's Testing Strategy.
- Same-file edits (base.css, index.html, app.js) are scheduled in separate waves to avoid conflicts.
- `src/public/theme.js` is intentionally untouched; theme behavior is exercised by 1.3.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["2.3", "4.1"] },
    { "id": 3, "tasks": ["4.3", "1.3", "2.4"] },
    { "id": 4, "tasks": ["4.5", "4.2"] },
    { "id": 5, "tasks": ["4.4", "4.6", "4.7"] }
  ]
}
```
