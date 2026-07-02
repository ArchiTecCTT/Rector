import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultRuntimeSettings } from "../../src/config/runtimeSettings";
import { PROVIDER_CONFIG_VERSION } from "../../src/providers/config";
import {
  buildRepoLiveProviderDiscoveryOptions,
  discoverLiveProviderFromRepo,
} from "../../src/live/repoLiveProviderDiscovery";

const GENERATED_AT = "2026-06-30T00:00:00.000Z";
const SECRET = "sk-zai-secret-1234567890";

describe("repo live provider discovery", () => {
  it("buildRepoLiveProviderDiscoveryOptions wires configured-product stores under repo .rector", () => {
    const options = buildRepoLiveProviderDiscoveryOptions("/tmp/rector-repo");
    expect(options.runtimeSettingsStore).toBeDefined();
    expect(options.providerConfigStore).toBeDefined();
    expect(options.secretStore).toBeDefined();
  });

  it("discovers Z.ai from configured-product files when env coordinates are partial", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "rector-repo-discovery-"));
    try {
      const rectorDir = path.join(repoRoot, ".rector");
      await mkdir(rectorDir, { recursive: true });
      await writeFile(
        path.join(rectorDir, "runtime-settings.json"),
        `${JSON.stringify({
          ...defaultRuntimeSettings(GENERATED_AT),
          orchestrationProfile: "configured",
          updatedAt: GENERATED_AT,
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(rectorDir, "providers.json"),
        `${JSON.stringify({
          version: PROVIDER_CONFIG_VERSION,
          activeRoutes: { slm: "openai-compatible:zai" },
          providers: [
            {
              id: "openai-compatible:zai",
              kind: "openai-compatible",
              label: "Z.ai",
              baseUrl: "https://api.z.ai/api/paas/v4",
              model: "glm-4.5",
              secretRef: "secret:zai",
              createdAt: GENERATED_AT,
              updatedAt: GENERATED_AT,
            },
          ],
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(rectorDir, "secret.key"),
        `${JSON.stringify({
          key: Buffer.alloc(32, 7).toString("hex"),
          version: "v2",
          createdAt: GENERATED_AT,
        }, null, 2)}\n`,
        "utf8",
      );

      const { createLocalSecretStore } = await import("../../src/security/secretStore");
      const key = Buffer.alloc(32, 7);
      const secretStore = createLocalSecretStore({
        filePath: path.join(rectorDir, "secrets.enc"),
        encryptionKey: key,
      });
      await secretStore.setSecret("secret:zai", SECRET);

      const result = await discoverLiveProviderFromRepo(repoRoot, {
        RECTOR_LIVE_PROVIDER: "zai",
        OPENAI_COMPATIBLE_API_KEY: SECRET,
      });

      expect(result.selected).toMatchObject({
        providerId: "openai-compatible:zai",
        source: "runtime-settings",
        host: "api.z.ai",
        liveEvidence: true,
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});