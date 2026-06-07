import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Doc-structure test: Desktop_Shell_Decision (docs/deployment/desktop-shell-decision.md)
// Validates: Requirements 6.1, 6.2, 6.3, 6.4
//
// This is a structure check over a design-only document (per the design's
// Testing Strategy: the Desktop Shell document is covered by doc-structure
// checks, not property tests). It reads the committed Markdown from disk and
// asserts the required sections and content are present. It performs no network
// or provider calls.
// ---------------------------------------------------------------------------

const DOC_PATH = "docs/deployment/desktop-shell-decision.md";
const doc = readFileSync(DOC_PATH, "utf8");
const docLower = doc.toLowerCase();

// The six assessment factors required by Requirement 6.2. Each entry lists the
// accepted phrasings so the assertion is resilient to minor wording choices
// while still requiring the concept to be documented.
const ASSESSMENT_FACTORS: ReadonlyArray<{ name: string; patterns: RegExp[] }> = [
  { name: "packaging complexity", patterns: [/packaging complexity/i] },
  {
    name: "local server lifecycle management",
    patterns: [/local server lifecycle/i],
  },
  {
    name: "native folder picker support",
    patterns: [/native folder picker/i, /folder picker/i],
  },
  { name: "secure secret storage", patterns: [/secure secret storage/i, /secret storage/i] },
  { name: "auto-update path", patterns: [/auto-?update/i] },
];

function sectionBody(headingPattern: RegExp): string {
  const lines = doc.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line) && headingPattern.test(line));
  if (startIndex === -1) return "";
  const startLevel = (lines[startIndex].match(/^#+/)?.[0].length ?? 1);
  const body: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch && headingMatch[1].length <= startLevel) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

describe("Desktop_Shell_Decision document structure", () => {
  it("exists with non-trivial content", () => {
    expect(doc.trim().length).toBeGreaterThan(200);
  });

  // Requirement 6.1: state exactly one recommended shell from {Tauri, Electron}.
  describe("Requirement 6.1 — single recommended shell", () => {
    it("has a Recommendation section", () => {
      expect(doc).toMatch(/^#{1,6}\s+Recommendation\s*$/m);
    });

    it("recommends exactly one shell technology (Tauri or Electron)", () => {
      const recommendation = sectionBody(/^#{1,6}\s+Recommendation\s*$/);
      expect(recommendation.trim().length).toBeGreaterThan(0);

      // Bind a selection verb directly to the technology name so that an
      // adjacent mention of the alternative (e.g. "Electron was assessed as
      // the serious alternative") is not miscounted as a recommendation. We
      // collect the distinct shells named in a selection statement and assert
      // exactly one shell is selected.
      const selectionPatterns: RegExp[] = [
        /\b(?:built with|recommend(?:s|ed)?|choose|chose|chosen|select(?:s|ed)?)\s+(Tauri|Electron)\b/gi,
        /\b(Tauri|Electron)\s+(?:is|was|will be)\s+(?:the\s+)?(?:selected|recommended|chosen|built)\b/gi,
      ];

      const selected = new Set<string>();
      for (const pattern of selectionPatterns) {
        for (const match of recommendation.matchAll(pattern)) {
          selected.add(match[1].toLowerCase());
        }
      }

      expect([...selected]).toHaveLength(1);
    });
  });

  // Requirement 6.2: document, for BOTH Tauri and Electron, an assessment of
  // packaging, local server lifecycle, native folder picker, secure secret
  // storage, auto-update, and Windows/macOS/Linux platform concerns.
  describe("Requirement 6.2 — assessment factors for both candidates", () => {
    it("contains an Assessment section covering both Tauri and Electron", () => {
      expect(doc).toMatch(/^#{1,6}\s+Assessment\s*$/m);
      const assessment = sectionBody(/^#{1,6}\s+Assessment\s*$/);
      expect(assessment).toMatch(/tauri/i);
      expect(assessment).toMatch(/electron/i);
    });

    it.each(ASSESSMENT_FACTORS)("documents the '$name' factor", ({ patterns }) => {
      expect(patterns.some((pattern) => pattern.test(doc))).toBe(true);
    });

    it("documents Windows, macOS, and Linux platform concerns", () => {
      expect(docLower).toContain("windows");
      expect(docLower).toContain("macos");
      expect(docLower).toContain("linux");
    });
  });

  // Requirement 6.3: the rationale references the documented assessment factors
  // for the recommended technology.
  describe("Requirement 6.3 — rationale references assessment factors", () => {
    it("has a Rationale section", () => {
      expect(doc).toMatch(/^#{1,6}\s+Rationale\s*$/m);
    });

    it("references at least two assessment factors in the rationale", () => {
      const rationale = sectionBody(/^#{1,6}\s+Rationale\s*$/);
      expect(rationale.trim().length).toBeGreaterThan(0);

      const referencedFactors = ASSESSMENT_FACTORS.filter(({ patterns }) =>
        patterns.some((pattern) => pattern.test(rationale)),
      );
      expect(referencedFactors.length).toBeGreaterThanOrEqual(2);
    });
  });

  // Requirement 6.4: include either a minimal prototype path, or a documented
  // reason the prototype was deferred.
  describe("Requirement 6.4 — prototype path or deferral reason", () => {
    it("documents a minimal prototype path or a deferral reason", () => {
      const hasPrototypePath = /^#{1,6}\s+.*prototype.*$/im.test(doc);
      const hasDeferral = /defer/i.test(doc);

      expect(hasPrototypePath || hasDeferral).toBe(true);
    });

    it("the prototype/deferral content is non-empty", () => {
      const prototypeBody = sectionBody(/prototype/i);
      const deferralBody = sectionBody(/defer/i);
      expect((prototypeBody + deferralBody).trim().length).toBeGreaterThan(0);
    });
  });
});
