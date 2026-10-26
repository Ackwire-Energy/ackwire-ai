import type { Me, OrgSummary } from "../api/types";

/** Only same-site relative redirects (no open redirect to other hosts). */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : undefined;
}

/** The sign-in page that comes back to `redirect`, with the address the page before already knew filled in. */
export const signInPath = (redirect: string, email?: string) =>
  `/login?${new URLSearchParams({ redirect, ...(email ? { email } : {}) })}`;

/**
 * Where a sign-in leads, read from its `redirect` alone so the page can say it: an invitation (by its token, which
 * that address already holds), connecting an AI or creating an agent (the ready email's buttons). Null for anywhere
 * else.
 */
export function signInFor(
  redirect: string | undefined,
): { invite: string } | { connect: "ai" } | { create: "agent" } | null {
  if (!redirect) return null;
  const url = new URL(redirect, "http://localhost");
  const invite = /^\/invite\/([^/]+)$/.exec(url.pathname)?.[1];
  if (invite) return { invite };
  if (/^\/org\/[^/]+\/agents\/new$/.test(url.pathname)) return { create: "agent" };
  return url.searchParams.get("connect") === "ai" ? { connect: "ai" } : null;
}

/** Where `/` sends a signed-in person: last organization, the first one, or onboarding. */
export function landingFor(me: Me, lastOrgId: string | null): { to: "/onboarding" } | { orgId: string } {
  if (me.organizations.length === 0) return { to: "/onboarding" };
  const org = me.organizations.find((o) => o.id === lastOrgId) ?? (me.organizations[0] as OrgSummary);
  return { orgId: org.id };
}

/** The membership for an org route, or null when the person isn't a member. */
export const membershipIn = (me: Me, orgId: string) => me.organizations.find((o) => o.id === orgId) ?? null;
