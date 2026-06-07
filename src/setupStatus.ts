import { redactSecrets } from "./security/redaction";
import type { SecretStore } from "./security/secretStore";

/**
 * Setup Status Service (Requirement 1).
 *
 * A pure composer that turns the ambient configuration (an injected `env` map plus the
 * {@link SecretStore}) into a redacted, presence-only readiness summary for the Setup_Wizard.
 * It is additive and inert in Local_Mode: it reads configuration only, never mutates it, never
 * performs network I/O, and never reads a raw secret value into its output.
 *
 * The assembled response is routed through the `Redaction_Layer` before it is returned so no
 * secret substring can escape (Requirement 1.3). Secret VALUES never appear — only per-provider
 * presence booleans sourced from the {@link SecretStore} (Requirements 1.4, 7.5). If redaction of
 * a value fails, that value is omitted rather than returned (Requirement 1.10).
 */

/** The orchestration mode surfaced to the wizard: Local_Mode or External_Mode (Requirement 1.1). */
export type SetupMode = "local" | "external";

/** The closed set of readiness states reported per category (Requirement 1.2). */
export type ReadinessStatus = "Ready" | "Incomplete" | "Error";

/** The four configuration categories the wizard reports on (Requirement 1.2). */
export type SetupCategory = "provider" | "persistence" | "workspace" | "budget";

/** One category's readiness: exactly one {@link ReadinessStatus} plus a redacted explanation. */
export interface CategoryReadiness {
  category: SetupCategory;
  /** Exactly one of Ready | Incomplete | Error (Requirement 1.2). */
  status: ReadinessStatus;
  /**
   * Redacted, human-language explanation. References env key NAMES only — never values — so it
   * carries no secret material even before the boundary redaction pass. May be empty when the
   * value's redaction failed and the detail was omitted (Requirement 1.10).
   */
  detail: string;
}

/** The redacted setup status payload returned to the Setup_API/Setup_Wizard. */
export interface SetupStatusResponse {
  /** Local_Mode or External_Mode (Requirement 1.1). */
  mode: SetupMode;
  /** Exactly one entry per {@link SetupCategory}, no duplicates (Requirement 1.2). */
  categories: CategoryReadiness[];
  /** Per-provider presence booleans only — never secret values (Requirements 1.4, 7.5). */
  secretPresence: Record<string, boolean>;
}

/**
 * Provider ids whose secret presence is reported and whose env configuration drives provider
 * readiness in External_Mode. Mirrors the supported BYOK providers and their required env key
 * NAMES (never values) used by `parseOrchestrationConfig`/`runConnectionTest`; kept local so this
 * module stays a pure, dependency-light composer.
 */
const PROVIDER_ENV_REQUIREMENTS: ReadonlyArray<{ id: string; requiredEnvKeys: readonly string[] }> = [
  { id: "together", requiredEnvKeys: ["TOGETHER_API_KEY"] },
  { id: "cloudflare", requiredEnvKeys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] },
  { id: "azure-openai", requiredEnvKeys: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"] },
];

/** Provider ids reported in `secretPresence`, in a stable order. */
const PROVIDER_IDS: readonly string[] = PROVIDER_ENV_REQUIREMENTS.map((descriptor) => descriptor.id);

/** The full TiDB connection field set; all must be present for the hosted persistence path. */
const TIDB_REQUIRED_KEYS = ["TIDB_HOST", "TIDB_PORT", "TIDB_USER", "TIDB_PASSWORD", "TIDB_DATABASE"] as const;

/** True when an env value is set to a non-empty, non-whitespace string. */
function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Compose the redacted, presence-only setup status from the injected `env` and {@link SecretStore}.
 *
 * Async because secret presence is sourced from the {@link SecretStore} (`hasSecret` is async). The
 * returned response is fully redacted and contains only presence booleans, never secret values.
 */
export async function computeSetupStatus(
  env: Record<string, string | undefined>,
  secretStore: SecretStore
): Promise<SetupStatusResponse> {
  // Requirement 1.1: External_Mode only when ORCHESTRATOR_MODE is exactly "external"; Local otherwise.
  const mode: SetupMode = env.ORCHESTRATOR_MODE === "external" ? "external" : "local";

  // Presence booleans only — the SecretStore is the sole source and never exposes a value here.
  const secretPresence: Record<string, boolean> = {};
  for (const providerId of PROVIDER_IDS) {
    secretPresence[providerId] = await secretStore.hasSecret(providerId);
  }
  const anyProviderSecret = Object.values(secretPresence).some(Boolean);

  // Requirement 1.2: exactly one readiness entry per category, no duplicates.
  const categories: CategoryReadiness[] = [
    deriveProviderReadiness(mode, env, anyProviderSecret),
    derivePersistenceReadiness(env),
    deriveWorkspaceReadiness(env),
    deriveBudgetReadiness(),
  ];

  // Requirements 1.3, 1.10: redact at the boundary; omit any value whose redaction fails.
  return redactResponse({ mode, categories, secretPresence });
}

/**
 * Provider category readiness. Local_Mode needs no provider (Ready). External_Mode is Ready when at
 * least one provider has a stored secret or its required env keys are present, otherwise Incomplete.
 */
