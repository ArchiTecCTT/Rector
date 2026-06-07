# Requirements Document

## Introduction

This feature replaces the structural layout of Rector's browser UI with a modern, region-based shell
inspired by current agent IDEs. The previous effort shipped a runtime theming system but preserved
the old three-column layout; this redesign delivers the missing structural half: a slim top bar, a
de-cluttered conversation rail, a focused chat canvas, and a dockable/overlay trace panel. The six
stacked sidebar "system" buttons are consolidated into a single settings (gear) menu plus a
Cmd/Ctrl+K command palette.

The redesign is a structure and visual-language change only. It does not rewrite the BYOK
provider-config logic, the deterministic local pipeline, the SSE/polling transport, or the
theme-token system; those are consumed as-is and re-homed in the new shell. Hard architectural
constraints are preserved: the client stays dependency-free vanilla HTML/CSS/JS served statically
from `src/public/`, with no client build step, no CDN or remote fonts/assets, and zero external
network calls. Every existing element id and JS handler is either preserved in place or migrated
through an explicit, documented mapping so nothing breaks.

## Glossary

- **Shell**: The top-level region-based layout container (`.app`), composed of a two-row structure: the Top_Bar row and the content row.
- **Top_Bar**: The slim, full-width region (`.topbar`) hosting the conversation title, run status pill, live-connection badge, and the global action launchers (command palette, trace toggle, settings gear).
- **Conversation_Rail**: The slimmed left region (`.rail`) holding only the brand mark, the New action, the conversation list, and a compact footer.
- **Chat_Canvas**: The central region (`.chat`) holding the messages region and the composer, with no per-column header.
- **Trace_Panel**: The region (`.trace`) presenting run trace content that docks as a column on wide windows and overlays the canvas on narrow windows.
- **Settings_Menu**: The anchored popover (`#settings-menu`) opened from the gear button, listing the system configuration actions plus pending approvals.
- **Command_Palette**: The centered keyboard-driven overlay (`#command-palette`) opened with Cmd/Ctrl+K, listing launchable commands with filter-as-you-type and keyboard navigation.
- **Command_Registry**: The client-side list of command descriptors that map a label to an existing open/toggle function.
- **System_Action**: One of the six configuration actions: setup status, provider configuration, test provider connection, workspace safety, appearance, and pending approvals.
- **Open_Function**: An existing handler in `app.js` (e.g., `openSetupWizard`, `openProviderConfig`) that opens the modal for a System_Action.
- **Theme_System**: The existing CSS custom-property token contract in `base.css` plus the five theme stylesheets and the `window.RectorTheme` controller in `theme.js`.
- **Approval_Badge**: The pending-approvals count indicator (`approval-badge`) plus its mirrored gear dot (`settings-approval-dot`).
- **Structural_Token**: A CSS custom property added to `:root` for layout geometry and stacking (`--topbar-h`, `--rail-w`, `--trace-w`, `--z-topbar`, `--z-overlay-panel`, `--z-menu`, `--z-palette`).
- **Cached_Id**: An element id present in the `cacheEls()` lookup list in `app.js`.
- **Reduced_Motion_Mode**: The state in which the user has indicated a preference for reduced motion, signalled by `[data-reduced-motion="true"]` or `prefers-reduced-motion`.

## Requirements

### Requirement 1: Region-based shell layout

**User Story:** As a user, I want a fresh region-based shell with a slim top bar above the content, so that the interface reads as a genuine structural overhaul rather than a recolor.

#### Acceptance Criteria

1. THE Shell SHALL render a two-row layout with the Top_Bar spanning the full Shell width in the first row and the content row filling the remaining vertical space in the second row.
2. THE Shell SHALL render the content row as three regions in left-to-right structural (document) order: Conversation_Rail, Chat_Canvas, and Trace_Panel.
3. THE Shell SHALL set the Top_Bar row height to the resolved value of the `--topbar-h` Structural_Token.
4. THE Shell SHALL set the Conversation_Rail width to the resolved value of the `--rail-w` Structural_Token and SHALL allocate the remaining content-row width to the Chat_Canvas and Trace_Panel.
5. IF the `--topbar-h` or `--rail-w` Structural_Token is unset, THEN THE Shell SHALL fall back to a built-in default geometry so the layout still renders.

