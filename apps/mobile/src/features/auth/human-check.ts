import { ApiError } from "@agenteschat/client";
import { ACCOUNT_BLOCKED, knownErrorText } from "@agenteschat/client/lib/errors";
import {
  type createHumanCheck,
  HUMAN_CHECK_BLOCKED,
  type HumanAction,
  isHumanCheckRefusal,
} from "@agenteschat/client/lib/human-check";
import type { TFunction } from "i18next";

/** Where Turnstile's script and its frame come from. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * What the check's WebView loads in place (its `originWhitelist`): the server's own page, Turnstile's frame and the
 * blank documents frames start as. react-native-webview opens any other address in the browser and blocks it,
 * frames included, so without Cloudflare's origin every check would open a browser tab and never load.
 */
export function humanCheckOrigins(server: string): string[] {
  return ["about:blank", "about:srcdoc", new URL(server).origin, TURNSTILE_ORIGIN];
}

/** The server's `/human-check.html` for one action, in the app's theme and language: Cloudflare sees the server's host. */
export function humanCheckUrl(
  server: string,
  widget: { siteKey: string; action: HumanAction; theme: "light" | "dark"; language: string },
): string {
  const query = new URLSearchParams({ k: widget.siteKey, a: widget.action, t: widget.theme, l: widget.language });
  return `${server}/human-check.html?${query.toString()}`;
}

/** What the check's page says (`human-check.html`): `error` without a code means Turnstile's script didn't load. */
export type HumanCheckEvent =
  | { type: "token"; token: string }
  | { type: "expired" }
  | { type: "error"; code?: string }
  | { type: "interactive" }
  | { type: "done" };

/** One message from the page, or null for anything else (another frame's, or not JSON). */
export function humanCheckEvent(data: string): HumanCheckEvent | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, token, code } = message as Record<string, unknown>;
  switch (type) {
    case "token":
      return typeof token === "string" && token !== "" ? { type, token } : null;
    case "error": {
      const said = typeof code === "number" ? String(code) : code;
      return typeof said === "string" && said !== "" ? { type, code: said } : { type };
    }
    case "expired":
    case "interactive":
    case "done":
      return { type };
    default:
      return null;
  }
}

/**
 * Where the check's page stands. `asking`: Cloudflare waits for the person's click. `broken`: the page or
 * Turnstile's script didn't load, so every call goes with `unavailable` until the page loads again.
 */
export interface CheckPage {
  asking: boolean;
  broken: boolean;
}

export const FRESH_PAGE: CheckPage = { asking: false, broken: false };

/** One event of the page, handed to the widget's tokens: the page's state after it. */
export function checkEvent(
  tokens: ReturnType<typeof createHumanCheck>,
  page: CheckPage,
  event: HumanCheckEvent,
): CheckPage {
  switch (event.type) {
    case "token":
      tokens.give(event.token);
      return { asking: false, broken: false };
    case "expired":
      tokens.expire();
      return page;
    case "error":
      tokens.fail(event.code);
      return { asking: false, broken: page.broken || event.code === undefined };
    case "interactive":
      // A call waits for the click however long it takes, since the check did load.
      tokens.hold();
      return { ...page, asking: true };
    case "done":
      return { ...page, asking: false };
  }
}

/** A guarded call the person stopped in the check's sheet: nothing to say, they can press again. */
export class CheckCancelled extends Error {}

/**
 * A refused request in the phone's words: the bot check's blocked line names no browser (the app has none to
 * switch to), then a blocked account, a known code, too many tries, else the generic line. Never the server's text.
 */
export function refusalText(t: TFunction, refusal: { status: number; code?: string | null }): string {
  if (refusal.code === HUMAN_CHECK_BLOCKED) return t("mobile.humanCheck.blocked");
  if (refusal.code === ACCOUNT_BLOCKED) return t("auth.accountBlocked");
  const error = refusal instanceof ApiError ? refusal : new ApiError(refusal.status, refusal.code ?? "", "");
  return knownErrorText(t, error) ?? t(refusal.status === 429 ? "auth.tooManyTries" : "mobile.auth.errors.generic");
}

/** A failed call to the app's API in the phone's words: the server's refusal, else no connection. */
export const failureText = (t: TFunction, error: unknown) =>
  error instanceof ApiError ? refusalText(t, error) : t("mobile.auth.errors.network");

/** Better Auth's answer as a refusal `withHumanCheck` reads (its status and code on top), or null when it passed. */
export const refusalOf = ({ error }: { error: { status: number; code?: string } | null }) =>
  error ? { status: error.status, code: error.code } : null;

/** A refused sign-up means sign-up is closed only when it is a 403 that isn't the bot check's. */
export const signUpClosed = (refusal: { status: number; code?: string | null }) =>
  refusal.status === 403 && !isHumanCheckRefusal(refusal.code ?? undefined);
