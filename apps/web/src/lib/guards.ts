import type { Me, OrgSummary } from "@/api/types";

/** Only same-site relative redirects (no open redirect to other hosts). */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : undefined;
}

/** Where `/` sends a signed-in person: last organization, the first one, or onboarding. */
export function landingFor(me: Me, lastOrgId: string | null): { to: "/onboarding" } | { orgId: string } {
  if (me.organizations.length === 0) return { to: "/onboarding" };
  const org = me.organizations.find((o) => o.id === lastOrgId) ?? (me.organizations[0] as OrgSummary);
  return { orgId: org.id };
}

/** The membership for an org route, or null when the person isn't a member. */
export const membershipIn = (me: Me, orgId: string) => me.organizations.find((o) => o.id === orgId) ?? null;
