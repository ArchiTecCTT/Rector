// Accessibility + theme-aware-panels tests (task 14).
//
// Validates (by CSS/DOM assertion, no jsdom, no network — deterministic):
//   - Req 8.1/8.2: the existing panels (setup status, provider test/config,
//     workspace safety, approval, appearance) + their modal backdrops/panels
//     consume the Active_Theme's surface/elevation/overlay tokens, not
//     hardcoded colors.
//   - Req 8.3 / 9.3: the --focus-ring token is applied to every interactive
//     control class (buttons, inputs, links, the selectable provider radio
//     rows, conversation items, suggestions, the motion checkbox, theme/accent
//     radios, segmented controls, phase-card headers).
//   - Req 9.1 (on-accent labels): every theme's --accent-contrast meets at
//     least the WCAG AA UI/bold-label 3:1 threshold against its own --accent,
//     so primary-button labels stay legible in every theme (this is the bug
//     the token fixes: white on Penumbra/Cairn/Aether's light accents).
//   - Req 9.4: run/connection status is never conveyed by color alone — the
//     status pill pairs every state with a glyph, and status text is rendered.
//   - Req 9.2: the runtime reduced-motion hook disables non-essential
//     animation UNIVERSALLY (the `*` selector), i.e. across every panel/theme.
//   - Req 9.5: the chat, trace, modal, and form surfaces keep their semantic
//     roles and ARIA attributes in index.html.
//   - Req 8.4: the approval panel ships its approve/deny actions disabled and
//     renders the redacted operation details (target path, command, diff)
//     block, so gating is preserved before any decision is enabled.
//
// CSS/HTML are static assets; we parse the files directly (same approach as
// tests/themeSystem.dom.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readPublic(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/public/${relPath}`, import.meta.url)),
    "utf8",
  );
}

const BASE_CSS = readPublic("styles/base.css");
const INDEX_HTML = readPublic("index.html");

const THEME_FILES: Array<{ id: string; file: string }> = [
  { id: "halo", file: "styles/themes/halo.css" },
  { id: "aether", file: "styles/themes/aether.css" },
  { id: "cairn", file: "styles/themes/cairn.css" },
  { id: "penumbra", file: "styles/themes/penumbra.css" },
  { id: "vellum", file: "styles/themes/vellum.css" },
];

// Extract the declaration block (text between the first `{` after the selector
// and its matching `}`) for a top-level rule. The selector is passed
// regex-ready (e.g. "\\.btn--primary").
function ruleBlock(css: string, selector: string): string | null {
  // Match the selector at the start of a line (optionally indented), followed by `{`.
  const re = new RegExp(`(^|\\n)\\s*${selector}\\s*\\{`);
  const m = re.exec(css);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

// ---- WCAG relative-luminance contrast (for #rrggbb hex) -------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(hexA: string, hexB: string): number {
  const la = relLuminance(hexToRgb(hexA));
  const lb = relLuminance(hexToRgb(hexB));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function tokenValue(css: string, token: string): string | null {
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`);
  const m = re.exec(css);
  return m ? m[1].trim() : null;
}

// ===========================================================================
// 1. Theme-aware panels consume surface/elevation/overlay tokens (Req 8.1/8.2)
// ===========================================================================
describe("Theme-aware existing panels (Req 8.1, 8.2)", () => {
  it("modal backdrop uses the --overlay token and the panel uses surface + shadow tokens", () => {
    const backdrop = ruleBlock(BASE_CSS, "\\.modal__backdrop");
    const panel = ruleBlock(BASE_CSS, "\\.modal__panel");
    expect(backdrop).toContain("var(--overlay)");
    expect(panel).toContain("var(--surface)");
    expect(panel).toContain("var(--shadow-lg)");
  });

  it.each([
    ["setup wizard pill", "\\.wizard-pill"],
    ["provider test result", "\\.provider-result"],
    ["workspace safety badge", "\\.safety-badge"],
    ["approval code block", "\\.approval-code"],
    ["provider config card", "\\.provider-config-card"],
    ["appearance theme card", "\\.appearance-theme"],
  ])("%s references theme tokens, not hardcoded colors", (_name, selector) => {
    const block = ruleBlock(BASE_CSS, selector);
    expect(block, `${selector} rule missing`).not.toBeNull();
    // No raw hex / rgb color literal inside the panel rule — every color is a token.
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(/);
    expect(block).toMatch(/var\(--/);
  });

  it("has no hardcoded color literals in base.css outside the :root contract and theme-preview swatches", () => {
    const lines = BASE_CSS.split("\n");
    const offenders: string[] = [];
    let inRoot = false;
    let braceDepth = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^:root\s*\{/.test(line)) inRoot = true;
      if (inRoot) {
        braceDepth += (line.match(/\{/g) ?? []).length;
        braceDepth -= (line.match(/\}/g) ?? []).length;
        if (braceDepth <= 0) inRoot = false;
        continue; // :root holds the token CONTRACT defaults — hex allowed there.
      }
      // The appearance theme-preview swatches intentionally hardcode each theme's
      // real palette so the preview is accurate regardless of the active theme.
      if (line.includes("appearance-theme__swatch")) continue;
      if (/linear-gradient\(135deg, #/.test(line)) continue;
      // A token fallback like var(--x, #fff) is acceptable.
      if (/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/.test(line)) continue;
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line)) {
        offenders.push(line);
      }
    }
    expect(offenders, `unexpected hardcoded colors:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});

