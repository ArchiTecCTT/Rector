/**
 * Greeting-set routing unit tests (task 3.3, ORN-57).
 *
 * Example-based coverage for the explicit vague-greeting set in
 * `triageUserMessage` (`src/orchestration/triage.ts`). Per Requirement 3.1, a
 * user message that consists solely of a bare greeting ("Hello", "hi",
 * "What's up", etc.) carries no task detail and SHALL be classified as
 * `NEEDS_CLARIFICATION`.
 *
 * Everything is pure and in-memory: `triageUserMessage` is a deterministic
 * classifier. No provider, network, or API key is used.
 *
 * _Requirements: 3.1_
 */
import { describe, it, expect } from "vitest";

import { triageUserMessage, TRIAGE_ROUTES } from "../src/orchestration/triage";

/**
 * The explicit vague-greeting set. The first three are the exemplars named
 * verbatim in Requirement 3.1 ("Hello", "hi", "What's up"); the remainder
 * exercise the supported greeting variants, casing, repeated letters, and
 * trailing punctuation that the classifier strips before matching.
 */
const VAGUE_GREETINGS = [
  // Named exemplars (Req 3.1).
  "Hello",
  "hi",
  "What's up",
  // Casing and punctuation variants.
  "HELLO",
  "Hello!",
  "Hi.",
  "hey",
  "Hey!",
  "What's up?",
  "Whats up",
  "Wassup",
  "sup",
  // Greeting phrases.
  "Hi there",
  "Hello there",
  "Good morning",
  "Good afternoon",
  "Good evening",
  "How are you",
  "How's it going?",
  "How do you do",
  // Repeated-letter / casual spellings.
  "hiii",
  "heyyy",
  "yo",
  "howdy",
  "greetings",
];

describe("triageUserMessage — explicit greeting set routes to NEEDS_CLARIFICATION (Req 3.1)", () => {
  for (const greeting of VAGUE_GREETINGS) {
    it(`classifies ${JSON.stringify(greeting)} as NEEDS_CLARIFICATION`, () => {
      const result = triageUserMessage(greeting);
      expect(result.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
    });
  }

  it("flags the greeting set as an ambiguous request with a non-empty reason", () => {
    for (const greeting of VAGUE_GREETINGS) {
      const result = triageUserMessage(greeting);
      expect(result.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
      expect(result.riskFlags).toContain("ambiguous_request");
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("triageUserMessage — a greeting carrying real task detail is not treated as vague", () => {
  // A greeting prefix followed by an actual task should route somewhere other
  // than NEEDS_CLARIFICATION, confirming the greeting set matches only bare
  // greetings and does not swallow substantive requests.
  const detailedMessages = [
    "Hello, please implement pagination in src/api/server.ts",
    "Hi, can you explain what a discriminated union is?",
  ];

  for (const message of detailedMessages) {
    it(`does not classify ${JSON.stringify(message)} as a vague greeting`, () => {
      const result = triageUserMessage(message);
      expect(result.route).not.toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
    });
  }
});
