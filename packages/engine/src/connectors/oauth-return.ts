/**
 * Where a connector's OAuth round trip lands. The web app: a path on our site (the callback finishes with the
 * browser's session). The phone app: the system browser has no session of ours, so the callback hands the
 * code and state back to the app (`APP_OAUTH_REDIRECT`), and the app finishes with its own session
 * (`POST …/connectors/oauth/complete`): the state is still bound to the person who started it, so a code
 * caught by anyone else can't be used.
 */

/** Stored as the state's `returnTo` when the phone app started the authorization. */
export const APP_OAUTH_RETURN = "app:connectors";

/** The phone app's deep link (its scheme in apps/mobile/app.config.ts) that receives `state` and `code`. */
export const APP_OAUTH_REDIRECT = "agenteschat://connectors/oauth";

/** A safe `returnTo`: the app's marker, or a path on our site (never another host); "/" otherwise. */
export function oauthReturnTo(input: string | undefined): string {
  if (input === APP_OAUTH_RETURN) return APP_OAUTH_RETURN;
  return input?.startsWith("/") && !input.startsWith("//") && !input.startsWith("/\\") ? input : "/";
}

/** The authorization was started by the phone app. */
export const isAppReturn = (returnTo: string) => returnTo === APP_OAUTH_RETURN;

/** The app's deep link with what the provider sent back (or why it refused). */
export function appOAuthRedirect(input: { state?: string; code?: string; error?: string }): string {
  const url = new URL(APP_OAUTH_REDIRECT);
  if (input.error) url.searchParams.set("error", input.error);
  if (input.state) url.searchParams.set("state", input.state);
  if (input.code) url.searchParams.set("code", input.code);
  return url.toString();
}