### Requirement 2: Top bar content and action launchers

**User Story:** As a user, I want the active conversation title, run status, connection state, and global controls in one slim top bar, so that I have a single consistent place for context and actions.

#### Acceptance Criteria

1. THE Top_Bar SHALL host the conversation title (`chat-title`), the run status pill (`run-status`), and the live-connection badge (`live-indicator`).
2. THE Top_Bar SHALL host the command-palette launcher (`open-command-palette`), the trace toggle (`toggle-trace`), and the settings gear (`open-settings-menu`).
3. WHEN the run status changes, THE Top_Bar SHALL display the active run's current phase in the run status pill.
4. WHEN no run is active, THE Top_Bar SHALL display an idle state in the run status pill that visibly differs from any active run phase.
5. IF the active run terminates in a failure state, THEN THE Top_Bar SHALL display a failed state in the run status pill that visibly differs from both the idle state and in-progress phases.
6. WHEN the live-connection state changes, THE Top_Bar SHALL update the live-connection badge to reflect the current connection mode, distinguishing among a live connection, a polling-fallback connection, and a disconnected state.

### Requirement 3: De-cluttered conversation rail

**User Story:** As a user, I want the left rail to focus on my conversations, so that the conversation list is the dominant element instead of competing with system buttons.

#### Acceptance Criteria

1. THE Conversation_Rail SHALL host only the brand mark, the New action (`new-conversation`), the conversation list (`conversation-list`), and the footer with the version label and health indicator (`health-indicator`).
2. THE Conversation_Rail SHALL render the conversation list (`conversation-list`) as the element that expands to occupy all vertical space remaining between the rail header (brand mark and New action) and the rail footer.
3. THE Conversation_Rail SHALL exclude all six System_Action buttons.
4. THE Conversation_Rail SHALL exclude the mode banner element.
5. WHILE no conversations exist, THE Conversation_Rail SHALL display the empty-state message (`conversation-empty`).
6. WHILE one or more conversations exist, THE Conversation_Rail SHALL render an entry in the conversation list (`conversation-list`) for each conversation and SHALL hide the empty-state message (`conversation-empty`).

### Requirement 4: Focused chat canvas

**User Story:** As a user, I want the chat area to be a focused canvas without a per-column header, so that the messages and composer are the primary surface.

#### Acceptance Criteria

1. THE Chat_Canvas SHALL host the messages region (`messages`), including the empty-state (`empty-state`) and suggestions (`suggestions`) elements, such that `document.getElementById` resolves each to a non-null element after load.
2. THE Chat_Canvas SHALL host the composer (`composer`), the composer input (`composer-input`), and the composer send control (`composer-send`), such that `document.getElementById` resolves each to a non-null element after load.
3. THE Chat_Canvas SHALL exclude the former per-column chat header (`.chat__head`), such that no element with that class is present in the Chat_Canvas region.
4. THE Chat_Canvas SHALL cap the maximum rendered width of message content at the value of the `--measure` token and SHALL center that content horizontally within the region.
5. WHEN the messages region contains no messages, THE Chat_Canvas SHALL display the empty-state element (`empty-state`) and SHALL keep the composer (`composer`, `composer-input`, `composer-send`) operational.

### Requirement 5: Dockable and overlay trace panel

**User Story:** As a user, I want the trace panel to dock on wide screens and overlay on narrow screens, so that I can view run details without permanently sacrificing canvas space.

#### Acceptance Criteria

1. THE Trace_Panel SHALL host the existing trace content, including run summary, observability, cost panel, phase cards, decision, and raw events, with all `trace-*`, `obs-*`, `cost-*`, `phase-cards`, `decision-*`, and `events` ids preserved.
2. WHILE the Trace_Panel is open AND the viewport width is greater than 900 pixels, THE Trace_Panel SHALL dock as a column sized by the `--trace-w` Structural_Token.
3. WHILE the Trace_Panel is open AND the viewport width is at or below 900 pixels, THE Trace_Panel SHALL overlay the Chat_Canvas at the `--z-overlay-panel` stacking level.
4. WHEN the trace toggle (`toggle-trace`) is activated WHILE the Trace_Panel is closed, THE Shell SHALL open the Trace_Panel.
5. WHEN the trace toggle (`toggle-trace`) is activated WHILE the Trace_Panel is open, THE Shell SHALL close the Trace_Panel.
6. WHEN the trace close control (`close-trace`) is activated WHILE the Trace_Panel is open, THE Shell SHALL close the Trace_Panel and return keyboard focus to the trace toggle (`toggle-trace`).

