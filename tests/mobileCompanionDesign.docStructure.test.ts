// Doc-structure test for the Mobile_Companion_Design document
// (docs/design/mobile-companion.md, authored by task 12.3).
//
// This is a pure document-structure test: it reads the version-controlled
// design-only Markdown file from disk and asserts that every section the
// requirements mandate is present. It makes ZERO network and ZERO provider
// calls — it only reads a tracked file.
//
// Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DOC_PATH = fileURLToPath(new URL("../docs/design/mobile-companion.md", import.meta.url));
const doc = readFileSync(DOC_PATH, "utf8");
const lowerDoc = doc.toLowerCase();

describe("Mobile_Companion_Design doc structure", () => {
  it("declares itself a design-only document (no mobile client code shipped)", () => {
    expect(lowerDoc).toContain("design-only");
  });

  // Requirement 10.1: document each of the five control-surface capabilities.
  describe("control-surface capabilities (Req 10.1)", () => {
    it("has a capabilities section", () => {
      expect(doc).toMatch(/##+\s*Control-surface capabilities/i);
    });

    const capabilities: Array<[string, RegExp]> = [
      ["send instructions to an agent", /send\s+instructions?\s+to\s+an\s+agent/i],
      ["monitor run status", /monitor\s+run\s+status/i],
      ["approve or deny risky operations", /approve\s+or\s+deny\s+risky\s+operations/i],
      ["receive run-completion notifications", /run[-\s]completion\s+notifications?/i],
      ["read run summaries", /read\s+run\s+summaries/i],
    ];

    it.each(capabilities)("documents the '%s' capability", (_label, pattern) => {
      expect(doc).toMatch(pattern);
    });
  });

  // Requirement 10.2: the mobile client executes no local workspace code.
  it("states the mobile client executes no local workspace code (Req 10.2)", () => {
    expect(doc).toMatch(/##+\s*No local execution/i);
    expect(lowerDoc).toContain("executes no local workspace code");
    // The specific forbidden classes of local execution are enumerated.
    expect(lowerDoc).toContain("no shell commands");
    expect(lowerDoc).toContain("no file-system writes");
    expect(lowerDoc).toMatch(/no build or test execution/i);
  });

  // Requirement 10.3: communicates only with the desktop app or hosted relay,
  // never directly with the local workspace.
  it("specifies the desktop/relay-only communication boundary (Req 10.3)", () => {
    expect(doc).toMatch(/##+\s*Communication boundary/i);
    expect(lowerDoc).toContain("desktop application");
    expect(lowerDoc).toContain("hosted relay");
    expect(lowerDoc).toMatch(/never communicates directly with the local workspace/i);
  });

  // Requirement 10.4: each named risk has a description and a mitigation or an
  // explicit residual-risk statement.
  describe("security risks and mitigations (Req 10.4)", () => {
    it("has a risks section", () => {
      expect(doc).toMatch(/##+\s*Security risks and mitigations/i);
    });

    const namedRisks = ["Stolen device", "Relay compromise", "Prompt injection", "Approval spoofing"];

    it.each(namedRisks)("names the '%s' risk with a description and mitigation/residual-risk", (risk) => {
      // The risk must appear as its own heading.
      const headingPattern = new RegExp(`###+\\s*Risk:\\s*${risk}`, "i");
      expect(doc).toMatch(headingPattern);

      // Isolate the risk's section so the description/mitigation assertions are
      // scoped to that risk rather than satisfied by another section.
      const sectionStart = doc.search(headingPattern);
      expect(sectionStart).toBeGreaterThanOrEqual(0);
      const rest = doc.slice(sectionStart + 1);
      const nextHeading = rest.search(/\n###+\s/);
      const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).toLowerCase();

      expect(section).toContain("description");
      expect(section).toMatch(/mitigation|residual risk/);
    });
  });

  // Requirement 10.5: approvals routed through the Approval_Flow and recorded
  // in the Event_Log.
  it("routes approvals through the Approval_Flow and Event_Log (Req 10.5)", () => {
    expect(doc).toMatch(/##+\s*Approval routing/i);
    expect(doc).toContain("Approval_Flow");
    expect(doc).toContain("Event_Log");
    // The decision must be recorded before the operation acts.
    expect(lowerDoc).toMatch(/recorded in the[\s\S]{0,40}event_log[\s\S]{0,40}before/i);
  });

  // Requirement 10.6: an explicit, enumerated list of non-goals.
  it("enumerates an explicit list of non-goals (Req 10.6)", () => {
    expect(doc).toMatch(/##+\s*Non-goals/i);

    // Scope to the non-goals section and assert it is an enumerated list
    // with at least two items.
    const headingPattern = /##+\s*Non-goals/i;
    const start = doc.search(headingPattern);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + 1);
    const nextHeading = rest.search(/\n##+\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const enumeratedItems = section.match(/^\s*\d+\.\s+\S/gm) ?? [];
    expect(enumeratedItems.length).toBeGreaterThanOrEqual(2);
  });
});