// ===========================================================================
// 2. Focus-ring token on every interactive control (Req 8.3, 9.3)
// ===========================================================================
describe("Focus-ring token on interactive controls (Req 8.3, 9.3)", () => {
  // selector -> the focus pseudo it uses to surface the ring.
  const FOCUSABLE: Array<{ name: string; selector: string }> = [
    { name: "buttons", selector: "\\.btn:focus-visible" },
    { name: "composer textarea", selector: "\\.composer__input:focus" },
    { name: "conversation items", selector: "\\.conversation-item:focus-visible" },
    { name: "suggestions", selector: "\\.suggestion:focus-visible" },
    { name: "message trace link", selector: "\\.msg__trace-link:focus-visible" },
    { name: "provider radio rows", selector: "\\.provider-option:focus-within" },
    { name: "approval identity input", selector: "\\.approval-input:focus" },
    { name: "phase-card header", selector: "\\.phase-card__header:focus-visible" },
    { name: "provider-config input", selector: "\\.provider-config-input:focus-visible" },
    { name: "provider-config role toggle", selector: "\\.provider-config-role:focus-visible" },
    { name: "appearance theme radio", selector: "\\.appearance-theme:focus-within" },
    { name: "appearance accent radio", selector: "\\.appearance-accent:focus-within" },
    { name: "appearance motion checkbox", selector: "\\.appearance-toggle:focus-within" },
  ];

  it.each(FOCUSABLE)("$name surface the --focus-ring token", ({ selector }) => {
    const block = ruleBlock(BASE_CSS, selector);
    expect(block, `${selector} has no focus rule`).not.toBeNull();
    expect(block).toContain("var(--focus-ring)");
  });

  it("segmented controls (density/font-size radios) surface the focus ring", () => {
    // These are styled via the adjacent-sibling label, not the input directly.
    expect(BASE_CSS).toMatch(
      /\.appearance-segment input:focus-visible \+ span\s*\{[^}]*var\(--focus-ring\)/,
    );
  });
});

