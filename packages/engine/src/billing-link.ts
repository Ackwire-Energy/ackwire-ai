import { createHmac, randomUUID } from "node:crypto";
import { type Database, eq, schema, sql } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { operatorOrg } from "./operator";
import { requirePermission, type UserLocale } from "./organizations";

const { organizations, channels, messages, artifacts, wikiPages, issues } = schema;

/** Where in the app a billing link was opened from: the billing service opens on what it came for (ADR 0079). */
export const BILLING_FROM = [
  "settings",
  "hold",
  "onboarding",
  "new_workspace",
  "invite_full",
  "upload_full",
  "storage",
] as const;
export type BillingFrom = (typeof BILLING_FROM)[number];

export interface BillingLinkClaims {
  aud: "agentes-billing";
  /** Single use on the billing service's side. */
  jti: string;
  /** Seconds. */
  iat: number;
  exp: number;
  orgId: string;
  orgName: string;
  userId: string;
  email: string;
  name: string;
  role: "owner" | "admin";
  locale: UserLocale;
  from: BillingFrom;
  /** The path on this server the billing service sends the person back to. */
  return: string;
  /**
   * What the workspace holds, as counts only (`totalsOf`). `storageBytes` null: the workspace keeps its files on its
   * own bucket.
   */
  usage: {
    members: number;
    agents: number;
    storageBytes: number | null;
    messages: number;
    channels: number;
    files: number;
    wikiPages: number;
    issues: number;
    /** When the workspace was created, in seconds. */
    since: number;
  };
}

/** How long a link opens the billing service: minted on click, it only has to reach the next page. */
export const BILLING_LINK_SECONDS = 300;

/**
 * `v1.<claims as base64url JSON>.<base64url HMAC-SHA256 of "v1.<claims>">`. The billing service checks the
 * signature over the payload exactly as sent, never over claims it serialized again.
 */
export function signBillingLink(secret: string, claims: BillingLinkClaims): string {
  const signed = `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

/** Where under the workspace each entry point sends people back (the onboarding's opens it again at its AI step). */
const RETURN_TO: Partial<Record<BillingFrom, string>> = {
  settings: "/settings/billing",
  storage: "/settings/storage",
  invite_full: "/members",
  onboarding: "/onboarding",
};

/**
 * What a workspace holds, for the billing service's pages (ADR 0079 §3): workspace-wide counts, never a name, a word of
 * content, or a figure per channel or person. Messages are those of every conversation a person can read (an
 * agent-only room has no `u:` in its key, as `isAgentOnlyDm` reads it), counted per conversation on each month's
 * `(channel_id, created_at)` index without reading a row: no index of `messages` starts with `org_id` (ADR 0009).
 */
const totalsOf = (orgId: string) => ({
  messages: sql<number>`(select coalesce(sum(per.n), 0) from ${channels} c,
      lateral (select count(*) as n from ${messages} m where m.channel_id = c.id) per
    where c.org_id = ${orgId} and (c.kind <> 'dm' or c.dm_key like '%u:%'))`.mapWith(Number),
  channels: sql<number>`(select count(*) from ${channels} where ${channels.orgId} = ${orgId}
    and ${channels.kind} = 'channel' and ${channels.archivedAt} is null)`.mapWith(Number),
  files: sql<number>`(select count(*) from ${artifacts} where ${artifacts.orgId} = ${orgId}
    and ${artifacts.deletedAt} is null)`.mapWith(Number),
  wikiPages: sql<number>`(select count(*) from ${wikiPages} where ${wikiPages.orgId} = ${orgId}
    and ${wikiPages.deletedAt} is null)`.mapWith(Number),
  issues: sql<number>`(select count(*) from ${issues} where ${issues.orgId} = ${orgId}
    and ${issues.status} <> 'canceled')`.mapWith(Number),
});

/**
 * A signed link to the workspace's plan and billing on the billing service, for its owners and admins. A
 * suspended workspace refuses it (`org.suspended`); a held one doesn't, since paying is how a billing hold ends.
 */
export async function mintBillingLink(
  db: Database,
  input: { secret: string; baseUrl: string; userId: string; orgId: string; from: BillingFrom; now?: Date },
): Promise<{ url: string; expiresAt: Date }> {
  const { userId, orgId, from } = input;
  const membership = await requirePermission(db, userId, orgId, "manage_billing");
  const [org, [user], [totals]] = await Promise.all([
    operatorOrg(db, orgId),
    db
      .select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
    db.select(totalsOf(orgId)).from(organizations).where(eq(organizations.id, orgId)),
  ]);
  if (!org || !user || !totals) throw new Error("billing link: the workspace or the account is gone");
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const exp = iat + BILLING_LINK_SECONDS;
  const token = signBillingLink(input.secret, {
    aud: "agentes-billing",
    jti: randomUUID(),
    iat,
    exp,
    orgId,
    orgName: org.name,
    userId,
    email: user.email,
    name: user.name,
    role: membership.role === "owner" ? "owner" : "admin",
    locale: appLocale([user.locale], true) ?? "en",
    from,
    return: `/org/${orgId}${RETURN_TO[from] ?? ""}`,
    usage: {
      members: org.counts.members,
      agents: org.counts.agents,
      storageBytes: org.meters.ownStorage ? null : org.meters.storageBytes,
      ...totals,
      since: Math.floor(org.createdAt.getTime() / 1000),
    },
  });
  return { url: `${input.baseUrl.replace(/\/+$/, "")}/link?t=${token}`, expiresAt: new Date(exp * 1000) };
}
