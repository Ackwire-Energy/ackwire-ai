import type { JoinRequest } from "@agenteschat/client";
import { askedLabel } from "@agenteschat/client/lib/join-requests";
import type { TFunction } from "i18next";

/**
 * A request to join's chips, as on the web: "Not verified" only where nobody proved the address (a server without
 * email, or a request typed before codes), then when it was asked. A server from before codes sends only
 * `confirmed`, which meant the same there.
 */
export function requestChips(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "createdAt" | "verified" | "confirmed">,
  now = new Date(),
): { unverified: string | null; asked: string } {
  return {
    unverified: (r.verified ?? r.confirmed) ? null : t("members.requests.unverified"),
    asked: askedLabel(t, locale, r.createdAt, now),
  };
}

/** The people of the workspace as Membros lists them: by name, in the person's language's order. */
export function membersByName<M extends { name: string }>(members: readonly M[], locale?: string): M[] {
  return [...members].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: "base" }));
}