### Requirement 6: Settings menu

**User Story:** As a user, I want a single gear menu that lists all system actions, so that I can reach configuration without a cluttered sidebar.

#### Acceptance Criteria

1. WHEN the settings gear is activated AND the Settings_Menu is closed, THE Settings_Menu SHALL open, set `aria-expanded` to `true` on the gear control, and move keyboard focus to the first menu item.
2. THE Settings_Menu SHALL present a menu item for each System_Action: setup status, provider configuration, test provider connection, workspace safety, appearance, and pending approvals.
3. WHEN a Settings_Menu item is activated, THE Settings_Menu SHALL invoke the existing Open_Function for that System_Action and then close.
4. WHEN a click occurs outside the Settings_Menu while it is open, THE Settings_Menu SHALL close and set `aria-expanded` to `false` on the gear control.
5. WHEN the Escape key is pressed while the Settings_Menu is open, THE Settings_Menu SHALL close, set `aria-expanded` to `false` on the gear control, and return keyboard focus to the gear control.
6. WHEN the settings gear is activated AND the Settings_Menu is open, THE Settings_Menu SHALL close and set `aria-expanded` to `false` on the gear control.

### Requirement 7: Command palette

**User Story:** As a user, I want a keyboard-driven command palette, so that I can launch any system action or conversation command without using the mouse.

#### Acceptance Criteria

1. WHEN the user presses Cmd/Ctrl+K while the Command_Palette is closed, THE Command_Palette SHALL open, focus its input with an empty query, display all registered commands, and set `aria-selected` to `true` on the first command in the list.
2. WHEN the user presses Cmd/Ctrl+K while the Command_Palette is open, THE Command_Palette SHALL close.
3. THE Command_Registry SHALL include one command for each System_Action plus "Toggle trace panel" and "New conversation".
4. WHEN the user types a query in the Command_Palette input, THE Command_Palette SHALL display only the commands whose label contains the query text as a case-insensitive substring match after leading and trailing whitespace is removed, and SHALL set `aria-selected` to `true` on the first matching command.
5. IF the query matches no commands, THEN THE Command_Palette SHALL display a no-results indicator and SHALL set `aria-selected` to `true` on no option.
6. WHEN the user presses ArrowDown or ArrowUp in the Command_Palette, THE Command_Palette SHALL move the `aria-selected` option by one position in that direction, clamping at the first and last visible options without wrapping.
7. WHEN the user presses Enter in the Command_Palette AND a command is `aria-selected`, THE Command_Palette SHALL close and then invoke the run function of the selected command.
8. IF the user presses Enter in the Command_Palette AND no command is `aria-selected`, THEN THE Command_Palette SHALL take no action and remain open.
9. WHEN the user presses Escape in the Command_Palette, THE Command_Palette SHALL close.
10. WHEN the Command_Palette backdrop is activated, THE Command_Palette SHALL close.

### Requirement 8: Action reachability and behavior delegation

**User Story:** As a user, I want every system action reachable from both the menu and the palette, invoking the same behavior as before, so that no functionality is lost in the redesign.

#### Acceptance Criteria

1. THE Settings_Menu SHALL provide, for each of the six System_Actions (setup status, provider configuration, test provider connection, workspace safety, appearance, and pending approvals), exactly one control that is operable by both pointer activation and keyboard activation and that exposes an accessible name identifying its System_Action.
2. THE Command_Palette SHALL provide, for each of the six System_Actions (setup status, provider configuration, test provider connection, workspace safety, appearance, and pending approvals), exactly one command that is selectable and invocable via keyboard and that exposes a label identifying its System_Action.
3. WHEN a System_Action is invoked from the Settings_Menu or the Command_Palette, THE Shell SHALL call the same Open_Function in `app.js` that the former sidebar button for that System_Action called, such that the same modal opens and the same outcome occurs as before the redesign.
4. THE Command_Registry SHALL define each command's run function as a reference to an existing function in `app.js`, and SHALL NOT re-implement action behavior.
5. IF the Open_Function referenced by an invoked System_Action control or command cannot be resolved to an existing function in `app.js`, THEN THE Shell SHALL leave the current application state unchanged and surface an indication that the action could not be opened.

