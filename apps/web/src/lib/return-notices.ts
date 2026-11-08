import { oauthReturnText } from "@agenteschat/client/lib/errors";
import type { TFunction } from "i18next";
import type { ToastStore } from "./toast";

/** The server's callbacks say why a provider's return didn't connect in these parameters (a code, never words). */
const OAUTH_ERRORS = ["connector_error", "github_app_error"];

/** What GitHub's return did (`?github_app=`): the agentes.chat app installed, or the server's own app made. */
const GITHUB_APP_DONE = { installed: "githubApp.installed", created: "githubApp.server.created" } as const;

/**
 * What a provider's return said in the address, as a toast once the app opens, on whatever page it lands: why a
 * connector or the GitHub App didn't connect (that the GitHub account's owner was asked to install is news, not an
 * error), that the GitHub App was installed or made, and Gmail's or Outlook's failure that found no workspace
 * (`/?mail=failed`). Takes only its own parameters out of the address.
 */
export function showReturnNotices(t: TFunction, show: ToastStore["show"], location: Location = window.location) {
  const url = new URL(location.href);
  for (const param of OAUTH_ERRORS) {
    const code = url.searchParams.get(param);
    if (code === null) continue;
    show(oauthReturnText(t, code), code === "requested" ? "info" : "error");
    url.searchParams.delete(param);
  }
  const done = url.searchParams.get("github_app");
  if (done !== null && Object.hasOwn(GITHUB_APP_DONE, done)) {
    show(t(GITHUB_APP_DONE[done as keyof typeof GITHUB_APP_DONE]));
    url.searchParams.delete("github_app");
  }
  if (url.pathname === "/" && url.searchParams.get("mail") === "failed") {
    show(t("mail.failed"), "error");
    url.searchParams.delete("mail");
    url.searchParams.delete("account");
  }
  const next = url.pathname + url.search + url.hash;
  if (next !== location.pathname + location.search + location.hash) window.history.replaceState(null, "", next);
}
