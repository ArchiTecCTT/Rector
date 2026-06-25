# rector-mini-fix

A tiny real fixture repository used by the Phase 0.5 global reliability scenarios.

It deliberately ships a one-line bug in `src/calculator.ts` (`add` subtracts instead of
adds). The standalone verifier `src/calculator.verify.ts` asserts the intended behaviour
and therefore fails (non-zero exit) against the buggy source until the bug is fixed.

Run the verifier directly:

```bash
npx tsx tests/fixtures/repos/rector-mini-fix/src/calculator.verify.ts
```

This fixture is offline and model-free. Scenarios reference it via the `workspace` field.
