import { strict as assert } from "node:assert";

import { add } from "./calculator";

/**
 * Standalone runnable verifier for the fixture repo (NOT a vitest spec — it lives outside the
 * `tests/**\/*.test.ts` glob and is invoked directly with `tsx`). It asserts the intended fixed
 * behaviour, so it FAILS (non-zero exit) against the committed buggy `add` until the bug is fixed,
 * which is exactly what the coding global scenario's validator command exercises.
 */
function main(): void {
  assert.equal(add(2, 3), 5, "add(2, 3) should equal 5");
  assert.equal(add(0, 0), 0, "add(0, 0) should equal 0");
  assert.equal(add(10, 5), 15, "add(10, 5) should equal 15");
  process.stdout.write("rector-mini-fix verifier: PASS\n");
}

main();
