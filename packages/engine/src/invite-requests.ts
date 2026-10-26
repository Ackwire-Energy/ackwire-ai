import type { PubSub } from "@agenteschat/adapters";
import { type Database, eq, inArray, schema } from "@agenteschat/db";
import { sha256 } from "./crypto";
import { emailLocale, emailsByLocale, queueEmail } from "./email";
import { ConflictError, NotFoundError } from "./errors";
import { publishUserEvent } from "./events";
import { adminIds } from "./gateway";
import { can, getMembership } from "./organizations";

const { organizationInvitations, organizationInviteLinks, organizations, users } = schema;

/**
 * Someone opened an expired invitation (or org link) and asks for a new one
 * (public: the token is the proof). The person who invited them is told by
 * email and in the app; if they can no longer invite, the org's admins are.
 * Once per invitation.
 */
export async function requestNewInvitation(
  deps: { db: Database; pubsub?: PubSub },
  publicUrl: string,
  token: string,
  now = new Date(),
) {
  const { db } = deps;
  const hash = sha256(token);
  const [invitation] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.tokenHash, hash));
  let target: { id: string; orgId: string; email: string; inviterId: string | null };
  if (invitation) {
    if (invitation.acceptedAt) throw new ConflictError("This invitation was already accepted");
    if (invitation.expiresAt > now) throw new ConflictError("This invitation is still valid");
    target = {
      id: invitation.id,
      orgId: invitation.orgId,
      email: invitation.email,
      inviterId: invitation.invitedByUserId,
    };
  } else {
    const [link] = await db.select().from(organizationInviteLinks).where(eq(organizationInviteLinks.tokenHash, hash));
    if (!link) throw new NotFoundError("Invitation not found");
    if (!link.revokedAt && link.expiresAt > now) throw new ConflictError("This invitation is still valid");
    target = { id: link.id, orgId: link.orgId, email: "", inviterId: link.createdByUserId };
  }
  const inviter = target.inviterId ? await getMembership(db, target.inviterId, target.orgId) : null;
  const recipientIds =
    inviter && target.inviterId && can(inviter.role, "manage_members")
      ? [target.inviterId]
      : await adminIds(db, target.orgId);
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, target.orgId));
  if (!org || recipientIds.length === 0) return;
  const people = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, recipientIds));
  const groups = emailsByLocale(
    people.map((p) => ({ email: p.email, locale: emailLocale(p.locale) })),
    `invite-request:${target.id}`,
  );
  for (const { locale, to, key } of groups) {
    await queueEmail(db, {
      orgId: target.orgId,
      key,
      to,
      template: {
        kind: "invite_request",
        locale,
        orgName: org.name,
        email: target.email,
        url: `${publicUrl.replace(/\/$/, "")}/org/${target.orgId}/settings/members`,
      },
    });
  }
  for (const userId of recipientIds) {
    await publishUserEvent(deps.pubsub, target.orgId, userId, {
      type: "invitation.renewal_requested",
      invitationId: target.id,
      email: target.email || null,
    });
  }
}
