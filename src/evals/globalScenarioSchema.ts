import { parse as parseYaml } from "yaml";
import path from "node:path";
import { z } from "zod";

export const GLOBAL_SCENARIO_SCHEMA_VERSION = "rector.global-scenario.v1";

const NonEmptyTextSchema = z.string().min(1);
const NonNegativeIntSchema = z.number().int().nonnegative();

/**
 * A relative path that is guaranteed to stay inside the scenario workspace.
 *
 * REJECTS: posix-absolute paths (`/x`), Windows drive prefixes (`C:\x`, `C:/x`),
 * UNC paths (`\\srv\share`, `//srv/share`), any `..` segment (even one that
 * normalizes back inside, per the plan's stricter rule), a leading `./`, empty
 * segments (e.g. `a//b`, trailing `/`), and anything whose posix-normalized form
 * escapes the workspace (starts with `/` or `..`).
 *
 * ALLOWED: bare `.` (so validator `cwd` may default to it) and ordinary
 * relative paths like `src/calculator.ts` or `tests/fixtures/repos/rector-mini-fix`.
 * The leading-`./` rejection means `./foo` is rejected while exactly `.` is not,
 * which is the cwd exception the plan calls for ("do not allow `./foo`, but do
 * allow exactly `.`").
 */
export const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.startsWith("/")) return false; // posix absolute
    if (/^[a-zA-Z]:[/\\]/.test(value)) return false; // Windows drive prefix
    if (value.startsWith("\\\\") || value.startsWith("//")) return false; // UNC
    if (value.startsWith("./")) return false; // leading ./
    const segments = value.split(/[/\\]/);
    if (segments.some((segment) => segment === "..")) return false; // any .. segment
    if (segments.some((segment) => segment === "")) return false; // empty segment (//, trailing /)
    const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
    if (normalized.startsWith("/") || normalized.startsWith("..")) return false;
    return !normalized.split("/").some((segment) => segment === "..");
  }, {
    message:
      "path must be a safe relative path within the scenario workspace (no absolute, .., leading ./, drive, or UNC)",
  });

/**
 * Commands a global scenario validator may invoke. This is a closed allowlist so
 * no validator can spawn an arbitrary shell/utility. `npx` is permitted ONLY with
 * `--no-install` (enforced in {@link GlobalValidatorSchema}); network install is
 * never allowed offline.
 */
export const GLOBAL_VALIDATOR_ALLOWED_CMDS = ["node", "npm", "npx", "tsx", "git"] as const;
export type GlobalValidatorCmd = (typeof GLOBAL_VALIDATOR_ALLOWED_CMDS)[number];

const AllowedValidatorCmdSchema = z.enum(GLOBAL_VALIDATOR_ALLOWED_CMDS);

/**
 * A single structured validator command. Replaces the legacy `validators: string[]`
 * form. Execution is `spawnSync(cmd, args, { shell: false })` (todo 9) — the args
 * array is passed verbatim so quoted/spaced args round-trip without a shell split.
 *
 * - `cwd` defaults to `.` (the scenario workspace); bare `.` is allowed, `./foo`
 *   is rejected by {@link SafeRelativePathSchema}.
 * - `timeoutMs` is required (per-validator); the runner caps it at the harness
 *   ceiling.
 * - `expectedExitCode` defaults to `0`; todo 12 will wire reliability to compare
 *   the actual exit against this rather than hardcoding 0.
 * - `npx` validators MUST include `--no-install` in `args` (refine below rejects
 *   `npx` without it). No validator may invoke a shell or fetch packages.
 */
export const GlobalValidatorSchema = z
  .object({
    id: NonEmptyTextSchema,
    cmd: AllowedValidatorCmdSchema,
    args: z.array(z.string()),
    cwd: SafeRelativePathSchema.default("."),
    timeoutMs: NonNegativeIntSchema,
    expectedExitCode: z.number().int().default(0),
  })
  .strict()
  .refine((validator) => {
    if (validator.cmd === "npx") {
      // `--no-install` must be present (anywhere in args) so npx never fetches.
      return validator.args.includes("--no-install");
    }
    return true;
  }, {
    message: "npx validators must include --no-install (no network package install)",
  });
export type GlobalValidator = Readonly<z.infer<typeof GlobalValidatorSchema>>;

/**
 * Pre-run setup. `copyWorkspaceToTemp` is honored by the runner (todo 9); offline
 * it defaults to false (run in place). `fixtures` are extra fixture paths copied
 * alongside the workspace, each a safe relative path.
 */
const GlobalSetupSchema = z
  .object({
    copyWorkspaceToTemp: z.boolean().default(false),
    fixtures: z.array(SafeRelativePathSchema).default([]),
  })
  .strict();

