import {
  acceptInvitation,
  appleSignInTokens,
  avatarFile,
  changeMemberRole,
  countUsers,
  createInvitation,
  createOrganization,
  deleteAccount,
  getOrganization,
  isValidTimeZone,
  listInvitations,
  listMembers,
  listMemberships,
  orgLogoFile,
  previewInvitation,
  queueInvitationEmail,
  removeAvatar,
  removeMember,
  removeOrgLogo,
  requirePermission,
  revokeInvitation,
  setAvatar,
  setMyLocale,
  setOrgLogo,
  signInOptions,
  updateOrganization,
  updateOrgSettings,
  USER_LOCALES,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { authUiConfig } from "../../auth";
import { clientIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  iso,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { Invitation, Member, Organization, Role } from "./schemas";

const tags = ["Account"];
/** E-mail lookups on the sign-in screen: enough for typos and a few accounts, not for listing who has one. */
const SIGN_IN_OPTIONS_PER_IP = { limit: 30, windowMs: 10 * 60_000 };
const Name = z.string().trim().min(1).max(100);
const Context = z.string().max(20_000).openapi({ description: "Shared with every agent of the organization." });

/** Account, organizations, members and invitations. */
export function accountRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  const session = requireSession(deps.auth);
  for (const path of [
    "/me",
    "/account",
    "/avatars/*",
    "/org-logos/*",
    "/organizations",
    "/organizations/*",
    "/invitations/:token/accept",
  ])
    app.use(path, session);

  // ── Public ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/auth-config",
      tags,
      summary: "Sign-in options for the login page",
      responses: {
        200: json(
          z.object({
            socialProviders: z.object({ google: z.boolean(), github: z.boolean(), apple: z.boolean() }),
            signupOpen: z
              .boolean()
              .openapi({ description: "Offer the sign-up form (invited people can always sign up)." }),
            firstRun: z.boolean().openapi({ description: "No account exists yet: show first-run setup." }),
            passwordReset: z.boolean().openapi({ description: "Offer \"forgot password\" (e-mail is configured)." }),
          }),
        ),
      },
    }),
    async (c) => {
      const users = await countUsers(db);
      return c.json(
        {
          ...authUiConfig(config),
          signupOpen: config.ALLOW_SIGNUP || users === 0,
          firstRun: users === 0,
          passwordReset: deps.adapters.email.delivers === true,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/sign-in-options",
      tags,
      summary: "How an e-mail signs in (the login screen asks for the e-mail first)",
      description: "Tells whether the e-mail has an account, so it is rate limited per IP.",
      request: {
        body: body(
          z.object({
            email: z.email().max(254),
            inviteToken: z.string().min(1).max(200).optional().openapi({ description: "From an org invite link." }),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            account: z.boolean(),
            password: z.boolean().openapi({ description: "The account has a password." }),
            providers: z.array(z.enum(["google", "github", "apple"])).openapi({ description: "Social sign-ins linked." }),
            canSignUp: z.boolean().openapi({ description: "No account, and this e-mail may create one." }),
          }),
        ),
        429: errorResponse("Too many attempts (`rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const ip = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"));
      const limit = await deps.adapters.rateLimiter.consume(`sign-in-options:${ip}`, SIGN_IN_OPTIONS_PER_IP);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again later");
      const { email, inviteToken } = c.req.valid("json");
      return c.json(await signInOptions(db, email, config.ALLOW_SIGNUP, inviteToken), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/invitations/{token}",
      tags,
      summary: "Preview an invitation",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: json(
          z.object({
            orgName: z.string(),
            email: z.string().openapi({ description: "Empty for an org-wide invite link." }),
            role: Role,
            kind: z.enum(["email", "link"]),
          }),
        ),
        404: errors[404],
      },
    }),
    async (c) => {
      const invitation = await previewInvitation(db, c.req.valid("param").token);
      return invitation ? c.json(invitation, 200) : apiError(c, 404, "not_found", "Invitation not found or expired");
    },
  );

  // ── Signed in ─────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags,
      security,
      summary: "The signed-in person and their organizations",
      responses: {
        200: json(
          z.object({
            user: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() }),
            organizations: z.array(Organization),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const user = c.get("user");
      const memberships = await listMemberships(db, user.id);
      return c.json(
        {
          user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
          organizations: memberships.map((m) => ({
            id: m.orgId,
            name: m.orgName,
            role: m.role,
            logo: m.orgLogo ?? null,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me",
      tags,
      security,
      summary: "Change your app language",
      description: "The language of the emails and pushes sent to you. The onboarding saves the one in use.",
      request: { body: body(z.object({ locale: z.enum(USER_LOCALES) })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await setMyLocale(db, c.get("user").id, c.req.valid("json").locale);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/account",
      tags,
      security,
      summary: "Delete your account",
      description:
        "Deletes the signed-in person, their sessions, phones and memberships, and the organizations where they are the only member. Messages they wrote stay without an author. Refused with `sole_owner` (params: `organizations`, their names) while they are the only owner of an organization that has other members.",
      responses: {
        204: { description: "Deleted; the session cookies are cleared" },
        401: errors[401],
        409: errorResponse("Only owner of an organization with other members (`sole_owner`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      // Read before the account goes (its sign-in rows are deleted with it).
      const revoke = deps.extras?.appleRevoke;
      const appleTokens = revoke ? await appleSignInTokens(db, user.id) : [];
      await deleteAccount(db, user.id, { pubsub: deps.adapters.pubsub });
      // Apple wants its tokens revoked when the account is deleted (best effort: the account is already gone).
      if (revoke) await Promise.all(appleTokens.map((token) => revoke(token).catch(() => undefined)));
      // Their photo files (best effort: the account is already gone).
      const blobs = deps.adapters.platformBlobs;
      const photos = await blobs.list(`avatars/${user.id}/`).catch(() => [] as string[]);
      await Promise.all(photos.map((key) => blobs.delete(key).catch(() => undefined)));
      for (const cookie of expiredSessionCookies()) c.header("set-cookie", cookie, { append: true });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/me/avatar",
      tags,
      security,
      summary: "Set your photo (JPEG, PNG or WebP up to 2 MB; metadata is removed). It is yours in every organization.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            imageBase64: z
              .string()
              .min(1)
              .max(3_000_000)
              .openapi({ description: "The image bytes in base64 (a data: URL prefix is accepted)." }),
            contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          }),
        ),
      },
      responses: {
        200: json(z.object({ avatarUrl: z.string() })),
        429: errorResponse("Too many photo changes"),
        ...errors,
      },
    }),
    async (c) => {
      const user = c.get("user");
      await requirePermission(db, user.id, c.req.valid("param").orgId, "read");
      const limit = await deps.adapters.rateLimiter.consume(`avatar:${user.id}`, { limit: 10, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many photo changes; try again later");
      return c.json(await setAvatar({ db, blobs: deps.adapters.platformBlobs }, user.id, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/me/avatar",
      tags,
      security,
      summary: "Remove your photo (back to initials)",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      await removeAvatar({ db, blobs: deps.adapters.platformBlobs }, c.get("user").id);
      return c.body(null, 204);
    },
  );

  // The workspace logo: an admin uploads it; every member sees it.
  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/logo",
      tags,
      security,
      summary: "Set the workspace logo (JPEG, PNG or WebP up to 2 MB; metadata is removed). Admins.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            imageBase64: z
              .string()
              .min(1)
              .max(3_000_000)
              .openapi({ description: "The image bytes in base64 (a data: URL prefix is accepted)." }),
            contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          }),
        ),
      },
      responses: {
        200: json(z.object({ logo: z.string() })),
        429: errorResponse("Too many logo changes"),
        ...errors,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      await requirePermission(db, user.id, orgId, "configure");
      const limit = await deps.adapters.rateLimiter.consume(`org-logo:${orgId}`, { limit: 20, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many logo changes; try again later");
      return c.json(
        await setOrgLogo({ db, blobs: deps.adapters.platformBlobs }, user.id, orgId, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/logo",
      tags,
      security,
      summary: "Remove the workspace logo (back to the agent mark). Admins.",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await removeOrgLogo({ db, blobs: deps.adapters.platformBlobs }, c.get("user").id, c.req.valid("param").orgId);
      return c.body(null, 204);
    },
  );

  // The logo file, for the org's members (content-hash names: cached for good).
  app.get("/org-logos/:orgId/:file", async (c) => {
    const file = await orgLogoFile(
      { db, blobs: deps.adapters.platformBlobs },
      c.get("user").id,
      c.req.param("orgId"),
      c.req.param("file"),
    );
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  // A person's photo, for people who share an organization with them. The file
  // name is a content hash, so a new photo gets a new URL and the old one can be cached.
  app.get("/avatars/:userId/:file", async (c) => {
    const file = await avatarFile(
      { db, blobs: deps.adapters.platformBlobs },
      c.get("user").id,
      c.req.param("userId"),
      c.req.param("file"),
    );
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations",
      tags,
      security,
      summary: "Create an organization (you become its owner)",
      request: {
        body: body(
          z.object({
            name: Name,
            context: Context.optional(),
            teamSize: z.enum(["solo", "small", "medium", "large"]).optional(),
            timezone: z.string().max(64).optional().openapi({ description: "IANA zone, e.g. America/Sao_Paulo." }),
          }),
        ),
      },
      responses: {
        201: json(z.object({ organization: Organization, generalChannelId: z.uuid() }), "Created"),
        ...errors,
      },
    }),
    async (c) => {
      const { teamSize, timezone, ...input } = c.req.valid("json");
      const { organization, general } = await createOrganization(db, c.get("user").id, input);
      if (teamSize || (timezone && isValidTimeZone(timezone))) {
        await updateOrgSettings(db, c.get("user").id, organization.id, {
          ...(teamSize ? { teamSize } : {}),
          ...(timezone && isValidTimeZone(timezone) ? { timezone } : {}),
        });
      }
      return c.json(
        {
          organization: {
            id: organization.id,
            name: organization.name,
            role: "owner" as const,
            context: organization.context,
          },
          generalChannelId: general.id,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}",
      tags,
      security,
      summary: "An organization you belong to",
      request: { params: OrgParams },
      responses: { 200: json(Organization), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const membership = await requirePermission(db, c.get("user").id, orgId, "read");
      const org = await getOrganization(db, orgId);
      return c.json(
        {
          id: orgId,
          name: membership.orgName,
          role: membership.role,
          context: org?.context ?? "",
          logo: org?.logo ?? null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}",
      tags,
      security,
      summary: "Rename or change the organization context",
      request: { params: OrgParams, body: body(z.object({ name: Name.optional(), context: Context.optional() })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await updateOrganization(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/members",
      tags,
      security,
      summary: "People in the organization",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ members: z.array(Member) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const members = await listMembers(db, orgId);
      return c.json({ members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })) }, 200);
    },
  );

  const MemberParams = OrgParams.extend({ userId: z.string() });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/members/{userId}",
      tags,
      security,
      summary: "Change a member's role",
      request: { params: MemberParams, body: body(z.object({ role: Role })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await changeMemberRole(db, c.get("user").id, orgId, userId, c.req.valid("json").role);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/members/{userId}",
      tags,
      security,
      summary: "Remove a member (or leave)",
      request: { params: MemberParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await removeMember(db, c.get("user").id, orgId, userId, { pubsub: deps.adapters.pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/invitations",
      tags,
      security,
      summary: "Pending invitations",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ invitations: z.array(Invitation) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "manage_members");
      const rows = await listInvitations(db, orgId);
      return c.json(
        {
          invitations: rows.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            expiresAt: i.expiresAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invitations",
      tags,
      security,
      summary: "Invite someone by email",
      description: "Returns the invitation link to share. Only a hash of its token is stored.",
      request: { params: OrgParams, body: body(z.object({ email: z.email(), role: Role })) },
      responses: { 201: json(z.object({ invitation: Invitation, url: z.string() }), "Created"), ...errors },
    }),
    async (c) => {
      const { invitation, token } = await createInvitation(
        db,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      const url = `${config.PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`;
      await queueInvitationEmail(db, {
        orgId: invitation.orgId,
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        url,
        inviterId: c.get("user").id,
      });
      deps.wakeWorkers?.();
      return c.json(
        {
          invitation: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            expiresAt: iso(invitation.expiresAt) ?? "",
          },
          url,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/invitations/{invitationId}",
      tags,
      security,
      summary: "Revoke an invitation",
      request: { params: OrgParams.extend({ invitationId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, invitationId } = c.req.valid("param");
      await revokeInvitation(db, c.get("user").id, orgId, invitationId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/accept",
      tags,
      security,
      summary: "Accept an invitation (signed in with the invited email)",
      request: { params: z.object({ token: z.string() }) },
      responses: { 200: json(z.object({ orgId: z.uuid() })), ...errors },
    }),
    async (c) => c.json(await acceptInvitation(db, c.get("user"), c.req.valid("param").token), 200),
  );

  return app;
}

/** Better Auth's session cookies, expired (plain and `__Secure-` names, as on http and https). */
function expiredSessionCookies() {
  const cookies: string[] = [];
  for (const prefix of ["", "__Secure-"]) {
    const secure = prefix ? "; Secure" : "";
    for (const name of ["session_token", "session_data", "dont_remember"])
      cookies.push(`${prefix}better-auth.${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
  return cookies;
}