### Requirement 9: Pending-approvals count visibility

**User Story:** As a user, I want pending approvals visible without opening the menu, so that I notice work waiting on me.

#### Acceptance Criteria

1. WHILE the pending-approvals count is greater than zero, THE Approval_Badge SHALL display the count on the Settings_Menu pending-approvals item and SHALL show the gear dot (`settings-approval-dot`).
2. WHILE the pending-approvals count is zero, THE Approval_Badge SHALL hide the count and hide the gear dot (`settings-approval-dot`).
3. THE Command_Palette SHALL display the same pending-approvals count value as the Approval_Badge, read from the same source.
4. WHILE the Settings_Menu is closed, WHEN the pending-approvals count changes, THE Approval_Badge SHALL reflect the current count within 500 milliseconds.
5. WHILE the pending-approvals count exceeds 99, THE Approval_Badge SHALL display "99+".

### Requirement 10: Element id and handler preservation

**User Story:** As a developer, I want every existing element id and handler preserved or explicitly migrated, so that no existing wiring breaks.

#### Acceptance Criteria

1. WHEN `init()` completes, THE Shell SHALL render every Cached_Id such that `document.getElementById(id)` resolves to a non-null element.
2. WHEN `init()` runs, THE Shell SHALL attach every existing `bind*()` handler and SHALL complete `init()` without raising an uncaught exception.
3. IF a `bind*()` handler's target element is absent when `init()` runs, THEN THE Shell SHALL skip binding that handler, continue attaching the remaining handlers, and complete `init()` without throwing.
4. WHEN a preserved control (a control whose Cached_Id is retained after the redesign) is activated after `init()` completes, THE Shell SHALL invoke the same open, close, or toggle function that the control invoked before the redesign.
5. WHERE an element id present in the `cacheEls()` lookup list before the redesign is renamed or removed, THE redesign SHALL provide a documented mapping from the former id to its replacement id or to the function that subsumes its behavior.

### Requirement 11: Dependency-free, no-build, offline constraints

**User Story:** As a maintainer, I want the client to remain dependency-free and fully offline, so that the application stays simple to serve and free of external runtime risk.

#### Acceptance Criteria

1. THE Shell SHALL resolve every `<link>`, `<script>`, `src`, `href`, and `@font-face url()` reference to a path under `src/public/`, with no reference to a CDN, a remote host, or a remotely hosted font.
2. THE Shell SHALL provide all icons as inline SVG referenced via `<use>`, with no icon font file and no request to any remote host to retrieve an icon.
3. THE Shell SHALL load and operate from the raw files served by `express.static`, requiring no client-side transpile, bundle, or build artifact.
4. IF an inline SVG icon symbol referenced by a control is missing, THEN THE Shell SHALL retain that control's visible text label and accessible name so the control remains operable and reachable.
5. THE Shell SHALL issue no network request to any origin other than the origin serving the application during initial load and during user interaction.

### Requirement 12: Theme token system preservation

**User Story:** As a user, I want theme switching to keep working across all new regions, so that the redesign does not break the appearance system.

#### Acceptance Criteria

1. THE Shell SHALL define structural rules that reference Theme_System token custom properties for color, type, radius, elevation, and motion, and SHALL use no literal color, length, or duration values for those properties.
2. WHEN a theme is applied via `window.RectorTheme.applyTheme`, THE Shell SHALL update the computed color, type, radius, elevation, and motion styles of the Top_Bar, Conversation_Rail, Chat_Canvas, Trace_Panel, Settings_Menu, and Command_Palette using that theme's tokens, without a page reload, for each of the five themes.
3. THE Shell SHALL add each of the seven Structural_Tokens (`--topbar-h`, `--rail-w`, `--trace-w`, `--z-topbar`, `--z-overlay-panel`, `--z-menu`, `--z-palette`) as an additive property in `:root` that resolves to a non-empty default, such that dependent regions render with non-zero geometry and the documented stacking order when no theme overrides them.
4. THE Shell SHALL preserve the existing `<head>` no-flash boot script so `data-theme` and overrides apply before first paint, with no visible flash of a different theme.

