import { oauthReturnText } from "@agenteschat/client/lib/errors";
import type { TFunction } from "i18next";
import type { ToastStore } from "./toast";

/** The server's callbacks say why a provider's return didn't connect in these parameters (a code, never words). */
const OAUTH_ERRORS = ["connector_error", "github_app_error"];

/**
 * What a provider's return said in the address, as a toast once the app opens: why a connector or the GitHub App
 * didn't connect (that the GitHub account's owner was asked to install is news, not an error), and Gmail's or
 * Outlook's failure that found no workspace (`/?mail=failed`). Takes only its own parameters out of the address.
 */
export function showReturnNotices(t: TFunction, show: ToastStore["show"], location: Location = window.location) {
  const url = new URL(location.href);
  for (const param of OAUTH_ERRORS) {
    const code = url.searchParams.get(param);
    if (code === null) continue;
    show(oauthReturnText(t, code), code === "requested" ? "info" : "error");
    url.searchParams.delete(param);
  }
  if (url.pathname === "/" && url.searchParams.get("mail") === "failed") {
    show(t("mail.failed"), "error");
    url.searchParams.delete("mail");
    url.searchParams.delete("account");
  }
  const next = url.pathname + url.search + url.hash;
  if (next !== location.pathname + location.search + location.hash) window.history.replaceState(null, "", next);
}
