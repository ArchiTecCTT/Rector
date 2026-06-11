import { Mem0MemoryProvider } from "../../memory/mem0Adapter";
import { TiDBMemoryProvider } from "../../memory/tidbMemoryAdapter";
import { ChromaMemoryProvider } from "../../memory/chromaMemoryAdapter";
import type { MemoryProvider } from "../../memory/provider";
import type { MemoryProviderRecord } from "../../providers/memoryConfig";
import type { ResolveMemoryProviderOptions } from "../../providers/memoryBridge";
import { KindProviderRegistry } from "../providerRegistry";

const memoryProviderRegistry = new KindProviderRegistry<
  MemoryProviderRecord,
  MemoryProvider,
  ResolveMemoryProviderOptions
>();

function registerMemoryProviderModules(): void {
  memoryProviderRegistry.register("mem0", (record, secret, options) => {
    const provider = new Mem0MemoryProvider({
      id: record.id,
      kind: record.kind,
      label: record.label,
      apiKey: secret ?? "",
      config: record.config,
      now: options.now,
      run: options.run,
    });
    provider.validateConfig?.();
    return provider;
  });

  memoryProviderRegistry.register("tidb-memory", (record, secret, options) => {
    const provider = TiDBMemoryProvider.fromRecord(record, secret, {
      now: options.now,
      delegateStore: options.delegateStoreForLocalSqliteMem as
        | ConstructorParameters<typeof TiDBMemoryProvider>[0]["delegateStore"]
        | undefined,
    });
    provider.validateConfig?.();
    return provider;
  });

  memoryProviderRegistry.register("chroma", (record, secret, options) => {
    const provider = new ChromaMemoryProvider({
      id: record.id,
      kind: record.kind,
      label: record.label,
      config: record.config,
      apiKey: secret,
      now: options.now,
      run: options.run,
    });
    provider.validateConfig?.();
    return provider;
  });
}

registerMemoryProviderModules();

export function getMemoryProviderRegistry(): KindProviderRegistry<
  MemoryProviderRecord,
  MemoryProvider,
  ResolveMemoryProviderOptions
> {
  return memoryProviderRegistry;
}