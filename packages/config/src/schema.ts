import { z } from "zod";
import { parsePemKey } from "./pem";

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
    | "Email"
    | "Email for agents"
    | "Push"
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
  APPLE_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Services ID for “Sign in with Apple” (e.g. `chat.agentes.signin`). Enabled when set together with `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`. Return URL: `{PUBLIC_URL}/api/auth/callback/apple`.",
    section: "Sign-in",
  },
  APPLE_TEAM_ID: {
    schema: z.string().optional(),
    description: "Apple Developer team id (10 characters) for Sign in with Apple.",
    section: "Sign-in",
  },
  APPLE_KEY_ID: {
    schema: z.string().optional(),
    description: "Key id of the Sign in with Apple private key.",
    section: "Sign-in",
  },
  APPLE_PRIVATE_KEY: {
    schema: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return value;
        try {
          return parsePemKey(value);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
          return z.NEVER;
        }
      }),
    description:
      "Sign in with Apple private key (.p8): PEM, PEM with `\\n`, or base64 of the PEM file. The server signs Apple's client secret with it at boot (valid 150 days: restart at least that often).",
    section: "Sign-in",
    secret: true,
  },
  APPLE_APP_BUNDLE_ID: {
    schema: z.string().optional(),
    description: "Bundle id of the iOS app (e.g. `chat.agentes.app`), so it can sign in with Apple natively.",
    section: "Sign-in",
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
  ROUTER_STRATEGY: {
    schema: z.enum(["jev", "llm"]).optional(),
    description:
      "How the router scores agents: `jev` (TypeSafe Jev, needs `TYPESAFE_API_KEY`; falls back to `llm` on error or timeout) or `llm` (a structured-output call with `ROUTER_MODEL`). Default: `jev` when `TYPESAFE_API_KEY` is set, else `llm`.",
    section: "Agents",
  },
  TYPESAFE_API_KEY: {
    schema: z.string().optional(),
    description:
      "Platform key for TypeSafe Jev (router). Internal: never per organization, never exposed by the API. Jev usage is recorded per organization as `router` usage billed to the platform.",
    section: "Agents",
    secret: true,
  },
  JEV_TIMEOUT_MS: {
    schema: z.coerce.number().int().min(200).max(30_000).default(2000),
    description: "Timeout for a Jev router call; after it the LLM router decides.",
    section: "Agents",
  },
  OPENAI_CHEAP_MODEL: {
    schema: modelId.default("gpt-6-luna"),
    description:
      "Cheap OpenAI model for the organization's own calls (router fallback, summaries, reflection) when its default key is an OpenAI key.",
    section: "Agents",
  },
  ROUTER_MIN_SCORE: {
    schema: z.coerce.number().min(0).max(1).default(0.5),
    description: "Minimum router score (0–1) for an agent to answer a message without mentions.",
    section: "Agents",
  },
  ROUTER_MENTION_THRESHOLD: {
    schema: z.coerce.number().min(0).max(1).default(0.6),
    description:
      "When an agent @mentions another, minimum Jev probability (0–1) that it is asking that agent to act now for it to answer.",
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
  MEMORY_JUDGE_ORGS: {
    schema: z.string().default("*"),
    description:
      "Organizations whose memory writes go through the judge (Jev, with the cheap model as fallback): duplicates, refinements, updates and contradictions found by meaning, not by words (ADR 0028). Default `*` (all). Organization ids separated by commas to limit it; empty turns it off (words only).",
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
  GITHUB_APP_ID: {
    schema: z.string().optional(),
    description:
      "Id of a GitHub App for agents' git and pull requests. With `GITHUB_APP_PRIVATE_KEY`, the git proxy uses short installation tokens scoped to one repository (1 hour) where the organization installed the app from agentes.chat, and the org's GitHub connection elsewhere.",
    section: "Connectors",
  },
  GITHUB_APP_PRIVATE_KEY: {
    schema: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return value;
        try {
          return parsePemKey(value);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
          return z.NEVER;
        }
      }),
    description: "Private key of that GitHub App: PEM, PEM with `\\n`, or base64 of the PEM file.",
    section: "Connectors",
    secret: true,
  },
  GITHUB_APP_SLUG: {
    schema: z.string().optional(),
    description:
      "URL name of that GitHub App (`github.com/apps/{slug}`). Organizations install it from the app; only installations made that way are used.",
    section: "Connectors",
  },
  GITHUB_APP_CLIENT_ID: {
    schema: z.string().optional(),
    description:
      "Client id of that GitHub App (user authorization during installation must be on). Callback URL: `{PUBLIC_URL}/api/app/github-app/callback`. Used to check that the person installing can see the installation.",
    section: "Connectors",
  },
  GITHUB_APP_CLIENT_SECRET: {
    schema: z.string().optional(),
    description: "Client secret of that GitHub App.",
    section: "Connectors",
    secret: true,
  },
  GITHUB_APP_WEBHOOK_SECRET: {
    schema: z.string().optional(),
    description:
      "Webhook secret of that GitHub App. Webhook URL: `{PUBLIC_URL}/api/github-app/webhook` (uninstalls, suspensions and repository changes).",
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
  MILLIONSEND_API_KEY: {
    schema: z.string().optional(),
    description:
      "MillionSend API key (transactional email: invitations, password reset, email verification, budget and approval alerts). Without it, emails are written to the log instead of sent, and password reset and email verification stay off.",
    section: "Email",
    secret: true,
  },
  EMAIL_FROM: {
    schema: z.string().default("agentes <ola@agentes.chat>"),
    description:
      "Sender of transactional emails, e.g. `agentes <ola@agentes.chat>` (the domain must be verified in MillionSend).",
    section: "Email",
  },
  COMPOSIO_API_KEY: {
    schema: z.string().optional(),
    description:
      "Composio project API key (Gmail and Outlook for agents, ADR 0038). Without it, Gmail and Outlook don't appear among the email connectors; IMAP mailboxes still work.",
    section: "Email for agents",
    secret: true,
  },
  COMPOSIO_WEBHOOK_SECRET: {
    schema: z.string().optional(),
    description:
      "Signing secret of the Composio webhook subscription (Standard Webhooks). Point the subscription at `{PUBLIC_URL}/api/webhooks/composio`. Without it, routines can't wake on new Gmail/Outlook mail.",
    section: "Email for agents",
    secret: true,
  },
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: {
    schema: z.string().optional(),
    description:
      "Composio auth config for Gmail (`ac_…`). Optional: without it, one using Composio's managed Google app is created on first use. Set it to use our own Google OAuth app (white label).",
    section: "Email for agents",
  },
  COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: {
    schema: z.string().optional(),
    description:
      "Composio auth config for Outlook (`ac_…`). Optional: without it, one using Composio's managed Microsoft app is created on first use.",
    section: "Email for agents",
  },
  MAIL_IMAP_ENABLED: {
    schema: z.stringbool().default(true),
    description: "IMAP/SMTP mailboxes for agents (iCloud, hosting providers, any server). `false` hides them.",
    section: "Email for agents",
  },
  MAIL_POLL_SECONDS: {
    schema: z.coerce.number().int().min(60).max(3600).default(300),
    description: "How often IMAP folders watched by routines are checked for new mail.",
    section: "Email for agents",
  },
  EMAIL_REPLY_TO: {
    schema: z.string().optional(),
    description: "Optional Reply-To address for transactional emails.",
    section: "Email",
  },
  APPROVAL_REMINDER_HOURS: {
    schema: z.coerce.number().min(0.25).max(23).default(4),
    description: "Email approvers a digest of requests still waiting after this many hours (requests expire at 24 h).",
    section: "Email",
  },
  EXPO_ACCESS_TOKEN: {
    schema: z.string().optional(),
    description:
      "Expo access token for push notifications to the phone app (only needed when “enhanced push security” is on in the Expo project). Pushes are sent through the Expo Push API either way.",
    section: "Push",
    secret: true,
  },
  S3_ENDPOINT: {
    schema: z.url().optional(),
    description:
      "S3-compatible endpoint for platform file storage (artifacts, uploads), e.g. a Cloudflare R2 endpoint. Without S3_ENDPOINT and S3_BUCKET, files are stored in Postgres.",
    section: "Storage",
    example: "https://<account>.r2.cloudflarestorage.com",
  },
  S3_REGION: {
    schema: z.string().default("auto"),
    description: "Region of the platform bucket (`auto` for R2).",
    section: "Storage",
  },
  S3_BUCKET: {
    schema: z.string().optional(),
    description: "Bucket for platform file storage. Each organization gets its own key prefix; objects stay private.",
    section: "Storage",
  },
  S3_ACCESS_KEY_ID: {
    schema: z.string().optional(),
    description: "Access key id for the platform bucket.",
    section: "Storage",
  },
  S3_SECRET_ACCESS_KEY: {
    schema: z.string().optional(),
    description: "Secret access key for the platform bucket.",
    section: "Storage",
    secret: true,
  },
  DAYTONA_API_KEY: {
    schema: z.string().optional(),
    description:
      "Daytona API key: sandboxes where agents run code (`run_code`, skill scripts). Platform secret, never sent to a sandbox or a client. Without it the sandbox tools are off.",
    section: "Sandbox",
    secret: true,
  },
  DAYTONA_API_URL: {
    schema: z.url().default("https://app.daytona.io/api"),
    description: "Daytona API base URL.",
    section: "Sandbox",
  },
  DAYTONA_TARGET: {
    schema: z.string().optional(),
    description: "Daytona region for new sandboxes (e.g. `us` or `eu`). Default: the Daytona organization's default.",
    section: "Sandbox",
  },
  SANDBOX_SNAPSHOT: {
    schema: z.string().optional(),
    description:
      "Name of our computer snapshot in Daytona (built from infra/sandbox/Dockerfile by `bun apps/server/scripts/sandbox-snapshot.ts`). Unset: the provider's default image, with /workspace created on first start.",
    section: "Sandbox",
    example: "agentes-computer-v3",
  },
  SANDBOX_AUTO_STOP_MINUTES: {
    schema: z.coerce.number().int().min(1).max(120).default(10),
    description: "An agent's computer stops after this many idle minutes (its next use starts it again, files kept).",
    section: "Sandbox",
  },
  SANDBOX_ARCHIVE_AFTER_DAYS: {
    schema: z.coerce.number().int().min(1).max(30).default(7),
    description:
      "A stopped computer is archived after this many days (files kept; starting it takes longer). Computers are never deleted automatically.",
    section: "Sandbox",
  },
  SANDBOX_PRICE_VCPU_HOUR_USD: {
    schema: z.coerce.number().min(0).default(0.0504),
    description: "Price of one vCPU per hour, for the sandbox usage recorded per agent (Daytona list price).",
    section: "Sandbox",
  },
  SANDBOX_PRICE_MEMORY_GIB_HOUR_USD: {
    schema: z.coerce.number().min(0).default(0.0162),
    description: "Price of one GiB of memory per hour, for sandbox usage.",
    section: "Sandbox",
  },
  SANDBOX_PRICE_DISK_GIB_HOUR_USD: {
    schema: z.coerce.number().min(0).default(0.000108),
    description: "Price of one GiB of disk per hour, for sandbox usage.",
    section: "Sandbox",
  },
  DESKTOP_RELEASES_TOKEN: {
    schema: z.string().optional(),
    description:
      "Fine-grained GitHub token (read-only contents) for the repository that publishes the desktop app's releases. The server reads the latest `desktop-v*` release with it (`/api/desktop/latest`, `/api/desktop/download/...`). Unset: those endpoints answer 404.",
    section: "Sandbox",
    secret: true,
  },
  DESKTOP_RELEASES_REPO: {
    schema: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo")
      .default("wescld/agents.chat"),
    description: "GitHub repository (`owner/repo`) whose releases tagged `desktop-v<version>` hold the desktop app.",
    section: "Sandbox",
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
