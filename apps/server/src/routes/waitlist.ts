import { confirmWaitlist, joinWaitlist, WAITLIST_LOCALES } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
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
    "Public, from the landing page (our origin only, JSON only). Emails a confirmation link (double opt-in). Answers 202 whether or not the email was already on the list or confirmed.",
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

/** Loopback, private, CGNAT (Railway's internal network) and link-local addresses: proxies, never a client. */
function isInternal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/**
 * The client's address: walking `x-forwarded-for` from the right (what our
 * proxies appended), the first one that isn't internal. Entries further left
 * come from the client and can be anything, so they never key a limit.
 * Without a public hop, the `x-real-ip` our host sets.
 */
function clientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isInternal(hop)) return hop;
  }
  return realIp?.trim() || hops[0] || "unknown";
}

/** `POST /api/waitlist` and `/api/waitlist/confirm`: the landing page's only call to action. */
export function registerWaitlist(api: OpenAPIHono, deps: AppDeps) {
  const origins = allowedOrigins(deps.config);
  const { rateLimiter } = deps.adapters;

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
    await joinWaitlist(deps.db, { email, locale, publicUrl: deps.config.PUBLIC_URL });
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
