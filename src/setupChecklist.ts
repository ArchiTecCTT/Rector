export interface SetupItem {
  key: string;
  label: string;
  description: string;
  required: boolean;
  defaultValue?: string;
  category: "core" | "event-bus" | "database" | "llm" | "sandbox" | "memory" | "integrations" | "telemetry" | "persistence";
}

export const SETUP_ITEMS: SetupItem[] = [
  { key: "NODE_ENV", label: "Environment", description: "Use development for local mode; production enables real adapter wiring later.", required: false, defaultValue: "development", category: "core" },
  { key: "PORT", label: "HTTP Port", description: "Local API/UI port.", required: false, defaultValue: "3000", category: "core" },
  { key: "HOST", label: "HTTP Host", description: "Bind host for local API/UI. Defaults to loopback for local safety.", required: false, defaultValue: "127.0.0.1", category: "core" },
  { key: "DOPPLER_TOKEN", label: "Doppler Token", description: "Service token used to load production secrets.", required: false, category: "core" },
  { key: "ORCHESTRATOR_MODE", label: "Orchestration Mode (deprecated)", description: "DEPRECATED advanced override only. Primary product configuration is via the web UI setup wizard, which persists orchestrationProfile (unconfigured/configured) to .rector/runtime-settings.json. This env knob remains for one-time migration from legacy installs (local→unconfigured, external+providers→configured). New installs should not use it.", required: false, defaultValue: "local", category: "core" },

  { key: "KAFKA_BROKERS", label: "Kafka Brokers", description: "Comma-separated Kafka bootstrap servers.", required: false, defaultValue: "localhost:9092", category: "event-bus" },
  { key: "KAFKA_CLIENT_ID", label: "Kafka Client ID", description: "Client ID for Thalamus and worker consumers.", required: false, defaultValue: "rector-local", category: "event-bus" },
  { key: "KAFKA_USERNAME", label: "Kafka Username", description: "Confluent Cloud API key or SASL username.", required: false, category: "event-bus" },
  { key: "KAFKA_PASSWORD", label: "Kafka Password", description: "Confluent Cloud API secret or SASL password.", required: false, category: "event-bus" },
  { key: "KAFKA_SSL", label: "Kafka SSL", description: "Set true for Confluent Cloud TLS.", required: false, defaultValue: "false", category: "event-bus" },

  { key: "MONGO_URI", label: "MongoDB URI", description: "Mongo connection string for persistent task storage.", required: false, defaultValue: "mongodb://localhost:27017/rector", category: "database" },
  { key: "MONGO_DB", label: "MongoDB Database", description: "Database name for Rector state documents.", required: false, defaultValue: "rector_core", category: "database" },

  { key: "RECTOR_PERSISTENCE", label: "RectorStore Driver", description: "Selects the RectorStore backend: memory (default) keeps the in-memory provider-free store and is the regression baseline (no file, no network); sqlite is the local file-backed store; tidb is the optional hosted TiDB Cloud path. Mongo/Redis vars are ignored by store selection.", required: false, defaultValue: "memory", category: "persistence" },
  { key: "RECTOR_SQLITE_PATH", label: "SQLite Path", description: "Local file path for the sqlite driver (used only when RECTOR_PERSISTENCE=sqlite). Defaults to a local file; no cloud account and no network are required.", required: false, defaultValue: ".rector/rector.db", category: "persistence" },
  { key: "TIDB_HOST", label: "TiDB Host", description: "TiDB Cloud host (used only when RECTOR_PERSISTENCE=tidb). The full TIDB_* block must be set for the hosted path.", required: false, category: "persistence" },
  { key: "TIDB_PORT", label: "TiDB Port", description: "TiDB Cloud port (used only when RECTOR_PERSISTENCE=tidb).", required: false, defaultValue: "4000", category: "persistence" },
  { key: "TIDB_USER", label: "TiDB User", description: "TiDB Cloud username (used only when RECTOR_PERSISTENCE=tidb).", required: false, category: "persistence" },
  { key: "TIDB_PASSWORD", label: "TiDB Password", description: "TiDB Cloud password (used only when RECTOR_PERSISTENCE=tidb).", required: false, category: "persistence" },
  { key: "TIDB_DATABASE", label: "TiDB Database", description: "TiDB Cloud database name (used only when RECTOR_PERSISTENCE=tidb).", required: false, category: "persistence" },
  { key: "TIDB_TLS", label: "TiDB TLS", description: "Enable TLS for the TiDB Cloud connection (used only when RECTOR_PERSISTENCE=tidb).", required: false, defaultValue: "true", category: "persistence" },

  { key: "LLM_BASE_URL", label: "LLM Base URL", description: "OpenAI-compatible base URL for local/provider LLM calls.", required: false, defaultValue: "https://api.openai.com/v1", category: "llm" },
  { key: "LLM_API_KEY", label: "LLM API Key", description: "Generic OpenAI-compatible API key.", required: false, category: "llm" },
  { key: "TOGETHER_API_KEY", label: "Together API Key", description: "Together AI key for SLM execution and APC tests.", required: false, category: "llm" },
  { key: "TOGETHER_BASE_URL", label: "Together Base URL", description: "Together AI OpenAI-compatible endpoint.", required: false, defaultValue: "https://api.together.xyz/v1", category: "llm" },
  { key: "FLAGSHIP_MODEL", label: "Flagship Model", description: "Planning/synthesis model identifier.", required: false, defaultValue: "gpt-4o", category: "llm" },
  { key: "SLM_MODEL", label: "SLM Model", description: "Cheap coding model for fan-out work.", required: false, defaultValue: "Qwen/Qwen2.5-Coder-7B-Instruct", category: "llm" },
  { key: "AZURE_OPENAI_ENDPOINT", label: "Azure OpenAI Endpoint", description: "Azure endpoint for flagship model mode.", required: false, category: "llm" },
  { key: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI API Key", description: "Azure OpenAI credential.", required: false, category: "llm" },
  { key: "AZURE_OPENAI_DEPLOYMENT", label: "Azure Deployment", description: "Azure flagship deployment name.", required: false, category: "llm" },
  { key: "AWS_REGION", label: "AWS Region", description: "AWS Bedrock region if using Bedrock instead of Azure.", required: false, category: "llm" },
  { key: "AWS_ACCESS_KEY_ID", label: "AWS Access Key ID", description: "AWS access key for Bedrock.", required: false, category: "llm" },
  { key: "AWS_SECRET_ACCESS_KEY", label: "AWS Secret Access Key", description: "AWS secret key for Bedrock.", required: false, category: "llm" },

  { key: "SANDBOX_RUNTIME", label: "Sandbox Runtime", description: "Sandbox provider: local or depot.", required: false, defaultValue: "local", category: "sandbox" },
  { key: "DEPOT_API_KEY", label: "Depot API Key", description: "Depot API key for containerized validation.", required: false, category: "sandbox" },
  { key: "SENTRY_DSN", label: "Sentry DSN", description: "Sentry project DSN for validation/healing errors.", required: false, category: "sandbox" },
  { key: "CODECOV_TOKEN", label: "CodeCov Token", description: "Coverage reporting token.", required: false, category: "sandbox" },
  { key: "CODESCENE_TOKEN", label: "Codescene Token", description: "Codescene CLI/API token for quality gates.", required: false, category: "sandbox" },

  { key: "CHROMA_URL", label: "Chroma URL", description: "Vector memory endpoint.", required: false, defaultValue: "http://localhost:8000", category: "memory" },
  { key: "CHROMA_API_KEY", label: "Chroma API Key", description: "Chroma Cloud token if using hosted Chroma.", required: false, category: "memory" },

  { key: "LINEAR_API_KEY", label: "Linear API Key", description: "Linear GraphQL token for issue ingest/handoff.", required: false, category: "integrations" },
  { key: "LINEAR_WEBHOOK_SECRET", label: "Linear Webhook Secret", description: "Secret used to verify incoming Linear webhooks.", required: false, category: "integrations" },
  { key: "MAKE_WEBHOOK_URL", label: "Make Webhook URL", description: "Make.com webhook for human approval automations.", required: false, category: "integrations" },
  { key: "MAKE_WEBHOOK_SECRET", label: "Make Webhook Secret", description: "Secret used to authenticate Make webhook payloads.", required: false, category: "integrations" },

  { key: "TELEMETRY_BACKEND", label: "Telemetry Backend", description: "Telemetry provider: local, posthog, datadog, or newrelic.", required: false, defaultValue: "local", category: "telemetry" },
  { key: "POSTHOG_API_KEY", label: "PostHog API Key", description: "PostHog project key for cost/token events.", required: false, category: "telemetry" },
  { key: "POSTHOG_HOST", label: "PostHog Host", description: "PostHog ingest host.", required: false, defaultValue: "https://app.posthog.com", category: "telemetry" },
  { key: "DATADOG_API_KEY", label: "DataDog API Key", description: "DataDog API key for APM/infra metrics.", required: false, category: "telemetry" },
  { key: "DATADOG_SITE", label: "DataDog Site", description: "DataDog site such as datadoghq.com or datadoghq.eu.", required: false, defaultValue: "datadoghq.com", category: "telemetry" },
  { key: "NEW_RELIC_LICENSE_KEY", label: "New Relic License Key", description: "Fallback APM license key.", required: false, category: "telemetry" },
  { key: "AMPLITUDE_API_KEY", label: "Amplitude API Key", description: "Frontend user analytics key.", required: false, category: "telemetry" },
];

const SENSITIVE_KEYS = new Set([
  "DOPPLER_TOKEN",
  "KAFKA_USERNAME",
  "KAFKA_PASSWORD",
  "MONGO_URI",
  "TIDB_PASSWORD",
  "LLM_API_KEY",
  "TOGETHER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "DEPOT_API_KEY",
  "SENTRY_DSN",
  "CODECOV_TOKEN",
  "CODESCENE_TOKEN",
  "CHROMA_API_KEY",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "MAKE_WEBHOOK_URL",
  "MAKE_WEBHOOK_SECRET",
  "POSTHOG_API_KEY",
  "DATADOG_API_KEY",
  "NEW_RELIC_LICENSE_KEY",
  "AMPLITUDE_API_KEY",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

export function getSetupChecklist() {
  return SETUP_ITEMS.map((item) => {
    const isSet = item.key in process.env;
    const actualValue = process.env[item.key];
    const sensitive = isSensitiveKey(item.key);
    const fallback = item.defaultValue ?? "";

    return {
      ...item,
      isSensitive: sensitive,
      isSet,
      currentValue: sensitive ? undefined : actualValue ?? fallback,
      displayValue: sensitive && isSet ? "••••••••" : actualValue ?? fallback,
    };
  });
}
