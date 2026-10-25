/** Where the confirmation email's link lands (the sign-up's `callbackURL`); Better Auth adds `error=` when it fails. */
export const EMAIL_CONFIRMED_PATH = "/?email_confirmed=1";

/** The toast for a page opened from that link, or null: the address is confirmed, or the link no longer works. */
export function emailConfirmedToast(
  search: string,
): { key: "auth.emailConfirmed" | "auth.emailLinkExpired"; tone: "info" | "error" } | null {
  const params = new URLSearchParams(search);
  if (!params.has("email_confirmed")) return null;
  return params.has("error")
    ? { key: "auth.emailLinkExpired", tone: "error" }
    : { key: "auth.emailConfirmed", tone: "info" };
}
