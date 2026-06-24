import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  GLOBAL_SCENARIO_SCHEMA_VERSION,
  GlobalScenarioSchema,
  GlobalValidatorSchema,
  SafeRelativePathSchema,
  loadGlobalScenario,
} from "../../src/evals/globalScenarioSchema";

const SCENARIO_YAML = `schemaVersion: rector.global-scenario.v1
id: coding-memory-patch-001
title: Patch the memory promotion bug
type: coding
workspace: fixtures/repos/rector-mini-bug
userGoal: Fix the failing memory promotion path so the targeted test passes.
allowedSystems: [coding]
forbiddenSystems: [research, writing, design]
expectedSpecialist: coding
successCriteria:
  - targeted test passes
validators:
  - id: memory-promotion-test
    cmd: npm
    args: ["test", "--", "memoryPromotion.test.ts"]
    timeoutMs: 120000
oracles:
  mustChange:
    - src/memory/promotion.ts
  mustNotChange:
    - src/protocol/events.ts
  mustIncludeEvidence:
    - cartographer.grounding
budgets:
  maxToolCalls: 30
  maxRuntimeMs: 900000
  maxMainModelRawToolTokens: 1000
expected:
  status: passed
  changedPaths:
    - src/memory/promotion.ts
  unchangedPaths:
    - src/protocol/events.ts
  evidenceRefs:
    - cartographer.grounding
`;

function baseValidator(overrides: Partial<{ id: string; cmd: string; args: string[]; cwd: string; timeoutMs: number; expectedExitCode: number }> = {}): unknown {
  return {
    id: "v1",
    cmd: "node",
    args: ["-e", "process.exit(0)"],
    timeoutMs: 60000,
    ...overrides,
  };
}

