import { z } from "zod";

/**
 * Every environment variable agentes.chat reads is declared here, exactly once.
 *
 * This list is the single source of truth for:
 * - runtime validation (see `loadConfig`)
 * - `.env.example` (`bun run docs:env`)
 *
 * Adding a variable anywhere else is a bug (docs/adr/0004-configuration.md).
 */
export interface EnvVarDefinition {
  /** Zod schema that parses the raw string value. Include `.default()` for optional vars. */
  schema: z.ZodType;
  /** Shown in `.env.example`. Write it for a self-hoster, not for us. */
  description: string;
  /** Grouping used in `.env.example`. */
  section:
    | "Server"
    | "Database"
    | "Security"
    | "Sign-in"
    | "Agents"
    | "Connectors"
    | "Search"
    | "Storage"
    | "Sandbox"
    | "Observability";
  /** Example value for docs. Never a real secret. */
  example?: string;
  /** Secret values are never logged and are masked in diagnostics. */
  secret?: boolean;
}

/** Claude model ids accepted as defaults. Prices live in `@agenteschat/providers` (`MODEL_CATALOG`). */
const modelId = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "must be a model id such as claude-sonnet-5-5");

export const envVars = {
  NODE_ENV: {
    schema: z.enum(["development", "test", "production"]).default("development"),
    description: "Runtime mode. Use `production` for any real deployment.",
    section: "Server",
    example: "production",
  },
  HOST: {
    schema: z.string().default("0.0.0.0"),
    description: "Interface the HTTP server binds to.",
    section: "Server",
  },
  PORT: {
    schema: z.coerce.number().int().min(1).max(65535).default(3000),
    description: "Port the HTTP and WebSocket server listens on.",
    section: "Server",
  },
  PUBLIC_URL: {
    schema: z.url().default("http://localhost:3000"),
    description:
      "Public base URL of this instance, without a trailing slash. Used for sign-in callbacks, invitation links and the allowed browser origin.",
    section: "Server",
    example: "https://chat.example.com",
  },
  WEB_DIR: {
    schema: z.string().default("./public"),
    description:
      "Directory containing the built web app (single-page app). Served by this server when it exists; otherwise only the API runs.",
    section: "Server",
  },
  DATABASE_URL: {
    schema: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL"),
    description:
      "PostgreSQL connection string (PostgreSQL 15 or newer with the `vector` extension available). Add `?sslmode=require` for managed databases that require TLS.",
    section: "Database",
    example: "postgres://agenteschat:password@db.example.com:5432/agenteschat?sslmode=require",
    secret: true,
  },
  DATABASE_POOL_MAX: {
    schema: z.coerce.number().int().min(1).default(10),
    description: "Maximum number of open connections per agentes.chat process.",
    section: "Database",
  },
  RUN_MIGRATIONS_ON_BOOT: {
    schema: z.stringbool().default(true),
    description:
      "Apply pending database migrations when the server starts. Disable only if you run migrations as a separate deployment step.",
    section: "Database",
  },
  AGENTES_SECRET: {
    schema: z.string().min(32, "must be at least 32 characters; generate one with `openssl rand -base64 48`"),
    description:
      "Master secret. Session signing and the key that encrypts stored provider credentials (API keys of model providers) derive from it. Generate with `openssl rand -base64 48`. **Changing it makes stored credentials unreadable.** Back it up.",
    section: "Security",
    example: "<output of openssl rand -base64 48>",
    secret: true,
  },
  ALLOW_SIGNUP: {
    schema: z.stringbool().default(false),
    description:
      "Let anyone create an account. When off (default), only the **first** account can sign up (it becomes owner of the installation) and everyone else needs an invitation. Keep it off on a self-hosted instance reachable from the internet.",
    section: "Sign-in",
  },
  TRUSTED_PROXIES: {
    schema: z.string().optional(),
    description:
      "Comma-separated IPs/CIDRs of your reverse proxies (load balancer, Cloudflare…). Used to find the real client IP for sign-in rate limiting. Leave empty if agentes.chat is reached directly.",
    section: "Sign-in",
    example: "10.0.0.0/8,172.16.0.0/12",
  },
  GOOGLE_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Enables “Sign in with Google” when set together with `GOOGLE_CLIENT_SECRET`. Redirect URI: `{PUBLIC_URL}/api/auth/callback/google`.",
    section: "Sign-in",
  },
  GOOGLE_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "OAuth client secret for Google sign-in.",
    section: "Sign-in",
    secret: true,
  },
  GITHUB_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Enables “Sign in with GitHub” when set together with `GITHUB_CLIENT_SECRET`. Callback URL: `{PUBLIC_URL}/api/auth/callback/github`.",
    section: "Sign-in",
  },
  GITHUB_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "OAuth client secret for GitHub sign-in.",
    section: "Sign-in",
    secret: true,
  },
  AGENT_DEFAULT_MODEL: {
    schema: modelId.default("claude-sonnet-5-5"),
    description: "Model used by new agents unless one is chosen explicitly.",
    section: "Agents",
  },
  ROUTER_ENABLED: {
    schema: z.stringbool().default(true),
    description:
      "Let the router pick which agents (at most 2) answer messages that mention nobody. Off = agents answer only when @mentioned.",
    section: "Agents",
  },
  ROUTER_MODEL: {
    schema: modelId.default("claude-haiku-5-5"),
    description:
      "Small, fixed model that scores which agents should answer a message without mentions (router). Any model in the catalog; an organization can override it in its settings. Billed to the organization's default provider key.",
    section: "Agents",
  },
  ROUTER_MIN_SCORE: {
    schema: z.coerce.number().min(0).max(1).default(0.5),
    description: "Minimum router score (0–1) for an agent to answer a message without mentions.",
    section: "Agents",
  },
  AGENT_MAX_OUTPUT_TOKENS: {
    schema: z.coerce.number().int().min(256).max(128_000).default(16_000),
    description: "Upper bound on tokens an agent may generate in one reply.",
    section: "Agents",
  },
  AGENT_MAX_TOOL_TURNS: {
    schema: z.coerce.number().int().min(1).max(200).default(25),
    description: "Maximum model calls in one agent run (each tool round trip is one). Stops runaway tool loops.",
    section: "Agents",
  },
  AGENT_CONTEXT_MESSAGES: {
    schema: z.coerce.number().int().min(1).max(500).default(30),
    description: "How many recent channel (or thread) messages are included in an agent's context.",
    section: "Agents",
  },
  AGENT_MAX_HOPS: {
    schema: z.coerce.number().int().min(1).max(20).default(3),
    description:
      "Maximum consecutive agent replies in one thread without a person posting. Stops agents from triggering each other forever.",
    section: "Agents",
  },
  PLATFORM_ANTHROPIC_API_KEY: {
    schema: z.string().optional(),
    description:
      "Platform Anthropic key (Cloud): organizations without a key of their own, and the onboarding option “Chave do agentes”, use it. Usage is still recorded per organization.",
    section: "Agents",
    secret: true,
  },
  PLATFORM_ANTHROPIC_WORKSPACE_ID: {
    schema: z.string().optional(),
    description:
      "Workspace id for the platform key, when the key is not scoped to a workspace (sent as `anthropic-workspace-id`).",
    section: "Agents",
  },
  SUMMARY_MODEL: {
    schema: modelId.default("claude-haiku-5-5"),
    description:
      "Model that writes thread and channel summaries and extracts decisions, facts and lessons (reflection). An organization can override it. Billed to the organization (usage kind `summary`).",
    section: "Agents",
  },
  REFLECT_EVERY_MESSAGES: {
    schema: z.coerce.number().int().min(2).max(500).default(20),
    description: "Reflect on a thread (extract decisions, facts, lessons) each time it grows by this many replies.",
    section: "Agents",
  },
  REFLECT_IDLE_MINUTES: {
    schema: z.coerce.number().int().min(5).max(10_080).default(120),
    description: "Also reflect on a thread once it has been quiet this long.",
    section: "Agents",
  },
  REFLECT_MAX_PER_THREAD: {
    schema: z.coerce.number().int().min(1).max(100).default(5),
    description: "Upper bound on reflections per thread (bounds cost and agent-to-agent loops).",
    section: "Agents",
  },
  EMBEDDINGS_PROVIDER: {
    schema: z.enum(["none", "voyage"]).default("none"),
    description:
      "Vector embeddings for search. `none`: full-text search only. `voyage`: Voyage AI (needs `VOYAGE_API_KEY`); usage is recorded per organization (kind `embedding`).",
    section: "Search",
  },
  VOYAGE_API_KEY: {
    schema: z.string().optional(),
    description: "Voyage AI API key, used when `EMBEDDINGS_PROVIDER=voyage`.",
    section: "Search",
    secret: true,
  },
  EMBEDDING_MODEL: {
    schema: z.string().default("voyage-3.5"),
    description: "Embedding model (1024 dimensions). After changing it, reindex (`search.reindex`).",
    section: "Search",
  },
  CONNECTOR_GITHUB_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Client id of the GitHub OAuth app used to connect GitHub for agents (not sign-in). Set together with `CONNECTOR_GITHUB_CLIENT_SECRET`. Redirect URI: `{PUBLIC_URL}/api/app/connectors/oauth/callback`. Without it, GitHub can still be connected with an API key.",
    section: "Connectors",
  },
  CONNECTOR_GITHUB_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "Client secret of the GitHub OAuth app for the GitHub connector.",
    section: "Connectors",
    secret: true,
  },
  CONNECTOR_SENTRY_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Client id of the Sentry integration used to connect Sentry for agents (not sign-in). Set together with `CONNECTOR_SENTRY_CLIENT_SECRET`. Redirect URI: `{PUBLIC_URL}/api/app/connectors/oauth/callback`. Without it, Sentry can still be connected with an API key.",
    section: "Connectors",
  },
  CONNECTOR_SENTRY_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "Client secret of the Sentry integration for the Sentry connector.",
    section: "Connectors",
    secret: true,
  },
  CONNECTOR_LINEAR_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Client id of the Linear OAuth app used to connect Linear for agents (not sign-in). Set together with `CONNECTOR_LINEAR_CLIENT_SECRET`. Redirect URI: `{PUBLIC_URL}/api/app/connectors/oauth/callback`. Without it, Linear can still be connected with an API key.",
    section: "Connectors",
  },
  CONNECTOR_LINEAR_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "Client secret of the Linear OAuth app for the Linear connector.",
    section: "Connectors",
    secret: true,
  },
  CONNECTOR_GOOGLE_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Client id of the Google OAuth client used to connect Google Drive for agents (not sign-in). Set together with `CONNECTOR_GOOGLE_CLIENT_SECRET`. Redirect URI: `{PUBLIC_URL}/api/app/connectors/oauth/callback`. Without it, Google Drive can still be connected with an API key.",
    section: "Connectors",
  },
  CONNECTOR_GOOGLE_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "Client secret of the Google OAuth client for the Google Drive connector.",
    section: "Connectors",
    secret: true,
  },
  LOG_LEVEL: {
    schema: z.enum(["debug", "info", "warn", "error"]).default("info"),
    description: "Minimum log level written to stdout.",
    section: "Observability",
  },
} satisfies Record<string, EnvVarDefinition>;

export type EnvVarName = keyof typeof envVars;

export const configSchema = z.object(
  Object.fromEntries(Object.entries(envVars).map(([key, def]) => [key, def.schema])) as {
    [K in EnvVarName]: (typeof envVars)[K]["schema"];
  },
);

export type Config = z.infer<typeof configSchema>;
