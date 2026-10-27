import { formatShortDate } from "@agenteschat/client/lib/format";
import { askedLabel } from "@agenteschat/client/lib/join-requests";
import type { TFunction } from "i18next";

/** A request to join's two times, a line each as on the web: when it was asked, then when it closes unanswered. */
export function requestTimes(
  t: TFunction,
  locale: string,
  r: { createdAt: string; expiresAt: string },
  now = new Date(),
): [asked: string, closes: string] {
  return [
    askedLabel(t, locale, r.createdAt, now),
    t("members.requests.via", { date: formatShortDate(locale, r.expiresAt) }),
  ];
}

/** The people of the workspace as Membros lists them: by name, in the person's language's order. */
export function membersByName<M extends { name: string }>(members: readonly M[], locale?: string): M[] {
  return [...members].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: "base" }));
}
