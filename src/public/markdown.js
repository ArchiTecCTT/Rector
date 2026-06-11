// ============================================================
// Rector — self-contained Markdown renderer (design B1, Req 6.3)
// ------------------------------------------------------------
// A tiny, dependency-free Markdown -> HTML renderer used to format
// ASSISTANT chat messages (Req 6.3). It has no build step, no modules,
// and no remote origins, matching app.js's <script src> loading style
// and theme.js's exposure pattern.
//
// SECURITY MODEL (XSS-safe — design B1):
//   * ALL source text is HTML-escaped FIRST (&, <, >, ", ') before any
//     markup is produced. Because the working string can no longer
//     contain raw < > " ', no constructed tag or attribute can be broken
//     out of by user input — attribute-breakout and html-injection
//     vectors are neutralized up front.
//   * Raw HTML in the source is therefore NEVER passed through; it is
//     rendered as visible, escaped text.
//   * Link hrefs are additionally scheme-checked: only http, https, and
//     mailto are allowed. Any other scheme (javascript:, data:, vbscript:,
//     etc.) is rejected and the link is rendered as plain escaped text
//     with no anchor.
//
// The renderer returns an HTML STRING. The caller assigns it via
// innerHTML; since the output is fully escaped/sanitized, that assignment
// is safe. Returning a string also makes the renderer unit-testable in a
// plain Node environment (no DOM/jsdom needed), like the theme tests.
//
// Exposure (consistent with theme.js):
//   * window.RectorMarkdown — { render, escapeHtml } singleton in browsers.
//   * module.exports         — same shape, for Node-based tests.
//
// Supported elements (design B1): headings, bold, italic, inline code,
// fenced code blocks, unordered + ordered lists, links, paragraphs.
// ============================================================