/**
 * What the harness does before validators run. `validator_only` (default) just
 * runs validators. `scripted_patch` applies `patchFile` (a safe relative path)
 * with `git apply` in the workspace — honestly a harness operation, NOT specialist
 * execution (todo 9 wires it). `none` runs no operation. `patchFile` is only
 * permitted when `kind === "scripted_patch"`.
 */
const GlobalOperationSchema = z
  .object({
    kind: z.enum(["none", "scripted_patch", "validator_only"]).default("validator_only"),
    patchFile: SafeRelativePathSchema.optional(),
    description: NonEmptyTextSchema.optional(),
  })
  .strict()
  .refine((operation) => {
    // patchFile is only meaningful for a scripted patch; reject it otherwise.
    return operation.patchFile === undefined || operation.kind === "scripted_patch";
  }, {
    message: "operation.patchFile is only allowed when operation.kind is scripted_patch",
  });

/**
 * Authoritative expected outcome for global gate semantics (todo 18). `status`
 * is the declared pass/fail/skip; the gate passes a scenario only when its actual
 * status equals this. `changedPaths`/`unchangedPaths` are the allowed patch
 * target set and the protected set (todo 9 uses `changedPaths` for patch
 * containment). `evidenceRefs` are evidence ids the scenario expects to resolve.
 */
const GlobalExpectedSchema = z
  .object({
    status: z.enum(["passed", "failed", "skipped"]),
    changedPaths: z.array(SafeRelativePathSchema),
    unchangedPaths: z.array(SafeRelativePathSchema),
    evidenceRefs: z.array(NonEmptyTextSchema),
    memoryAssertionPath: SafeRelativePathSchema.optional(),
    runEventTracePath: SafeRelativePathSchema.optional(),
  })
  .strict();

const GlobalScenarioOraclesSchema = z
  .object({
    mustChange: z.array(NonEmptyTextSchema),
    mustNotChange: z.array(NonEmptyTextSchema),
    mustIncludeEvidence: z.array(NonEmptyTextSchema),
  })
  .strict();

const GlobalScenarioBudgetsSchema = z
  .object({
    maxToolCalls: NonNegativeIntSchema,
    maxRuntimeMs: NonNegativeIntSchema,
    maxMainModelRawToolTokens: NonNegativeIntSchema,
  })
  .strict();

export const GlobalScenarioSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_SCENARIO_SCHEMA_VERSION).default(GLOBAL_SCENARIO_SCHEMA_VERSION),
    id: NonEmptyTextSchema,
    title: NonEmptyTextSchema,
    // Free-text category (e.g. "coding", "delegation", "memory", "live"). Live
    // detection stays in globalRunner.requiresLiveProvider: type === "live" OR a
    // validator arg carries the LIVE_EVALS token. Kept free-text (not an enum) so
    // downstream scenario categories are preserved; the live signal is explicit.
    type: NonEmptyTextSchema,
    workspace: SafeRelativePathSchema,
    userGoal: NonEmptyTextSchema,
    allowedSystems: z.array(NonEmptyTextSchema),
    forbiddenSystems: z.array(NonEmptyTextSchema),
    expectedSpecialist: NonEmptyTextSchema,
    successCriteria: z.array(NonEmptyTextSchema),
    validators: z.array(GlobalValidatorSchema),
    oracles: GlobalScenarioOraclesSchema,
    budgets: GlobalScenarioBudgetsSchema,
    // Authoritative gate semantics + structured setup/operation. `expected` is
    // required (the gate compares actual vs expected.status for every scenario);
    // `setup`/`operation` are optional with safe defaults.
    setup: GlobalSetupSchema.default({ copyWorkspaceToTemp: false, fixtures: [] }),
    operation: GlobalOperationSchema.default({ kind: "validator_only" }),
    expected: GlobalExpectedSchema,
  })
  .strict();

export type GlobalScenario = Readonly<z.infer<typeof GlobalScenarioSchema>>;
export type GlobalScenarioOracles = GlobalScenario["oracles"];
export type GlobalScenarioBudgets = GlobalScenario["budgets"];
export type GlobalScenarioExpected = GlobalScenario["expected"];
export type GlobalScenarioOperation = GlobalScenario["operation"];
export type GlobalScenarioSetup = GlobalScenario["setup"];

export type GlobalScenarioFormat = "yaml" | "json";

/**
 * Parses and validates a global reliability scenario from text.
 *
 * YAML is a strict superset of JSON, so the `yaml` package parses both. We always
 * route through it (the `js-yaml` package is not available in this repo) and treat
 * `format` as an explicit hint only; the parsed value is validated by
 * {@link GlobalScenarioSchema}, which throws a ZodError naming the offending field
 * on any shape mismatch (including an unsafe path or an `npx` validator missing
 * `--no-install`).
 */
export function loadGlobalScenario(text: string, format: GlobalScenarioFormat = "yaml"): GlobalScenario {
  const raw: unknown = format === "json" ? JSON.parse(text) : parseYaml(text);
  return GlobalScenarioSchema.parse(raw);
}
