import {
  acceptInvitation,
  addHostComputer,
  announceMembers,
  appleSignInTokens,
  avatarFile,
  canCreateWorkspace,
  changeMemberRole,
  cloudNotice,
  countUsers,
  createInvitation,
  createOrganization,
  type DeletionDeps,
  deleteAccount,
  getOrganization,
  hasPassword,
  isEmailVerified,
  isValidTimeZone,
  joinStatus,
  listInvitations,
  listMembers,
  listMemberships,
  needsWorkspaceAllowance,
  ONBOARDING_STEPS,
  orgLogoFile,
  previewInvitation,
  queueInvitationEmail,
  removeAvatar,
  removeMember,
  removeOrgLogo,
  requireOwnerToDelete,
  requirePermission,
  restoreWorkspace,
  revokeInvitation,
  saveOnboarding,
  scheduleDeletion,
  setAvatar,
  setMyLocale,
  setOrgLogo,
  settleJoinRequests,
  signInOptions,
  toldReason,
  USER_LOCALES,
  unfinishedWorkspaces,
  updateOrganization,
  updateOrgSettings,
  workspaceDeletions,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  authUiConfig,
  deletionProof,
  mintPhoneSignIn,
  sessionUser,
  signedInLately,
  signupOpen,
  signupPolicy,
  workspacePolicy,
} from "../../auth";
import { requestLimitIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import { humanCheckRefusal } from "../../http/human-check";
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
/** A workspace's deletions in a day: deleting and restoring it over and over can't email its people all day. */
const DELETIONS_PER_DAY = { limit: 3, windowMs: 86_400_000 };
const Name = z.string().trim().min(1).max(100);
const Context = z.string().max(20_000).openapi({ description: "Shared with every agent of the organization." });

/** Account, organizations, members and invitations. */
export function accountRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  const session = requireSession(deps.auth);
  const deletion: DeletionDeps = {
    db,
    pubsub: deps.adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub,
    emails: deps.adapters.email.delivers ? { publicUrl: config.PUBLIC_URL } : null,
  };
  for (const path of [
    "/me",
    "/me/password",
    "/phone-sign-in",
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
            ownerClaim: z.boolean().openapi({
              description: "No account yet, and only the owner link (`OWNER_CLAIM_SHA256`) creates the first one.",
            }),
            passwordReset: z.boolean().openapi({ description: 'Offer "forgot password" (e-mail is configured).' }),
            termsUrl: z
              .string()
              .nullable()
              .openapi({ description: "Terms of service linked on the sign-in screen (TERMS_URL)." }),
            privacyUrl: z
              .string()
              .nullable()
              .openapi({ description: "Privacy policy linked on the sign-in screen (PRIVACY_URL)." }),
            supportEmail: z.string().nullable().openapi({
              description: "Where people write to whoever runs this server (SUPPORT_EMAIL): hold, suspension.",
            }),
            workspaceComputer: z.boolean().openapi({
              description:
                "Every workspace gets a computer of its own (MACHINE_PROVISIONING=external): a new person's setup has none to connect.",
            }),
            billingUrl: z.string().nullable().openapi({
              description:
                "The billing service (BILLING_URL, ADR 0079): owners and admins open a workspace's plan and billing there through `POST …/billing-link`. Null: no billing.",
            }),
            turnstileSiteKey: z.string().nullable().openapi({
              description:
                "The bot check's site key (`TURNSTILE_SITE_KEY`, ADR 0075): pages run Cloudflare Turnstile and send its token in `x-captcha-response`. Null: no check, and nothing loads from Cloudflare.",
            }),
          }),
        ),
      },
    }),
    async (c) => {
      const users = await countUsers(db);
      // The first account of an installation that waits for its owner's link or key is made there, not here.
      const ownerWaits = users === 0 && signupPolicy(config).ownerByLink;
      return c.json(
        {
          ...authUiConfig(config),
          signupOpen: await signupOpen(db, config, users),
          firstRun: users === 0 && !ownerWaits,
          ownerClaim: users === 0 && Boolean(config.OWNER_CLAIM_SHA256),
          passwordReset: deps.adapters.email.delivers === true,
          workspaceComputer: config.MACHINE_PROVISIONING === "external",
          billingUrl: config.BILLING_URL ?? null,
          turnstileSiteKey: deps.adapters.humanCheck?.siteKey ?? null,
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
      description:
        "Tells whether the e-mail has an account, so it is rate limited per IP, and guarded by the bot check when this server has one (`human_check`, `human_check_blocked`).",
      request: {
        body: body(
          z.object({
            email: z.email().max(254),
            access: z.string().max(64).optional().catch(undefined).openapi({
              type: "string",
              maxLength: 64,
              description:
                "The token of an early-access link (`/signup?access=`, ADR 0078), when the page has one. Any other value counts as absent.",
            }),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            account: z.boolean(),
            password: z.boolean().openapi({ description: "The account has a password." }),
            providers: z
              .array(z.enum(["google", "github", "apple"]))
              .openapi({ description: "Social sign-ins linked." }),
            canSignUp: z.boolean().openapi({ description: "No account, and this e-mail may create one." }),
            accessExpired: z.literal(true).optional().openapi({
              description: "`access` is the link of an invitation to this same address, and it expired.",
            }),
          }),
        ),
        429: errorResponse("Too many attempts (`rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await deps.adapters.rateLimiter.consume(`sign-in-options:${ip}`, SIGN_IN_OPTIONS_PER_IP);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
      const refused = await humanCheckRefusal(
        deps.adapters.humanCheck,
        c.req.raw.headers,
        "email-lookup",
        config.TRUSTED_PROXIES,
      );
      if (refused) return apiError(c, 403, refused.code, refused.message);
      const { email, access } = c.req.valid("json");
      return c.json(await signInOptions(db, email, signupPolicy(config), access), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/invitations/{token}",
      tags,
      summary: "Preview an invitation",
      description:
        "Public. For an invitation link (ADR 0068), also what the signed-in person's request stands at (`you`).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: json(
          z.object({
            orgName: z.string(),
            email: z.string().openapi({ description: "Empty for an org-wide invite link." }),
            role: Role,
            kind: z.enum(["email", "link"]),
            invitedBy: z.string().nullable().openapi({ description: "Who invited (their name), when known." }),
            agents: z
              .array(
                z.object({
                  id: z.uuid(),
                  name: z.string(),
                  appearance: z.object({ color: z.string(), eyes: z.string(), accessory: z.string() }).nullable(),
                }),
              )
              .openapi({ description: "The organization's first agents (name and look)." }),
            moreAgents: z
              .number()
              .int()
              .positive()
              .optional()
              .openapi({ description: "How many more agents work there than `agents` names." }),
            closed: z
              .literal(true)
              .optional()
              .openapi({ description: "A link turned off, expired, or whose workspace is paused: nobody can ask." }),
            you: z
              .object({
                member: z.boolean(),
                orgId: z.uuid().optional().openapi({ description: "Only when a member." }),
                email: z.string(),
                request: z
                  .object({ status: z.enum(["pending", "approved", "denied"]), reason: z.string().nullable() })
                  .nullable()
                  .openapi({
                    description:
                      "The latest request for their address through a link, with its answer; always null while " +
                      "the address isn't confirmed.",
                  }),
              })
              .optional()
              .openapi({
                description:
                  "A link opened signed in: where they stand. On a link that no longer works, only a member's.",
              }),
          }),
        ),
        404: errors[404],
      },
    }),
    async (c) => {
      const token = c.req.valid("param").token;
      const invitation = await previewInvitation(db, token);
      if (!invitation) return apiError(c, 404, "not_found", "Invitation not found or expired");
      const user = invitation.kind === "link" ? await sessionUser(deps.auth, c.req.raw.headers) : null;
      const status = user ? await joinStatus(db, user, token) : null;
      // A link that no longer works still tells a member they're in; anyone else hears only that it doesn't work.
      const you = "closed" in invitation && !status?.member ? null : status;
      return c.json({ ...invitation, ...(you ? { you } : {}) }, 200);
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
            user: z.object({
              id: z.string(),
              name: z.string(),
              email: z.string(),
              image: z.string().nullable(),
              hasPassword: z.boolean().openapi({
                description:
                  "Signs in with a password. False for social sign-ins only, and for the owner the desktop app signs in.",
              }),
              emailVerified: z.boolean().openapi({
                description: "The person opened the link that confirms their email address.",
              }),
              canCreateWorkspace: z.boolean().openapi({
                description:
                  "`POST /organizations` would make a workspace for them. False on agentes.chat Cloud while sign-up is by invitation, unless early access allowed their account and its address is confirmed (ADR 0078). `org.create_refused` and `org.create_unpaid` (ADR 0079) can still refuse it.",
              }),
            }),
            organizations: z.array(Organization),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const user = c.get("user");
      const [memberships, password, verified, creates, unfinished] = await Promise.all([
        listMemberships(db, user.id),
        hasPassword(db, user.id),
        isEmailVerified(db, user.id),
        canCreateWorkspace(db, user.id, workspacePolicy(config)),
        unfinishedWorkspaces(db, user.id),
      ]);
      const onboardingOf = (orgId: string) => unfinished.find((u) => u.organization.id === orgId);
      const deletions = await workspaceDeletions(
        db,
        memberships.flatMap((m) => (m.standing?.deletionDueAt ? [m.orgId] : [])),
      );
      const now = Date.now();
      return c.json(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image ?? null,
            hasPassword: password,
            emailVerified: verified,
            canCreateWorkspace: creates,
          },
          organizations: memberships.map((m) => {
            const setup = onboardingOf(m.orgId);
            const deleting = deletions.get(m.orgId);
            return {
              id: m.orgId,
              name: m.orgName,
              role: m.role,
              logo: m.orgLogo ?? null,
              ...(m.standing
                ? { standing: { state: m.standing.state, reason: toldReason(m.standing), ...cloudNotice() } }
                : {}),
              ...(setup
                ? { onboarding: { step: setup.organization.onboardingStep, generalChannelId: setup.general.id } }
                : {}),
              ...(deleting
                ? {
                    deletion: {
                      dueAt: deleting.dueAt.getTime() > now ? deleting.dueAt.toISOString() : null,
                      requestedAt: iso(deleting.requestedAt),
                      requestedBy: deleting.requestedBy,
                    },
                  }
                : {}),
            };
          }),
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
      method: "post",
      path: "/me/password",
      tags,
      security,
      summary: "Add a password to an account that has none",
      description:
        "For an account that signs in another way (Google, Apple, or the desktop app that runs this server), so it can also sign in with its email from other browsers. Needs a sign-in in the last 10 minutes (403 `reauth.sign_in`): a password proves it's the person, so a session alone can't add one. Refused with `password_set` when it has one: changing a password is the reset flow.",
      request: { body: body(z.object({ password: z.string().min(8).max(128) })) },
      responses: { 204: noContent[204], ...errors, 409: errorResponse("Already has a password (`password_set`)") },
    }),
    async (c) => {
      if (!(await signedInLately(deps.auth, c.req.raw.headers, c.get("user").id))) {
        return apiError(c, 403, "reauth.sign_in", "Sign in again to add a password");
      }
      if (await hasPassword(db, c.get("user").id)) {
        return apiError(c, 409, "password_set", "This account already has a password");
      }
      await deps.auth.api.setPassword({
        body: { newPassword: c.req.valid("json").password },
        headers: c.req.raw.headers,
      });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/phone-sign-in",
      tags,
      security,
      summary: "A one-time sign-in for the phone app",
      description:
        "For the QR code of “Abrir no celular”: `agenteschat://connect?server=…&token=…`. The phone trades the token at `POST /api/auth/sign-in/one-time-token` for a session of its own: once, within a few minutes, and only while this session lasts.",
      responses: {
        201: json(
          z.object({
            token: z.string(),
            server: z.string(),
            expiresIn: z.number().int().openapi({ description: "Seconds the token lasts, from this answer." }),
          }),
          "Created",
        ),
        401: errors[401],
        429: errorResponse("Too many codes"),
      },
    }),
    async (c) => {
      const current = await deps.auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
      });
      if (!current) return apiError(c, 401, "unauthorized", "Sign in to continue");
      const limit = await deps.adapters.rateLimiter.consume(`phone-sign-in:${current.user.id}`, {
        limit: 30,
        windowMs: 3600_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many codes. Try again later.");
      const { token, expiresIn } = await mintPhoneSignIn(deps.auth, current.session.token);
      return c.json({ token, server: new URL(config.PUBLIC_URL).origin, expiresIn }, 201);
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
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many photo changes. Try again later.");
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
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many logo changes. Try again later.");
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
      description:
        "Its owner sets it up in the onboarding, already past its first step (`onboarding` in `GET /me` until `PATCH …/onboarding` says it's finished). While they have one they haven't finished, that one comes back (200) instead of a new one, so a stale tab or a second press makes no other, even one waiting for its first plan. 403 `org.create_refused` while your account is blocked or you are in a workspace suspended or on a hold the billing service didn't set; 403 `org.create_unpaid` (`params.orgId`) while you own a workspace waiting for its first plan; 403 `org.create_invite_only` on agentes.chat Cloud while sign-up is by invitation, unless early access allowed the person's account and its address is confirmed (ADR 0078). With BILLING_HOLD_NEW_WORKSPACES it starts on the `payment` hold (ADR 0079).",
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
        200: json(
          z.object({ organization: Organization, generalChannelId: z.uuid() }),
          "The workspace they are still setting up, as it is",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { teamSize, timezone, ...input } = c.req.valid("json");
      const userId = c.get("user").id;
      const { organization, general, existing } = await createOrganization(db, userId, input, {
        holdForPayment: config.BILLING_HOLD_NEW_WORKSPACES,
        needsAllowance: await needsWorkspaceAllowance(db, userId, workspacePolicy(config)),
        onboarding: true,
      });
      const created = {
        organization: {
          id: organization.id,
          name: organization.name,
          role: "owner" as const,
          context: organization.context,
        },
        generalChannelId: general.id,
      };
      if (existing) return c.json(created, 200);
      if (config.HOST_COMPUTER_TOKEN) await addHostComputer(db, organization.id);
      if (teamSize || (timezone && isValidTimeZone(timezone))) {
        await updateOrgSettings(db, c.get("user").id, organization.id, {
          ...(teamSize ? { teamSize } : {}),
          ...(timezone && isValidTimeZone(timezone) ? { timezone } : {}),
        });
      }
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/onboarding",
      tags,
      security,
      summary: "Save how far you got in setting up your workspace",
      description:
        "Its owner only (403 for anyone else). `step`: the furthest step reached, saved as each one is passed (a skipped one counts); it only moves forward, so an earlier one changes nothing. `finished`: the onboarding is over, for good. Until then the apps open the onboarding instead of the workspace (`onboarding` in `GET /me`).",
      request: {
        params: OrgParams,
        body: body(z.object({ step: z.enum(ONBOARDING_STEPS).optional(), finished: z.literal(true).optional() })),
      },
      responses: {
        200: json(
          z.object({
            step: z.enum(ONBOARDING_STEPS).openapi({ description: "The furthest step reached." }),
            finished: z.boolean(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(await saveOnboarding(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 200),
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
      method: "post",
      path: "/organizations/{orgId}/deletion",
      tags,
      security,
      summary: "Delete a workspace (owners)",
      description:
        "It closes to everyone now, like a suspended workspace (`org.deleting`, as an `org.deleting` org event), its work stops, and it is deleted for good 7 days later. Until then any owner can restore it (`DELETE …/deletion`). Proof that it's you: a sign-in in the last 10 minutes, else `password` (403 `reauth.sign_in` without one, `reauth.password` for a wrong one, 429 after 5 in 15 minutes). A workspace takes 3 deletions a day (429). Already being deleted, it answers 202 with its date, and nobody is told again. 403 `forbidden` for anyone but an owner, `org.suspended` while suspended.",
      request: {
        params: OrgParams,
        body: body(z.object({ password: z.string().min(1).max(128).optional() })),
      },
      responses: {
        202: json(
          z.object({
            deletion: z.object({ dueAt: z.string().openapi({ description: "When it goes for good." }) }),
          }),
          "Being deleted",
        ),
        ...errors,
        429: errorResponse("Too many tries, or too many deletions of it today (`rate_limited`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { orgId } = c.req.valid("param");
      const due = (await requireOwnerToDelete(db, user.id, orgId)).standing?.deletionDueAt;
      if (due) return c.json({ deletion: { dueAt: due.toISOString() } }, 202);
      await deletionProof(
        deps.auth,
        deps.adapters.rateLimiter,
        c.req.raw.headers,
        user.id,
        c.req.valid("json").password,
      );
      if (!(await deps.adapters.rateLimiter.consume(`org-deletion:${orgId}`, DELETIONS_PER_DAY)).allowed) {
        return apiError(c, 429, "rate_limited", "This workspace was deleted too many times today. Try again tomorrow.");
      }
      const { dueAt } = await scheduleDeletion(deletion, user.id, orgId, "owner");
      deps.wakeWorkers?.();
      return c.json({ deletion: { dueAt: dueAt.toISOString() } }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/deletion",
      tags,
      security,
      summary: "Restore a workspace being deleted (owners)",
      description:
        "Any owner, before its date; it opens again and its members are told. 409 `org.not_restorable` when it isn't being deleted or its date passed; 403 `forbidden` for anyone but an owner, `org.suspended` while suspended, `org.create_unpaid` (`params.orgId`) when it waits for its first plan and you own another that does; 404 once it is gone.",
      request: { params: OrgParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requireOwnerToDelete(db, c.get("user").id, orgId);
      await restoreWorkspace(deletion, c.get("user").id, orgId);
      deps.wakeWorkers?.();
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
      await changeMemberRole(db, c.get("user").id, orgId, userId, c.req.valid("json").role, {
        pubsub: deps.adapters.pubsub,
      });
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
    async (c) => {
      const joined = await acceptInvitation(db, c.get("user"), c.req.valid("param").token);
      await announceMembers(deps.adapters.pubsub, joined.orgId);
      // A request to join they had waiting closed as they joined: the admins' notice goes with the last one.
      await settleJoinRequests({ db, pubsub: deps.adapters.pubsub }, joined.orgId);
      return c.json(joined, 200);
    },
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
