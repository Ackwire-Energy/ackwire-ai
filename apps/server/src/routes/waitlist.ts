import { confirmWaitlist, joinWaitlist, WAITLIST_LOCALES } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { clientIp } from "../http/client-ip";
import { apiError, errorResponse } from "../http/errors";
import { type AppDeps, allowedOrigins } from "./app/context";

/** Joins per address per hour, and in total per hour (each one can send an email). */
const JOIN_PER_IP = { limit: 10, windowMs: 3600_000 };
const JOIN_TOTAL = { limit: 500, windowMs: 3600_000 };
/** Confirmation attempts per address per hour (tokens are 192 bits; this only stops noise). */
const CONFIRM_PER_IP = { limit: 30, windowMs: 3600_000 };

const join = createRoute({
  method: "post",
  path: "/waitlist",
  tags: ["Public"],
  summary: "Join the waiting list",
  description:
    "Public, from the landing page (our origin or `LANDING_URL`, JSON only). Emails a confirmation link (double opt-in). Answers 202 whether or not the email was already on the list or confirmed.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().max(254).openapi({ example: "ana@acme.com" }),
            locale: z.enum(WAITLIST_LOCALES).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Confirmation pending",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: errorResponse("Invalid email (`invalid_email`) or body (`invalid_request`)"),
    403: errorResponse("Not from our origin (`bad_origin`)"),
    429: errorResponse("Too many attempts (`rate_limited`)"),
  },
});

const confirm = createRoute({
  method: "post",
  path: "/waitlist/confirm",
  tags: ["Public"],
  summary: "Confirm a waiting list email",
  description:
    "Public, from the landing page that the confirmation link opens (POST, so link scanners that only fetch the URL don't confirm).",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ token: z.string().max(64) }) } },
    },
  },
  responses: {
    200: { description: "Confirmed", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    400: errorResponse("Unknown or expired link (`invalid_token`) or bad body (`invalid_request`)"),
    403: errorResponse("Not from our origin (`bad_origin`)"),
    429: errorResponse("Too many attempts (`rate_limited`)"),
  },
});

/**
 * `POST /api/waitlist` and `/api/waitlist/confirm`: the landing page's only call to action.
 * The landing page is its own site (`LANDING_URL`), so these two routes, and only these,
 * answer it through CORS: JSON only, no cookies.
 */
export function registerWaitlist(api: OpenAPIHono, deps: AppDeps) {
  const landing = deps.config.LANDING_URL ? new URL(deps.config.LANDING_URL).origin : null;
  const origins = new Set([...allowedOrigins(deps.config), ...(landing ? [landing] : [])]);
  const { rateLimiter } = deps.adapters;
  if (landing) {
    const landingCors = cors({ origin: landing, allowMethods: ["POST"], allowHeaders: ["content-type"], maxAge: 600 });
    api.use("/waitlist", landingCors);
    api.use("/waitlist/confirm", landingCors);
  }

  api.openapi(join, async (c) => {
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    if (
      !(
        await rateLimiter.consume(
          `waitlist:${clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"))}`,
          JOIN_PER_IP,
        )
      ).allowed
    )
      return apiError(c, 429, "rate_limited", "Too many requests; try again later");
    const { email, locale } = c.req.valid("json");
    if (!(await rateLimiter.consume("waitlist:all", JOIN_TOTAL)).allowed)
      return apiError(c, 429, "rate_limited", "Too many requests; try again later");
    // The link opens the landing page, which confirms it.
    await joinWaitlist(deps.db, { email, locale, publicUrl: deps.config.LANDING_URL ?? deps.config.PUBLIC_URL });
    return c.json({ ok: true as const }, 202);
  });

  api.openapi(confirm, async (c) => {
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    if (
      !(
        await rateLimiter.consume(
          `waitlist-confirm:${clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"))}`,
          CONFIRM_PER_IP,
        )
      ).allowed
    )
      return apiError(c, 429, "rate_limited", "Too many requests; try again later");
    if (!(await confirmWaitlist(deps.db, c.req.valid("json").token)))
      return apiError(c, 400, "invalid_token", "This link is unknown or expired; join the list again for a new one");
    return c.json({ ok: true as const }, 200);
  });
}
