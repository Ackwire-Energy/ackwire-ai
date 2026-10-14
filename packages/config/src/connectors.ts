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
