import { defineConfig } from "vitest/config";

const NODE_SQLITE_SHIM_ID = "\0virtual:node-sqlite-shim";

export default defineConfig({
  plugins: [
    {
      // `node:sqlite` is a Node built-in (used by the local SQLite driver) that
      // the bundled Vite resolver does not recognize, so it tries to load a
      // bare `sqlite` module and fails. Resolve it to a virtual shim that loads
      // the real built-in at runtime via `createRequire`, leaving all source
      // code untouched.
      name: "externalize-node-sqlite",
      enforce: "pre",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") {
          return NODE_SQLITE_SHIM_ID;
        }
        return null;
      },
      load(id) {
        if (id === NODE_SQLITE_SHIM_ID) {
          return [
            'import { createRequire } from "node:module";',
            "const require = createRequire(import.meta.url);",
            'const sqlite = require("node:sqlite");',
            "export const DatabaseSync = sqlite.DatabaseSync;",
            "export default sqlite;",
          ].join("\n");
        }
        return null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
