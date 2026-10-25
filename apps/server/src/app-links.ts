import type { Config } from "@agenteschat/config";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Links that open the phone app: an invitation (`/invite/{token}`) and "Esqueci a senha"
 * (`/reset-password?token=`) open straight in the app when it is installed (iOS universal links, Android App
 * Links); without the app they stay links to the website, which handles both. The files below are what iOS
 * and Android fetch from our domain to trust the app with those paths.
 */
export const APP_LINK_PATHS = ["/invite/*", "/reset-password"];

/** `apple-app-site-association`: the iOS app (team + bundle id) handles these paths. Null when not configured. */
export function appleAppSiteAssociation(config: Pick<Config, "APPLE_TEAM_ID" | "APPLE_APP_BUNDLE_ID">) {
  if (!config.APPLE_TEAM_ID || !config.APPLE_APP_BUNDLE_ID) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [`${config.APPLE_TEAM_ID}.${config.APPLE_APP_BUNDLE_ID}`],
          components: APP_LINK_PATHS.map((path) => ({ "/": path })),
        },
      ],
    },
  };
}

/** `assetlinks.json`: the Android app (package + signing certificates) handles our links. Null when not configured. */
export function androidAssetLinks(config: Pick<Config, "ANDROID_APP_PACKAGE" | "ANDROID_APP_CERT_SHA256">) {
  const fingerprints = (config.ANDROID_APP_CERT_SHA256 ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  if (!config.ANDROID_APP_PACKAGE || fingerprints.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.ANDROID_APP_PACKAGE,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

/** Serves both files at `/.well-known/` (JSON, no redirect, as both platforms require). */
export function registerAppLinks(app: OpenAPIHono, config: Config) {
  app.get("/.well-known/apple-app-site-association", (c) => {
    const body = appleAppSiteAssociation(config);
    return body ? c.json(body) : c.text("Not found", 404);
  });
  app.get("/.well-known/assetlinks.json", (c) => {
    const body = androidAssetLinks(config);
    return body ? c.json(body) : c.text("Not found", 404);
  });
}
