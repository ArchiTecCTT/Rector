import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Task 4.2 — Connection-test action enablement property test.
 *
 * **Property 5: Connection-test action enablement**
 * **Validates: Requirements 2.1**
 *
 * For any subset of configured providers marked as selected, the connection-test
 * action SHALL be enabled if and only if exactly one provider is selected.
 *
 * `connectionTestEnabled(selectedIds)` is the pure enablement predicate factored
 * into the browser client (`src/public/app.js`) by task 4.1. That file is a
 * browser script that runs `init()` (touching `document`) on load, so it cannot
 * be imported into the node test environment directly. Instead we read the real
 * source, extract just the `connectionTestEnabled` function, and evaluate it in
 * isolation. This exercises the actual shipped predicate with zero DOM, network,
 * or provider calls.
 */

/**
 * Load the real `connectionTestEnabled` predicate out of the browser client
 * source without executing its DOM/init side effects.
 */
function loadConnectionTestEnabled(): (
  selectedIds: string[] | Set<string>,
) => boolean {
  const appJsPath = fileURLToPath(new URL("../src/public/app.js", import.meta.url));
  const source = readFileSync(appJsPath, "utf8");

  const match = source.match(
    /function connectionTestEnabled\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error(
      "Could not locate connectionTestEnabled in src/public/app.js — was it removed or renamed?",
    );
  }

  // Build a callable from the extracted function source. No module/global state
  // from app.js leaks in, so nothing browser-specific runs.
  const factory = new Function(`${match[0]}\nreturn connectionTestEnabled;`);
  return factory() as (selectedIds: string[] | Set<string>) => boolean;
}

// Provider ids the panel can select (mirror of PROVIDERS in src/public/app.js).
const PROVIDER_IDS = ["together", "cloudflare", "azure-openai"];

describe("connection-test action enablement (Property 5)", () => {
  const connectionTestEnabled = loadConnectionTestEnabled();

  // Feature: productization-alpha, Property 5: Connection-test action enablement
  it("is enabled iff exactly one provider is selected (array selection)", () => {
    fc.assert(
      fc.property(fc.subarray(PROVIDER_IDS), (selectedIds) => {
        const expected = selectedIds.length === 1;
        expect(connectionTestEnabled(selectedIds)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: productization-alpha, Property 5: Connection-test action enablement
  it("is enabled iff exactly one provider is selected (Set selection)", () => {
    fc.assert(
      fc.property(fc.subarray(PROVIDER_IDS), (selectedIds) => {
        // The panel holds the live selection in a Set; the predicate accepts
        // either form, so the same rule must hold for a Set.
        const selectedSet = new Set(selectedIds);
        const expected = selectedSet.size === 1;
        expect(connectionTestEnabled(selectedSet)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