// ===========================================================================
// 3. On-accent label contrast per theme (Req 9.1)
// ===========================================================================
describe("On-accent label contrast (--accent-contrast vs --accent) (Req 9.1)", () => {
  it("the primary button colors its label with the --accent-contrast token", () => {
    const block = ruleBlock(BASE_CSS, "\\.btn--primary");
    expect(block).toContain("var(--accent-contrast");
    expect(block).toContain("background: var(--accent)");
  });

  it.each(THEME_FILES)(
    "$id --accent-contrast vs --accent meets the AA UI/bold-label 3:1 threshold",
    ({ file }) => {
      const css = readPublic(file);
      const accent = tokenValue(css, "--accent");
      const contrast = tokenValue(css, "--accent-contrast");
      expect(accent, "missing --accent").toMatch(/^#[0-9a-fA-F]{3,6}$/);
      expect(contrast, "missing --accent-contrast").toMatch(/^#[0-9a-fA-F]{3,6}$/);
      const ratio = contrastRatio(accent as string, contrast as string);
      expect(
        ratio,
        `accent ${accent} vs on-accent ${contrast} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    },
  );
});

// ===========================================================================
// 4. Status never by color alone (Req 9.4)
// ===========================================================================
describe("Status is never color-only (Req 9.4)", () => {
  it("the status pill pairs a glyph (::before content) with every state", () => {
    // Base glyph + one per state: idle/running/done/decision/failed.
    for (const state of ["idle", "running", "done", "decision", "failed"]) {
      const re = new RegExp(
        `\\.status-pill--${state}::before\\s*\\{[^}]*content:`,
      );
      expect(BASE_CSS, `status-pill--${state} lacks an icon glyph`).toMatch(re);
    }
  });

  it("phase cards carry both an icon and a textual status (not color alone)", () => {
    expect(ruleBlock(BASE_CSS, "\\.phase-card__icon")).not.toBeNull();
    expect(ruleBlock(BASE_CSS, "\\.phase-card__status")).not.toBeNull();
  });
});

// ===========================================================================
// 5. Reduced-motion is honored universally across panels/themes (Req 9.2)
// ===========================================================================
describe("Reduced-motion coverage (Req 9.2)", () => {
  it("the runtime reduced-motion hook disables animation/transition for ALL elements", () => {
    // The selector list must include the universal `*` so the override reaches
    // every panel and theme, not just specific components.
    const idx = BASE_CSS.indexOf('[data-reduced-motion="true"]');
    expect(idx).toBeGreaterThan(-1);
    const selectorChunk = BASE_CSS.slice(idx - 40, BASE_CSS.indexOf("{", idx));
    expect(selectorChunk).toContain('[data-reduced-motion="true"] *');
    const open = BASE_CSS.indexOf("{", idx);
    const close = BASE_CSS.indexOf("}", open);
    const block = BASE_CSS.slice(open + 1, close);
    expect(block).toMatch(/animation-duration:\s*0\.0*1m?s\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.0*1m?s\s*!important/);
  });
});

// ===========================================================================
// 6. Semantic roles / ARIA preserved on chat, trace, modal, form (Req 9.5)
// ===========================================================================
describe("Semantic roles and ARIA preserved (Req 9.5)", () => {
  it("chat + trace landmarks keep their roles/labels and live regions", () => {
    expect(INDEX_HTML).toContain('<main class="chat" aria-label="Chat">');
    expect(INDEX_HTML).toContain('aria-label="Run trace"');
    expect(INDEX_HTML).toContain('class="messages" id="messages" aria-live="polite"');
    expect(INDEX_HTML).toContain('id="phase-cards" role="list"');
  });

  it.each([
    "setup-wizard-modal",
    "provider-test-modal",
    "workspace-safety-modal",
    "approval-modal",
    "provider-config-modal",
    "appearance-modal",
  ])("modal %s keeps role=dialog, aria-modal and a labelledby title", (id) => {
    const idx = INDEX_HTML.indexOf(`id="${id}"`);
    expect(idx, `modal ${id} not found`).toBeGreaterThan(-1);
    const open = INDEX_HTML.lastIndexOf("<div", idx);
    const tag = INDEX_HTML.slice(open, INDEX_HTML.indexOf(">", idx) + 1);
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain("aria-labelledby=");
  });

  it("appearance radiogroups keep their roles for theme/accent/density/font-size", () => {
    expect(INDEX_HTML).toContain('id="appearance-theme-list" role="radiogroup"');
    expect(INDEX_HTML).toContain('id="appearance-accent-list" role="radiogroup"');
    expect(INDEX_HTML).toContain('id="appearance-density" role="radiogroup"');
    expect(INDEX_HTML).toContain('id="appearance-fontscale" role="radiogroup"');
  });
});

// ===========================================================================
// 7. Approval gating preserved (Req 8.4)
// ===========================================================================
describe("Approval gating preserved (Req 8.4)", () => {
  it("ships approve and deny actions disabled by default", () => {
    const approve = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="approval-approve"') - 40,
      INDEX_HTML.indexOf('id="approval-approve"') + 80,
    );
    const deny = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="approval-deny"') - 40,
      INDEX_HTML.indexOf('id="approval-deny"') + 80,
    );
    expect(approve).toContain("disabled");
    expect(deny).toContain("disabled");
  });

  it("renders the redacted operation-detail fields before a decision (target path, command, diff)", () => {
    expect(INDEX_HTML).toContain('id="approval-detail"');
    expect(INDEX_HTML).toContain('id="approval-target-path"');
    expect(INDEX_HTML).toContain('id="approval-command"');
    expect(INDEX_HTML).toContain('id="approval-diff"');
  });
});
