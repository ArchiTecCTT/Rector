import { z } from "zod";
import { TruthItemSchema, TruthSearchInputSchema, TruthSearchResultSchema, type TruthItem, type TruthSearchInput, type TruthSearchResult } from "./truthLibrary";

export const SemanticAdapterProviderSchema = z.enum(["chroma", "algolia"]);
export type SemanticAdapterProvider = z.infer<typeof SemanticAdapterProviderSchema>;

export const SemanticAdapterUpsertResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  networkCalls: z.literal(0),
});
export type SemanticAdapterUpsertResult = z.infer<typeof SemanticAdapterUpsertResultSchema>;

export interface SemanticMemorySearchAdapter {
  readonly provider: SemanticAdapterProvider;
  readonly displayName: string;
  readonly networkEnabled: false;
  upsert(items: TruthItem[]): Promise<SemanticAdapterUpsertResult>;
  search(input: TruthSearchInput): Promise<TruthSearchResult[]>;
}

export interface ChromaMemoryAdapterOptions {
  collectionName?: string;
}

export interface AlgoliaSearchAdapterOptions {
  indexName?: string;
}

export class ChromaMemoryAdapter implements SemanticMemorySearchAdapter {
  readonly provider = "chroma" as const;
  readonly displayName = "Chroma Memory Adapter Stub";
  readonly networkEnabled = false;
  readonly collectionName: string;

  constructor(options: ChromaMemoryAdapterOptions = {}) {
    this.collectionName = options.collectionName ?? "rector-memory";
  }

  async upsert(items: TruthItem[]): Promise<SemanticAdapterUpsertResult> {
    for (const item of items) TruthItemSchema.parse(item);
    return SemanticAdapterUpsertResultSchema.parse({ accepted: 0, skipped: items.length, networkCalls: 0 });
  }

  async search(input: TruthSearchInput): Promise<TruthSearchResult[]> {
    TruthSearchInputSchema.parse(input);
    return z.array(TruthSearchResultSchema).parse([]);
  }
}

export class AlgoliaSearchAdapter implements SemanticMemorySearchAdapter {
  readonly provider = "algolia" as const;
  readonly displayName = "Algolia Search Adapter Stub";
  readonly networkEnabled = false;
  readonly indexName: string;

  constructor(options: AlgoliaSearchAdapterOptions = {}) {
    this.indexName = options.indexName ?? "rector-memory";
  }

  async upsert(items: TruthItem[]): Promise<SemanticAdapterUpsertResult> {
    for (const item of items) TruthItemSchema.parse(item);
    return SemanticAdapterUpsertResultSchema.parse({ accepted: 0, skipped: items.length, networkCalls: 0 });
  }

  async search(input: TruthSearchInput): Promise<TruthSearchResult[]> {
    TruthSearchInputSchema.parse(input);
    return z.array(TruthSearchResultSchema).parse([]);
  }
}
