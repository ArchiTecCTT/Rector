import { describe } from "vitest";

import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { Mem0MemoryProvider } from "../src/memory/mem0Adapter";
import { LocalMemoryProvider } from "../src/memory/provider";
import { TiDBMemoryProvider } from "../src/memory/tidbMemoryAdapter";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "../src/store";
import {
  createFakeChromaClient,
  createFakeMem0Client,
  createMysqlDialectSqliteDriver,
  fixedNow,
  runMemoryProviderContractSuite,
} from "./support/memoryProviderContract";

describe("shared MemoryProvider contract — local in-memory", () => {
  runMemoryProviderContractSuite(
    () =>
      new LocalMemoryProvider({
        id: "local-inmemory:contract",
        kind: "local-inmemory",
        now: fixedNow,
      }),
    { localNoNetwork: true },
  );
});

describe("shared MemoryProvider contract — local SQL delegate", () => {
  const openDrivers = new Set<SqlDriver>();
  runMemoryProviderContractSuite(
    () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      openDrivers.add(driver);
      return new LocalMemoryProvider({
        id: "local-sqlite-mem:contract",
        kind: "local-sqlite-mem",
        now: fixedNow,
        delegate: new SqlRectorStore({ driver, now: fixedNow }),
      });
    },
    {
      localNoNetwork: true,
      close: () => {
        for (const driver of openDrivers) driver.close();
        openDrivers.clear();
      },
    },
  );
});

describe("shared MemoryProvider contract — TiDB provider injected delegate", () => {
  const openDrivers = new Set<SqlDriver>();
  runMemoryProviderContractSuite(
    () => {
      const driver = createMysqlDialectSqliteDriver();
      openDrivers.add(driver);
      return new TiDBMemoryProvider({
        id: "tidb-memory:contract",
        delegateStore: new SqlRectorStore({ driver, now: fixedNow }),
      });
    },
    {
      close: () => {
        for (const driver of openDrivers) driver.close();
        openDrivers.clear();
      },
    },
  );
});

describe("shared MemoryProvider contract — Mem0 fake client", () => {
  runMemoryProviderContractSuite(
    () =>
      new Mem0MemoryProvider({
        id: "mem0:contract",
        apiKey: "test-key",
        now: fixedNow,
        clientFactory: () => createFakeMem0Client(),
      }),
  );
});

describe("shared MemoryProvider contract — Chroma fake client", () => {
  runMemoryProviderContractSuite(
    () =>
      new ChromaMemoryProvider({
        id: "chroma:contract",
        config: { baseUrl: "http://localhost:8000" },
        apiKey: "test-key",
        now: fixedNow,
        clientFactory: () => createFakeChromaClient(),
      }),
  );
});
