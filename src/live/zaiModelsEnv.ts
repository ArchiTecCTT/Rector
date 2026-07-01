export function parseZaiModelsList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function dedupeZaiModelsPreserveOrder(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const model of models) {
    const key = model.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}