function deriveProviderReadiness(
  mode: SetupMode,
  env: Record<string, string | undefined>,
  anyProviderSecret: boolean
): CategoryReadiness {
  if (mode === "local") {
    return {
      category: "provider",
      status: "Ready",
      detail: "Local mode runs provider-free; no provider credentials are required.",
    };
  }

  const envConfigured = PROVIDER_ENV_REQUIREMENTS.some((descriptor) =>
    descriptor.requiredEnvKeys.every((key) => isPresent(env[key]))
  );

  if (anyProviderSecret || envConfigured) {
    return {
      category: "provider",
      status: "Ready",
      detail: "At least one provider is configured for external mode.",
    };
  }

  return {
    category: "provider",
    status: "Incomplete",
    detail: "External mode requires at least one configured provider, but none are configured yet.",
  };
}

/**
 * Persistence category readiness from RECTOR_PERSISTENCE. `memory`/`sqlite` (and the unset default)
 * are local-ready; `tidb` is Ready only when the full TiDB field set is present, else Incomplete;
 * any other value is an Error.
 */
function derivePersistenceReadiness(env: Record<string, string | undefined>): CategoryReadiness {
  const driver = (env.RECTOR_PERSISTENCE ?? "").trim() || "memory";

  if (driver === "memory" || driver === "sqlite") {
    return {
      category: "persistence",
      status: "Ready",
      detail: `Persistence driver "${driver}" is configured (local default path).`,
    };
  }

  if (driver === "tidb") {
    const missing = TIDB_REQUIRED_KEYS.filter((key) => !isPresent(env[key]));
    if (missing.length === 0) {
      return {
        category: "persistence",
        status: "Ready",
        detail: "TiDB persistence is selected and all required connection fields are present.",
      };
    }
    return {
      category: "persistence",
      status: "Incomplete",
      detail: `TiDB persistence is selected but these fields are missing: ${missing.join(", ")}.`,
    };
  }

  return {
    category: "persistence",
    status: "Error",
    detail: `Unknown persistence driver "${driver}"; expected one of memory, sqlite, tidb.`,
  };
}

/**
 * Workspace category readiness from SANDBOX_RUNTIME. The local sandbox (and the unset default) is
 * always Ready; `depot` is Ready only when DEPOT_API_KEY is present, else Incomplete; any other
 * value is an Error.
 */
function deriveWorkspaceReadiness(env: Record<string, string | undefined>): CategoryReadiness {
  const runtime = (env.SANDBOX_RUNTIME ?? "").trim() || "local";

  if (runtime === "local") {
    return {
      category: "workspace",
      status: "Ready",
      detail: "Local sandbox runtime is active with workspace containment enforced.",
    };
  }

  if (runtime === "depot") {
    if (isPresent(env.DEPOT_API_KEY)) {
      return {
        category: "workspace",
        status: "Ready",
        detail: "Depot sandbox runtime is configured.",
      };
    }
    return {
      category: "workspace",
      status: "Incomplete",
      detail: "Depot sandbox runtime is selected but DEPOT_API_KEY is not set.",
    };
  }

  return {
    category: "workspace",
    status: "Error",
    detail: `Unknown sandbox runtime "${runtime}"; expected one of local, depot.`,
  };
}

/**
 * Budget category readiness. Cumulative budget enforcement is always active with built-in safe
 * defaults (no env configuration is required for it to operate), so the category is Ready.
 */
function deriveBudgetReadiness(): CategoryReadiness {
  return {
    category: "budget",
    status: "Ready",
    detail: "Cumulative budget enforcement is active with built-in safe defaults.",
  };
}

/**
 * Route the assembled response through the `Redaction_Layer` (Requirement 1.3), omitting any value
 * whose redaction fails rather than returning it (Requirement 1.10).
 *
 * Redaction is applied per field so a single failing value is dropped in isolation: a category's
 * `detail` is emptied (its content omitted) and a `secretPresence` entry is removed, while the
 * closed-set `mode`, `category`, and `status` discriminants — which can carry no secret — are kept.
 */
function redactResponse(raw: SetupStatusResponse): SetupStatusResponse {
  const categories: CategoryReadiness[] = raw.categories.map((entry) => ({
    category: entry.category,
    status: entry.status,
    detail: safeRedact(entry.detail) ?? "",
  }));

  const secretPresence: Record<string, boolean> = {};
  for (const [providerId, present] of Object.entries(raw.secretPresence)) {
    const redacted = safeRedactValue(present);
    if (redacted === undefined) continue; // omit this value rather than return it (Req 1.10)
    secretPresence[providerId] = redacted;
  }

  return { mode: raw.mode, categories, secretPresence };
}

/** Redact a string value, returning `undefined` (omit) if redaction throws (Requirement 1.10). */
function safeRedact(value: string): string | undefined {
  try {
    return redactSecrets(value);
  } catch {
    return undefined;
  }
}

/** Redact a boolean presence value, returning `undefined` (omit) if redaction throws (Req 1.10). */
function safeRedactValue(value: boolean): boolean | undefined {
  try {
    return redactSecrets(value);
  } catch {
    return undefined;
  }
}
