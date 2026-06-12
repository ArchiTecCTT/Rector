import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { PERFORMANCE_BASELINE_SECTIONS } from "../scripts/performance-baseline";

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "GOOGLE_API_KEY",
  "MEM0_API_KEY",
  "CHROMA_URL",
  "CHROMA_API_KEY",
  "E2B_API_KEY",
] as const;

const DECOY_SECRETS = {
  OPENAI_API_KEY: "sk-decoy-openai-must-not-appear-in-output",
  ANTHROPIC_API_KEY: "sk-ant-decoy-must-not-appear",
  AZURE_OPENAI_API_KEY: "decoy-azure-key-must-not-appear",
} as const;

const SECRET_OUTPUT_PATTERNS = [
  /sk-decoy-openai-must-not-appear-in-output/,
  /sk-ant-decoy-must-not-appear/,
  /decoy-azure-key-must-not-appear/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /Bearer\s+sk-[A-Za-z0-9]{8,}/,
  /api_key=sk-[A-Za-z0-9]{8,}/,
];

describe("performance baseline script", () => {
  it("runs in local/provider-free mode with expected sections and no secret-like output", () => {
    // Cold subprocess + full benchmark suite can exceed the default 5s vitest timeout.
    const env = { ...process.env, ...DECOY_SECRETS };
    for (const key of PROVIDER_ENV_KEYS) {
      if (!(key in DECOY_SECRETS)) delete env[key];
    }

    const output = execFileSync("npm", ["run", "benchmark:performance"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const section of PERFORMANCE_BASELINE_SECTIONS) {
      expect(output).toContain(section);
    }

    expect(output).toContain("Rector performance baseline (local/provider-free)");
    expect(output).toContain("| Section | ms | preferred | acceptable | status |");

    for (const pattern of SECRET_OUTPUT_PATTERNS) {
      expect(output).not.toMatch(pattern);
    }
  }, 180_000);
});