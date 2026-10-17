import type { Config } from "./schema";

/** OAuth apps of the connectors configured in this deployment (by connector id). */
export function connectorOAuthApps(
  config: Config,
): Record<string, { clientId: string; clientSecret: string } | undefined> {
  const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
  return {
    github: pair(config.CONNECTOR_GITHUB_CLIENT_ID, config.CONNECTOR_GITHUB_CLIENT_SECRET),
    sentry: pair(config.CONNECTOR_SENTRY_CLIENT_ID, config.CONNECTOR_SENTRY_CLIENT_SECRET),
    linear: pair(config.CONNECTOR_LINEAR_CLIENT_ID, config.CONNECTOR_LINEAR_CLIENT_SECRET),
    drive: pair(config.CONNECTOR_GOOGLE_CLIENT_ID, config.CONNECTOR_GOOGLE_CLIENT_SECRET),
  };
}

/** Our GitHub App (git and PRs; ADR 0033), or null when `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` aren't set. */
export function githubAppConfig(config: Config) {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) return null;
  return {
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
    slug: config.GITHUB_APP_SLUG,
    clientId: config.GITHUB_APP_CLIENT_ID,
    clientSecret: config.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: config.GITHUB_APP_WEBHOOK_SECRET,
  };
}