### Requirement 13: Motion and keyboard accessibility

**User Story:** As a user, I want smooth, accessible motion and full keyboard operability, so that the interface is comfortable and usable without a mouse.

#### Acceptance Criteria

1. THE Shell SHALL animate the Settings_Menu, the Command_Palette, and the overlay Trace_Panel using only the `transform` and `opacity` properties, with each entrance and exit transition completing within 300 milliseconds.
2. WHILE Reduced_Motion_Mode is active, WHEN the Settings_Menu or the Command_Palette opens, THE Shell SHALL present the surface directly in its final visible state with no entrance transition.
3. WHEN an interactive control receives keyboard focus, THE Shell SHALL display a visible focus indicator styled with the `--focus-ring` token around that control.
4. THE Shell SHALL provide a non-empty accessible name for every interactive control in the Top_Bar, Settings_Menu, and Command_Palette.
5. THE Shell SHALL make every interactive control in the Top_Bar, Settings_Menu, and Command_Palette reachable by Tab focus and operable by Enter or Space using only the keyboard.

### Requirement 14: Overlay listener hygiene

**User Story:** As a developer, I want overlays to clean up their global listeners on close, so that closed overlays leave no dangling handlers.

#### Acceptance Criteria

1. WHEN the Settings_Menu or Command_Palette opens, THE Shell SHALL attach exactly one outside-click listener and exactly one Escape-key listener at the document level for that overlay.
2. WHEN the Settings_Menu or Command_Palette closes, THE Shell SHALL remove the outside-click listener and the Escape-key listener it attached on open, such that the number of document-level listeners attached by that overlay returns to the count present immediately before that overlay opened.
3. IF the Settings_Menu or Command_Palette is already open when an open of the same overlay is requested, THEN THE Shell SHALL NOT attach any additional outside-click or Escape-key listeners.
4. WHILE neither the Settings_Menu nor the Command_Palette is open, THE Shell SHALL have zero outside-click or Escape-key listeners attached at the document level by those overlays.
5. WHEN a Command_Palette command is invoked, THE Command_Palette SHALL close and remove its document-level listeners before calling the command's run function.

### Requirement 15: Defensive element guards

**User Story:** As a developer, I want each new controller to guard its DOM references, so that markup or id drift degrades gracefully instead of throwing.

#### Acceptance Criteria

1. IF a required element reference (an element looked up by its id) is absent when the Top_Bar, Conversation_Rail, Chat_Canvas, Trace_Panel, Settings_Menu, or Command_Palette controller initializes, THEN THE Shell SHALL return early from that controller without throwing.
2. WHILE a required element reference is absent, THE Shell SHALL leave the controls whose required references are present operational.
3. IF a required element reference is absent when a control's handler is invoked at runtime, THEN THE Shell SHALL take no action for that handler and SHALL NOT throw.
4. IF a required element reference is absent when a controller initializes, THEN THE Shell SHALL emit a developer-facing diagnostic message identifying the missing reference.

### Requirement 16: Behavior preservation of consumed subsystems

**User Story:** As a user, I want streaming, trace, cost, approval, provider config, and conversation behavior to work exactly as today, so that only the layout changes.

#### Acceptance Criteria

1. WHEN the server emits run output over SSE, THE Shell SHALL render message content, phase updates, and event ordering identical to the pre-redesign client given the same server event sequence.
2. THE Shell SHALL produce phase-card derivation, cost and token accounting, approval-flow state, provider-configuration results, setup-status results, workspace-safety results, and conversation-list contents that match the pre-redesign client's observable outputs (displayed values, ordering, and state) when given identical inputs.
3. WHEN a consumed subsystem produces a result for a given input, THE Shell SHALL display the same observable output (values, ordering, and state) as the pre-redesign client, with differences limited to control location and shell layout.
4. IF the SSE connection fails to open or is interrupted, THEN THE Shell SHALL switch to the polling-fallback transport, render the same run output as the SSE path for that run, and update the live-connection badge (`live-indicator`) to reflect the polling connection mode.
5. IF a consumed subsystem reports a failure, THEN THE Shell SHALL surface the same failure indication to the user and preserve the same post-failure state (retained or rolled back) as the pre-redesign client.
