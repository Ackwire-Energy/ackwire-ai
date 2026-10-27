import {
  approveJoinRequest,
  askToJoin,
  checkJoinCode,
  denyJoinRequest,
  inviteLink,
  JOIN_CODE_LENGTH,
  JOIN_NAME_MAX,
  JOIN_NOTE_MAX,
  JOIN_REASON_MAX,
  listInviteLinks,
  listWaitingJoinRequests,
  requestLocale,
  requestNewInvitation,
  sendJoinCode,
  sha256,
  turnOffInviteLink,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { sessionUser } from "../../auth";
import { requestIp } from "../../http/client-ip";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Organizations"];
/** Asks from one place and through one link (ADR 0068): enough for a team arriving, not for a flood. */
const ASKS_PER_IP = { limit: 10, windowMs: 3600_000 };
const ASKS_PER_LINK = { limit: 20, windowMs: 3600_000 };
/** Codes that prove an address (ADR 0072): the per-address limits are the engine's, in the database. */
const CODES_PER_IP = { limit: 10, windowMs: 3600_000 };
const CODES_PER_LINK = { limit: 40, windowMs: 3600_000 };
const CHECKS_PER_IP = { limit: 30, windowMs: 3600_000 };
const TOO_MANY = "Too many requests from here. Try again in an hour.";
const Code = z.string().regex(new RegExp(`^\\d{${JOIN_CODE_LENGTH}}$`));

const Token = z.object({ token: z.string().min(1).max(200) });
const LinkParams = OrgParams.extend({ linkId: z.uuid() });
const RequestParams = OrgParams.extend({ requestId: z.uuid() });
const InviteLink = z.object({
  id: z.uuid(),
  url: z.string().nullable().openapi({ description: "Null for a link made before links could be shown again." }),
  expiresAt: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable().openapi({ description: "Who made it (their name)." }),
  waiting: z.number().int().openapi({ description: "Requests made through it, still waiting." }),
});
const JoinRequest = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  note: z.string().nullable().openapi({ description: "Their words: shown in the app, never sent out." }),
  verified: z.boolean().openapi({
    description:
      "A code proved the address, or a confirmed account with it asked. False only on a server without email, " +
      "or for a request typed before codes.",
  }),
  confirmed: z.boolean().openapi({
    deprecated: true,
    description: "Approving lets an account in at once. Read `verified` instead.",
  }),
  createdAt: z.string(),
  expiresAt: z.string(),
});

/**
 * The workspace's invitation link and the requests to join it brings (ADR 0068), and "ask for a new invitation"
 * from an expired email invitation.
 */