describe("GlobalScenarioSchema", () => {
  it("round-trips a real inline scenario yaml into a typed object", () => {
    // Given: a scenario authored in the plan's exact YAML format with structured validators.
    // When: it is loaded through the YAML path.
    const scenario = loadGlobalScenario(SCENARIO_YAML, "yaml");

    // Then: every field is parsed with the declared types and defaults (cwd ".", expectedExitCode 0).
    expect(scenario.schemaVersion).toBe(GLOBAL_SCENARIO_SCHEMA_VERSION);
    expect(scenario.id).toBe("coding-memory-patch-001");
    expect(scenario.type).toBe("coding");
    expect(scenario.allowedSystems).toEqual(["coding"]);
    expect(scenario.forbiddenSystems).toEqual(["research", "writing", "design"]);
    expect(scenario.expectedSpecialist).toBe("coding");
    expect(scenario.successCriteria).toEqual(["targeted test passes"]);
    expect(scenario.validators).toEqual([
      { id: "memory-promotion-test", cmd: "npm", args: ["test", "--", "memoryPromotion.test.ts"], cwd: ".", timeoutMs: 120000, expectedExitCode: 0 },
    ]);
    expect(scenario.oracles.mustChange).toEqual(["src/memory/promotion.ts"]);
    expect(scenario.oracles.mustNotChange).toEqual(["src/protocol/events.ts"]);
    expect(scenario.oracles.mustIncludeEvidence).toEqual(["cartographer.grounding"]);
    expect(scenario.budgets.maxToolCalls).toBe(30);
    expect(scenario.budgets.maxRuntimeMs).toBe(900000);
    expect(scenario.budgets.maxMainModelRawToolTokens).toBe(1000);
    // Authoritative gate semantics parsed from the new `expected` block.
    expect(scenario.expected.status).toBe("passed");
    expect(scenario.expected.changedPaths).toEqual(["src/memory/promotion.ts"]);
    expect(scenario.expected.unchangedPaths).toEqual(["src/protocol/events.ts"]);
    expect(scenario.expected.evidenceRefs).toEqual(["cartographer.grounding"]);
    // setup/operation default safely to in-place validator-only execution.
    expect(scenario.setup.copyWorkspaceToTemp).toBe(false);
    expect(scenario.setup.fixtures).toEqual([]);
    expect(scenario.operation.kind).toBe("validator_only");
  });

  it("defaults the schemaVersion when omitted from valid input", () => {
    // Given: a parsed scenario object that omits the optional schemaVersion literal.
    const withoutVersion = {
      id: "coding-001",
      title: "Title",
      type: "coding",
      workspace: "fixtures/repos/rector-mini-bug",
      userGoal: "Do the thing.",
      allowedSystems: ["coding"],
      forbiddenSystems: [],
      expectedSpecialist: "coding",
      successCriteria: ["passes"],
      validators: [baseValidator()],
      oracles: { mustChange: [], mustNotChange: [], mustIncludeEvidence: [] },
      budgets: { maxToolCalls: 0, maxRuntimeMs: 0, maxMainModelRawToolTokens: 0 },
      expected: { status: "passed", changedPaths: [], unchangedPaths: [], evidenceRefs: [] },
    };

    // When: the object is validated.
    const scenario = GlobalScenarioSchema.parse(withoutVersion);

    // Then: the canonical schema version is applied and empty system arrays are accepted.
    expect(scenario.schemaVersion).toBe(GLOBAL_SCENARIO_SCHEMA_VERSION);
    expect(scenario.forbiddenSystems).toEqual([]);
  });

  it("rejects a scenario missing oracles with a clear field path", () => {
    // Given: an otherwise-valid scenario yaml with the oracles block removed.
    const missingOracles = SCENARIO_YAML.replace(
      /oracles:\n( {2}.*\n| {4}.*\n)+/,
      "",
    );

    // When: it is loaded.
    const act = () => loadGlobalScenario(missingOracles, "yaml");

    // Then: a ZodError flags the missing oracles field by path.
    expect(act).toThrow(ZodError);
    try {
      act();
    } catch (error) {
      const zodError = error as ZodError;
      expect(zodError.issues.some((issue) => issue.path.join(".") === "oracles")).toBe(true);
    }
  });

  it("throws a ZodError naming budgets.maxToolCalls when it is a string", () => {
    // Given: a scenario whose maxToolCalls budget is a string instead of an integer.
    const stringBudget = SCENARIO_YAML.replace("maxToolCalls: 30", 'maxToolCalls: "30"');

    // When: it is loaded.
    const act = () => loadGlobalScenario(stringBudget, "yaml");

    // Then: the ZodError identifies the offending nested field.
    expect(act).toThrow(ZodError);
    try {
      act();
    } catch (error) {
      const zodError = error as ZodError;
      expect(zodError.issues.some((issue) => issue.path.join(".") === "budgets.maxToolCalls")).toBe(true);
    }
  });

  it("rejects a scenario missing the required expected block", () => {
    // Given: a valid scenario object with the authoritative expected block omitted.
    const base = GlobalScenarioSchema.parse(loadGlobalScenario(SCENARIO_YAML, "yaml"));
    const { expected: _omit, ...withoutExpected } = base;

    // When: it is validated without expected.
    const result = GlobalScenarioSchema.safeParse(withoutExpected);

    // Then: the schema rejects it and names the missing expected field.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "expected")).toBe(true);
    }
  });

  it("loads an equivalent scenario from JSON input", () => {
    // Given: the same scenario serialized as JSON.
    const jsonText = JSON.stringify({
      schemaVersion: GLOBAL_SCENARIO_SCHEMA_VERSION,
      id: "coding-memory-patch-001",
      title: "Patch the memory promotion bug",
      type: "coding",
      workspace: "fixtures/repos/rector-mini-bug",
      userGoal: "Fix the failing memory promotion path.",
      allowedSystems: ["coding"],
      forbiddenSystems: ["research"],
      expectedSpecialist: "coding",
      successCriteria: ["targeted test passes"],
      validators: [{ id: "memory-promotion-test", cmd: "npm", args: ["test", "--", "memoryPromotion.test.ts"], timeoutMs: 120000 }],
      oracles: {
        mustChange: ["src/memory/promotion.ts"],
        mustNotChange: ["src/protocol/events.ts"],
        mustIncludeEvidence: ["cartographer.grounding"],
      },
      budgets: { maxToolCalls: 30, maxRuntimeMs: 900000, maxMainModelRawToolTokens: 1000 },
      expected: { status: "passed", changedPaths: ["src/memory/promotion.ts"], unchangedPaths: ["src/protocol/events.ts"], evidenceRefs: ["cartographer.grounding"] },
    });

    // When: it is loaded through the JSON path.
    const scenario = loadGlobalScenario(jsonText, "json");

    // Then: the JSON-sourced scenario validates identically to the YAML one.
    expect(scenario.id).toBe("coding-memory-patch-001");
    expect(scenario.budgets.maxRuntimeMs).toBe(900000);
  });
});

