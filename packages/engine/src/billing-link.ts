import { createHmac, randomUUID } from "node:crypto";
import { type Database, eq, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { operatorOrg } from "./operator";
import { requirePermission, type UserLocale } from "./organizations";

/** Where in the app a billing link was opened from: the billing service opens on what it came for (ADR 0077). */
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
  /** `storageBytes` null: the workspace keeps its files on its own bucket. */
  usage: { members: number; agents: number; storageBytes: number | null };
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

const RETURN_TO: Partial<Record<BillingFrom, string>> = {
  settings: "/settings/billing",
  storage: "/settings/storage",
  invite_full: "/members",
};

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
  const [org, [user]] = await Promise.all([
    operatorOrg(db, orgId),
    db
      .select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
  ]);
  if (!org || !user) throw new Error("billing link: the workspace or the account is gone");
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
    locale: appLocale([user.locale]) ?? "pt-BR",
    from,
    return: `/org/${orgId}${RETURN_TO[from] ?? ""}`,
    usage: {
      members: org.counts.members,
      agents: org.counts.agents,
      storageBytes: org.meters.ownStorage ? null : org.meters.storageBytes,
    },
  });
  return { url: `${input.baseUrl.replace(/\/+$/, "")}/link?t=${token}`, expiresAt: new Date(exp * 1000) };
}
