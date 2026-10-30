import type { JoinRequest, Member, OrgRole } from "@agenteschat/client";
import { askedLabel } from "@agenteschat/client/lib/join-requests";
import { rolesOf } from "@agenteschat/client/lib/roles";
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

/**
 * A person's roles on Membros (ADR 0084): "Dono" first for an owner, then their roles top first, joined; nothing for
 * someone with no role (what everyone may do goes without saying).
 */
export function roleLine(
  t: TFunction,
  person: Pick<Member, "role" | "roleIds">,
  roles: readonly OrgRole[],
): string | undefined {
  const names = [...(person.role === "owner" ? [t("roles.owner")] : []), ...rolesOf(person, roles).map((r) => r.name)];
  return names.length > 0 ? names.join(" · ") : undefined;
}