export function inviteRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const events = { db, pubsub: adapters.pubsub };
  const linkUrl = (token: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`;

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/invite-links",
      tags,
      security,
      summary: "The invitation links people can still ask with (admins)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ links: z.array(InviteLink) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const links = await listInviteLinks(db, config.AGENTES_SECRET, c.get("user").id, orgId);
      return c.json(
        {
          links: links.map(({ token, ...l }) => ({
            ...l,
            url: token ? linkUrl(token) : null,
            expiresAt: l.expiresAt.toISOString(),
            createdAt: l.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invite-links",
      tags,
      security,
      summary: "The workspace's invitation link: the active one, or a new one (admins)",
      description:
        "Whoever opens it can only ask to join; an admin approves each person. It works for 30 days. Only a hash " +
        "of its token is stored, and the same link comes back every time.",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ id: z.uuid(), url: z.string(), expiresAt: z.string() }), "The active link"),
        201: json(z.object({ id: z.uuid(), url: z.string(), expiresAt: z.string() }), "Made"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { link, token, made } = await inviteLink(db, config.AGENTES_SECRET, c.get("user").id, orgId);
      return c.json({ id: link.id, url: linkUrl(token), expiresAt: link.expiresAt.toISOString() }, made ? 201 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/invite-links/{linkId}",
      tags,
      security,
      summary: "Turn an invitation link off (admins)",
      description: "Nobody new can ask with it, and the requests made through it close without emailing anyone.",
      request: { params: LinkParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, linkId } = c.req.valid("param");
      await turnOffInviteLink(events, c.get("user").id, orgId, linkId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/join-requests",
      tags,
      security,
      summary: "Requests to join waiting for an answer, oldest first (admins)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ requests: z.array(JoinRequest) })), ...errors },
    }),
    async (c) => {
      const rows = await listWaitingJoinRequests(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          requests: rows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/join-requests/{requestId}/approve",
      tags,
      security,
      summary: "Approve a request to join with a role (admins)",
      description:
        "A signed-in account with this address confirmed joins at once; anyone else gets an email invitation to " +
        "the address. `emailed: false` on a server that doesn't send email: hand them `url` yourself.",
      request: { params: RequestParams, body: body(z.object({ role: z.enum(["member", "admin"]) })) },
      responses: {
        200: json(
          z.discriminatedUnion("outcome", [
            z.object({ outcome: z.literal("joined") }),
            z.object({
              outcome: z.literal("invited"),
              url: z.string().openapi({ description: "The invitation, for that address only (7 days)." }),
              emailed: z.boolean(),
            }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      const result = await approveJoinRequest(
        events,
        config.PUBLIC_URL,
        c.get("user").id,
        orgId,
        requestId,
        c.req.valid("json").role,
      );
      deps.wakeWorkers?.();
      return c.json(
        result.outcome === "invited" ? { ...result, emailed: adapters.email.delivers === true } : result,
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/join-requests/{requestId}/deny",
      tags,
      security,
      summary: "Deny a request to join (admins)",
      description: "The person is told by email, with the reason when one is given.",
      request: {
        params: RequestParams,
        body: body(z.object({ reason: z.string().max(JOIN_REASON_MAX).optional() })),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      await denyJoinRequest(events, c.get("user").id, orgId, requestId, c.req.valid("json").reason);
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/code",
      tags,
      summary: "Email a code that proves the address, before asking to join through a link",
      description:
        "Public. Signed out: the address typed. Signed in: the account's own, when it isn't confirmed. Every " +
        "address gets the same answer. 60 s between two codes for one address (`retryIn`), and a few an hour " +
        "and a day per address, all counted in the database. `join.no_email` on a server that sends no email.",
      request: { params: Token, body: body(z.object({ email: z.email().max(254).optional() })) },
      responses: {
        202: json(z.object({ email: z.string(), resendIn: z.number().int() }), "Sent"),
        429: errorResponse(
          "Too many (`join.code_wait` with `retryIn`, `join.code_limit`, `join.rate_limited`, `rate_limited`)",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { token } = c.req.valid("param");
      const ip = await adapters.rateLimiter.consume(`join-code:ip:${requestIp(c.req.raw.headers)}`, CODES_PER_IP);
      if (!ip.allowed) return apiError(c, 429, "join.rate_limited", TOO_MANY);
      const link = await adapters.rateLimiter.consume(`join-code:link:${sha256(token)}`, CODES_PER_LINK);
      if (!link.allowed) return apiError(c, 429, "join.rate_limited", TOO_MANY);
      if (adapters.email.delivers !== true) return apiError(c, 409, "join.no_email", "This server doesn't send email.");
      const { email } = c.req.valid("json");
      const user = await sessionUser(deps.auth, c.req.raw.headers);
      if (!user && !email) return apiError(c, 400, "invalid_request", "Your email is needed");
      const sent = await sendJoinCode(events, config.PUBLIC_URL, {
        token,
        user,
        email,
        locale: requestLocale(c.req.header("accept-language")),
      });
      deps.wakeWorkers?.();
      return c.json(sent, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/code/check",
      tags,
      summary: "Check a code from the email: right, the address can ask for 30 minutes",
      description:
        "Public. `join.code_wrong` also when no code was sent. 5 wrong tries per code, 10 a day per address. " +
        "It never confirms an account.",
      request: {
        params: Token,
        body: body(z.object({ email: z.email().max(254).optional(), code: Code })),
      },
      responses: {
        200: json(z.object({ verified: z.literal(true) })),
        429: errorResponse("Too many checks from here (`join.rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const ip = await adapters.rateLimiter.consume(
        `join-code-check:ip:${requestIp(c.req.raw.headers)}`,
        CHECKS_PER_IP,
      );
      if (!ip.allowed) return apiError(c, 429, "join.rate_limited", TOO_MANY);
      const { email, code } = c.req.valid("json");
      const user = await sessionUser(deps.auth, c.req.raw.headers);
      if (!user && !email) return apiError(c, 400, "invalid_request", "Your email is needed");
      return c.json(await checkJoinCode(events, { token: c.req.valid("param").token, user, email, code }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/requests",
      tags,
      summary: "Ask to join through an invitation link",
      description:
        "Public. Signed out: a name, an email and an optional note, and no account is made. Signed in: the " +
        "account asks. On a server that sends email, an address that isn't a confirmed account's carries the " +
        "`code` from it (`…/code`), and a proven ask hears where it stands. On a server without email, a typed " +
        "request answers the same whatever the address. Limited per IP and per link.",
      request: {
        params: Token,
        body: body(
          z.object({
            name: z.string().trim().min(1).max(JOIN_NAME_MAX).optional(),
            email: z.email().max(254).optional(),
            note: z.string().max(JOIN_NOTE_MAX).optional(),
            code: Code.optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({ status: z.literal("pending"), email: z.string(), emailed: z.boolean() }),
          "Already waiting",
        ),
        201: json(z.object({ status: z.literal("pending"), email: z.string(), emailed: z.boolean() }), "Sent"),
        429: errorResponse("Too many requests (`join.rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const { token } = c.req.valid("param");
      const ip = await adapters.rateLimiter.consume(`join-request:ip:${requestIp(c.req.raw.headers)}`, ASKS_PER_IP);
      if (!ip.allowed) return apiError(c, 429, "join.rate_limited", TOO_MANY);
      const link = await adapters.rateLimiter.consume(`join-request:link:${sha256(token)}`, ASKS_PER_LINK);
      if (!link.allowed) return apiError(c, 429, "join.rate_limited", TOO_MANY);
      const input = c.req.valid("json");
      const user = await sessionUser(deps.auth, c.req.raw.headers);
      if (!user && (!input.name || !input.email)) {
        return apiError(c, 400, "invalid_request", "Your name and your email are needed");
      }
      const asked = await askToJoin(events, config.PUBLIC_URL, {
        token,
        user,
        name: input.name,
        email: input.email,
        note: input.note,
        locale: requestLocale(c.req.header("accept-language")),
        proofNeeded: adapters.email.delivers === true,
        code: input.code,
      });
      deps.wakeWorkers?.();
      const reply = { status: asked.status, email: asked.email, emailed: adapters.email.delivers === true };
      return c.json(reply, asked.created ? 201 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/request-new",
      tags,
      summary: "Ask whoever invited you for a new invitation (the old one expired)",
      description: "Email invitations only: an invitation link answers 404.",
      request: { params: Token },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const ip = requestIp(c.req.raw.headers);
      const limit = await adapters.rateLimiter.consume(`invite-request:${ip}`, { limit: 10, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again later");
      await requestNewInvitation(db, config.PUBLIC_URL, c.req.valid("param").token);
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  return app;
}