describe("GlobalValidatorSchema", () => {
  it("rejects a validator whose cmd is outside the allowlist (e.g. bash)", () => {
    // Given: a validator invoking a shell binary not in the allowlist.
    // When/Then: the schema rejects it so no validator can spawn an arbitrary shell.
    const result = GlobalValidatorSchema.safeParse(baseValidator({ cmd: "bash" }));
    expect(result.success).toBe(false);
  });

  it("rejects an npx validator that omits --no-install", () => {
    // Given: an npx validator with no --no-install flag (would allow a network install).
    const networkNpx = baseValidator({ cmd: "npx", args: ["tsx", "src/calculator.verify.ts"] });

    // When/Then: the schema rejects it; offline validators may never fetch packages.
    const result = GlobalValidatorSchema.safeParse(networkNpx);
    expect(result.success).toBe(false);
  });

  it("accepts an npx validator that includes --no-install", () => {
    // Given: an npx validator carrying --no-install (local resolve, no network).
    const localNpx = baseValidator({ cmd: "npx", args: ["--no-install", "tsx", "src/calculator.verify.ts"] });

    // When/Then: it parses and the --no-install arg is preserved verbatim.
    const parsed = GlobalValidatorSchema.parse(localNpx);
    expect(parsed.cmd).toBe("npx");
    expect(parsed.args).toEqual(["--no-install", "tsx", "src/calculator.verify.ts"]);
  });

  it("accepts exactly '.' for validator cwd but rejects './foo'", () => {
    // Given: a validator whose cwd is the bare workspace default.
    // Then: bare '.' is accepted (cwd defaults to it).
    expect(GlobalValidatorSchema.safeParse(baseValidator({ cwd: "." })).success).toBe(true);

    // And: a leading-./ relative path is rejected even for cwd.
    const leadingDotSlash = GlobalValidatorSchema.safeParse(baseValidator({ cwd: "./foo" }));
    expect(leadingDotSlash.success).toBe(false);
  });

  it("round-trips quoted/spaced args as separate array elements", () => {
    // Given: a validator with an arg containing a space.
    const spaced = baseValidator({ cmd: "node", args: ["-e", "console.log('hello world')"] });

    // When: it is parsed.
    const parsed = GlobalValidatorSchema.parse(spaced);

    // Then: the spaced arg survives as a single array element (no whitespace split).
    expect(parsed.args).toEqual(["-e", "console.log('hello world')"]);
    expect(parsed.args.length).toBe(2);
  });

  it("defaults cwd to '.' and expectedExitCode to 0 when omitted", () => {
    // Given: a validator omitting cwd and expectedExitCode.
    const minimal = { id: "v1", cmd: "node", args: ["--version"], timeoutMs: 30000 };

    // When: it is parsed.
    const parsed = GlobalValidatorSchema.parse(minimal);

    // Then: the documented defaults are applied.
    expect(parsed.cwd).toBe(".");
    expect(parsed.expectedExitCode).toBe(0);
  });
});

describe("SafeRelativePathSchema", () => {
  it("accepts ordinary relative paths and bare '.'", () => {
    // Given: normal in-workspace relative paths plus the bare cwd sentinel.
    // Then: all are accepted.
    expect(SafeRelativePathSchema.safeParse("src/calculator.ts").success).toBe(true);
    expect(SafeRelativePathSchema.safeParse("tests/fixtures/repos/rector-mini-fix").success).toBe(true);
    expect(SafeRelativePathSchema.safeParse(".").success).toBe(true);
    expect(SafeRelativePathSchema.safeParse("a/b/c.ts").success).toBe(true);
  });

  it("rejects posix-absolute paths", () => {
    expect(SafeRelativePathSchema.safeParse("/etc/passwd").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("/tmp/x").success).toBe(false);
  });

  it("rejects parent-directory (..) segments", () => {
    expect(SafeRelativePathSchema.safeParse("..").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("../escape").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("a/../../b").success).toBe(false);
    // Even a .. that normalizes back inside is rejected (stricter than normalize-alone).
    expect(SafeRelativePathSchema.safeParse("a/../b").success).toBe(false);
  });

  it("rejects a leading ./", () => {
    expect(SafeRelativePathSchema.safeParse("./foo").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("./src/x.ts").success).toBe(false);
  });

  it("rejects Windows drive prefixes", () => {
    expect(SafeRelativePathSchema.safeParse("C:\\Users\\x").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("D:/src/x.ts").success).toBe(false);
  });

  it("rejects UNC paths", () => {
    expect(SafeRelativePathSchema.safeParse("\\\\server\\share").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("//server/share").success).toBe(false);
  });

  it("rejects empty segments from double or trailing separators", () => {
    expect(SafeRelativePathSchema.safeParse("a//b").success).toBe(false);
    expect(SafeRelativePathSchema.safeParse("a/b/").success).toBe(false);
  });

  it("applies inside a scenario's workspace and changedPaths fields", () => {
    // Given: a scenario object with an absolute workspace and a `..` changedPath.
    const base = GlobalScenarioSchema.parse(loadGlobalScenario(SCENARIO_YAML, "yaml"));
    const absoluteWorkspace = { ...base, workspace: "/abs/workspace" };
    const escapingChange = { ...base, expected: { ...base.expected, changedPaths: ["../escape.ts"] } };

    // Then: the schema rejects both unsafe paths at the scenario boundary.
    expect(GlobalScenarioSchema.safeParse(absoluteWorkspace).success).toBe(false);
    expect(GlobalScenarioSchema.safeParse(escapingChange).success).toBe(false);
  });
});