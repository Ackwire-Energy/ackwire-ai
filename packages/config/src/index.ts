import { type Config, configSchema, envVars } from "./schema";

export { connectorOAuthApps, githubAppConfig } from "./connectors";
export { type Config, type EnvVarDefinition, type EnvVarName, envVars } from "./schema";

/** agentes.chat's own site: its signed-out `/` is the marketing page and its legal pages are its own. */
const OFFICIAL_HOSTS = new Set(["agentes.chat", "www.agentes.chat"]);

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses and validates configuration from environment variables.
 * Throws `ConfigError` listing every problem at once, so a self-hoster can fix
 * their `.env` in a single pass.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the default.
  const raw = Object.fromEntries(Object.keys(envVars).map((key) => [key, env[key] === "" ? undefined : env[key]]));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        const missing = raw[key] === undefined;
        return missing ? `${key} is required` : `${key}: ${issue.message}`;
      }),
    );
  }
  const config = result.data;
  // Its requests are read only through the operator API: without it every workspace would wait forever.
  if (config.MACHINE_PROVISIONING === "external" && !config.OPERATOR_API_TOKEN) {
    throw new ConfigError(["MACHINE_PROVISIONING=external needs OPERATOR_API_TOKEN"]);
  }
  const site = new URL(config.PUBLIC_URL);
  if (OFFICIAL_HOSTS.has(site.hostname)) {
    if (raw.LANDING_PAGE === undefined) config.LANDING_PAGE = true;
    config.TERMS_URL ??= `${site.origin}/terms`;
    config.PRIVACY_URL ??= `${site.origin}/privacy`;
  }
  return config;
}

/** Returns a copy of the config safe to log: secret values are masked. */
export function redactConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      const def = envVars[key as keyof typeof envVars] as { secret?: boolean };
      return [key, def.secret ? "********" : value];
    }),
  );
}

/**
 * Config for tests: fixed secret, no real database. Never use outside tests.
 * Lets `bun test` run with no `.env` present.
 */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused/test",
    AGENTES_SECRET: "test-secret-".padEnd(48, "x"),
    PUBLIC_URL: "http://localhost:3000",
    ...overrides,
  });
}
