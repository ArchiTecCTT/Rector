// UI shell static-scan / no-build tests (task 2.4).
//
// These are STATIC-SCAN checks: they read the served client files verbatim
// (the same bytes express.static serves out of src/public) and assert on the
// text. There is no generative property-based library here — the design's
// Testing Strategy classifies Properties 4 and 5 as static/structural checks,
// not DOM or generative properties.
//
//   - Property 4: No external network calls — every <link>/<script>/src/href
//     and @font-face url() reference in index.html and base.css resolves to a
//     local path under src/public/, never to a CDN, remote host, or remote
//     font; icons are inline <svg> sprites (no icon font, no remote fetch).
//                                                       (Req 11.1, 11.2, 11.5)
//   - Property 5: No client build step — the document loads the raw files as
//     served (each <link>/<script> reference exists verbatim under src/public),
//     with no bundle/transpile/build artifact and no module import map.
//                                                       (Req 11.3)
//
// **Validates: Requirements 11.1, 11.2, 11.3, 11.5**
//
// Scan discipline (per task 2.4): only asset-bearing references are inspected —
// `href=`/`src=` attributes in markup and `url()`/`@import` in CSS. Non-asset
// uses of a remote-looking string (e.g. an SVG `xmlns="http://www.w3.org/2000/svg"`
// namespace declaration, or a `placeholder="https://api.example.com/v1"` form
// hint) are deliberately NOT flagged, because they neither load nor reference a
// remote resource.
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---- static asset helpers -------------------------------------------------

/** Absolute path to a file under the served src/public/ tree. */
function publicPath(relPath: string): string {
  return fileURLToPath(new URL(`../src/public/${relPath}`, import.meta.url));
}

function readPublic(relPath: string): string {
  return readFileSync(publicPath(relPath), "utf8");
}

const INDEX_HTML = readPublic("index.html");
const BASE_CSS = readPublic("styles/base.css");

/**
 * Remove inline <script> BODIES (keeping the opening/closing tags so a
 * `<script src=…>` attribute is still inspected) and HTML comments, so that JS
 * string literals like `var href = "styles/themes/" + theme` and commented-out
 * markup never masquerade as real asset references.
 */
function markupOnly(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(--!?>)/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*[^>]*>)/gi, "$1$2");
}

/** A reference is remote if it is absolute-with-scheme or protocol-relative. */
function isRemote(ref: string): boolean {
  const v = ref.trim();
  return /^https?:\/\//i.test(v) || /^\/\//.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
}

/** All `href="…"` / `src="…"` attribute values found in real markup. */
function assetRefs(html: string): string[] {
  const refs: string[] = [];
  const re = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  const cleaned = markupOnly(html);
  while ((m = re.exec(cleaned)) !== null) refs.push(m[2]);
  return refs;
}

/** All `url(…)` argument values found in a CSS source. */
function cssUrls(css: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) urls.push(m[2]);
  return urls;
}

/** `<use href="…">` references (SVG sprite references). */
function useRefs(html: string): string[] {
  const refs: string[] = [];
  const re = /<use\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) refs.push(m[2]);
  return refs;
}

// The five icon symbols the design defines once and references via <use>.
const ICON_SYMBOLS = ["i-gear", "i-cmd", "i-trace", "i-plus", "i-chevron"];

