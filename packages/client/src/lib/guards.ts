import type { Me, OrgSummary } from "../api/types";

const SAME_ORIGIN = "https://x.invalid";
/** Control characters (browsers drop tabs and newlines, so `/\t/evil.com` becomes `//evil.com`) or a backslash. */
const unsafeChars = (text: string) =>
  [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || ch === "\\";
  });

/**
 * Only same-site relative redirects (no open redirect to other hosts): parsed against a placeholder origin that
 * must stay the origin, refused when the path (also decoded) has control characters or a backslash or starts with
 * `//`. Returns the normalized path, query and fragment.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || unsafeChars(value)) return undefined;
  let url: URL;
  let decoded: string;
  try {
    url = new URL(value, SAME_ORIGIN);
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (url.origin !== SAME_ORIGIN || url.pathname.startsWith("//") || decoded.startsWith("//") || unsafeChars(decoded))
    return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `value` when it is an http(s) address, the only links the apps open from data agents or people wrote. */
export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The password sign-up's header with an early-access link's token (mirrors `packages/engine/src/early-access.ts`). */
export const EARLY_ACCESS_HEADER = "x-early-access";

/** An early-access link's token (`/signup?access=`), only in the shape the server makes: 43 base64url characters. */
export const earlyAccessToken = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;

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

/**
 * A workspace this person made and hasn't finished setting up: the apps open its onboarding, which resumes it,
 * instead of the workspace. Never one they were invited into.
 */
export const settingUp = (org: OrgSummary) => org.role === "owner" && org.onboarding !== undefined;

/**
 * Where `/` sends a signed-in person: the last organization, or the first one, of those set up; with none, the
 * onboarding (which resumes the one they are setting up).
 */
export function landingFor(me: Me, lastOrgId: string | null): { to: "/onboarding" } | { orgId: string } {
  const ready = me.organizations.filter((o) => !settingUp(o));
  const org = ready.find((o) => o.id === lastOrgId) ?? ready[0];
  return org ? { orgId: org.id } : { to: "/onboarding" };
}

/** The membership for an org route, or null when the person isn't a member. */
export const membershipIn = (me: Me, orgId: string) => me.organizations.find((o) => o.id === orgId) ?? null;