(function (global) {
  "use strict";

  // ---------- escaping ----------

  // Escape every HTML-significant character. This is the single most
  // important security primitive: it runs on ALL source text before any
  // markup is generated, so user input can never introduce a tag or break
  // out of an attribute. Order matters: & must be escaped first.
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- link href sanitization ----------

  // Allow only safe, well-known schemes. Anything else (javascript:, data:,
  // vbscript:, file:, etc.) is rejected. Relative and anchor links (no
  // scheme) are allowed. `raw` here is the ALREADY-ESCAPED url text.
  var SAFE_SCHEME = /^(https?:|mailto:)/i;
  // A bare scheme is "word characters followed by a colon" at the start.
  var HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

  function isSafeHref(escapedUrl) {
    // Strip leading whitespace and control chars that could disguise a scheme
    // (e.g. "java\tscript:"). Control chars are not valid in URLs anyway.
    var url = String(escapedUrl).replace(/[\u0000-\u0020]+/g, "");
    if (!url) return false;
    // The escaped form turns '&' into '&amp;' but leaves ':' intact, so scheme
    // detection is unaffected.
    if (HAS_SCHEME.test(url)) {
      return SAFE_SCHEME.test(url);
    }
    // No scheme -> relative URL / fragment / mailto-less path: allowed.
    // Reject protocol-relative "//host" to avoid surprise cross-origin nav.
    return url.indexOf("//") !== 0;
  }

  // ---------- inline rendering (operates on ESCAPED text) ----------

  // Placeholder markers protect already-rendered spans (code, links) from
  // later emphasis passes. NUL bytes never appear in escaped source text.
  var PH_OPEN = "\u0000";
  var PH_CLOSE = "\u0001";

  function renderInline(escaped) {
    var slots = [];

    function stash(html) {
      var token = PH_OPEN + slots.length + PH_CLOSE;
      slots.push(html);
      return token;
    }

    var out = escaped;

    // 1) Inline code spans `code` — highest precedence; their content is
    //    already escaped and must NOT receive emphasis processing.
    out = out.replace(/`([^`]+)`/g, function (_m, code) {
      return stash("<code>" + code + "</code>");
    });

    // 2) Links [text](url). The url is validated for a safe scheme; unsafe
    //    links degrade to their plain (escaped) text with no anchor. The
    //    link text may itself contain emphasis, so render it inline first.
    out = out.replace(
      /\[([^\]]*)\]\(([^)\s]*)\)/g,
      function (_m, text, url) {
        var label = renderInlineEmphasis(text);
        if (isSafeHref(url)) {
          return stash(
            '<a href="' +
              url +
              '" rel="noopener noreferrer nofollow" target="_blank">' +
              label +
              "</a>",
          );
        }
        // Unsafe scheme: drop the anchor, keep the visible text.
        return stash(label);
      },
    );

    // 3) Bold / italic on the remaining text.
    out = renderInlineEmphasis(out);

    // 4) Restore protected spans.
    out = out.replace(
      new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g"),
      function (_m, idx) {
        return slots[Number(idx)];
      },
    );

    return out;
  }

  // Bold then italic. Run on escaped text only. **/__ before */_ so the
  // double-marker isn't half-consumed by the single-marker pass.
  function renderInlineEmphasis(escaped) {
    return String(escaped)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>");
  }

  // ---------- block rendering ----------

  var HEADING = /^(#{1,6})\s+(.*)$/;
  var FENCE = /^```(.*)$/;
  var UL_ITEM = /^[ \t]*[-*+]\s+(.*)$/;
  var OL_ITEM = /^[ \t]*\d+[.)]\s+(.*)$/;
  var LANG_OK = /^[a-zA-Z0-9_+-]+$/;

  function render(source) {
    if (source === null || source === undefined) return "";
    var lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    var html = [];
    var i = 0;
    var paragraph = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      var text = paragraph.join(" ");
      html.push("<p>" + renderInline(escapeHtml(text)) + "</p>");
      paragraph = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block: ``` ... ``` — content is escaped verbatim, no
      // inline processing, so html injection inside a code block is shown
      // as literal text.
      var fence = FENCE.exec(line);
      if (fence) {
        flushParagraph();
        var lang = fence[1].trim();
        var codeLines = [];
        i += 1;
        while (i < lines.length && !FENCE.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        // Skip the closing fence if present.
        if (i < lines.length) i += 1;
        var classAttr = LANG_OK.test(lang)
          ? ' class="language-' + lang + '"'
          : "";
        html.push(
          "<pre><code" +
            classAttr +
            ">" +
            escapeHtml(codeLines.join("\n")) +
            "</code></pre>",
        );
        continue;
      }

      // Blank line -> paragraph boundary.
      if (/^\s*$/.test(line)) {
        flushParagraph();
        i += 1;
        continue;
      }

      // Heading.
      var heading = HEADING.exec(line);
      if (heading) {
        flushParagraph();
        var level = heading[1].length;
        html.push(
          "<h" +
            level +
            ">" +
            renderInline(escapeHtml(heading[2].trim())) +
            "</h" +
            level +
            ">",
        );
        i += 1;
        continue;
      }

      // Unordered list — consume consecutive UL items.
      if (UL_ITEM.test(line)) {
        flushParagraph();
        var ulItems = [];
        while (i < lines.length && UL_ITEM.test(lines[i])) {
          ulItems.push(UL_ITEM.exec(lines[i])[1]);
          i += 1;
        }
        html.push(renderList("ul", ulItems));
        continue;
      }

      // Ordered list — consume consecutive OL items.
      if (OL_ITEM.test(line)) {
        flushParagraph();
        var olItems = [];
        while (i < lines.length && OL_ITEM.test(lines[i])) {
          olItems.push(OL_ITEM.exec(lines[i])[1]);
          i += 1;
        }
        html.push(renderList("ol", olItems));
        continue;
      }

      // Otherwise accumulate into the current paragraph.
      paragraph.push(line.trim());
      i += 1;
    }

    flushParagraph();
    return html.join("\n");
  }

  function renderList(tag, items) {
    var li = items
      .map(function (item) {
        return "<li>" + renderInline(escapeHtml(item)) + "</li>";
      })
      .join("");
    return "<" + tag + ">" + li + "</" + tag + ">";
  }

  var RectorMarkdown = {
    render: render,
    escapeHtml: escapeHtml,
  };

  // Browser global, consistent with window.RectorTheme.
  global.RectorMarkdown = RectorMarkdown;

  // CommonJS export for Node-based tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RectorMarkdown;
  }
})(
  typeof window !== "undefined"
    ? window
    : typeof globalThis !== "undefined"
      ? globalThis
      : this,
);
