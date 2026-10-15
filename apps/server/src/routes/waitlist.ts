import { joinWaitlist, WAITLIST_LOCALES } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { type AppDeps, allowedOrigins } from "./app/context";

const route = createRoute({
  method: "post",
  path: "/waitlist",
  tags: ["Public"],
  summary: "Join the waiting list",
  description:
    "Public, from the landing page (our origin only, JSON only). Answers 202 whether or not the email was already on the list.",
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
    202: { description: "On the list", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    400: errorResponse("Invalid email (`invalid_email`) or body (`invalid_request`)"),
    403: errorResponse("Not from our origin (`bad_origin`)"),
    429: errorResponse("Too many attempts from this address (`rate_limited`)"),
  },
});

/** `POST /api/waitlist`: the only call to action of the landing page. */
export function registerWaitlist(api: OpenAPIHono, deps: AppDeps) {
  const origins = allowedOrigins(deps.config);
  api.openapi(route, async (c) => {
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const limit = await deps.adapters.rateLimiter.consume(`waitlist:${ip}`, { limit: 10, windowMs: 3600_000 });
    if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again later");
    const { email, locale } = c.req.valid("json");
    await joinWaitlist(deps.db, { email, locale });
    return c.json({ ok: true as const }, 202);
  });
}
