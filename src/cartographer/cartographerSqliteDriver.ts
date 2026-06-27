import { dirname } from "node:path";

import { ensureRestrictedDir, ensureRestrictedFile } from "../security/filePermissions";
import { DEFAULT_SQLITE_PATH, createSqliteDriver, type SqlDriver } from "../store";

export type CartographerSqliteDriverOptions = {
  readonly driver?: SqlDriver;
  readonly path?: string;
};

/** Create or reuse a restricted SQLite driver for Cartographer persistence stores. */
export function createCartographerSqliteDriver(options: CartographerSqliteDriverOptions = {}): SqlDriver {
  const path = options.path ?? DEFAULT_SQLITE_PATH;
  if (options.driver) {
    return options.driver;
  }
  if (path !== ":memory:") ensureRestrictedDir(dirname(path));
  const driver = createSqliteDriver({ path });
  if (path !== ":memory:") ensureRestrictedFile(path);
  return driver;
}