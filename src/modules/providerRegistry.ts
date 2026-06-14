export type ProviderFactory<TRecord, TProvider, TOptions, TExtra extends unknown[] = []> = (
  record: TRecord,
  secret: string | undefined,
  options: TOptions,
  ...extra: TExtra
) => TProvider;

/**
 * Maps persisted provider `kind` strings to factory functions (Chunk 040).
 * Replaces hardcoded switch statements in config/memory bridges.
 */
export class KindProviderRegistry<
  TRecord extends { kind: string },
  TProvider,
  TOptions,
  TExtra extends unknown[] = [],
> {
  private readonly factories = new Map<string, ProviderFactory<TRecord, TProvider, TOptions, TExtra>>();

  register(
    kind: string,
    factory: ProviderFactory<TRecord, TProvider, TOptions, TExtra>,
  ): void {
    if (this.factories.has(kind)) {
      throw new Error(`Provider factory already registered for kind: ${kind}`);
    }
    this.factories.set(kind, factory);
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }

  build(
    record: TRecord,
    secret: string | undefined,
    options: TOptions,
    ...extra: TExtra
  ): TProvider | undefined {
    const factory = this.factories.get(record.kind);
    if (!factory) return undefined;
    return factory(record, secret, options, ...extra);
  }
}