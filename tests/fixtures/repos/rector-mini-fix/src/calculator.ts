export function add(a: number, b: number): number {
  // BUG (intentional fixture defect): subtracts instead of adding. The coding scenario's
  // to-be-fixed state is `return a + b;`. The verifier below fails until this is corrected.
  return a - b;
}