// ===========================================================================
// Property 4: No external network calls (Req 11.1, 11.2, 11.5)
// ===========================================================================
describe("Property 4: No external network calls", () => {
  it("index.html has no remote href/src asset reference", () => {
    const remote = assetRefs(INDEX_HTML).filter(isRemote);
    expect(remote, `remote href/src references: ${remote.join(", ")}`).toEqual([]);
  });

  it("every index.html href/src is a fragment, data URI, or local path under src/public", () => {
    for (const ref of assetRefs(INDEX_HTML)) {
      const v = ref.trim();
      expect(isRemote(v), `unexpected remote reference: ${v}`).toBe(false);
      if (v.startsWith("#") || v.startsWith("data:") || v === "") continue;
      const local = v.split(/[?#]/)[0];
      expect(
        existsSync(publicPath(local)),
        `referenced asset must exist verbatim under src/public: ${local}`,
      ).toBe(true);
    }
  });

  it("does not flag non-asset remote-looking strings (xmlns / placeholder)", () => {
    // Guard against an over-eager scanner: the file legitimately contains an
    // https URL inside a non-asset attribute (a form placeholder). It must NOT
    // appear among the inspected href/src asset references.
    expect(INDEX_HTML).toContain('placeholder="https://api.example.com/v1"');
    expect(assetRefs(INDEX_HTML).some((r) => {
      try {
        const url = new URL(r, "http://localhost");
        return url.hostname === "api.example.com";
      } catch {
        return false;
      }
    })).toBe(false);
  });

  it("base.css has no remote url() reference", () => {
    const remote = cssUrls(BASE_CSS).filter(isRemote);
    expect(remote, `remote url() references: ${remote.join(", ")}`).toEqual([]);
  });

  it("base.css declares no remote @font-face / @import source", () => {
    // No @import at all (and certainly none pointing at a remote stylesheet),
    // and any @font-face src must be local.
    expect(/@import\s+(?:url\()?\s*["']?https?:\/\//i.test(BASE_CSS)).toBe(false);
    const fontFaceBlocks = BASE_CSS.match(/@font-face\s*\{[^}]*\}/gi) ?? [];
    for (const block of fontFaceBlocks) {
      const remote = cssUrls(block).filter(isRemote);
      expect(remote, `remote @font-face src: ${remote.join(", ")}`).toEqual([]);
    }
  });

  it("icons are inline <svg> symbols referenced via local <use href=\"#…\"> (no icon font, no remote fetch)", () => {
    // The sprite defines each symbol once...
    for (const id of ICON_SYMBOLS) {
      expect(
        new RegExp(`<symbol\\b[^>]*\\bid\\s*=\\s*["']${id}["']`, "i").test(INDEX_HTML),
        `inline <symbol id="${id}"> must be defined`,
      ).toBe(true);
    }
    // ...and every <use> points at a local fragment (#…), never a remote URL.
    const uses = useRefs(INDEX_HTML);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref.startsWith("#"), `<use> must reference a local fragment, got: ${ref}`).toBe(true);
      expect(isRemote(ref)).toBe(false);
    }
    // No icon-font stylesheet links (e.g. Font Awesome / Material Icons).
    expect(/font-?awesome|material-icons|glyphicons/i.test(INDEX_HTML)).toBe(false);
  });
});

// ===========================================================================
// Property 5: No client build step (Req 11.3)
// ===========================================================================
describe("Property 5: No client build step", () => {
  it("loads the three client scripts as raw local files served verbatim", () => {
    const scriptSrcs = assetRefs(INDEX_HTML).filter((r) => /\.js(\?|#|$)/i.test(r));
    // theme.js, markdown.js, app.js are served as-is from src/public.
    for (const expected of ["theme.js", "markdown.js", "app.js"]) {
      expect(scriptSrcs).toContain(expected);
      expect(existsSync(publicPath(expected))).toBe(true);
    }
  });

  it("references no build artifact (bundle, dist output, or hashed chunk)", () => {
    const refs = assetRefs(INDEX_HTML).map((r) => r.split(/[?#]/)[0]);
    for (const ref of refs) {
      expect(/(^|\/)dist\//i.test(ref), `unexpected build-output path: ${ref}`).toBe(false);
      expect(/\bbundle\b/i.test(ref), `unexpected bundle reference: ${ref}`).toBe(false);
      // Hashed chunk names like app.4f3a9b2c.js are a build-tool fingerprint.
      expect(/\.[0-9a-f]{8,}\.(?:js|css)$/i.test(ref), `unexpected hashed chunk: ${ref}`).toBe(false);
    }
  });

  it("uses no module import map or remote ES-module loading", () => {
    expect(/type\s*=\s*["']importmap["']/i.test(INDEX_HTML)).toBe(false);
    // No <script type="module"> importing from a remote origin.
    const moduleScripts = INDEX_HTML.match(/<script\b[^>]*type\s*=\s*["']module["'][^>]*>/gi) ?? [];
    for (const tag of moduleScripts) {
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? "";
      expect(isRemote(src), `remote module script: ${src}`).toBe(false);
    }
  });

  it("links every stylesheet from a local path under src/public", () => {
    const cssLinks = assetRefs(INDEX_HTML).filter((r) => /\.css(\?|#|$)/i.test(r));
    expect(cssLinks.length).toBeGreaterThan(0);
    for (const href of cssLinks) {
      expect(isRemote(href)).toBe(false);
      expect(existsSync(publicPath(href.split(/[?#]/)[0]))).toBe(true);
    }
  });
});
