// Unit tests for the self-contained Markdown renderer (src/public/markdown.js,
// task 10). The renderer formats ASSISTANT chat messages (Req 6.3) and must be
// XSS-safe (design B1): all source text is escaped before any markup is built,
// raw HTML never passes through, and link hrefs are scheme-restricted.
//
// markdown.js is a dependency-free browser script. We import it for its global
// side-effect (in Node it assigns globalThis.RectorMarkdown / module.exports)
// and assert on the returned HTML STRING — no jsdom, no network, deterministic.
import { beforeAll, describe, expect, it } from "vitest";

import "../src/public/markdown.js";

type Markdown = {
  render: (src: unknown) => string;
  escapeHtml: (value: unknown) => string;
};

let md: Markdown;

beforeAll(() => {
  md = (globalThis as unknown as { RectorMarkdown: Markdown }).RectorMarkdown;
  expect(typeof md).toBe("object");
  expect(typeof md.render).toBe("function");
  expect(typeof md.escapeHtml).toBe("function");
});

// ===========================================================================
// 1. Supported elements (design B1)
// ===========================================================================
describe("Markdown element rendering", () => {
  it("renders ATX headings h1..h6", () => {
    expect(md.render("# Title")).toBe("<h1>Title</h1>");
    expect(md.render("### Three")).toBe("<h3>Three</h3>");
    expect(md.render("###### Six")).toBe("<h6>Six</h6>");
  });

  it("renders bold (** and __)", () => {
    expect(md.render("**bold**")).toBe("<p><strong>bold</strong></p>");
    expect(md.render("__bold__")).toBe("<p><strong>bold</strong></p>");
  });

  it("renders italic (* and _)", () => {
    expect(md.render("*it*")).toBe("<p><em>it</em></p>");
    expect(md.render("_it_")).toBe("<p><em>it</em></p>");
  });

  it("renders inline code", () => {
    expect(md.render("use `npm test` now")).toBe(
      "<p>use <code>npm test</code> now</p>",
    );
  });

  it("renders fenced code blocks with an optional language class", () => {
    expect(md.render("```\nplain\n```")).toBe(
      "<pre><code>plain</code></pre>",
    );
    expect(md.render("```ts\nconst x = 1;\n```")).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  it("renders unordered lists", () => {
    expect(md.render("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md.render("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders ordered lists", () => {
    expect(md.render("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders links with a safe http(s) href", () => {
    expect(md.render("[Rector](https://example.com)")).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">Rector</a></p>',
    );
  });

  it("renders mailto links", () => {
    expect(md.render("[mail](mailto:a@b.com)")).toContain(
      'href="mailto:a@b.com"',
    );
  });

  it("groups consecutive text lines into a single paragraph", () => {
    expect(md.render("line one\nline two")).toBe("<p>line one line two</p>");
  });

  it("separates paragraphs on a blank line", () => {
    expect(md.render("one\n\ntwo")).toBe("<p>one</p>\n<p>two</p>");
  });

  it("combines emphasis inside list items and headings", () => {
    expect(md.render("# A **bold** title")).toBe(
      "<h1>A <strong>bold</strong> title</h1>",
    );
    expect(md.render("- item with `code`")).toBe(
      "<ul><li>item with <code>code</code></li></ul>",
    );
  });

  it("returns an empty string for empty/nullish input", () => {
    expect(md.render("")).toBe("");
    expect(md.render(null)).toBe("");
    expect(md.render(undefined)).toBe("");
  });
});

// ===========================================================================
// 2. Escaping primitive (Req 6.3, design B1)
// ===========================================================================
describe("escapeHtml", () => {
  it("escapes &, <, >, \", and '", () => {
    expect(md.escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes ampersand before other entities (no double-escape gaps)", () => {
    expect(md.escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});

// ===========================================================================
// 3. XSS vectors — all input is escaped before insertion (design B1)
// ===========================================================================
describe("XSS safety", () => {
  it("escapes raw <script> tags in plain text (no html passthrough)", () => {
    const out = md.render("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes html injected inside fenced code blocks", () => {
    const out = md.render("```\n<img src=x onerror=alert(1)>\n```");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // Still wrapped as a code block.
    expect(out.startsWith("<pre><code>")).toBe(true);
  });

  it("escapes html injected inside inline code", () => {
    const out = md.render("text `<b>x</b>` more");
    expect(out).not.toContain("<b>");
    expect(out).toContain("<code>&lt;b&gt;x&lt;/b&gt;</code>");
  });

  it("rejects javascript: link hrefs and keeps only the escaped text", () => {
    const out = md.render("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a ");
    expect(out).toContain("click");
  });

  it("rejects data: and vbscript: schemes", () => {
    expect(md.render("[x](data:text/html,<script>1</script>)")).not.toContain(
      "<a ",
    );
    expect(md.render("[x](vbscript:msgbox(1))")).not.toContain("<a ");
  });

  it("rejects obfuscated schemes with embedded whitespace/control chars", () => {
    const out = md.render("[x](java\tscript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toMatch(/javascript:/i);
  });

  it("prevents attribute breakout in link hrefs via quotes", () => {
    // A double quote in the URL would otherwise close the href attribute.
    const out = md.render('[x](https://a.com" onmouseover="alert(1))');
    expect(out).not.toContain('"http');
    expect(out).not.toContain("onmouseover=\"alert");
    // The quote is escaped, so it cannot terminate the attribute.
    expect(out).toContain("&quot;");
  });

  it("never emits a raw double-quote that could break an attribute", () => {
    const out = md.render('paragraph with a " quote and <tag>');
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;tag&gt;");
    expect(out).not.toContain("<tag>");
  });

  it("allows relative links but rejects protocol-relative ones", () => {
    expect(md.render("[doc](/docs/readme)")).toContain('href="/docs/readme"');
    expect(md.render("[x](//evil.example)")).not.toContain("<a ");
  });
});
